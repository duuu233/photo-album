// WiFi 版 TF 卡 / 本地模式 / 详情页改版（2026-10-29，docs/wifi/前端对接20261029.md）：
//   ① 状态：LOCAL_TF → local「本地模式」，提示「当前设备状态：本地模式，请恢复设备网络再试」；
//      投屏严格口径 projectBlockedTip：离线 / 本地模式 / 查不到 →「设备不在线」；选择设备列表过滤离线 / 本地模式 / 未知的 WiFi 版；
//   ② utils/wifi-tf：TF 卡文案（未插卡 / 已用/总量 / --）、play-tf 错误提示、command.result 按 msgid 匹配（推送早于响应也认）、超时；
//   ③ utils/wifi-share：所有者判定（老记录按所有者）、分享列表分出所有者与接收者；
//   ④ 消息类型 TF_LOCAL_MODE 有文案；
//   ⑤ WiFi 详情：本地模式下投屏 / 轮播设置 / TF卡 只提示；未插卡不可点；解除绑定只删设备；
//      删除设备按「清相册记录 → 删全部云端 bin → 删设备」顺序，任一步失败不删设备；
//   ⑥ 模板：功能栏顺序、分享 / 删除仅所有者、电量在状态栏、新页面已注册；投屏进度页中间改为状态图标。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const root = path.join(__dirname, '..')

let checks = 0
function checked(name) { checks++; console.log('PASS ' + name) }

global.wx = new Proxy({}, { get: () => () => {} })
const toasts = []
const stubModule = (request, exports) => {
  const filename = require.resolve(request)
  require.cache[filename] = { id: filename, filename, loaded: true, children: [], paths: [], exports }
}
let onlineReply = null
let infoReply = null
stubModule('../utils/iot-api', {
  getDeviceInfo: async () => { if (infoReply instanceof Error) throw infoReply; return infoReply },
  getDeviceOnline: async () => { if (onlineReply instanceof Error) throw onlineReply; return onlineReply }
})
stubModule('../utils/toast', { show: options => toasts.push(options.title) })
const wifiStatus = require('../utils/wifi-status')
const wifiTf = require('../utils/wifi-tf')
const wifiShare = require('../utils/wifi-share')
const messages = require('../utils/wifi-messages')

const read = file => fs.readFileSync(path.join(root, file), 'utf8')
const flush = () => new Promise(resolve => setImmediate(resolve))

async function main() {
  {
    assert.equal(wifiStatus.deviceState({ online: false, status: 'LOCAL_TF' }), 'local')
    assert.equal(wifiStatus.STATUS_TEXT.local, '本地模式')
    assert.equal(wifiStatus.blockedTip('local'), '当前设备状态：本地模式，请恢复设备网络再试')
    infoReply = { online: false, status: 'LOCAL_TF', shadow: { battery: 80, wifiRssi: -40 } }
    const fields = await wifiStatus.fetchFields({ productDeviceId: 'X' })
    assert.equal(fields.wifiStatusText, '本地模式', '首页 / 列表卡显示本地模式')
    assert.equal(fields.wifiBatteryText, '', '本地模式影子冻结，不显示电量')
    const tip = reply => { onlineReply = reply; return wifiStatus.projectBlockedTip({ productDeviceId: 'X' }) }
    assert.equal(await tip({ online: true, status: 'ONLINE' }), '')
    assert.equal(await tip({ online: false, status: 'LOCAL_TF' }), '设备不在线')
    assert.equal(await tip({ online: false, status: 'OFFLINE' }), '设备不在线')
    assert.equal(await tip({ online: false, status: 'NEW_ONE' }), '设备不在线', '不认识的状态按未知')
    assert.equal(await tip(new Error('503')), '设备不在线', '查不到也不允许')
    assert.equal(await tip({ online: false, status: 'SLEEPING' }), '设备休眠中，唤醒后可操作', '休眠沿用原提示')
    onlineReply = { online: false, status: 'LOCAL_TF' }
    assert.equal(await wifiStatus.queryBlockedTip({ productDeviceId: 'X' }), wifiStatus.LOCAL_TIP, '轮播保存前判断')
    onlineReply = new Error('503')
    assert.equal(await wifiStatus.queryBlockedTip({ productDeviceId: 'X' }), '', '保存前查不到交给接口')
    checked('状态：本地模式与投屏严格口径')
  }
  {
    const replies = { W1: { online: true, status: 'ONLINE' }, W2: { online: false, status: 'LOCAL_TF' }, W3: { online: false, status: 'OFFLINE' }, W4: new Error('403'), W5: { online: false, status: 'SLEEPING' } }
    const original = require('../utils/iot-api').getDeviceInfo
    require('../utils/iot-api').getDeviceInfo = async deviceNo => { const r = replies[deviceNo]; if (r instanceof Error) throw r; return r }
    const devices = ['W1', 'W2', 'W3', 'W4', 'W5', 'B1'].map(id => ({ id, productDeviceId: id, wifi: id[0] === 'W' }))
    const kept = await wifiStatus.filterPickable(devices, item => item.wifi)
    require('../utils/iot-api').getDeviceInfo = original
    assert.deepEqual(kept.map(item => item.id), ['W1', 'W5', 'B1'], '离线 / 本地模式 / 未知的 WiFi 版过滤，休眠与蓝牙版保留')
    checked('选择设备列表过滤')
  }
  {
    assert.deepEqual(wifiTf.tfState({ tfStatus: 'absent' }), { state: 'absent', text: '未插卡' })
    assert.deepEqual(wifiTf.tfState({ tfStatus: 'present', tfUsed: 512, tfTotal: 30720 }), { state: 'present', text: '512MB/30GB' })
    assert.equal(wifiTf.tfState({ tfStatus: 'present', tfUsed: 1536, tfTotal: 0 }).text, '已插卡')
    assert.equal(wifiTf.tfState({}).state, 'unknown')
    assert.equal(wifiTf.sizeText(1536), '1.5GB')
    assert.equal(wifiTf.playTfErrorText({ code: 4000 }), '设备未插TF卡，无法开启')
    assert.equal(wifiTf.playTfErrorText({ code: 4041 }), '设备不在线，无法开启')
    assert.equal(wifiTf.playTfErrorText({ code: 4045 }), '设备升级中，请稍后')
    checked('TF 卡文案与错误提示')
  }
  {
    const handlers = []
    const ws = { on: (type, fn) => { handlers.push([type, fn]); return () => handlers.splice(handlers.findIndex(item => item[1] === fn), 1) } }
    const push = event => handlers.filter(item => item[0] === 'command.result').forEach(item => item[1](event))
    const early = wifiTf.createResultWaiter(ws, 'D0:CF:13', 'play_tf')
    push({ type: 'command.result', deviceNo: 'D0CF13', action: 'play_tf', msgid: '9', success: true, result: 0 })
    assert.deepEqual(await early.wait('9', 1000), { success: true, result: 0 }, '推送早于 HTTP 响应也认')
    early.dispose()
    assert.equal(handlers.length, 0, 'dispose 退订')
    const late = wifiTf.createResultWaiter(ws, 'D0CF13', 'play_tf')
    const waiting = late.wait('10', 1000)
    push({ deviceNo: 'D0CF13', action: 'play_tf', msgid: '11', success: true })
    push({ deviceNo: 'OTHER', action: 'play_tf', msgid: '10', success: true })
    push({ deviceNo: 'D0CF13', action: 'play_tf', msgid: '10', success: false, result: 112 })
    assert.deepEqual(await waiting, { success: false, result: 112 }, '按设备 + msgid 匹配')
    late.dispose()
    const slow = wifiTf.createResultWaiter(ws, 'D0CF13', 'play_tf')
    assert.deepEqual(await slow.wait('12', 5), { timeout: true }, '超时')
    slow.dispose()
    checked('command.result 匹配与超时')
  }
  {
    assert.equal(wifiShare.isOwner({ isToHave: 1 }), true)
    assert.equal(wifiShare.isOwner({ isToHave: 0, shareUserId: 5 }), false, '有分享者的是接收者')
    assert.equal(wifiShare.isOwner({}), true, '分享上线前的老记录按所有者')
    const split = wifiShare.splitMembers([
      { userProductId: 2, userName: 'B', avatar: 'b.png', isToHave: 0, joinTime: '2026-10-29 10:00', createTime: '2026-01-01 00:00' },
      { userProductId: 1, userName: 'A', avatar: 'a.png', isToHave: 1 }
    ])
    assert.equal(split.owner.name, 'A', '所有者固定第一栏')
    assert.deepEqual(split.members.map(item => item.name), ['B'])
    assert.equal(split.members[0].joinedAt, '2026-10-29 10:00', '加入时间取 joinTime')
    assert.equal(wifiShare.toMember({ userProductId: 3, createTime: 'x' }).joinedAt, '', '没有 joinTime 不拿别的时间顶替')
    const fallback = wifiShare.splitMembers([], { userProductId: 1, userName: '我', avatar: '' })
    assert.equal(fallback.owner.name, '我', '列表没有所有者时用当前用户')
    assert.equal(messages.toItem({ id: 1, type: 'TF_LOCAL_MODE', payload: {} }).title, '设备已进入本地模式')
    checked('分享列表与消息类型')
  }
  {
    // WiFi 详情页（vm 沙箱，依赖按文件名注入）
    let definition
    const state = { navs: [], calls: [], deleteError: null, cloudError: null }
    const modules = {
      api: {
        getDeviceDetail: async () => ({ id: '7', productDeviceId: 'D0:CF:13', isToHave: 1 }),
        clearUserProductImg: async id => { state.calls.push(['clear', id]) },
        deleteDevice: async id => { state.calls.push(['delete', id]); if (state.deleteError) throw state.deleteError }
      },
      'iot-api': {
        getDeviceInfo: async () => infoReply,
        getUnreadCount: async () => ({ unreadCount: 0 }),
        deletePhotos: async payload => { state.calls.push(['cloud', JSON.parse(JSON.stringify(payload))]); if (state.cloudError) throw state.cloudError; return {} }
      },
      'iot-ws': { on: () => () => {}, subscribe() {}, unsubscribe() {}, getSubscriptions: () => [] },
      toast: { show: value => toasts.push(value.title), warn: value => toasts.push(value.title) },
      system: { getLayoutMetrics: () => ({}) },
      'fold-adapt': { adapt: value => value },
      media: {},
      battery: { normalizeBattery: value => value, getBatteryIcon: () => 'icon' },
      'device-identity': { forget() {} },
      'wifi-status': wifiStatus,
      'wifi-tf': wifiTf,
      'wifi-share': wifiShare
    }
    vm.runInNewContext(read('subpackages/device/wifi-detail/wifi-detail.js'), {
      require: target => modules[target.split('/').at(-1)],
      Page: value => { definition = value },
      getApp: () => ({ globalData: {}, setSelectedDevice() {} }),
      wx: { navigateTo: options => state.navs.push(options.url), navigateBack() {}, showLoading() {}, hideLoading() {} },
      setTimeout: () => 0,
      console: { log() {}, warn() {} }
    }, { filename: 'wifi-detail.js' })
    const make = () => {
      const page = { ...definition, data: JSON.parse(JSON.stringify(definition.data)), setData(values) { Object.assign(this.data, values) } }
      page.onLoad({ id: '7' })
      return page
    }

    infoReply = { online: false, status: 'LOCAL_TF', shadow: { tfStatus: 'present', tfUsed: 1, tfTotal: 2 } }
    let page = make()
    await page.load()
    await flush()
    assert.equal(page.data.status, 'local')
    assert.equal(page.data.isOwner, true)
    toasts.length = 0
    page.startProjection()
    page.openSlideshow()
    page.openTf()
    assert.deepEqual(toasts, Array(3).fill(wifiStatus.LOCAL_TIP), '本地模式：投屏 / 轮播设置 / TF卡 只提示')
    assert.equal(page.data.showMediaSheet, false)
    page.openInfo()
    page.openSleep()
    page.openMessages()
    page.openShare()
    assert.equal(state.navs.length, 4, '设备信息 / 休眠 / 消息 / 分享照常进')

    infoReply = { online: true, status: 'ONLINE', shadow: { tfStatus: 'absent', battery: 66 } }
    page = make()
    await page.load()
    await flush()
    assert.equal(page.data.batteryText, '66%', '电量在状态栏')
    state.navs.length = 0
    page.openTf()
    assert.deepEqual(state.navs, [], '未插卡不可点')

    state.calls.length = 0
    await page.confirmUnbind()
    assert.deepEqual(state.calls, [['delete', '7']], '解除绑定只删设备')

    page = make()
    await page.load()
    state.calls.length = 0
    await page.confirmDeleteDevice()
    assert.deepEqual(state.calls, [['clear', '7'], ['cloud', { deviceNo: 'D0CF13', all: true }], ['delete', '7']], '先删图片（记录 + 云端）再删设备')

    page = make()
    await page.load()
    state.calls.length = 0
    state.cloudError = Object.assign(new Error('接口(IoT)-服务异常'), { code: 5000 })
    await page.confirmDeleteDevice()
    assert.deepEqual(state.calls.map(item => item[0]), ['clear', 'cloud'], '云端图片删失败不删设备')
    state.cloudError = null
    checked('WiFi 详情：本地模式拦截、解绑与删除')
  }
  {
    const tpl = read('subpackages/device/wifi-detail/wifi-detail.wxml')
    const order = ['bindtap="startProjection"', 'bindtap="openInfo"', 'bindtap="openSleep"', 'bindtap="openMessages"', 'bindtap="openTf"', 'bindtap="openShare"', 'bindtap="showUnbindConfirm"', 'bindtap="showDeleteConfirm"']
    const positions = order.map(key => tpl.indexOf(key))
    assert.ok(positions.every(pos => pos > -1), '入口齐全')
    assert.deepEqual(positions.slice().sort((a, b) => a - b), positions, '投屏 / 轮播在功能栏之前，功能栏顺序：设备信息、休眠、消息、TF卡、分享、解绑，页底删除')
    assert.ok(/wx:if="\{\{isOwner\}\}"[^>]*bindtap="openShare"/.test(tpl), '分享仅所有者')
    assert.ok(/wx:if="\{\{isOwner\}\}" class="outline-delete-device"/.test(tpl), '删除设备仅所有者，样式同蓝牙版')
    assert.ok(tpl.indexOf('batteryText') < tpl.indexOf('wifi-detail-actions'), '电量在顶部状态栏')
    assert.equal(tpl.indexOf('国家码'), -1, '不显示国家码')
    assert.ok(/\.wifi-detail-state\.is-local\s*\{/.test(read('subpackages/device/wifi-detail/wifi-detail.wxss')))
    assert.ok(/\.device-status\.wifi-status\.is-local\s*\{/.test(read('pages/home/home.wxss')), '首页本地模式颜色')
    assert.ok(/\.wifi-state\.is-local\s*\{/.test(read('subpackages/device/list/list.wxss')), '我的设备本地模式颜色')
    const info = read('subpackages/device/wifi-info/wifi-info.js')
    assert.ok(['WiFi信号', 'WiFi名称', '最后上线', '最后心跳', '固件版本'].every(label => info.indexOf(`'${label}'`) > -1), '设备信息五项')
    assert.equal(info.indexOf('国家码'), -1)
    const appJson = JSON.parse(read('app.json'))
    const device = appJson.subpackages.find(item => item.root === 'subpackages/device')
    assert.ok(['wifi-info/wifi-info', 'wifi-tf/wifi-tf', 'wifi-share/wifi-share'].every(page => device.pages.includes(page)), '新页面已注册')
    assert.ok(/wifiStatus\.queryBlockedTip/.test(read('subpackages/device/wifi-slideshow/wifi-slideshow.js')), '轮播保存前判断设备状态')
    assert.ok(/wifiStatus\.projectBlockedTip/.test(read('subpackages/projection/preview/preview-page.js')), '预览页开始投屏判断设备状态')
    assert.ok(/wifiStatus\.filterPickable/.test(read('subpackages/ai/chat/chat.js')), 'AI 生图选择设备过滤')
    assert.ok(/wifiStatus\.filterPickable/.test(read('subpackages/gallery/detail/detail.js')), '官方图库选择设备过滤')
    const resultTpl = read('subpackages/projection/wifi-result/wifi-result.wxml')
    assert.equal(resultTpl.indexOf('src="{{items[current].src}}"'), -1, '投屏进度页中间不再放投屏图片')
    assert.ok(/class="wifi-result-art"[^>]*upload-icon01\.png/.test(resultTpl), '改为状态图标')
    checked('模板与入口')
  }
  console.log(`wifi-tf-local-mode: ${checks} groups passed`)
}
main().catch(error => { console.error(error); process.exitCode = 1 })
