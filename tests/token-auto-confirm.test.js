// 「星币不足 → 去充值」直达套餐确认（2026-09-18 产品口径「跳到套餐确认」）。
//
// 链路是两跳：AI 聊天页 `navigateTo('/subpackages/token/index/index?buy=1')`
//   → 星币管理页拉完套餐，自己把确认页推上来。
// 之所以不从聊天页直接跳确认页：确认页要一个具体的 `id`（拿不到就当场「套餐已失效」退回去），
// 而套餐列表在星币管理页拉；这样返回栈里也留着那一页，用户想换一档退一步就能换。
//
// 锁住三件事：
//   ① 带 buy=1 进来，套餐加载完就跳确认页，且跳的是**默认选中那一档**；
//   ② **只跳一次** —— 本页是 onShow 重拉的，不消费掉标记的话，用户从确认页退回来会被又推进去；
//   ③ 没带标记的正常进入不许自己跳走。
const assert = require('node:assert/strict')

const navigations = []
const storage = { token: 'user-token', jwtToken: 'jwt-token' }

global.getCurrentPages = () => []
global.getApp = () => ({ requireLogin: () => true })
global.wx = {
  getStorageSync: key => storage[key],
  getSystemInfoSync: () => ({ language: 'zh_CN', windowWidth: 375, statusBarHeight: 20 }),
  getWindowInfo: () => ({ windowWidth: 375, statusBarHeight: 20, safeArea: { bottom: 812 } }),
  getAppBaseInfo: () => ({ language: 'zh_CN' }),
  getDeviceInfo: () => ({ platform: 'devtools', model: 'test-device' }),
  canIUse: () => true,
  showToast() {},
  hideToast() {},
  showLoading() {},
  hideLoading() {},
  navigateTo: options => navigations.push(options.url)
}

// 三个接口全走桩：本用例验的是页面的跳转时机，不验接口形状（那是 token-pay 的活）
const tokenApi = require('../utils/token-api')
let packagesResult = () =>
  Promise.resolve([
    { id: '1', goodsId: 1, tokens: 100, gift: 0, price: 6, marketAmount: null, currencySymbol: '¥' },
    { id: '2', goodsId: 2, tokens: 300, gift: 30, price: 18, marketAmount: null, currencySymbol: '¥' },
    { id: '3', goodsId: 3, tokens: 600, gift: 90, price: 30, marketAmount: null, currencySymbol: '¥' }
  ])
tokenApi.getPackages = () => packagesResult()
tokenApi.getAccount = () => Promise.resolve({ balance: 0, totalPurchased: 0, totalSpent: 0 })
tokenApi.getAiConfigs = () => Promise.resolve([])

let pageConfig = null
global.Page = config => {
  pageConfig = config
}
require('../subpackages/token/index/index.js')
assert.ok(pageConfig, 'token/index 没有注册 Page')

function applyPath(target, key, value) {
  const tokens = key.match(/[^.[\]]+/g)
  let node = target
  for (let i = 0; i < tokens.length - 1; i += 1) {
    node = node[tokens[i]]
  }
  node[tokens[tokens.length - 1]] = value
}

function createPage(query) {
  const page = Object.create(pageConfig)
  page.data = JSON.parse(JSON.stringify(pageConfig.data))
  page.setData = patch => {
    Object.keys(patch).forEach(key => applyPath(page.data, key, patch[key]))
  }
  pageConfig.onLoad.call(page, query)
  return page
}

;(async () => {
  // ① 带 buy=1：加载完套餐直接进确认页，且带的是默认选中那一档（设计稿高亮的第二档）
  {
    navigations.length = 0
    const page = createPage({ buy: '1' })
    await page.loadPackages()

    assert.equal(page.data.selectedId, '2', '默认选中第二档（有赠送的主推档）')
    assert.deepEqual(
      navigations,
      ['/subpackages/token/confirm/confirm?id=2'],
      '套餐加载完就该进确认页，且带上默认选中那一档的 id'
    )

    // ② 只跳一次：onShow 会反复重拉，第二次不许再把用户推进去
    navigations.length = 0
    await page.loadPackages()
    assert.deepEqual(navigations, [], '从确认页退回来重拉套餐时不许再跳一次')
  }

  // ③ 正常进入（没带标记）不许自己跳走
  {
    navigations.length = 0
    const page = createPage({})
    await page.loadPackages()
    assert.deepEqual(navigations, [], '没有 buy=1 就老老实实停在星币管理页')
  }

  // ④ 套餐拉不到：停在本页（余额和规则表还看得见），且标记要消费掉
  {
    navigations.length = 0
    packagesResult = () => Promise.reject(new Error('network down'))
    const page = createPage({ buy: '1' })
    await page.loadPackages()
    assert.deepEqual(navigations, [], '没套餐可确认时停在本页，不推一个空确认页')

    packagesResult = () =>
      Promise.resolve([
        { id: '9', goodsId: 9, tokens: 100, gift: 0, price: 6, marketAmount: null, currencySymbol: '¥' }
      ])
    await page.loadPackages()
    assert.deepEqual(navigations, [], '标记已消费：下一次重拉成功也不该突然跳走')
  }

  console.log('token auto confirm tests passed')
})().catch(error => {
  console.error(error)
  process.exitCode = 1
})
