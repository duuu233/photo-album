// 微信虚拟支付对接的回归用例（2026-08-08）。
//
// 锁住的是「接错了不会报错、只会算出一个看起来正常的错数字」那几处：
//   ① 后端账户三个字段是 **String**，页面要拿来比大小/算增量 —— 忘了转数字，
//      "1280" > "980" 这种字符串比较能让到账判定直接判反；
//   ② 商品字段名两边完全不同（num/giveNum/amount ↔ tokens/gift/price），映射错了页面照样渲染；
//   ③ 记录分页判停必须优先信 pageCount —— 后端可能无视 pageSize 按自己的默认值分页，
//      只看「返回条数 < 请求条数」会在第一页就停（同 FAQ 翻页的老坑）；
//   ④ 支付签名参数缺失时必须**明确报错**，不能静默拿空串去调 wx.requestVirtualPayment；
//   ⑤ 到账判据只能是「服务端余额变多」，不能是 wx.requestVirtualPayment 的 success 回调。
const assert = require('node:assert/strict')

// —— wx 桩：request 按 URL 路由，虚拟支付按 payQueue 决定成功/失败 ——
const storage = { token: 'user-token', jwtToken: 'jwt-token' }
const routes = {}
const payCalls = []
let payBehavior = null

global.getCurrentPages = () => []
global.getApp = () => null
global.wx = {
  getAccountInfoSync: () => ({ miniProgram: { envVersion: 'release' } }),
  getStorageSync: key => storage[key],
  getDeviceInfo: () => ({ model: 'test-device' }),
  getAppBaseInfo: () => ({ language: 'zh-CN' }),
  canIUse: () => true,
  showToast() {},
  hideToast() {},
  showLoading() {},
  hideLoading() {},
  request(options) {
    const path = String(options.url).replace(/^https?:\/\/[^/]+/, '').split('?')[0]
    const handler = routes[path]
    if (!handler) {
      throw new Error(`用例没有为 ${path} 准备桩数据`)
    }
    const retData = handler(options)
    options.success({ statusCode: 200, data: { retCode: 200, retData } })
  },
  requestVirtualPayment(options) {
    payCalls.push(options)
    if (payBehavior && payBehavior.fail) {
      options.fail(payBehavior.fail)
      return
    }
    options.success({ errMsg: 'requestVirtualPayment:ok' })
  }
}

const tokenApi = require('../utils/token-api')
const wxVirtualPay = require('../utils/wx-virtual-pay')

// 单测把 9.4 秒的到账轮询压成毫秒级
const FAST_DELAYS = [1, 1, 1]

;(async () => {
  // ── ① 账户：String → Number，字段改名 ────────────────────────────────────
  {
    const account = tokenApi.normalizeAccount({
      availableToken: '1280',
      totalToken: '12280',
      consumeToken: '11000'
    })
    assert.deepEqual(account, { balance: 1280, totalPurchased: 12280, totalSpent: 11000 })
    // 必须是数字：字符串比较下 '980' > '1280' 为真，到账判定会判反
    assert.equal(typeof account.balance, 'number')
    // 字段缺失按 0，不能变成 NaN（NaN 会让余额显示成空白）
    assert.deepEqual(tokenApi.normalizeAccount({}), {
      balance: 0,
      totalPurchased: 0,
      totalSpent: 0
    })
    assert.deepEqual(tokenApi.normalizeAccount(null).balance, 0)
  }

  // ── ② 商品映射 + 单价口径 ─────────────────────────────────────────────────
  {
    const pkg = tokenApi.normalizePackage({
      goodsId: 12,
      goodsName: '500 Token',
      num: 500,
      giveNum: 20,
      amount: 199,
      unitPrice: 0,
      wxProductId: 'wx_prod_500',
      appleProductId: 'com.boltfox.token500'
    })
    assert.equal(pkg.id, '12') // 页面比对/URL 传参用字符串
    assert.equal(pkg.goodsId, 12) // 提交 addOrder 用数字
    assert.equal(pkg.tokens, 500)
    assert.equal(pkg.gift, 20)
    assert.equal(pkg.price, 199)
    assert.equal(pkg.wxProductId, 'wx_prod_500')

    // 单价按「含赠送」的总数算，且不受后端 unitPrice:0 影响
    assert.equal(tokenApi.totalTokensOf(pkg), 520)
    assert.equal(tokenApi.unitPriceOf(pkg), '0.38')
  }

  // ── ③ 记录分页：pageCount 优先，缺失时才看条数 ───────────────────────────
  {
    // GET 的业务参数走 wx.request 的 data（url 上只有 request.js 补的公共参数）
    let lastQuery = null
    routes['/Client/Order/getUserAccountTrade'] = options => {
      lastQuery = options.data
      return {
        pageData: [
          {
            joinTime: '2026-05-20 14:30',
            num: 500,
            giveNum: 20,
            amount: '199.00',
            payTypeMsg: '微信支付',
            orderStateMsg: '已完成'
          }
        ],
        pageCount: 3
      }
    }

    const page1 = await tokenApi.getRecords('purchase', { pageIndex: 1, pageSize: 20 })
    assert.equal(lastQuery.inOutType, 1)
    assert.equal(lastQuery.pageIndex, 1)
    assert.equal(lastQuery.pageSize, 20)
    assert.equal(page1.list[0].time, '2026-05-20 14:30')
    assert.equal(page1.list[0].tokens, 500)
    assert.equal(page1.list[0].channel, '微信支付')
    assert.equal(page1.list[0].status, '已完成')
    assert.ok(page1.list[0].id, 'wx:key 需要稳定的 id，后端没给主键就得自己拼')
    // 只回了 1 条（< pageSize 20），但 pageCount=3 说明还有下一页 —— 不能按条数判停
    assert.equal(page1.hasMore, true)

    const page3 = await tokenApi.getRecords('purchase', { pageIndex: 3, pageSize: 20 })
    assert.equal(page3.hasMore, false)

    // 消费侧：inOutType=2，description → scene
    routes['/Client/Order/getUserAccountTrade'] = options => {
      lastQuery = options.data
      return { pageData: [{ joinTime: '2026-05-20 15:42', description: 'AI 生成写实图', num: 10 }] }
    }
    const spend = await tokenApi.getRecords('spend', { pageIndex: 1, pageSize: 20 })
    assert.equal(lastQuery.inOutType, 2)
    assert.equal(spend.list[0].scene, 'AI 生成写实图')
    assert.equal(spend.list[0].tokens, 10)
    // 无分页元数据时退回条数判定：1 条 < 20 → 到底了
    assert.equal(spend.hasMore, false)
  }

  // ── ④ 支付参数解析：平铺 / 包一层都认，缺一个就返回 null ──────────────────
  {
    const signData = '{"offerId":"123","buyQuantity":1,"env":0,"outTradeNo":"NO1"}'

    const flat = wxVirtualPay.extractPayParams({
      orderNo: 'NO1',
      mode: 'short_series_goods',
      env: 0,
      signData,
      paySig: 'a'.repeat(64),
      signature: 'b'.repeat(64)
    })
    assert.equal(flat.signData, signData, 'signData 必须原样透传，重新序列化会导致 -15005')
    assert.equal(flat.mode, 'short_series_goods')
    assert.equal(flat.outTradeNo, 'NO1')

    const nested = wxVirtualPay.extractPayParams({
      orderNo: 'NO2',
      payParams: { signData, paySig: 'a', signature: 'b', env: 1, mode: 'short_series_coin' }
    })
    assert.equal(nested.mode, 'short_series_coin', '服务端说 coin 就传 coin，端上不写死模式')
    assert.equal(nested.env, 1)
    assert.equal(nested.outTradeNo, 'NO2', 'outTradeNo 缺失时回落到订单号，查单要用')

    // mode 非法 → 回落到道具直购，不把脏值透给微信
    assert.equal(
      wxVirtualPay.extractPayParams({ signData, paySig: 'a', signature: 'b', mode: 'x' }).mode,
      'short_series_goods'
    )
    // 少任意一个签名字段 → null（由 token-api 抛 ORDER_PAY_PARAMS_MISSING）
    assert.equal(wxVirtualPay.extractPayParams({ signData, paySig: 'a' }), null)
    assert.equal(wxVirtualPay.extractPayParams({ orderId: 9, orderNo: 'NO3', amount: 199 }), null)
    assert.equal(wxVirtualPay.extractPayParams(null), null)
  }

  // ── 错误码翻译：取消不是故障；未知码原样带出来 ────────────────────────────
  {
    assert.equal(
      wxVirtualPay.describeFail({ errMsg: 'requestVirtualPayment:fail cancel' }).code,
      'PAY_CANCELED'
    )
    assert.match(wxVirtualPay.describeFail({ errCode: -15005 }).message, /签名/)
    // 没把握含义的码不能编中文，必须让用户/客服看得见真实码
    assert.match(wxVirtualPay.describeFail({ errCode: -99999 }).message, /-99999/)
  }

  // ── ⑤ 后端没下发签名参数：明确报错，且**不得**调起微信支付 ────────────────
  {
    routes['/Client/Order/getUserAccount'] = () => ({
      availableToken: '100',
      totalToken: '100',
      consumeToken: '0'
    })
    routes['/Client/Order/addOrder'] = () => ({ orderId: 1, orderNo: 'NO_SIGN', amount: 199 })

    payCalls.length = 0
    await assert.rejects(
      () => tokenApi.purchase({ goodsId: 12, id: '12' }, 'wechat'),
      error => error.code === 'ORDER_PAY_PARAMS_MISSING'
    )
    assert.equal(payCalls.length, 0, '拿不到签名参数就不能去调 wx.requestVirtualPayment')
  }

  // ── ⑤ 到账判据 = 服务端余额变多，不是 success 回调 ────────────────────────
  {
    const signData = '{"outTradeNo":"NO9"}'
    let balance = 100
    routes['/Client/Order/getUserAccount'] = () => ({
      availableToken: String(balance),
      totalToken: '600',
      consumeToken: '0'
    })
    routes['/Client/Order/addOrder'] = () => ({
      orderId: 9,
      orderNo: 'NO9',
      amount: 199,
      payParams: { signData, paySig: 'sig', signature: 'usersig', env: 0 }
    })

    // 支付成功但后端回调还没到 → 余额没变 → pending，绝不能报「已到账」
    payCalls.length = 0
    payBehavior = null
    const pendingResult = await tokenApi.confirmPurchase({ outTradeNo: 'NO9', env: 0 }, 100, FAST_DELAYS)
    assert.equal(pendingResult.pending, true)
    assert.equal(pendingResult.gained, null)

    // 回调到了、余额涨了 → 报出真实增量
    balance = 620
    const doneResult = await tokenApi.confirmPurchase({ outTradeNo: 'NO9', env: 0 }, 100, FAST_DELAYS)
    assert.equal(doneResult.pending, false)
    assert.equal(doneResult.gained, 520)

    // 整条链路：建单 → 拉起支付 → 确认。支付调用只带微信文档列出的四个参数
    balance = 100
    setTimeout(() => { balance = 620 }, 5)
    const bought = await tokenApi.purchase({ goodsId: 12, id: '12' }, 'wechat')
    assert.equal(payCalls.length, 1)
    assert.equal(payCalls[0].signData, signData)
    assert.equal(payCalls[0].mode, 'short_series_goods')
    assert.equal(payCalls[0].env, undefined, 'env 已在 signData 里，端上不再平铺一份')
    assert.equal(bought.orderNo, 'NO9')
    assert.equal(bought.gained, 520)
  }

  // ── 用户取消 → PAY_CANCELED，不能被当成购买失败 ───────────────────────────
  {
    payBehavior = { fail: { errMsg: 'requestVirtualPayment:fail cancel' } }
    await assert.rejects(
      () => tokenApi.purchase({ goodsId: 12, id: '12' }, 'wechat'),
      error => error.code === 'PAY_CANCELED'
    )
    payBehavior = null
  }

  // ── PayPal 仍未接入：明确 reject，不能悄悄走微信 ───────────────────────────
  {
    payCalls.length = 0
    await assert.rejects(
      () => tokenApi.purchase({ goodsId: 12, id: '12' }, 'paypal'),
      error => error.code === 'PAYPAL_UNAVAILABLE'
    )
    assert.equal(payCalls.length, 0)
  }

  console.log('token-pay: 全部用例通过')
})()
