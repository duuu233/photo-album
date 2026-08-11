// AI 模块 Token 余额接入真实账户的回归用例（2026-08-11 接口对账）。
//
// 锁住的是「接错了页面照样渲染、只是数字是假的/错的」那几处：
//   ① `availableToken` 是 **String**，且要区分「后端没下发该字段」(null) 与「余额真的是 0」——
//      混在一起要么白多打一次 getUserAccount，要么把 0 显示成上一次的旧余额；
//   ② 余额未知时显示 '--'，**不能**用 0 兜底：有余额的用户看到「0 Token」会以为不能用了；
//   ③ 端上**不得**自己扣费：swagger 的 /Client/Order 下没有「消费 Token」端点，
//      扣费在服务端发生，端上再减一次就是双重记账（本用例断言模块不再导出 spend）。
const assert = require('node:assert/strict')

const storage = { token: 'user-token', jwtToken: 'jwt-token' }
const routes = {}
let globalUserInfo = null

global.getCurrentPages = () => []
global.getApp = () => ({ globalData: { userInfo: globalUserInfo } })
global.wx = {
  getStorageSync: key => storage[key],
  getDeviceInfo: () => ({ model: 'test-device' }),
  getAppBaseInfo: () => ({ language: 'zh-CN' }),
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
    options.success({ statusCode: 200, data: { retCode: 200, retData: handler(options) } })
  }
}

const aiToken = require('../utils/ai-token')
const api = require('../utils/api')

;(async () => {
  // ── ① 用户信息里的 availableToken：String → Number，缺失 → null（不是 0）────
  {
    const withBalance = api.normalizeUserProfile
      ? api.normalizeUserProfile({ availableToken: '1280' })
      : null
    // normalizeUserProfile 未导出时改走 getUserProfile 这条真实链路
    if (withBalance) {
      assert.equal(withBalance.availableToken, 1280)
    }

    routes['/Client/User/getUserInfo'] = () => ({ nickName: '甲', availableToken: '0' })
    const zero = await api.getUserProfile()
    assert.equal(zero.availableToken, 0, '余额真的是 0 时必须是数字 0，不能变成 null')

    routes['/Client/User/getUserInfo'] = () => ({ nickName: '甲' })
    const missing = await api.getUserProfile()
    assert.equal(missing.availableToken, null, '后端没下发该字段时必须是 null，调用方据此回退')
  }

  // ── ② 登录会话里的缓存余额 + 显示口径 ────────────────────────────────────
  {
    globalUserInfo = { availableToken: '360' }
    assert.equal(aiToken.cachedBalance(), 360)
    assert.equal(aiToken.displayBalance(360), '360')

    globalUserInfo = { availableToken: '0' }
    assert.equal(aiToken.cachedBalance(), 0)
    assert.equal(aiToken.displayBalance(0), '0', '0 是真实状态，要如实显示')

    globalUserInfo = null
    assert.equal(aiToken.cachedBalance(), aiToken.UNKNOWN_BALANCE)
    assert.equal(aiToken.displayBalance(aiToken.UNKNOWN_BALANCE), '--', '未知余额显示 --，不是 0')
  }

  // ── ③ 权威余额取账户接口；账户接口挂了回退用户信息接口 ────────────────────
  {
    routes['/Client/Order/getUserAccount'] = () => ({
      availableToken: '980',
      totalToken: '1000',
      consumeToken: '20'
    })
    assert.equal(await aiToken.fetchBalance(), 980)

    routes['/Client/Order/getUserAccount'] = () => {
      throw new Error('boom')
    }
    routes['/Client/User/getUserInfo'] = () => ({ availableToken: '77' })
    assert.equal(await aiToken.fetchBalance(), 77, '账户接口挂了要回退用户信息接口')

    routes['/Client/User/getUserInfo'] = () => {
      throw new Error('boom')
    }
    assert.equal(
      await aiToken.fetchBalance(),
      aiToken.UNKNOWN_BALANCE,
      '两条都挂了返回未知，页面保持原样，不弹错误也不清零'
    )
  }

  // ── ④ 拦截口径：开关关着一律放行；余额未知也放行（不能因为读不到就锁死功能）──
  {
    assert.equal(aiToken.LIMIT_ENABLED, false, '扣费口径与网关谈定前，拦截保持关闭')
    assert.equal(aiToken.hasBalance(0), true)
    assert.equal(aiToken.hasBalance(aiToken.UNKNOWN_BALANCE), true)
  }

  // ── ⑤ 端上不得扣费：spend 必须已经下线 ──────────────────────────────────
  {
    assert.equal(
      typeof aiToken.spend,
      'undefined',
      '扣费在服务端（swagger 无消费端点），端上再扣一次就是双重记账'
    )
  }

  console.log('ai-token-balance: 全部用例通过')
})()
