// WiFi 版设备分享·简化版（2026-10-29，服务端新增 getUserInfo.userId、addUserProduct.isToHave / shareUserId）：
//   ① 卡片路径：设备号 / 产品 / 所有者 userId / 设备名 / 昵称来回编解码；缺项或格式不对视为无效；
//   ② 接口：个人信息读出 userId（与展示用的 userNo 分开）；自己绑定默认 isToHave=1、shareUserId=0；
//      接受分享 isToHave=0、shareUserId=所有者；移除成员调 delUserProduct（成员那条 userProductId）；
//   ③ 接受页：自己分享的不接受；已在列表直接进详情；否则接受后进详情；未登录先记下卡片再去登录；
//   ④ 分享列表：能分享时卡片路径指向接受页，拿不到 userId 退回首页卡片；仅开发版能复制卡片参数；
//   ⑤ 登录页：登录成功后回接受页；页面已注册。
//   ⑥ 有效期（2026-11-04）：卡片带服务器时间戳 t（getCurrentTime），缺 t 视为无效；接受页已登录进页面就 chkTimeValid，
//      过期显示过期卡片；点接受再校验一次，过期 / 校验不了都不绑定；分享列表取不到时间戳不能分享，分享时再取最新的。
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
    const p = share.buildAcceptPath({ deviceId: 'E3:48:C2:1E:D4:28', productId: 12, ownerUserId: 34, deviceName: '客厅 相框&1', ownerName: '小明', shareTime: '1762240000000' })
    assert.ok(p.indexOf(share.ACCEPT_PAGE + '?') === 0)
    assert.ok(/[?&]t=1762240000000(&|$)/.test(p), '卡片带分享时间戳 t')
    const query = {}
    p.split('?')[1].split('&').forEach(pair => { const [k, v] = pair.split('='); query[k] = v })
    const info = share.parseAcceptQuery(query)
    assert.deepEqual(info, { deviceId: 'E3:48:C2:1E:D4:28', productId: '12', ownerUserId: '34', deviceName: '客厅 相框&1', ownerName: '小明', shareTime: '1762240000000' }, '编码后的参数能原样解回')
    assert.equal(share.parseAcceptQuery({ d: 'E3:48:C2:1E:D4:28', p: '12', u: '34', t: '1762240000' }).deviceName, '智能相框', '没带设备名用默认')
    assert.equal(share.parseAcceptQuery({ d: 'X', p: '12', t: '1' }), null, '缺所有者无效')
    assert.equal(share.parseAcceptQuery({ d: 'X', p: 'abc', u: '34', t: '1' }), null, '产品 ID 非数字无效')
    assert.equal(share.parseAcceptQuery({ d: 'X', p: '12', u: '34' }), null, '缺时间戳（有效期上线前的卡片）无效')
    assert.equal(share.parseAcceptQuery({ d: 'X', p: '12', u: '34', t: 'abc' }), null, '时间戳非数字无效')
    assert.equal(share.parseAcceptQuery({ d: 'X', p: '12', u: '34', t: '0' }), null, '时间戳为 0 无效')
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
      const gets = []
      let reply = 1762240000000
      http.get = (url, data, options) => { gets.push({ url, data, options }); return Promise.resolve(reply) }
      assert.equal(await api.getServerTime(), '1762240000000', '服务器时间戳原样取回')
      assert.deepEqual([gets[0].url, gets[0].options.showError], ['/Client/UserProduct/getCurrentTime', false])
      reply = null
      await assert.rejects(api.getServerTime(), '没有时间戳算失败')
      reply = true
      assert.equal(await api.checkShareTimeValid('1762240000000'), true)
      assert.deepEqual([gets[2].url, gets[2].data, gets[2].options.showError], ['/Client/UserProduct/chkTimeValid', { currentTime: '1762240000000' }, false], '校验传 currentTime')
      reply = false
      assert.equal(await api.checkShareTimeValid('1'), false, 'false = 已过期')
      http.get = () => Promise.reject({ code: 500, message: '链接已过期', data: false })
      assert.equal(await api.checkShareTimeValid('1'), false, 'retCode 非 200 但 retData 为 false 也按过期')
      http.get = () => Promise.reject({ code: 406, message: '登录失效', data: false })
      await assert.rejects(api.checkShareTimeValid('1'), '登录失效不算过期')
      http.get = () => Promise.reject({ code: 'NETWORK_ERROR', message: 'timeout' })
      await assert.rejects(api.checkShareTimeValid('1'), '网络失败不算过期')
      http.get = () => Promise.reject({ code: 500, message: '服务器异常' })
      await assert.rejects(api.checkShareTimeValid('1'), '没有布尔值不算过期')
    } finally {
      http.post = originalPost
      http.get = originalGet
    }
    assert.ok(/isToHave: 1, shareUserId: 0/.test(read('utils/api.js').split('async bindWifiDevice')[1]), '配网绑定也传所有者')
    checked('接口参数')
  }
  {
    const state = { navs: [], toasts: [], storage: {}, adds: [], devices: [], user: { userId: 99 }, login: 0, valid: true, checks: [] }
    const app = { globalData: { token: 't', jwtToken: 'j' }, requireLogin() { state.login++; return false } }
    const modules = {
      api: {
        getUserProfile: async () => state.user,
        getDevices: async () => state.devices,
        acceptSharedDevice: async payload => { state.adds.push(JSON.parse(JSON.stringify(payload))); state.devices = [{ id: '501', productDeviceId: 'E3:48:C2:1E:D4:28' }] },
        checkShareTimeValid: async time => {
          state.checks.push(time)
          const valid = typeof state.valid === 'function' ? state.valid() : state.valid
          if (valid === 'error') { throw new Error('network') }
          return valid
        }
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
    const options = { d: encodeURIComponent('E3:48:C2:1E:D4:28'), p: '12', u: '34', n: encodeURIComponent('客厅相框'), t: '1762240000000' }

    let page = make()
    page.onLoad(options)
    await page.onShow()
    assert.deepEqual(state.checks, ['1762240000000'], '已登录进页面就校验一次')
    assert.equal(page.data.checking, false)
    assert.equal(page.data.expired, false)
    await page.accept()
    assert.deepEqual(state.checks, ['1762240000000', '1762240000000'], '点接受再校验一次')
    assert.deepEqual(state.adds, [{ productId: 12, productName: '客厅相框', deviceId: 'E3:48:C2:1E:D4:28', shareUserId: 34 }])
    assert.deepEqual(state.navs, ['/subpackages/device/wifi-detail/wifi-detail?id=501'], '接受后进 WiFi 详情')

    state.navs.length = 0
    state.adds.length = 0
    page = make()
    page.onLoad(options)
    await page.onShow()
    assert.equal(state.adds.length, 0, '已在列表不重复绑定')
    assert.deepEqual(state.navs, ['/subpackages/device/wifi-detail/wifi-detail?id=501'])

    state.user = { userId: 34 }
    state.devices = []
    state.toasts.length = 0
    page = make()
    page.onLoad(options)
    await page.onShow()
    await page.accept()
    assert.equal(state.adds.length, 0)
    assert.deepEqual(state.toasts, ['这是你分享出去的设备'], '自己分享的不接受')

    state.user = { userId: 99 }
    state.valid = false
    page = make()
    page.onLoad(options)
    await page.onShow()
    assert.equal(page.data.expired, true, '进页面校验过期 → 过期卡片')
    await page.accept()
    assert.equal(state.adds.length, 0, '过期不绑定')

    state.valid = 'error'
    state.toasts.length = 0
    page = make()
    page.onLoad(options)
    await page.onShow()
    assert.equal(page.data.expired, false, '进页面校验失败不拦')
    await page.accept()
    assert.equal(state.adds.length, 0, '点接受时校验不了不绑定')
    assert.deepEqual(state.toasts, ['暂时无法校验分享链接，请稍后重试'])

    let calls = 0
    state.valid = () => ++calls === 1
    page = make()
    page.onLoad(options)
    await page.onShow()
    assert.equal(page.data.expired, false)
    await page.accept()
    assert.equal(page.data.expired, true, '停留期间过期：点接受时以这次校验为准')
    assert.equal(state.adds.length, 0)
    state.valid = true

    app.globalData = {}
    state.checks.length = 0
    page = make()
    page.onLoad(options)
    await page.onShow()
    assert.equal(page.data.loggedIn, false)
    assert.equal(state.checks.length, 0, '未登录不校验（接口要登录态）')
    await page.accept()
    assert.equal(state.login, 1, '未登录去登录')
    assert.ok(state.storage[share.PENDING_KEY].path.indexOf(share.ACCEPT_PAGE + '?') === 0, '记下卡片，登录后回来')
    assert.ok(/[?&]t=1762240000000(&|$)/.test(state.storage[share.PENDING_KEY].path), '记下的卡片带着原时间戳')

    page = make()
    page.onLoad({ d: 'X' })
    assert.equal(page.data.invalid, true, '参数不全显示无效')
    const acceptTpl = read('subpackages/device/wifi-share-accept/wifi-share-accept.wxml')
    assert.ok(/wx:elif="\{\{expired\}\}"[\s\S]*?分享链接已过期/.test(acceptTpl), '过期卡片')
    checked('接受页')
  }
  {
    const user = { userId: 34, nickName: '小明' }
    const device = { id: '7', userProductId: 7, productId: 12, productDeviceId: 'E3:48:C2:1E:D4:28', name: '客厅相框' }
    let devEnv = true
    const clips = []
    let now = 1762240000000
    let timeFails = false
    const modules = {
      api: {
        getDeviceDetail: async () => device,
        getShareUsers: async () => [{ userProductId: 7, userName: '小明', isToHave: 1 }],
        getUserProfile: async () => user,
        getServerTime: async () => { if (timeFails) { throw new Error('network') } now += 1000; return String(now) }
      },
      toast: { show() {} },
      system: { getLayoutMetrics: () => ({}), isDevEnv: () => devEnv },
      'fold-adapt': { adapt: value => value },
      'wifi-share': share,
      'share-card': { render: async () => 'wxfile://card.png', cardInfo: () => ({ thumb: '/assets/images/home-device-thumb.png' }) }
    }
    const wx = { setClipboardData: options => clips.push(options.data) }
    let page = loadPage('subpackages/device/wifi-share/wifi-share.js', modules, { wx })
    page.onLoad({ id: '7' })
    await page.load()
    assert.equal(page.data.canShare, true)
    const card = page.onShareAppMessage()
    assert.ok(card.path.indexOf(share.ACCEPT_PAGE + '?') === 0, '卡片进接受页')
    assert.ok(/u=34/.test(card.path) && /p=12/.test(card.path), '带所有者 userId 与产品')
    assert.ok(/[?&]t=\d+(&|$)/.test(card.path), '默认参数带进页面时取到的时间戳')
    assert.equal(card.imageUrl, 'wxfile://card.png', '卡片封面用 Canvas 画的图，不用页面截图')
    const fresh = await card.promise
    assert.equal(fresh.title, card.title)
    assert.equal(fresh.imageUrl, 'wxfile://card.png')
    assert.ok(fresh.path.indexOf('t=' + now) > 0 && fresh.path !== card.path, '分享时 promise 再取最新时间戳')
    timeFails = true
    const kept = page.onShareAppMessage()
    assert.deepEqual(await kept.promise, { title: kept.title, path: kept.path, imageUrl: kept.imageUrl }, '分享时取不到最新时间戳 → 用默认参数')
    timeFails = false
    {
      // 封面还没画完就分享：默认参数先用设备图，promise 等封面画完再带上
      let finish
      const slow = Object.assign({}, modules, { 'share-card': { render: () => new Promise(resolve => { finish = resolve }), cardInfo: () => ({ thumb: '/assets/images/home-device-thumb.png' }) } })
      const early = loadPage('subpackages/device/wifi-share/wifi-share.js', slow, { wx })
      early.onLoad({ id: '7' })
      await early.load()
      const pending = early.onShareAppMessage()
      assert.equal(pending.imageUrl, '/assets/images/home-device-thumb.png', '封面没画完时默认参数用设备图')
      finish('wxfile://late.png')
      assert.equal((await pending.promise).imageUrl, 'wxfile://late.png', '分享时等封面画完')
    }
    assert.equal(page.data.showDevCopy, true, '开发版显示复制测试参数')
    await page.copyTestQuery()
    assert.deepEqual(clips, [page.acceptPath().split('?')[1]], '复制的就是卡片 ? 后面的参数（含最新时间戳）')
    assert.ok(clips[0].indexOf('t=' + now) >= 0)
    devEnv = false
    page = loadPage('subpackages/device/wifi-share/wifi-share.js', modules, { wx })
    page.onLoad({ id: '7' })
    await page.load()
    assert.equal(page.data.showDevCopy, false, '体验版 / 正式版不显示')
    await page.copyTestQuery()
    assert.equal(clips.length, 1, '非开发版不复制')
    devEnv = true
    delete user.userId
    page = loadPage('subpackages/device/wifi-share/wifi-share.js', modules, { wx: {} })
    page.onLoad({ id: '7' })
    await page.load()
    assert.equal(page.data.canShare, false, '拿不到 userId 不能分享')
    assert.equal(page.data.showDevCopy, false, '不能分享时也不给复制')
    assert.equal(page.onShareAppMessage().path, '/pages/home/home')
    user.userId = 34
    timeFails = true
    const toasts = []
    modules.toast.show = value => toasts.push(value.title)
    page = loadPage('subpackages/device/wifi-share/wifi-share.js', modules, { wx: {} })
    page.onLoad({ id: '7' })
    await page.load()
    assert.equal(page.data.canShare, false, '取不到服务器时间戳不能分享')
    assert.equal(page.onShareAppMessage().path, '/pages/home/home')
    await page.shareUnavailable()
    assert.equal(page.data.canShare, false)
    assert.deepEqual(toasts, ['暂时无法分享，请稍后重试'])
    timeFails = false
    await page.shareUnavailable()
    assert.equal(page.data.canShare, true, '点按钮重取时间戳成功 → 换回分享按钮')
    assert.ok(/[?&]t=\d+(&|$)/.test(page.onShareAppMessage().path))
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
