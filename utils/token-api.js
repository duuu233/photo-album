// Token（支付体系）客户端接口层。
//
// 2026-08-08：由本地 mock 切到真实后端。对应的 `/Client/...` 端点是
//   GET  /Client/Order/getUserAccount        余额 / 累计购买 / 累计消耗
//   GET  /Client/Order/getGoodsList          商品（套餐）列表，带 wxProductId / appleProductId
//   GET  /Client/Order/getUserAccountTrade   购买 & 消费记录（分页，inOutType 区分）
//   POST /Client/Order/addOrder              在我们平台创建订单，返回 orderId / orderNo / amount
//   GET  /Client/Pay/getWxVirtualPayQueryOrder  兜底查微信侧订单状态
// 全部经 utils/request.js（自动带 userToken / terminal=3 / language 与两枚鉴权头）。
//
// 微信支付走的是**小程序虚拟支付**（Token 是虚拟商品，普通微信支付不适用），调用封装在
// utils/wx-virtual-pay.js。整条链路：
//   ① getGoodsList 取套餐 → ② addOrder 在我们平台建单（拿 orderNo 当 outTradeNo）
//   → ③ wx.requestVirtualPayment 用**服务端签好**的 signData/paySig/signature 拉起支付
//   → ④ 微信把发货通知回调给我们后端，后端加 Token
//   → ⑤ 端上轮询 getUserAccount 直到余额到账（⑤ 才是「买到了」的判据，③ 的 success 只是弱确认）。
//
// ⚠️ 待后端确认（唯一的缺口）：第 ③ 步要的 signData / paySig / signature 目前**不在**
//   addOrder 的返回里（swagger 的 ClientAddOrderApiOut 只有 amount / orderId / orderNo）。
//   这三个字段只能服务端算（appKey 与 session_key 都是服务端秘密，见 wx-virtual-pay.js 顶部），
//   所以要么由 addOrder 一并返回，要么补一个「创建支付」端点。端上已按「平铺或包一层都认」
//   的方式解析（wxVirtualPay.extractPayParams），后端就位后不用再改端上；
//   在那之前走到这步会抛 ORDER_PAY_PARAMS_MISSING，报错文案直接点名缺哪几个字段。
//
// 另见 `subpackages/ai/chat/chat.js` 的 `TOKEN_LIMIT_ENABLED`：聊天页的扣费拦截仍是关的。
// 本轮没有一并打开——后端目前没有「消费 Token」的 Client 端点（swagger 里只有购买侧），
// 扣费口径要和 AI 网关谈定后再开，否则就是把假扣费换成另一种假扣费。

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
function addOrder(pkg, channel) {
  const goodsId = toNumber(pkg && pkg.goodsId, 0) || toNumber(pkg && pkg.id, 0)
  const payType = PAY_TYPE[channel] || PAY_TYPE.wechat

  if (!goodsId) {
    return Promise.reject({
      code: 'GOODS_ID_MISSING',
      message: '套餐信息有误，请返回重新选择'
    })
  }

  return http
    .post(
      '/Client/Order/addOrder',
      { goodsId, payType },
      { mock: false, loading: true, loadingText: '下单中' }
    )
    .then(data => data || {})
}

/**
 * 兜底查微信侧订单状态（payStatus 1=已支付 2=已取消 3=已退款）。
 * 只在余额轮询超时后调一次，用来把提示分成「已付款、稍后到账」和「结果确认中」。
 * 静默失败：这一步只影响提示措辞，不该再弹一个 toast 盖住主流程的弹窗。
 */
function queryVirtualPayOrder(outTradeNo, env) {
  if (!outTradeNo) {
    return Promise.resolve(null)
  }
  return http
    .get(
      '/Client/Pay/getWxVirtualPayQueryOrder',
      { outTradeNo, env: env === 1 ? 1 : 0 },
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
 * @param {number|null} baselineBalance 支付前的余额，读不到时传 null（则不做差值判定）
 * @param {number[]} [delays] 轮询节奏，仅供单测把 9.4 秒压成毫秒级；业务侧一律用默认值
 * @returns {Promise<{account: object|null, gained: number|null, pending: boolean, payStatus: number}>}
 */
async function confirmPurchase(payParams, baselineBalance, delays) {
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
      return { account, gained: null, pending: false, payStatus: 0 }
    }

    if (account.balance > baselineBalance) {
      return {
        account,
        gained: account.balance - baselineBalance,
        pending: false,
        payStatus: 1
      }
    }
  }

  // 超时不等于失败：钱可能已经付了，只是回调还没到（或到了但处理慢）。
  // 查一次微信侧订单，把提示说准。
  const order = await queryVirtualPayOrder(
    payParams && payParams.outTradeNo,
    payParams && payParams.env
  )
  return {
    account,
    gained: null,
    pending: true,
    payStatus: toNumber(order && order.payStatus, 0)
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
 */
async function purchase(pkg, channel) {
  if (channel === 'paypal') {
    return Promise.reject({
      code: 'PAYPAL_UNAVAILABLE',
      message: 'PayPal 支付通道尚未接入'
    })
  }

  // 先探可用性再下单：微信版本不支持时提前拦住，别在后台留一串永远付不掉的待支付单
  if (!wxVirtualPay.isAvailable()) {
    return Promise.reject({
      code: 'VIRTUAL_PAY_UNAVAILABLE',
      message: '当前微信版本不支持虚拟支付，请升级微信后重试'
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

  const order = await addOrder(pkg, channel)
  const payParams = wxVirtualPay.extractPayParams(order)

  if (!payParams) {
    return Promise.reject({
      code: 'ORDER_PAY_PARAMS_MISSING',
      message: '下单成功但未拿到支付参数（signData / paySig / signature），请联系客服',
      data: order
    })
  }

  await wxVirtualPay.requestPayment(payParams)

  const confirmed = await confirmPurchase(payParams, baselineBalance)

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
  RECORD_PAGE_SIZE,
  totalTokensOf,
  unitPriceOf,
  getAccount,
  getPackages,
  getRecords,
  addOrder,
  queryVirtualPayOrder,
  confirmPurchase,
  purchase,
  // 归一函数导出供单测直接验字段映射（String→Number、字段改名这类最容易接错的地方）
  normalizeAccount,
  normalizePackage,
  normalizePurchaseRecord,
  normalizeSpendRecord
}
