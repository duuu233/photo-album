// 微信小程序「虚拟支付」调用层。
// 文档：https://developers.weixin.qq.com/miniprogram/dev/api/payment/wx.requestVirtualPayment.html
//
// 本模块只做三件事：可用性判断、把**服务端签好的**参数原样透传给 wx.requestVirtualPayment、
// 把微信的错误码翻成能给用户看的话。业务侧的下单、到账确认在 utils/token-api.js，
// 换商品体系/换支付方式时不用动这里。
//
// ⚠️ 签名参数只能由服务端产出，客户端不参与、也无法参与：
//     paySig    = hex(hmac_sha256(虚拟支付 appKey, 'requestVirtualPayment&' + signData))
//     signature = hex(hmac_sha256(session_key,     signData))
//   appKey 是小程序后台「虚拟支付」里的密钥、session_key 来自 code2session，两者都是服务端秘密。
//   放到端上等于把支付签名交给任何人伪造，所以这里**不拼 signData、不算签名**，只做搬运。
//
// ⚠️ signData 必须与服务端签名时用的字符串**逐字节一致**。服务端返回字符串就原样传；
//   只返回对象时本模块会本地 JSON.stringify 兜底，但键顺序/空格但凡有一点出入微信就回 -15005，
//   所以正确做法是让服务端直接把「它签过的那个字符串」返回给端上（见 normalizeSignData）。
//
// 名词对照（后端 swagger ↔ 微信）：商品的 `wxProductId` 就是 signData 里的 `productId`
//（米大师侧的道具 id），订单的 `orderNo` 就是 signData 里的 `outTradeNo`。两者都由服务端
// 填进 signData 并签名，客户端读到的同名字段仅供日志/校验，不参与支付调用。

// 支付模式。goods=道具直购（选套餐直接付钱，微信支付成功后回调我们发货）；
// coin=代币充值（先充米大师代币，再由服务端调 setWxVirtualPay 扣减）。
// 后端 swagger 两套都有实现，所以这里**不写死**，以服务端返回的 mode 为准，缺省按 goods。
const MODE_GOODS = 'short_series_goods'
const MODE_COIN = 'short_series_coin'
const SUPPORTED_MODES = [MODE_GOODS, MODE_COIN]

// 服务端可能把支付参数平铺在下单响应里，也可能包一层。联调期两种都认，省得为了一个
// 字段位置来回改端上（真正缺参数时下面会给出明确报错，不会静默走空）。
const PAY_BUNDLE_KEYS = [
  'payParams',
  'payParam',
  'payData',
  'wxPayParams',
  'virtualPay',
  'wxVirtualPay',
  'virtualPayParams'
]

// 已确认含义的微信错误码。没把握的一律不猜，走 fallback 原样带上 errCode/errMsg——
// 联调期看得见真实码比看一句编出来的中文有用得多。
const ERROR_MESSAGES = {
  1001: '支付参数有误，请联系客服（signData 字段不合法）',
  '-15005': '支付签名校验失败，请联系客服（服务端 paySig/signature 与 signData 不匹配）'
}

// 排查提示，**只进控制台、不进弹窗文案**（2026-08-12）。
// 这些含义来自微信开放社区的帖子整理而非官方错误码表，把握不到 ERROR_MESSAGES 的程度：
// 写进弹窗会把用户和客服按一个可能错的方向带偏，而打在日志里，开发看着它去查、查错了也只损失自己几分钟。
// 弹窗仍然走「原样带上 errCode」的老口径（见文件头第 4 条「错误码不猜」）。
//
// ⚠️ 先按 errMsg 认，再退回按 errCode 认 —— **一个码对应多种原因**，这是踩过的坑：
// 真机报 `-15001 INVALID_PLATFORM`（iOS 未启用苹果 IAP），而按码查表得到的却是
// 「productId 为空」，整整往错的方向查了一轮。errMsg 才是微信真正想说的那句话。
const ERROR_MSG_HINTS = [
  {
    keyword: 'INVALID_PLATFORM',
    hint: '当前平台不允许虚拟支付：iPhone 需要先在「小程序后台 → 微信虚拟支付 → 基本配置 → 启用苹果 IAP 支付」，安卓不需要这一步。与 signData、签名都无关——换台安卓机试，能过就实锤是它'
  },
  {
    keyword: 'PRODUCT_ID_EMPTY',
    hint: 'signData.productId 为空：后端商品没配 wxProductId'
  },
  {
    keyword: 'PAY_SIG_INVALID',
    hint: 'paySig（appKey 签的）不对，核对是否漏了 "requestVirtualPayment&" 前缀'
  },
  {
    keyword: 'SIGNATURE_INVALID',
    hint: 'signature（session_key 签的）与 signData 不匹配：多半是 signData 被重新序列化过，或 session_key 已过期'
  },
  {
    keyword: 'no permission',
    hint: '基础库版本过低（虚拟支付要求 ≥ 2.19.2），或该小程序未开通虚拟支付'
  }
]

const ERROR_CODE_HINTS = {
  '-15001': '参数不合法（**具体原因看 errMsg**：INVALID_PLATFORM=平台未开通、PRODUCT_ID_EMPTY=道具 id 为空…）。不是签名问题，签名是 -15005/-15006',
  '-15002': 'outTradeNo 重复：后端换个新单号重试',
  '-15003': '微信侧系统错误：可重试，连续复现找微信',
  '-15005': '签名校验失败：signature 与 signData 不匹配',
  '-15006': 'PAY_SIG_INVALID：paySig 不对',
  '-15007': 'session_key 过期：需要用户重新 wx.login，后端刷新后再签',
  '-15008': '二级商户进件未完成：小程序后台侧配置，端上无解',
  '-15009': '代币未发布（coin 模式）',
  '-15010': '道具 productId 未发布：在虚拟支付后台把这个道具发布掉；注意沙箱(env=1)与正式(env=0)是两套'
}

function hintOf(rawCode, errMsg) {
  const text = String(errMsg || '')
  for (let i = 0; i < ERROR_MSG_HINTS.length; i++) {
    if (text.indexOf(ERROR_MSG_HINTS[i].keyword) !== -1) {
      return ERROR_MSG_HINTS[i].hint
    }
  }
  return ERROR_CODE_HINTS[String(rawCode)] || ''
}

// 运行平台。虚拟支付在 iOS / 安卓上的开通条件不同（iOS 要单独启用苹果 IAP），
// 出错时不知道跑在哪个平台等于少一半线索。getDeviceInfo 是 2.20.1+，旧库退回 getSystemInfoSync。
function currentPlatform() {
  try {
    if (typeof wx.getDeviceInfo === 'function') {
      return (wx.getDeviceInfo() || {}).platform || ''
    }
    if (typeof wx.getSystemInfoSync === 'function') {
      return (wx.getSystemInfoSync() || {}).platform || ''
    }
  } catch (error) {
    // 取不到就算了，只是日志里少一个字段
  }
  return ''
}

// signData 里最容易签错的几个字段。同样**只提示不拦截**：端上无权判定后端签了什么才算对，
// 猜错了直接拦住比放过去更糟——用户连微信的真实错误码都看不到，排查线索反而少一条。
const SIGN_DATA_CHECKS = [
  {
    key: 'productId',
    bad: value => !value,
    hint: 'productId 为空 → 真机稳定回 -15001（后端商品的 wxProductId 没配）'
  },
  {
    key: 'offerId',
    bad: value => !value,
    hint: 'offerId 为空 → 米大师应用 id 没填。注意它不是小程序 appid'
  },
  {
    key: 'goodsPrice',
    bad: value => typeof value !== 'number' || !(value > 0) || value % 1 !== 0,
    hint: 'goodsPrice 必须是**分**为单位的正整数：传「元」、传字符串都会被判参数不合法'
  },
  {
    key: 'buyQuantity',
    bad: value => !(Number(value) > 0),
    hint: 'buyQuantity 缺失或非正数'
  },
  {
    key: 'outTradeNo',
    bad: value => !value,
    hint: 'outTradeNo 为空 → 微信侧无从幂等，重复下单会撞 -15002'
  },
  {
    key: 'currencyType',
    bad: value => value !== 'CNY',
    hint: "currencyType 通常应为 'CNY'"
  }
]

// paySig / signature 是 HMAC 结果不是密钥，但也没有全量打印的必要：前 8 位 + 长度足够和后端对账
function digest(value) {
  const text = String(value || '')
  return text ? `${text.slice(0, 8)}…(共${text.length}位)` : '(空)'
}

/**
 * 调起前把参数打全（2026-08-12 加，起因是真机一直 -15001 而端上什么都看不到）。
 *
 * `signData` 打的是**原文**，且这么做是安全的：它是被签名的明文（道具 id / 订单号 / 价格 / env），
 * 里面没有 appKey 也没有 session_key。必须打原文而不是打解析后的对象——签名是对这个字符串
 * 逐字节算的，键顺序、空格差一点就是 -15005，那种差异只有看原文才看得出来。
 */
function logPayParams(params) {
  const raw = params.signData
  const platform = currentPlatform()
  console.log('[虚拟支付] 调起 wx.requestVirtualPayment', {
    平台: platform || '(未知)',
    mode: params.mode,
    'signData(原文)': raw,
    'signData(字节数)': raw.length,
    paySig: digest(params.paySig),
    signature: digest(params.signature)
  })
  if (platform === 'ios') {
    console.warn(
      '[虚拟支付] ⚠️ 当前是 iOS：虚拟支付要求先在「小程序后台 → 微信虚拟支付 → 基本配置」启用苹果 IAP 支付，' +
        '未启用时无论参数多正确都会回 -15001 INVALID_PLATFORM（安卓无此限制）'
    )
  }

  let parsed = null
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    console.warn('[虚拟支付] signData 不是合法 JSON，无法逐字段核对（微信侧同样会判参数不合法）')
    return
  }

  console.log('[虚拟支付] signData 字段', {
    offerId: parsed.offerId,
    productId: parsed.productId,
    outTradeNo: parsed.outTradeNo,
    // 带上类型：goodsPrice 传成字符串或「元」是 -15001 的常见成因，只看数值看不出来
    goodsPrice: `${parsed.goodsPrice}（${typeof parsed.goodsPrice}）`,
    buyQuantity: parsed.buyQuantity,
    env: `${parsed.env}（${Number(parsed.env) === 1 ? '沙箱' : '正式'}）`,
    currencyType: parsed.currencyType,
    attach: parsed.attach
  })

  SIGN_DATA_CHECKS.forEach(check => {
    if (check.bad(parsed[check.key])) {
      console.warn(`[虚拟支付] ⚠️ signData.${check.key} 可疑：${check.hint}`, {
        实际值: parsed[check.key]
      })
    }
  })
}

function isAvailable() {
  try {
    if (typeof wx === 'undefined' || typeof wx.requestVirtualPayment !== 'function') {
      return false
    }
    // canIUse 在旧基础库上可能没有该条目，取不到就以函数存在为准
    if (typeof wx.canIUse === 'function') {
      return wx.canIUse('requestVirtualPayment') !== false
    }
    return true
  } catch (error) {
    return false
  }
}

/**
 * signData 归一：优先原样透传服务端给的字符串（签名就是对它算的）。
 * 只拿到对象时本地序列化兜底，并留一条 warn —— 这条日志出现在真机上，
 * 十有八九下一步就是 -15005，直接指向「让后端返回字符串」这个修法。
 */
function normalizeSignData(value) {
  if (typeof value === 'string') {
    return value
  }
  if (value && typeof value === 'object') {
    console.warn(
      '[虚拟支付] 服务端返回的是 signData 对象而非字符串，端上序列化的结果可能与签名时不一致（易报 -15005）'
    )
    try {
      return JSON.stringify(value)
    } catch (error) {
      return ''
    }
  }
  return ''
}

/**
 * 从下单响应里取出虚拟支付四件套（mode / signData / paySig / signature）。
 * 平铺、包一层都认；额外把 env、offerId、outTradeNo 一并带出来供日志/排查使用。
 * @returns {object|null} 参数不全时返回 null，由调用方给出「后端未下发支付参数」的明确报错
 */
function extractPayParams(source) {
  if (!source || typeof source !== 'object') {
    return null
  }

  const candidates = [source]
  PAY_BUNDLE_KEYS.forEach(key => {
    if (source[key] && typeof source[key] === 'object') {
      candidates.push(source[key])
    }
  })

  for (let i = 0; i < candidates.length; i++) {
    const item = candidates[i]
    const signData = normalizeSignData(item.signData)
    const paySig = item.paySig || ''
    const signature = item.signature || ''

    if (!signData || !paySig || !signature) {
      continue
    }

    const mode = SUPPORTED_MODES.indexOf(item.mode) === -1 ? MODE_GOODS : item.mode
    // env 现在只留作日志/排查线索：支付调用本身不带（它已经在 signData 里了，重复传反而
    // 多一个对不上的机会），查单也不再需要它——`/Client/Pay/getPayQuery` 只收
    // `payType` + `orderNo`（我们平台的订单号），旧的 `getWxVirtualPayQueryOrder` 已下线。
    const env = Number(item.env) === 1 ? 1 : 0

    return {
      mode,
      env,
      signData,
      paySig,
      signature,
      offerId: item.offerId || '',
      outTradeNo: item.outTradeNo || source.outTradeNo || source.orderNo || ''
    }
  }

  return null
}

// wx.requestVirtualPayment 的 fail 回调 → 统一的业务错误对象
function describeFail(error) {
  const errMsg = String((error && error.errMsg) || '')
  const rawCode =
    error && error.errCode !== undefined
      ? error.errCode
      : error && error.errno !== undefined
        ? error.errno
        : ''

  // 用户主动取消不是故障：调用方据此只关掉 loading、不弹「支付失败」
  if (/cancel/i.test(errMsg)) {
    console.log('[虚拟支付] 用户取消支付', { errMsg })
    return {
      code: 'PAY_CANCELED',
      message: '已取消支付'
    }
  }

  console.warn('[虚拟支付] 支付失败', {
    平台: currentPlatform() || '(未知)',
    errCode: rawCode === '' ? '(微信未给码)' : rawCode,
    errMsg,
    排查提示: hintOf(rawCode, errMsg) || '(无对照，把上面这行连同 signData 一起发后端核对)',
    原始错误: error
  })

  const known = ERROR_MESSAGES[String(rawCode)]
  return {
    code: rawCode === '' ? 'PAY_FAILED' : rawCode,
    // 未知码原样带上 errCode 与 errMsg：这条会进弹窗，联调时用户截个图就能定位
    message: known || `支付失败（${rawCode === '' ? errMsg || '未知错误' : rawCode}）`,
    errMsg
  }
}

/**
 * 拉起虚拟支付。
 *
 * ⚠️ resolve 只代表**微信客户端回了成功**，属于弱确认：微信异常退出、回调丢失都可能让它不来，
 *    反过来它来了也不等于我们后台已经发货。到账与否一律以服务端为准
 *    （见 utils/token-api.js 的 confirmPurchase：轮询余额 + 兜底查订单）。
 *
 * @param {object} params extractPayParams 的产物
 */
function requestPayment(params) {
  return new Promise((resolve, reject) => {
    if (!isAvailable()) {
      reject({
        code: 'VIRTUAL_PAY_UNAVAILABLE',
        message: '当前微信版本不支持虚拟支付，请升级微信后重试'
      })
      return
    }

    if (!params || !params.signData || !params.paySig || !params.signature) {
      reject({
        code: 'PAY_PARAMS_MISSING',
        message: '支付参数不完整，请稍后重试'
      })
      return
    }

    logPayParams(params)

    // 只传微信文档列出的四个参数。env/offerId 都在 signData 里，端上再平铺一份没有意义，
    // 还多一处能和签名内容对不上的地方。
    wx.requestVirtualPayment({
      mode: params.mode,
      signData: params.signData,
      paySig: params.paySig,
      signature: params.signature,
      success: resolve,
      fail: error => reject(describeFail(error))
    })
  })
}

module.exports = {
  MODE_GOODS,
  MODE_COIN,
  isAvailable,
  extractPayParams,
  requestPayment,
  // 导出供单测直接验错误码翻译，不必去 mock 整个 wx.requestVirtualPayment
  describeFail
}
