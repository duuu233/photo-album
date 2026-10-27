// 首页接 WiFi 版（2026-10-27）：
//   ① 设备卡：WiFi 版打 isWifi，状态先沿用上次、没有则「查询中」，再按 IoT 设备信息刷新（在线 / 电量）；蓝牙版只多 isWifi:false；
//   ② 拍照 / 相册入口：当前设备是 WiFi 版时不走蓝牙连接，确认云端在线即可；明确离线提示并拦下，查不到放行；
//   ③ 进预览时设备带 isWifi，预览页据此去 WiFi 投屏结果页；
//   ④ 模板：WiFi 卡没有「连接蓝牙」，显示云端状态。
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const root = path.join(__dirname, '..')

const storage = {}
const navigations = []
const toasts = []
const trace = []
global.wx = new Proxy(
  {
    navigateTo: options => navigations.push(options.url),
    getStorageSync: key => storage[key] || '',
    setStorageSync: (key, value) => { storage[key] = value }
  },
  { get: (target, prop) => (prop in target ? target[prop] : () => {}) }
)
const app = {
  globalData: { selectedDevice: null },
  requireLogin: () => true,
  setSelectedDevice: value => { app.globalData.selectedDevice = value },
  ensureLogin: async () => {}
}
global.getApp = () => app

const stubModule = (request, exports) => {
  const filename = require.resolve(request)
  require.cache[filename] = { id: filename, filename, loaded: true, children: [], paths: [], exports }
}
let online = true
let infoReply = { online: true, shadow: { battery: 72, wifiRssi: -50 } }
stubModule('../utils/iot-api', {
  getDeviceInfo: async deviceNo => { trace.push(`info:${deviceNo}`); return infoReply },
  getDeviceOnline: async deviceNo => {
    trace.push(`online:${deviceNo}`)
    if (online instanceof Error) throw online
    return { online }
  }
})
stubModule('../utils/toast', {
  show: options => toasts.push(typeof options === 'string' ? options : options.title),
  warn: options => toasts.push(typeof options === 'string' ? options : options.title)
})
stubModule('../utils/active-device', {
  findConnectedDeviceId: () => { trace.push('ble:find'); return '' },
  connectBoundDevice: async () => { trace.push('ble:connect'); throw new Error('不该连蓝牙') },
  showConnectError: () => {},
  devicesMatch: () => false,
  reconcileConnectionFlags: list => list,
  inheritStableIdentity: item => item,
  applyConnectedIdentity: item => item
})
stubModule('../utils/low-battery', { warnIfLow: async () => trace.push('lowBattery') })

let home = null
global.Page = config => { home = config }
require('../pages/home/home.js')

function newPage(data) {
  const page = Object.create(home)
  page.data = Object.assign(JSON.parse(JSON.stringify(home.data)), data)
  page.setData = patch => Object.assign(page.data, patch)
  return page
}

const wifiDevice = { id: '21', name: 'WiFi相框', broadcastId: 'IJ_*', productDeviceId: 'E3:48:C2:1E:D4:28' }
const bleDevice = { id: '9', name: '蓝牙相框', broadcastId: 'EF6-370', productDeviceId: 'AA:BB:CC:DD:EE:09' }

async function main() {
  {
    const page = newPage({ deviceList: [] })
    const wifi = page.tagWifiCard(wifiDevice)
    assert.equal(wifi.isWifi, true)
    assert.equal(wifi.wifiStatus, 'loading', '第一次先「查询中」')
    assert.equal(page.tagWifiCard(bleDevice).isWifi, false)
    assert.equal(page.tagWifiCard(bleDevice).wifiStatus, undefined, '蓝牙版不带 WiFi 字段')
    page.data.deviceList = [Object.assign({}, wifi, { wifiStatus: 'online', wifiStatusText: '在线', wifiBatteryText: '72%' })]
    assert.equal(page.tagWifiCard(wifiDevice).wifiStatus, 'online', '回首页先沿用上次状态，不闪「查询中」')

    const fresh = newPage({ deviceList: [wifi, page.tagWifiCard(bleDevice)], currentDeviceIndex: 0, currentDevice: wifi })
    await fresh.refreshWifiCards()
    assert.equal(fresh.data.deviceList[0].wifiStatus, 'online')
    assert.equal(fresh.data.deviceList[0].wifiBatteryText, '72%')
    assert.equal(fresh.data.currentDevice.wifiStatus, 'online', '当前卡同步更新')
    assert.deepEqual(trace.filter(item => item.startsWith('info:')), ['info:E3:48:C2:1E:D4:28'], '只查 WiFi 版')
    console.log('PASS 设备卡：WiFi 版打标记并按云端状态刷新')

    // 状态推送（2026-10-27，utils/wifi-watch）：推送带去冒号的 deviceNo，只重查那一台
    trace.length = 0
    const other = page.tagWifiCard({ id: '22', name: 'WiFi相框2', broadcastId: 'IJ_*', productDeviceId: 'D0:CF:13:F0:2F:F8' })
    const two = newPage({ deviceList: [wifi, other], currentDeviceIndex: 0, currentDevice: wifi })
    await two.refreshWifiCards(['D0CF13F02FF8'])
    assert.deepEqual(trace.filter(item => item.startsWith('info:')), ['info:D0:CF:13:F0:2F:F8'], '推送只重查那一台')
    const source = fs.readFileSync(path.join(root, 'pages/home/home.js'), 'utf8')
    assert.ok(/onShow\(\) \{[\s\S]*?this\.watchWifiCards\(\)[\s\S]*?this\.loadHomeState\(\)/.test(source), 'onShow 先按已有设备卡订阅，再拉设备列表')
    assert.ok(/onHide\(\) \{\s*this\.stopWifiWatch\(\)/.test(source), '隐藏时退订')
    assert.ok(/this\.refreshWifiCards\(\)\s*this\.watchWifiCards\(\)/.test(source), '设备列表刷新后按最新设备更新订阅')
    console.log('PASS 设备卡：状态推送只重查那一台，显示时订阅、隐藏时退订')
  }
  {
    trace.length = 0
    app.globalData.selectedDevice = wifiDevice
    const page = newPage({ isBoundHome: true, currentDevice: wifiDevice })
    online = true
    assert.equal(await page.ensureCanProject(), true, '在线放行')
    assert.equal(trace.filter(item => item.startsWith('ble:')).length, 0, 'WiFi 版不走蓝牙连接')
    online = false
    assert.equal(await page.ensureCanProject(), false, '明确离线拦下')
    assert.equal(toasts.at(-1), '设备已离线，请检查设备网络')
    online = Object.assign(new Error('服务暂时不可用'), { code: 503 })
    assert.equal(await page.ensureCanProject(), true, '查不到放行，由投屏接口裁决')
    console.log('PASS 拍照 / 相册入口：WiFi 版只确认在线，不连蓝牙')
  }
  {
    app.globalData.selectedDevice = wifiDevice
    const page = newPage({ hasDevice: true, currentDevice: wifiDevice })
    page.openPreview([{ tempFilePath: 'wxfile://a.jpg' }])
    assert.equal(storage.pendingProjection.device.isWifi, true, '进预览带 isWifi')
    assert.equal(navigations.at(-1), '/subpackages/projection/preview/preview')
    app.globalData.selectedDevice = bleDevice
    page.openPreview([{ tempFilePath: 'wxfile://b.jpg' }])
    assert.equal(storage.pendingProjection.device.isWifi, undefined, '蓝牙版原样')
    console.log('PASS 进预览：WiFi 版带 isWifi')
  }
  {
    const tpl = fs.readFileSync(path.join(root, 'pages/home/home.wxml'), 'utf8')
    const bleBlock = tpl.slice(tpl.indexOf('<block wx:if="{{!item.isWifi}}">'), tpl.indexOf('<block wx:else>'))
    const wifiBlock = tpl.slice(tpl.indexOf('<block wx:else>'), tpl.indexOf('</swiper-item>'))
    assert.ok(/catchtap="connectCurrentDevice"/.test(bleBlock), '蓝牙卡保留「连接蓝牙」')
    assert.equal(wifiBlock.indexOf('connectCurrentDevice'), -1, 'WiFi 卡没有「连接蓝牙」')
    assert.ok(/item\.wifiStatusText/.test(wifiBlock) && /item\.wifiBatteryText/.test(wifiBlock), 'WiFi 卡显示云端状态与电量')
    console.log('PASS 模板：WiFi 卡显示云端状态、无「连接蓝牙」')
  }
  console.log('home-wifi-entry: all passed')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
