// 虚拟支付的「金额自检」回归用例（2026-09-18）。
//
// 起因：线上 79.99 元的套餐拉起支付稳定回 **-15013（goodsPrice 道具价格错误）**，
// 而 1 元和 298.99 元都付得掉。三条数据一起指向服务端把「元」转「分」时用了截断：
//   79.99 * 100 = 7998.999999999999 → 截断 7998（少 1 分）
//   298.99 * 100 = 29899.000000000004 → 截断 29899（正好对）
//   1.00 * 100 = 100（对）
// 少 1 分的价格与微信后台该道具配置的价格对不上，微信就回 -15013。
//
// 客户端不产出 goodsPrice（只发 goodsId + payType，签名全在服务端），所以这里**不修价格**，
// 锁的是「下次再发生时，端上一眼能看出是谁的问题」：
//   ① extractPayParams 必须把我们平台订单的 amount（元）带出来；
//   ② 调起前把 amount×100 与签进 signData 的 goodsPrice（分）对一次账，不一致要 warn；
//   ③ -15013 要有能给用户看的话，而不是甩一个裸错误码。
const assert = require('node:assert/strict')

global.wx = {
  canIUse: () => true,
  getSystemInfoSync: () => ({ platform: 'android', system: 'Android 13', version: '8.0.60', SDKVersion: '3.0.0' }),
  getDeviceInfo: () => ({ platform: 'android', system: 'Android 13' }),
  getAppBaseInfo: () => ({ version: '8.0.60', SDKVersion: '3.0.0' }),
  requestVirtualPayment(options) {
    options.success({ errMsg: 'requestVirtualPayment:ok' })
  }
}

const wxVirtualPay = require('../utils/wx-virtual-pay')

// 造一份「服务端签好的」下单响应。cents 就是服务端签进 signData 的 goodsPrice。
function orderOf(amountYuan, cents) {
  const signData = JSON.stringify({
    offerId: '1450000000',
    productId: 'sku_79_99',
    outTradeNo: 'NO202609180001',
    goodsPrice: cents,
    buyQuantity: 1,
    env: 0,
    currencyType: 'CNY'
  })
  return {
    orderNo: 'NO202609180001',
    amount: amountYuan,
    signData,
    paySig: 'a'.repeat(64),
    signature: 'b'.repeat(64)
  }
}

// 抓一次调用里所有 console.log / console.warn 的文本
async function captureLogs(run) {
  const lines = []
  const rawLog = console.log
  const rawWarn = console.warn
  const collect = (...args) => lines.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
  console.log = collect
  console.warn = collect
  try {
    await run()
  } finally {
    console.log = rawLog
    console.warn = rawWarn
  }
  return lines.join('\n')
}

;(async () => {
  // ── ① 订单金额要带得出来，否则端上无从比对 ──────────────────────────
  {
    const params = wxVirtualPay.extractPayParams(orderOf(79.99, 7999))
    assert.ok(params, 'extractPayParams 应当取到支付参数')
    assert.equal(params.amount, 79.99, 'amount（元）必须带出来，供金额自检用')
  }

  // ── ② 少 1 分：必须 warn，并且点名 -15013 ───────────────────────────
  {
    // 7998 正是 (int)(79.99 * 100) 的结果，也就是线上那笔失败订单的形态
    const params = wxVirtualPay.extractPayParams(orderOf(79.99, 7998))
    const logs = await captureLogs(() => wxVirtualPay.requestPayment(params))
    assert.match(logs, /金额自检不一致/, '金额对不上时必须给出自检告警')
    assert.match(logs, /7999/, '告警要写出「应为」的分数，否则还得自己算')
    assert.match(logs, /7998/, '告警要写出实际签进去的分数')
    assert.match(logs, /-15013/, '告警要点名对应的微信错误码，省得再去查表')
  }

  // ── ③ 金额一致时不要误报 ───────────────────────────────────────────
  {
    const params = wxVirtualPay.extractPayParams(orderOf(79.99, 7999))
    const logs = await captureLogs(() => wxVirtualPay.requestPayment(params))
    assert.doesNotMatch(logs, /金额自检不一致/, '金额一致时不应告警')
    assert.match(logs, /金额自检通过/, '一致时也要留一行，方便确认这条自检确实跑了')
  }

  // ── ④ 298.99 元（线上付得掉的那个）同样不该误报 ─────────────────────
  {
    const params = wxVirtualPay.extractPayParams(orderOf(298.99, 29899))
    const logs = await captureLogs(() => wxVirtualPay.requestPayment(params))
    assert.doesNotMatch(logs, /金额自检不一致/, '298.99 元 → 29899 分是对的，不能误报')
  }

  // ── ⑤ -15013 要有给用户看的话 ──────────────────────────────────────
  {
    const described = wxVirtualPay.describeFail({
      errCode: -15013,
      errMsg: 'requestVirtualPayment:fail'
    })
    assert.equal(described.code, -15013)
    assert.match(described.message, /价格/, '-15013 的文案要说清是价格问题，不能只甩错误码')
    assert.doesNotMatch(described.message, /^支付失败（-15013）$/, '不能退回到 fallback 文案')
  }

  console.log('virtual-pay-amount-guard: 全部用例通过')
})().catch(error => {
  console.error(error)
  process.exit(1)
})
