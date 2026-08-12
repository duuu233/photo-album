// Token（支付体系）客户端接口层。
//
// 2026-08-08：由本地 mock 切到真实后端。对应的 `/Client/...` 端点是
//   GET  /Client/Order/getUserAccount        余额 / 累计购买 / 累计消耗
//   GET  /Client/Order/chkAiDialogue         能否发起 AI 对话（星币够不够，retData 是布尔，2026-08-12 新增）
//   GET  /Client/Order/getGoodsList          商品（套餐）列表，带 wxProductId / appleProductId
//   GET  /Client/Order/getUserAccountTrade   购买 & 消费记录（分页，inOutType 区分）
//   POST /Client/Order/addOrder              在我们平台创建订单，返回 orderId / orderNo / amount
//                                            + signData / paySig / signature（虚拟支付签名）
//   GET  /Client/Pay/getPayQuery             兜底查支付侧订单状态（payType + orderNo → payState）
// 全部经 utils/request.js（自动带 userToken / terminal=3 / language 与两枚鉴权头）。
//
// 微信支付走的是**小程序虚拟支付**（Token 是虚拟商品，普通微信支付不适用），调用封装在
// utils/wx-virtual-pay.js。整条链路：
//   ① getGoodsList 取套餐 → ② addOrder 在我们平台建单（拿 orderNo 当 outTradeNo）
//   → ③ wx.requestVirtualPayment 用**服务端签好**的 signData/paySig/signature 拉起支付
//   → ④ 微信把发货通知回调给我们后端，后端加 Token
//   → ⑤ 端上轮询 getUserAccount 直到余额到账（⑤ 才是「买到了」的判据，③ 的 success 只是弱确认）。
//
// ✅ 2026-08-11 接口对账（https://api.boltfox.cn/swagger-ui.html#/）：08-08 记的那个「唯一缺口」
//   **已由后端补齐** —— `ClientAddOrderApiOut` 现在是
//   `amount / orderId / orderNo / signData / paySig / signature`，第 ③ 步要的三个签名字段
//   由 addOrder 一并返回。端上本就按「平铺或包一层都认」解析（wxVirtualPay.extractPayParams），
//   无需改动；ORDER_PAY_PARAMS_MISSING 从「已知缺口」降级为异常兜底（真缺才报）。
//
// ⚠️ 仍然没有的：**「消费 Token」的 Client 端点**（swagger 的 /Client/Order 下只有购买侧四个）。
//   所以扣费必然发生在服务端（消费记录能从 getUserAccountTrade 的 inOutType=2 查到），
//   端上**不得**自己扣数——AI 侧只负责「展示真实余额 + 用完后重取」，见 utils/ai-token.js。

const http = require('./request')
const wxVirtualPay = require('./wx-virtual-pay')

// addOrder 的支付方式（swagger ClientOrderAddApiIn.payType）
const PAY_TYPE = {
  wechat: 1, // 微信支付（小程序=虚拟支付）
  apple: 2, // IOS 内购，APP 端用
  paypal: 3
}

// 记录类型 → getUserAccountTrade 的 inOutType
const IN_OUT_TYPE = {
  purchase: 1,
  spend: 2
}

const RECORD_PAGE_SIZE = 20

// 支付成功后等后端「发货」（微信回调 → 加 Token）的轮询节奏。
// 回调是异步的，端上 success 回来时余额通常还没变，直接拉一次会显示成没到账。
// 递增退避、总时长约 9.4s：够覆盖正常回调，又不至于让用户对着菊花干等。
// 超时不算失败——钱已经付了，转成「稍后到账」的提示，别把用户吓着。
const CONFIRM_DELAYS = [900, 1200, 1800, 2500, 3000]

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function toNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback || 0
}

// BasePageOutput 取列表：与 utils/api.js 的 pageData 同口径
function pageRows(data) {
  if (Array.isArray(data)) {
    return data
  }
  if (data && Array.isArray(data.pageData)) {
    return data.pageData
  }
  if (data && Array.isArray(data.list)) {
    return data.list
  }
  return []
}

/**
 * 账户概览归一。
 * 后端 UserAccountApiOut 的三个字段都是 **String**（availableToken / totalToken / consumeToken），
 * 页面要拿来比大小、算差值，这里统一转成数字；字段名也换成页面沿用的那套，wxml 不用动。
 */
function normalizeAccount(data) {
  const source = data || {}
  return {
    balance: toNumber(source.availableToken, 0),
    totalPurchased: toNumber(source.totalToken, 0),
    totalSpent: toNumber(source.consumeToken, 0)
  }
}

/**
 * 商品 → 套餐卡。
 * `id` 保持字符串：页面用它做选中比对，还要经 URL 传给确认页，数字进出 URL 容易变类型；
 * 真正提交给 addOrder 的是数字 `goodsId`。
 */
function normalizePackage(item) {
  const source = item || {}
  const goodsId = toNumber(source.goodsId, 0)
  return {
    id: String(goodsId),
    goodsId,
    name: source.goodsName || '',
    tokens: toNumber(source.num, 0),
    gift: toNumber(source.giveNum, 0),
    price: toNumber(source.amount, 0),
    // 微信/苹果两侧的商品渠道 id。端上不直接拿它去调支付（productId 是被服务端签进
    // signData 的，见 wx-virtual-pay.js），只用来判断「这档在本端买不买得了」并打日志。
    wxProductId: source.wxProductId || '',
    appleProductId: source.appleProductId || ''
  }
}

/**
 * 购买记录。ClientUserAccountTradeApiOut 没有主键，wx:key 需要一个稳定值，
 * 用「类型 + 页码 + 页内下标」拼一个——同一页数据顺序稳定，翻页也不会撞。
 */
function normalizePurchaseRecord(item, key) {
  const source = item || {}
  return {
    id: key,
    time: source.joinTime || '',
    tokens: toNumber(source.num, 0),
    gift: toNumber(source.giveNum, 0),
    amount: toNumber(source.amount, 0),
    channel: source.payTypeMsg || '',
    status: source.orderStateMsg || ''
  }
}

function normalizeSpendRecord(item, key) {
  const source = item || {}
  return {
    id: key,
    time: source.joinTime || '',
    // 消费侧后端给的是 description（例：「200 token」），页面那一行叫「场景」
    scene: source.description || '',
    tokens: toNumber(source.num, 0)
  }
}

/**
 * 单个套餐「合计获得」= 基础 Token + 赠送 Token。
 * 确认购买页与购买记录都用它，避免两处各算一遍算出不同的数。
 */
function totalTokensOf(pkg) {
  if (!pkg) {
    return 0
  }
  return (Number(pkg.tokens) || 0) + (Number(pkg.gift) || 0)
}

/**
 * 单价（约）：套餐卡底部的 `≈ ¥0.36/Token`。
 * 按**含赠送**的总数算，否则赠送多的档位单价反而显得更贵，与「越买越划算」的排序相悖。
 * ⚠️ 不用后端 ClientGoodsApiOut.unitPrice：那个字段是 integer（且不含赠送口径），
 *    直接渲染会变成「≈ ¥0/Token」。口径以本函数为准。
 */
function unitPriceOf(pkg) {
  const total = totalTokensOf(pkg)
  if (!total) {
    return '0.00'
  }
  return ((Number(pkg.price) || 0) / total).toFixed(2)
}

/**
 * 账户概览。
 * @param {object} [options] 透传给 request.js，支付链路里用 `{ showError: false }` 静默取基线余额
 */
function getAccount(options) {
  return http
    .get('/Client/Order/getUserAccount', {}, Object.assign({ mock: false }, options))
    .then(normalizeAccount)
}

// chkAiDialogue 说「不够」时用的业务码。2026-08-12 真机实测：**余额不足不是 200+false，
// 而是整个响应就报错**：
//   {"retCode":403,"retMsg":"token余额不足，需要最低余额：30.0 token","retData":null}
// 也就是说「能不能发」的否定答复是从 request.js 的**失败**分支出来的，
// 不认这个码就会被当成「接口挂了」而放行（见 ai-token.canDialogue 的兜底）。
const AI_DIALOGUE_FORBIDDEN_CODE = 403

// 从 retMsg 里抠出「最低余额」的数字（"…需要最低余额：30.0 token" → 30）。
// 抠不到返回 0，调用方据此退回不带数字的措辞——绝不瞎猜一个数写进提示里。
function parseRequiredTokens(message) {
  const matched = /([0-9]+(?:\.[0-9]+)?)/.exec(String(message || ''))
  if (!matched) {
    return 0
  }
  const value = Number(matched[1])
  return Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * 能否发起一次 AI 对话（2026-08-12 新增 `GET /Client/Order/chkAiDialogue`）。
 *
 * 服务端按当前用户的星币余额裁决，这是**唯一权威**的「够不够发一轮」判据：端上不知道一轮
 * 对话扣多少星币，原先那套自判逻辑（`ai-token.hasBalance` + `LIMIT_ENABLED`）已随本接口一并删除。
 *
 * 两种答复形状（**不对称**，见 AI_DIALOGUE_FORBIDDEN_CODE）：
 *   可以：`retCode=200`，`retData=true`
 *   不行：`retCode=403` + `retMsg`（带最低余额），`retData=null` —— 走 reject 分支
 *
 * @param {object} [options] 透传给 request.js（校验失败不该再弹一条接口红字，一律传 showError:false）
 * @returns {Promise<{allowed: boolean, required: number, message: string}>}
 *   allowed=false 时 `required` 是后端说的最低余额（抠不到为 0），`message` 是后端原话（供兜底措辞）。
 *   ⚠️ 只有**明确的 403** 才 resolve 成 false；其它错误（网络/5xx）原样 reject，由调用方决定放不放行。
 */
function checkAiDialogue(options) {
  return http
    .get('/Client/Order/chkAiDialogue', {}, Object.assign({ mock: false }, options))
    // 200 即放行。**不要求 retData 严格等于 true**：拒绝是由 403 表达的，
    // 真到了这一支还去纠结 retData 是 true 还是 null，只会在后端某天不回这个字段时
    // 把所有人都拦在门外——那比放过去糟得多（/chat 侧服务端还会再拒一次）。
    .then(data => ({
      allowed: data !== false && data !== 'false',
      required: 0,
      message: ''
    }))
    .catch(error => {
      const code = Number(error && error.code)
      if (code !== AI_DIALOGUE_FORBIDDEN_CODE) {
        throw error
      }
      // request.js 会给 message 加「接口-」前缀（那是给报错 toast 用的），这里要拿原话去解析和兜底
      const message = String((error && error.message) || '').replace(/^接口-/, '')
      return {
        allowed: false,
        required: parseRequiredTokens(message),
        message
      }
    })
}

function getPackages() {
  return http
    .get('/Client/Order/getGoodsList', {}, { mock: false })
    .then(data => pageRows(data).map(normalizePackage))
}

/**
 * 购买 / 消费记录（分页）。
 * @param {'purchase'|'spend'} type
 * @param {{pageIndex?: number, pageSize?: number}} options
 * @returns {Promise<{list: Array, hasMore: boolean, pageIndex: number}>}
 */
function getRecords(type, options) {
  const opts = options || {}
  const pageIndex = Math.max(1, toNumber(opts.pageIndex, 1))
  const pageSize = Math.max(1, toNumber(opts.pageSize, RECORD_PAGE_SIZE))
  const isSpend = type === 'spend'

  return http
    .get(
      '/Client/Order/getUserAccountTrade',
      {
        inOutType: isSpend ? IN_OUT_TYPE.spend : IN_OUT_TYPE.purchase,
        pageIndex,
        pageSize
      },
      { mock: false }
    )
    .then(data => {
      const rows = pageRows(data)
      const list = rows.map((item, index) => {
        const key = `${isSpend ? 's' : 'p'}${pageIndex}-${index}`
        return isSpend
          ? normalizeSpendRecord(item, key)
          : normalizePurchaseRecord(item, key)
      })

      // 判停优先用后端分页元数据；缺失时退回「不满一页即最后一页」。
      // 不能只看条数：后端可能无视 pageSize 按自己的默认值分页（同 FAQ 翻页的老坑）。
      const pageCount = toNumber(data && data.pageCount, 0)
      const hasMore = pageCount > 0 ? pageIndex < pageCount : rows.length >= pageSize

      return { list, hasMore, pageIndex }
    })
}

/**
 * 在我们平台创建订单。
 * @returns {Promise<object>} 原样返回后端响应：orderId / orderNo / amount，
 *          以及（后端补齐后的）虚拟支付签名参数
 */
function addOrder(pkg, channel, options) {
  const opts = options || {}
  const goodsId = toNumber(pkg && pkg.goodsId, 0) || toNumber(pkg && pkg.id, 0)
  const payType = PAY_TYPE[channel] || PAY_TYPE.wechat

  if (!goodsId) {
    return Promise.reject({
      code: 'GOODS_ID_MISSING',
      message: '套餐信息有误，请返回重新选择'
    })
  }

  const wxProductId = (pkg && pkg.wxProductId) || ''
  console.log('[虚拟支付] 建单 addOrder', {
    goodsId,
    payType,
    套餐: (pkg && pkg.name) || '',
    金额: (pkg && pkg.price) || 0,
    wxProductId: wxProductId || '(空)'
  })
  // getGoodsList 的 wxProductId 就是后端要签进 signData 的 productId。它在这里为空，
  // 基本可以断定后端签出来的 productId 也是空的 → 真机稳定回 -15001。
  // 只 warn 不拦：签什么由后端决定（也可能后端另有来源），端上凭一个字段就拒绝下单，
  // 会把「微信给的真实错误码」这条最有价值的线索也一并挡掉。
  if (payType === PAY_TYPE.wechat && !wxProductId) {
    console.warn(
      '[虚拟支付] ⚠️ 该套餐没有 wxProductId（微信侧道具 id），若后端据此签 signData.productId，拉起支付大概率回 -15001'
    )
  }

  return http
    .post(
      '/Client/Order/addOrder',
      { goodsId, payType },
      {
        mock: false,
        // 默认弹原生「下单中」；purchase() 里关掉它 —— 那条链路整段由页面的全屏 loading 盖着
        // （2026-08-12），再叠一层原生 loading 就是两个转圈叠在一起
        loading: opts.loading !== false,
        loadingText: '下单中'
      }
    )
    .then(data => {
      const order = data || {}
      // 打 key 列表而不是打值：签名三件套后端可能平铺、也可能包在 payParams/virtualPay 里
      // （extractPayParams 两种都认），出问题时第一件要看的就是「到底放哪了、有没有」。
      console.log('[虚拟支付] addOrder 返回', {
        orderNo: order.orderNo || '(空)',
        orderId: order.orderId || '(空)',
        amount: order.amount,
        字段: Object.keys(order).join(', '),
        'signData 类型': typeof order.signData,
        有paySig: !!order.paySig,
        有signature: !!order.signature
      })
      return order
    })
}

/**
 * 兜底查支付侧订单状态。只在余额轮询超时后调一次，用来把提示分成
 * 「已付款、稍后到账」和「结果确认中」。静默失败：这一步只影响提示措辞，
 * 不该再弹一个 toast 盖住主流程的弹窗。
 *
 * ⚠️ 2026-08-11 接口对账修正：端上原先调的 `/Client/Pay/getWxVirtualPayQueryOrder`
 * **在当前 swagger 里已不存在**（`/Client/Pay/` 下只剩 getPayQuery 与 Apple Pay 四个）。
 * 现按文档改调 `GET /Client/Pay/getPayQuery`：入参是 `payType` + `orderNo`（**我们平台的
 * 订单号**，不是微信侧 outTradeNo，也不再传 env），出参是
 * `{ payState, payNo, exceptionMsg, resData }` —— 字段名也从 `payStatus` 变成了 `payState`。
 *
 * 「待后端确认」：swagger 对 `payState` 只写了「支付状态」没给枚举。端上沿用旧口径
 * **1=已支付** 判定（其余值一律按「结果确认中」措辞，不会说成失败），后端给出枚举后再校准。
 */
function queryPayOrder(orderNo, payType) {
  if (!orderNo) {
    return Promise.resolve(null)
  }
  return http
    .get(
      '/Client/Pay/getPayQuery',
      { orderNo, payType: toNumber(payType, PAY_TYPE.wechat) },
      { mock: false, showError: false }
    )
    .catch(() => null)
}

/**
 * 以**服务端余额**为准确认到账。
 *
 * 微信的发货通知是异步打到我们后端的，所以支付 success 回来时余额往往还没变；
 * 这里按 CONFIRM_DELAYS 退避轮询，余额比支付前多了才算到账。
 * 轮询期间不弹接口错误（showError:false）——中途一次网络抖动就弹红字会让用户以为钱没了。
 *
 * @param {{orderNo?: string, payType?: number}} order 建单结果（超时兜底查订单要用它的 orderNo）
 * @param {number|null} baselineBalance 支付前的余额，读不到时传 null（则不做差值判定）
 * @param {number[]} [delays] 轮询节奏，仅供单测把 9.4 秒压成毫秒级；业务侧一律用默认值
 * @returns {Promise<{account: object|null, gained: number|null, pending: boolean, payState: number}>}
 */
async function confirmPurchase(order, baselineBalance, delays) {
  const schedule = Array.isArray(delays) && delays.length ? delays : CONFIRM_DELAYS
  let account = null

  for (let i = 0; i < schedule.length; i++) {
    await delay(schedule[i])
    try {
      account = await getAccount({ showError: false })
    } catch (error) {
      continue
    }

    // 拿不到支付前余额时无法算增量，只要账户读得到就当确认完成（金额交给记录页去核对）
    if (baselineBalance === null || baselineBalance === undefined) {
      return { account, gained: null, pending: false, payState: 0 }
    }

    if (account.balance > baselineBalance) {
      return {
        account,
        gained: account.balance - baselineBalance,
        pending: false,
        payState: 1
      }
    }
  }

  // 超时不等于失败：钱可能已经付了，只是回调还没到（或到了但处理慢）。
  // 查一次支付侧订单，把提示说准。
  const queried = await queryPayOrder(
    order && order.orderNo,
    order && order.payType
  )
  return {
    account,
    gained: null,
    pending: true,
    payState: toNumber(queried && queried.payState, 0)
  }
}

/**
 * 完整购买流程：建单 → 拉起微信虚拟支付 → 等服务端到账。
 *
 * 失败一律 reject 带 code 的错误对象，页面按 code 区分「取消」和「真失败」：
 *   PAY_CANCELED             用户自己取消，不该弹「购买失败」
 *   VIRTUAL_PAY_UNAVAILABLE  微信版本太老，没有 requestVirtualPayment
 *   ORDER_PAY_PARAMS_MISSING 后端没下发签名参数（当前已知缺口，见文件头）
 *   PAYPAL_UNAVAILABLE       PayPal 通道未接入
 *
 * @param {object} pkg 套餐（getPackages 归一后的对象）
 * @param {'wechat'|'paypal'} channel
 * @param {(stage: 'order'|'pay'|'confirm') => void} [onStage] 进度回调（2026-08-12 新增）。
 *        整条链路最长约 10s（建单 ~1s + 拉起支付 + 到账轮询 9.4s），页面的全屏 loading 靠它
 *        换文案，用户才知道在等什么；不传即完全不影响原有行为。
 */
async function purchase(pkg, channel, onStage) {
  // 回调抛错不能连累支付流程（页面 setData 出问题时尤其）
  const notify = stage => {
    if (typeof onStage !== 'function') {
      return
    }
    try {
      onStage(stage)
    } catch (error) {
      console.warn('[虚拟支付] 进度回调异常', error)
    }
  }

  if (channel === 'paypal') {
    return Promise.reject({
      code: 'PAYPAL_UNAVAILABLE',
      message: 'PayPal 支付通道尚未接入'
    })
  }

  // 先探可用性再下单：付不了时提前拦住，别在后台留一串永远付不掉的待支付单。
  // 2026-08-12 起这一步不止判「有没有这个 API」，还判 iOS 的系统/微信版本门槛——
  // 现场 iPhone + 微信 8.0.59 会一路走到微信那儿拿一个 -15001 INVALID_PLATFORM，
  // 用户只看到「支付失败（-15001）」，既不知道原因也不知道该做什么。
  const unsupported = wxVirtualPay.unsupportedReason()
  if (unsupported) {
    console.warn('[虚拟支付] 端上前置判定为不可支付，未建单', { 原因: unsupported })
    return Promise.reject({
      code: 'VIRTUAL_PAY_UNAVAILABLE',
      message: unsupported
    })
  }

  // 支付前的余额基线，用来判断到账。读失败不阻断购买（只是事后少一个增量数字），
  // 也不弹错误——用户点的是「立即购买」，为一次基线读取先看到一条红字很莫名。
  let baselineBalance = null
  try {
    baselineBalance = (await getAccount({ showError: false })).balance
  } catch (error) {
    baselineBalance = null
  }

  notify('order')
  // loading:false —— 这条链路整段由页面的全屏 loading 盖着，不再叠一层原生「下单中」
  const order = await addOrder(pkg, channel, { loading: false })
  const payParams = wxVirtualPay.extractPayParams(order)

  if (!payParams) {
    return Promise.reject({
      code: 'ORDER_PAY_PARAMS_MISSING',
      message: '下单成功但未拿到支付参数（signData / paySig / signature），请联系客服',
      data: order
    })
  }

  notify('pay')
  await wxVirtualPay.requestPayment(payParams)

  // 支付回来到这里最长还要等约 9.4s（退避轮询等服务端到账），页面文案在这一步换成「确认到账」，
  // 否则用户会觉得付完卡住了
  notify('confirm')
  // 超时兜底查的是**我们平台的订单号**（getPayQuery 的 orderNo），不是微信侧 outTradeNo。
  const confirmed = await confirmPurchase(
    {
      orderNo: order.orderNo || payParams.outTradeNo || '',
      payType: PAY_TYPE[channel] || PAY_TYPE.wechat
    },
    baselineBalance
  )

  return Object.assign(
    {
      orderId: order.orderId || '',
      orderNo: order.orderNo || payParams.outTradeNo || '',
      amount: toNumber(order.amount, 0)
    },
    confirmed
  )
}

module.exports = {
  PAY_TYPE,
  AI_DIALOGUE_FORBIDDEN_CODE,
  RECORD_PAGE_SIZE,
  totalTokensOf,
  unitPriceOf,
  getAccount,
  checkAiDialogue,
  getPackages,
  getRecords,
  addOrder,
  queryPayOrder,
  confirmPurchase,
  purchase,
  // 归一函数导出供单测直接验字段映射（String→Number、字段改名这类最容易接错的地方）
  normalizeAccount,
  normalizePackage,
  normalizePurchaseRecord,
  normalizeSpendRecord
}
