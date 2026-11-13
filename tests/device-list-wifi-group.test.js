// 我的设备按 WiFi 版 / 蓝牙版分组（2026-10-27）：
//   ① 已绑定记录按所属产品 broadcastId 认 WiFi 版（IJ_* 模板 / IJ_ 前缀），其余按蓝牙版；
//   ② WiFi 版状态来自 IoT GET /api/device/info：在线 / 离线 / 查不到（状态未知），在线才显示信号格与电量；
//   ③ WiFi 版按钮：投屏不连蓝牙、直接弹拍照 / 相册（离线先拦）；轮播设置进 WiFi 轮播页（V1.4 取代原「刷新状态」，不拦离线）；
//      点卡片进 WiFi 详情；选相框模式不让选 WiFi 版；
//   ④ 模板：两组标题按数量显示，WiFi 卡用 WiFi 按钮，蓝牙卡仍是「投屏 / 连接」原样；
//      2026-11-06 有意改动：上下分组改为顶部 Tab 切换（同投屏记录页 record-tabs），分组标题删掉；
//      原「WiFi 版在前 / 有设备才显示该组」挪到 Tab 上：WiFi版 Tab 在前、默认 Tab 落在有设备的那一类；
//      当前 Tab 没设备显示默认设备图 + 加号，整块点击进搜索设备页（goBind → bind）；
//   ⑤ 状态推送（2026-10-27，utils/wifi-watch）：只订阅 WiFi 版（去冒号），收到 device.status 只重查那一台，
//      长连接重连成功全部重查，onHide 退订并不再响应；已被别处订阅的不重复订阅、不替它退订。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const root = path.join(__dirname, '..')
const match = require('../utils/broadcast-match')
const signal = require('../utils/signal')

let checks = 0
function checked(name) { checks++; console.log('PASS ' + name) }
const plain = value => JSON.parse(JSON.stringify(value))

function loadListPage(options = {}) {
  let definition
  const state = { toasts: [], infoCalls: [], navs: [], selected: null, subs: [], unsubs: [], preSubscribed: options.preSubscribed || [] }
  const wsHandlers = {}
  state.emit = (type, payload) => (wsHandlers[type] || []).slice().forEach(fn => fn(payload))
  const ws = {
    on(type, fn) { (wsHandlers[type] = wsHandlers[type] || []).push(fn); return () => { wsHandlers[type] = wsHandlers[type].filter(item => item !== fn) } },
    subscribe(id) { state.subs.push(id) },
    unsubscribe(id) { state.unsubs.push(id) },
    getSubscriptions: () => state.preSubscribed.slice()
  }
  const devices = options.devices || [
    { id: '1', name: '客厅WiFi', broadcastId: 'IJ_*', productDeviceId: 'E3:48:C2:1E:D4:28', deviceNo: 'E3:48:C2:1E:D4:28' },
    { id: '2', name: '卧室蓝牙', broadcastId: 'EF6-370', productDeviceId: 'AA:BB:CC:DD:EE:01', deviceNo: 'AA:BB:CC:DD:EE:01' },
    { id: '3', name: '书房WiFi', broadcastId: 'IJ_', productDeviceId: 'D0:CF:13:F0:2F:F8', deviceNo: 'D0:CF:13:F0:2F:F8' }
  ]
  const modules = {
    api: { getDevices: async () => devices.map(item => Object.assign({}, item)) },
    toast: { show: value => state.toasts.push(value.title), warn: value => state.toasts.push(value.title || value) },
    system: { getLayoutMetrics: () => ({}) },
    battery: {
      normalizeBattery: value => (value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Math.round(Number(value))),
      getBatteryIcon: value => `icon-${value}`,
      batteryIconOf: () => 'icon-none',
      batteryText: () => '--',
      readLatestBattery: async () => ({})
    },
    'low-battery': {}, 'device-ble': {}, 'frame-protocol': {}, media: {}, 'device-name': {}, 'device-identity': {},
    'active-device': {
      reconcileConnectionFlags: list => list,
      devicesMatch: () => false,
      inheritStableIdentity: item => item,
      findConnectedDeviceId: () => ''
    },
    'tap-guard': require('../utils/tap-guard'),
    'fold-adapt': { adapt: value => value },
    'broadcast-match': match,
    'iot-api': {
      getDeviceInfo: (deviceNo, opts) => {
        state.infoCalls.push([deviceNo, opts && opts.showError])
        if (state.hang) return new Promise(() => {})
        return Promise.resolve().then(() => {
          const reply = (options.info || {})[deviceNo]
          if (reply instanceof Error) throw reply
          return reply || { deviceNo, online: false, shadow: {} }
        })
      }
    },
    signal
  }
  // 状态字段来自共用的 utils/wifi-status.js：按真实源码装配，依赖用上面同一组桩
  const statusSandbox = { module: { exports: {} }, require: target => modules[target.split('/').at(-1)], console: { log() {}, warn() {} } }
  vm.runInNewContext(fs.readFileSync(path.join(root, 'utils/wifi-status.js'), 'utf8'), statusSandbox, { filename: 'wifi-status.js' })
  modules['wifi-status'] = statusSandbox.module.exports
  const watchSandbox = { module: { exports: {} }, require: target => ({ './iot-ws': ws })[target], console: { log() {}, warn() {} } }
  vm.runInNewContext(fs.readFileSync(path.join(root, 'utils/wifi-watch.js'), 'utf8'), watchSandbox, { filename: 'wifi-watch.js' })
  modules['wifi-watch'] = watchSandbox.module.exports
  vm.runInNewContext(fs.readFileSync(path.join(root, 'subpackages/device/list/list.js'), 'utf8'), {
    require: target => modules[target.split('/').at(-1)],
    getApp: () => ({ globalData: { selectedDevice: null }, setSelectedDevice: value => { state.selected = value } }),
    Page: value => { definition = value },
    wx: {
      getStorageSync: () => '',
      navigateTo: value => state.navs.push(value.url),
      navigateBack() {}
    },
    console: { log() {}, warn() {} }, setTimeout: () => 0, clearTimeout() {}
  }, { filename: 'list.js' })
  const page = { ...definition, data: plain(definition.data), setData(values) { Object.assign(this.data, values) } }
  return { page, state }
}

const flush = () => new Promise(resolve => setImmediate(resolve))

async function main() {
  {
    assert.equal(match.isWifiBroadcastId('IJ_*'), true)
    assert.equal(match.isWifiBroadcastId('ij_*abc'), true, '其它 * 模板也是 WiFi 版')
    assert.equal(match.isWifiBroadcastId('IJ_'), true, '后台写成 IJ_ 前缀也认')
    assert.equal(match.isWifiBroadcastId('EF6-370'), false)
    assert.equal(match.isWifiBroadcastId('EB-169'), false)
    assert.equal(match.isWifiBroadcastId(''), false, '认不出广播 ID 的记录按蓝牙版，行为不变')
    assert.equal(match.isWifiBroadcastId(undefined), false)
    checked('按产品 broadcastId 认 WiFi 版')
  }
  {
    const { page, state } = loadListPage({
      info: {
        'E3:48:C2:1E:D4:28': { online: true, shadow: { battery: 86, wifiRssi: -46 } },
        'D0:CF:13:F0:2F:F8': Object.assign(new Error('无该设备操作权限'), { code: 403 })
      }
    })
    await page.loadDevices()
    await flush()
    const byId = id => page.data.devices.find(item => item.id === id)
    assert.equal(page.data.wifiCount, 2)
    assert.equal(page.data.bleCount, 1)
    assert.equal(byId('1').isWifi, true)
    assert.equal(byId('2').isWifi, false)
    assert.equal(byId('3').isWifi, true)
    assert.equal(byId('2').wifiStatus, undefined, '蓝牙版不带 WiFi 字段')
    assert.deepEqual(plain(state.infoCalls), [['E3:48:C2:1E:D4:28', false], ['D0:CF:13:F0:2F:F8', false]], '只查 WiFi 版，静默不弹错')
    assert.equal(byId('1').wifiStatus, 'online')
    assert.equal(byId('1').wifiStatusText, '在线')
    assert.equal(byId('1').wifiSignalLevel, 4, '-46dBm 满格')
    assert.equal(byId('1').wifiBatteryText, '86%')
    assert.equal(byId('3').wifiStatus, 'unknown', '403 等查不到 → 状态未知')
    assert.equal(byId('3').wifiStatusText, '状态未知')
    assert.equal(byId('3').wifiBatteryText, '', '不在线不显示电量')
    checked('WiFi 版状态来自 IoT 设备信息：在线显示信号与电量，查不到为状态未知')

    state.hang = true
    await page.loadDevices()
    assert.equal(byId('1').wifiStatus, 'online', '重新拉列表、新查询还没回来时沿用上次状态，不闪「查询中」')
    assert.equal(byId('1').wifiBatteryText, '86%')
    state.hang = false

    // V1.4 更新说明 1.5：原「刷新状态」改为「轮播设置」；状态未知 / 离线也能进（查询只要权限）
    await page.openWifiSlideshow({ currentTarget: { dataset: { id: '3' } } })
    assert.equal(state.navs.at(-1), '/subpackages/device/wifi-slideshow/wifi-slideshow?id=3', '进 WiFi 轮播设置页')
    // 2026-11-13 产品改口：强制升级去掉，列表页投屏 / 轮播设置不再做固件升级判断（「取消就不进」各条随之撤掉）
    assert.ok(!/firmware-gate|guardAction/.test(fs.readFileSync(path.join(root, 'subpackages/device/list/list.js'), 'utf8')), '列表页不做固件升级判断')
    const navCount = state.navs.length
    await page.openWifiSlideshow({ currentTarget: { dataset: { id: '2' } } })
    assert.equal(state.navs.length, navCount, '蓝牙版不走 WiFi 轮播页')
    assert.equal(typeof page.refreshWifiDevice, 'undefined', '「刷新状态」按钮已撤掉')
    checked('轮播设置进 WiFi 轮播页')

    await page.startWifiProjection({ currentTarget: { dataset: { id: '1' } } })
    assert.equal(page.data.showMediaSheet, true, '在线的 WiFi 版点投屏直接弹拍照 / 相册')
    assert.equal(page._projectionDevice.id, '1')
    assert.equal(state.selected, null, '不改当前选中设备')
    page.data.showMediaSheet = false
    await page.startWifiProjection({ currentTarget: { dataset: { id: '1' } } })
    assert.equal(page.data.showMediaSheet, false, '紧接着再点一次投屏被防重复点击挡下（tap-guard 冷却中）')
    page.__tapGuard = {} // 模拟冷却已过，下面测离线拦截
    page.data.devices = page.data.devices.map(item => (item.id === '1' ? Object.assign({}, item, { wifiStatus: 'offline' }) : item))
    await page.startWifiProjection({ currentTarget: { dataset: { id: '1' } } })
    assert.equal(page.data.showMediaSheet, false, '离线先拦下')
    assert.equal(state.toasts.at(-1), '设备已离线，请检查设备网络')

    page.selectDevice({ currentTarget: { dataset: { id: '1' } } })
    assert.equal(state.navs.at(-1), '/subpackages/device/wifi-detail/wifi-detail?id=1', '点 WiFi 卡进 WiFi 详情')
    page.selectDevice({ currentTarget: { dataset: { id: '2' } } })
    assert.equal(state.navs.at(-1), '/subpackages/device/detail/detail?id=2', '蓝牙卡仍进原详情')

    page.data.selectMode = true
    page.selectDevice({ currentTarget: { dataset: { id: '1' } } })
    assert.equal(state.selected, null, '选相框模式不让选 WiFi 版')
    assert.ok(/WiFi版设备请点卡片上的「投屏」/.test(state.toasts.at(-1)))
    checked('WiFi 版投屏弹拍照 / 相册、离线拦下；卡片进 WiFi 详情；选相框模式不让选')
  }
  {
    // ⑤ 状态推送
    const { page, state } = loadListPage({ preSubscribed: ['D0CF13F02FF8'] })
    await page.loadDevices()
    await flush()
    assert.deepEqual(plain(state.subs), ['E348C21ED428'], '只订阅 WiFi 版、去冒号；已被别处订阅的（D0CF…）不重复订阅')
    state.infoCalls.length = 0
    state.emit('device.status', { type: 'device.status', deviceNo: 'D0CF13F02FF8', online: false })
    await flush()
    assert.deepEqual(plain(state.infoCalls), [['D0:CF:13:F0:2F:F8', false]], '推送只重查那一台')
    state.emit('device.status', { type: 'device.status', deviceNo: 'AABBCCDDEE01', online: true })
    await flush()
    assert.equal(state.infoCalls.length, 1, '不在本页关心范围（蓝牙版）的推送不理')
    state.infoCalls.length = 0
    state.emit('state', { state: 'open', reconnect: false })
    await flush()
    assert.equal(state.infoCalls.length, 0, '首次连上不重查（进页已查过）')
    state.emit('state', { state: 'open', reconnect: true })
    await flush()
    assert.equal(state.infoCalls.length, 2, '重连成功全部重查')
    page.onHide()
    assert.deepEqual(plain(state.unsubs), ['E348C21ED428'], '隐藏时只退订自己订阅的')
    state.infoCalls.length = 0
    state.emit('device.status', { type: 'device.status', deviceNo: 'E348C21ED428', online: false })
    await flush()
    assert.equal(state.infoCalls.length, 0, '隐藏后不再响应推送')
    checked('状态推送：订阅 / 推送重查一台 / 重连全部重查 / 隐藏退订')
  }
  {
    const { page, state } = loadListPage({ devices: [{ id: '9', name: '蓝牙', broadcastId: 'EB-169', productDeviceId: 'AA:BB:CC:DD:EE:09' }] })
    await page.loadDevices()
    assert.deepEqual(state.subs, [], '纯蓝牙版用户不订阅、不建长连接')
    assert.equal(page.data.wifiCount, 0, '没有 WiFi 版')
    assert.equal(page.data.bleCount, 1)
    // 2026-11-06：原「不出 WiFi 版标题」改为 Tab 后，判据挪到默认 Tab——没有 WiFi 版就直接落在蓝牙版，不让用户先看空态
    assert.equal(page.data.deviceTab, 'ble', '只有蓝牙版时默认落在蓝牙版 Tab')
    checked('只有蓝牙版时默认蓝牙版 Tab')
  }
  {
    // Tab（2026-11-06）：默认 WiFi 版在前；点过之后重新加载保持；两类都没有落在 WiFi 版（空态）；选相框模式优先蓝牙版
    const { page, state } = loadListPage()
    await page.loadDevices()
    assert.equal(page.data.deviceTab, 'wifi', '两类都有：默认 WiFi 版')
    page.switchDeviceTab({ currentTarget: { dataset: { tab: 'ble' } } })
    assert.equal(page.data.deviceTab, 'ble', '点蓝牙版切过去')
    await page.loadDevices()
    assert.equal(page.data.deviceTab, 'ble', '用户点过 Tab，onShow 重拉列表不重置')
    page.switchDeviceTab({ currentTarget: { dataset: { tab: 'x' } } })
    assert.equal(page.data.deviceTab, 'ble', '非法 Tab 不理')
    assert.deepEqual(state.navs, [], '切 Tab 不跳页')
    const empty = loadListPage({ devices: [] })
    await empty.page.loadDevices()
    assert.equal(empty.page.data.deviceTab, 'wifi', '没有设备：落在 WiFi 版，显示空态')
    empty.page.goBind()
    assert.deepEqual(empty.state.navs, ['/subpackages/device/bind/bind'], '空态点击进搜索设备页')
    const wifiOnly = loadListPage({ devices: [{ id: '1', name: 'WiFi', broadcastId: 'IJ_*', productDeviceId: 'E3:48:C2:1E:D4:28' }] })
    await wifiOnly.page.loadDevices()
    assert.equal(wifiOnly.page.data.deviceTab, 'wifi')
    const select = loadListPage()
    select.page.data.selectMode = true
    await select.page.loadDevices()
    assert.equal(select.page.data.deviceTab, 'ble', '选相框模式（只能选蓝牙版）优先蓝牙版')
    checked('Tab：默认 / 切换 / 重载保持 / 空态 / 选相框模式')
  }
  {
    // 首页设备卡带 tab 进来（2026-11-12）：点 WiFi 版卡默认 WiFi版 Tab，蓝牙版卡默认蓝牙版 Tab，重拉列表不被默认规则改掉
    const ble = loadListPage()
    ble.page.onLoad({ tab: 'ble' })
    await ble.page.loadDevices()
    assert.equal(ble.page.data.deviceTab, 'ble', '两类都有，从蓝牙版卡进来停在蓝牙版')
    await ble.page.loadDevices()
    assert.equal(ble.page.data.deviceTab, 'ble', '重拉列表保持')
    const wifi = loadListPage({ devices: [{ id: '9', name: '蓝牙', broadcastId: 'EB-169', productDeviceId: 'AA:BB:CC:DD:EE:09' }] })
    wifi.page.onLoad({ tab: 'wifi' })
    await wifi.page.loadDevices()
    assert.equal(wifi.page.data.deviceTab, 'wifi', '指定了 WiFi版：没有 WiFi 版也停在该 Tab（空态），不落到蓝牙版')
    const none = loadListPage({ devices: [{ id: '9', name: '蓝牙', broadcastId: 'EB-169', productDeviceId: 'AA:BB:CC:DD:EE:09' }] })
    none.page.onLoad({})
    await none.page.loadDevices()
    assert.equal(none.page.data.deviceTab, 'ble', '不带 tab（六宫格「我的设备」）仍按默认规则')
    const bad = loadListPage()
    bad.page.onLoad({ tab: 'x' })
    await bad.page.loadDevices()
    assert.equal(bad.page.data.deviceTab, 'wifi', '非法 tab 不认')
    const select = loadListPage()
    select.page.onLoad({ select: '1', tab: 'wifi' })
    await select.page.loadDevices()
    assert.equal(select.page.data.deviceTab, 'ble', '选相框模式不认 tab')
    const homeTpl = fs.readFileSync(path.join(root, 'pages/home/home.wxml'), 'utf8')
    const homeJs = fs.readFileSync(path.join(root, 'pages/home/home.js'), 'utf8')
    assert.ok(/class="device-carousel" data-tab="\{\{item\.isWifi \? 'wifi' : 'ble'\}\}" bindtap="goDeviceList"/.test(homeTpl), '首页设备卡带 data-tab')
    assert.ok(homeJs.includes('`/subpackages/device/list/list?tab=${tab}`'), '首页按卡片类型带 tab 跳设备列表')
    checked('首页设备卡带 tab：列表默认停在对应 Tab')
  }
  {
    const tpl = fs.readFileSync(path.join(root, 'subpackages/device/list/list.wxml'), 'utf8')
    // 2026-11-06：分组标题改 Tab，「按数量显示」挪到当前 Tab 有无设备决定列表 / 空态，「WiFi 版在前」挪到 Tab 顺序
    assert.equal(tpl.indexOf('device-group-title'), -1, '分组标题已删（改 Tab）')
    assert.ok(/data-tab="wifi" bindtap="switchDeviceTab">WiFi版<\/view>/.test(tpl) && /data-tab="ble" bindtap="switchDeviceTab">蓝牙版<\/view>/.test(tpl), '两个 Tab')
    assert.ok(tpl.indexOf('data-tab="wifi"') < tpl.indexOf('data-tab="ble"'), 'WiFi版 Tab 在前')
    assert.ok(/class="device-tabs device-tabs--\{\{deviceTab\}\}"/.test(tpl) && /class="device-tabs__indicator"/.test(tpl), '滑动指示器按当前 Tab 定位')
    // 同日追加：添加按钮单独一行在上，Tab 在下一行（不与加号同行）
    const toolbarAt = tpl.indexOf('<view class="device-toolbar">')
    assert.ok(toolbarAt > -1 && toolbarAt < tpl.indexOf('class="device-tabs '), '添加按钮一行在 Tab 上方')
    assert.ok(tpl.slice(toolbarAt, tpl.indexOf('class="device-tabs ')).indexOf('bindtap="goBind"') > -1, '添加按钮仍进搜索设备页')
    assert.equal(tpl.indexOf('device-tab-bar'), -1, '不再把 Tab 和加号放同一行')
    assert.ok(/wx:if="\{\{deviceTab === 'wifi' \? wifiCount : bleCount\}\}" class="device-list"/.test(tpl), '当前 Tab 有设备才出列表')
    const emptyTab = tpl.slice(tpl.indexOf('class="empty-tab glass-panel"'))
    assert.ok(/^class="empty-tab glass-panel"[^>]*bindtap="goBind"/.test(emptyTab), '空态整块点击进搜索设备页')
    assert.ok(/empty_device_art\.png/.test(emptyTab) && /home-add-icon\.png/.test(emptyTab), '空态：默认设备图 + 加号')
    assert.ok(/wx:else class="empty-tab glass-panel"/.test(tpl), '空态是列表的 wx:else')
    const bleStart = tpl.indexOf('wx:if="{{!item.isWifi}}"')
    const wifiCard = tpl.slice(tpl.indexOf('wx:if="{{item.isWifi}}"'), bleStart)
    assert.ok(tpl.lastIndexOf("deviceTab === 'wifi'}}", tpl.indexOf('wx:if="{{item.isWifi}}"')) > -1, 'WiFi 卡只在 WiFi版 Tab 下渲染')
    assert.ok(/catchtap="startWifiProjection"/.test(wifiCard) && /catchtap="openWifiSlideshow"/.test(wifiCard), 'WiFi 卡：投屏 + 轮播设置')
    assert.ok(/<text>轮播设置<\/text>/.test(wifiCard) && wifiCard.indexOf('刷新状态</text>') === -1, '按钮文案改为轮播设置')
    assert.equal(wifiCard.indexOf('toggleConnection'), -1, 'WiFi 卡没有蓝牙连接 / 断开')
    const bleCard = tpl.slice(tpl.indexOf('wx:if="{{!item.isWifi}}"'))
    assert.ok(/catchtap="startProjection"/.test(bleCard) && /catchtap="toggleConnection"/.test(bleCard), '蓝牙卡按钮不变：投屏 + 连接 / 断开')
    const json = JSON.parse(fs.readFileSync(path.join(root, 'subpackages/device/list/list.json'), 'utf8'))
    assert.equal(json.usingComponents['signal-bars'], '/components/signal-bars/signal-bars')
    const css = fs.readFileSync(path.join(root, 'subpackages/device/list/list.wxss'), 'utf8')
    assert.ok(/\.device-tabs--ble \.device-tabs__indicator \{[^}]*translateX\(100%\)/.test(css), '切到蓝牙版指示器平移一格')
    assert.ok(/\.device-tab\.is-active \{[^}]*color: #ffffff/.test(css), '选中 Tab 白字')
    assert.ok(/\.empty-tab__plus \{[^}]*position: absolute/.test(css), '加号压在设备图右下')
    checked('模板：Tab、空态、WiFi 卡按钮、蓝牙卡按钮不变')
  }
  console.log(`device-list-wifi-group: ${checks} groups passed`)
}
main().catch(error => { console.error(error); process.exitCode = 1 })
