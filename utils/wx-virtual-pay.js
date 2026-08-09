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
 * 平铺、包一层都认；额外把 env、offerId、outTradeNo 一并带出来供订单查询与日志使用。
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
    // env 只在我们自己查订单时用（getWxVirtualPayQueryOrder 要传），
    // 支付调用本身不带——它已经在 signData 里了，重复传反而多一个对不上的机会。
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
    return {
      code: 'PAY_CANCELED',
      message: '已取消支付'
    }
  }

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
