// WiFi 版设备分享·简化版（2026-10-29，服务端新增 getUserInfo.userId、addUserProduct.isToHave / shareUserId）：
//   ① 卡片路径：设备号 / 产品 / 所有者 userId / 设备名 / 昵称来回编解码；缺项或格式不对视为无效；
//   ② 接口：个人信息读出 userId（与展示用的 userNo 分开）；自己绑定默认 isToHave=1、shareUserId=0；
//      接受分享 isToHave=0、shareUserId=所有者；移除成员调 delUserProduct（成员那条 userProductId）；
//   ③ 接受页：自己分享的不接受；已在列表直接进详情；否则接受后进详情；未登录先记下卡片再去登录；
//   ④ 分享列表：能分享时卡片路径指向接受页，拿不到 userId 退回首页卡片；仅开发版能复制卡片参数；
//   ⑤ 登录页：登录成功后回接受页；页面已注册。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const root = path.join(__dirname, '..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')
const share = require('../utils/wifi-share')
const api = require('../utils/api')
const http = require('../utils/request')

let checks = 0
function checked(name) { checks++; console.log('PASS ' + name) }

function loadPage(file, modules, globals) {
  let definition
  vm.runInNewContext(read(file), Object.assign({
    require: target => modules[target.split('/').at(-1)],
    Page: value => { definition = value },
    setTimeout: fn => { fn(); return 0 },
    console: { log() {}, warn() {} }
  }, globals), { filename: file })
  const page = { ...definition, data: JSON.parse(JSON.stringify(definition.data)), setData(values) { Object.assign(this.data, values) } }
  return page
}

async function main() {
  {
    const p = share.buildAcceptPath({ deviceId: 'E3:48:C2:1E:D4:28', productId: 12, ownerUserId: 34, deviceName: '客厅 相框&1', ownerName: '小明' })
    assert.ok(p.indexOf(share.ACCEPT_PAGE + '?') === 0)
    const query = {}
    p.split('?')[1].split('&').forEach(pair => { const [k, v] = pair.split('='); query[k] = v })
    const info = share.parseAcceptQuery(query)
    assert.deepEqual(info, { deviceId: 'E3:48:C2:1E:D4:28', productId: '12', ownerUserId: '34', deviceName: '客厅 相框&1', ownerName: '小明' }, '编码后的参数能原样解回')
    assert.equal(share.parseAcceptQuery({ d: 'E3:48:C2:1E:D4:28', p: '12', u: '34' }).deviceName, '智能相框', '没带设备名用默认')
    assert.equal(share.parseAcceptQuery({ d: 'X', p: '12' }), null, '缺所有者无效')
    assert.equal(share.parseAcceptQuery({ d: 'X', p: 'abc', u: '34' }), null, '产品 ID 非数字无效')
    assert.equal(share.parseAcceptQuery({}), null)
    const found = share.findBound([{ id: '1', productDeviceId: 'AA:BB:CC:DD:EE:FF' }, { id: '2', productDeviceId: 'E3:48:C2:1E:D4:28' }], 'e348c21ed428')
    assert.equal(found.id, '2', '按设备号去冒号比较')
    checked('卡片路径编解码与已绑定判断')
  }
  {
    const posts = []
    const originalPost = http.post
    const originalGet = http.get
    try {
      http.post = (url, data, options) => { posts.push({ url, data, options }); return Promise.resolve({}) }
      http.get = () => Promise.resolve({ userId: 34, userNo: 'U0034', nickName: '小明' })
      const user = await api.getUserProfile()
      assert.equal(user.userId, 34, '读出数字 userId')
      assert.equal(user.userNo, 'U0034', '展示用编号不变')
      await api.addUserProduct({ productId: 1, productName: 'A', deviceId: 'e348c21ed428' })
      assert.equal(posts[0].data.isToHave, 1, '自己绑定默认所有者')
      assert.equal(posts[0].data.shareUserId, 0)
      await api.acceptSharedDevice({ productId: 12, productName: '相框', deviceId: 'E3:48:C2:1E:D4:28', shareUserId: 34 })
      assert.equal(posts[1].url, '/Client/UserProduct/addUserProduct')
      assert.deepEqual([posts[1].data.isToHave, posts[1].data.shareUserId, posts[1].data.deviceId], [0, 34, 'E3:48:C2:1E:D4:28'], '接受分享 = 非所有者 + 分享者')
      await api.removeShareUser('77')
      assert.deepEqual([posts[2].url, posts[2].data], ['/Client/UserProduct/delUserProduct', { id: '77' }], '移除成员删成员那条记录')
    } finally {
      http.post = originalPost
      http.get = originalGet
    }
    assert.ok(/isToHave: 1, shareUserId: 0/.test(read('utils/api.js').split('async bindWifiDevice')[1]), '配网绑定也传所有者')
    checked('接口参数')
  }
  {
    const state = { navs: [], toasts: [], storage: {}, adds: [], devices: [], user: { userId: 99 }, login: 0 }
    const app = { globalData: { token: 't', jwtToken: 'j' }, requireLogin() { state.login++; return false } }
    const modules = {
      api: {
        getUserProfile: async () => state.user,
        getDevices: async () => state.devices,
        acceptSharedDevice: async payload => { state.adds.push(JSON.parse(JSON.stringify(payload))); state.devices = [{ id: '501', productDeviceId: 'E3:48:C2:1E:D4:28' }] }
      },
      toast: { show: value => state.toasts.push(value.title) },
      system: { getLayoutMetrics: () => ({}) },
      'fold-adapt': { adapt: value => value },
      'wifi-share': share
    }
    const wx = {
      getStorageSync: key => state.storage[key],
      setStorageSync: (key, value) => { state.storage[key] = value },
      redirectTo: options => state.navs.push(options.url),
      switchTab: options => state.navs.push(options.url)
    }
    const make = () => loadPage('subpackages/device/wifi-share-accept/wifi-share-accept.js', modules, { getApp: () => app, wx })
    const options = { d: encodeURIComponent('E3:48:C2:1E:D4:28'), p: '12', u: '34', n: encodeURIComponent('客厅相框') }

    let page = make()
    page.onLoad(options)
    page.onShow()
    await page.accept()
    assert.deepEqual(state.adds, [{ productId: 12, productName: '客厅相框', deviceId: 'E3:48:C2:1E:D4:28', shareUserId: 34 }])
    assert.deepEqual(state.navs, ['/subpackages/device/wifi-detail/wifi-detail?id=501'], '接受后进 WiFi 详情')

    state.navs.length = 0
    state.adds.length = 0
    page = make()
    page.onLoad(options)
    page.onShow()
    await page.accept()
    assert.equal(state.adds.length, 0, '已在列表不重复绑定')
    assert.deepEqual(state.navs, ['/subpackages/device/wifi-detail/wifi-detail?id=501'])

    state.user = { userId: 34 }
    state.devices = []
    state.toasts.length = 0
    page = make()
    page.onLoad(options)
    page.onShow()
    await page.accept()
    assert.equal(state.adds.length, 0)
    assert.deepEqual(state.toasts, ['这是你分享出去的设备'], '自己分享的不接受')

    app.globalData = {}
    page = make()
    page.onLoad(options)
    page.onShow()
    assert.equal(page.data.loggedIn, false)
    await page.accept()
    assert.equal(state.login, 1, '未登录去登录')
    assert.ok(state.storage[share.PENDING_KEY].path.indexOf(share.ACCEPT_PAGE + '?') === 0, '记下卡片，登录后回来')

    page = make()
    page.onLoad({ d: 'X' })
    assert.equal(page.data.invalid, true, '参数不全显示无效')
    checked('接受页')
  }
  {
    const user = { userId: 34, nickName: '小明' }
    const device = { id: '7', userProductId: 7, productId: 12, productDeviceId: 'E3:48:C2:1E:D4:28', name: '客厅相框' }
    let devEnv = true
    const clips = []
    const modules = {
      api: { getDeviceDetail: async () => device, getShareUsers: async () => [{ userProductId: 7, userName: '小明', isToHave: 1 }], getUserProfile: async () => user },
      toast: { show() {} },
      system: { getLayoutMetrics: () => ({}), isDevEnv: () => devEnv },
      'fold-adapt': { adapt: value => value },
      'wifi-share': share
    }
    const wx = { setClipboardData: options => clips.push(options.data) }
    let page = loadPage('subpackages/device/wifi-share/wifi-share.js', modules, { wx })
    page.onLoad({ id: '7' })
    await page.load()
    assert.equal(page.data.canShare, true)
    const card = page.onShareAppMessage()
    assert.ok(card.path.indexOf(share.ACCEPT_PAGE + '?') === 0, '卡片进接受页')
    assert.ok(/u=34/.test(card.path) && /p=12/.test(card.path), '带所有者 userId 与产品')
    assert.equal(page.data.showDevCopy, true, '开发版显示复制测试参数')
    page.copyTestQuery()
    assert.deepEqual(clips, [card.path.split('?')[1]], '复制的就是卡片 ? 后面的参数')
    devEnv = false
    page = loadPage('subpackages/device/wifi-share/wifi-share.js', modules, { wx })
    page.onLoad({ id: '7' })
    await page.load()
    assert.equal(page.data.showDevCopy, false, '体验版 / 正式版不显示')
    page.copyTestQuery()
    assert.equal(clips.length, 1, '非开发版不复制')
    devEnv = true
    delete user.userId
    page = loadPage('subpackages/device/wifi-share/wifi-share.js', modules, { wx: {} })
    page.onLoad({ id: '7' })
    await page.load()
    assert.equal(page.data.canShare, false, '拿不到 userId 不能分享')
    assert.equal(page.data.showDevCopy, false, '不能分享时也不给复制')
    assert.equal(page.onShareAppMessage().path, '/pages/home/home')
    const tpl = read('subpackages/device/wifi-share/wifi-share.wxml')
    assert.ok(/wx:if="\{\{canShare\}\}"[^>]*open-type="share"/.test(tpl), '分享按钮走微信卡片')
    assert.ok(/bindtap="removeMember"/.test(tpl))
    assert.ok(/wx:if="\{\{showDevCopy\}\}"[^>]*bindtap="copyTestQuery"/.test(tpl), '复制测试参数只按 showDevCopy 渲染')
    checked('分享列表')
  }
  {
    const login = read('pages/login/login.js')
    assert.ok(/takePendingShareAccept\(\)[\s\S]*?wx\.reLaunch/.test(login), '登录成功回接受页')
    const appJson = JSON.parse(read('app.json'))
    const device = appJson.subpackages.find(item => item.root === 'subpackages/device')
    assert.ok(device.pages.includes('wifi-share-accept/wifi-share-accept'), '接受页已注册')
    checked('登录回跳与页面注册')
  }
  console.log(`wifi-share: ${checks} groups passed`)
}
main().catch(error => { console.error(error); process.exitCode = 1 })
