// 我的设备按 WiFi 版 / 蓝牙版分组（2026-10-27）：
//   ① 已绑定记录按所属产品 broadcastId 认 WiFi 版（IJ_* 模板 / IJ_ 前缀），其余按蓝牙版；
//   ② WiFi 版状态来自 IoT GET /api/device/info：在线 / 离线 / 查不到（状态未知），在线才显示信号格与电量；
//   ③ WiFi 版按钮：投屏不连蓝牙、直接弹拍照 / 相册（离线先拦）；轮播设置进 WiFi 轮播页（V1.4 取代原「刷新状态」，不拦离线）；
//      点卡片进 WiFi 详情；选相框模式不让选 WiFi 版；
//   ④ 模板：两组标题按数量显示，WiFi 卡用 WiFi 按钮，蓝牙卡仍是「投屏 / 连接」原样。
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
  const state = { toasts: [], infoCalls: [], navs: [], selected: null }
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
    page.openWifiSlideshow({ currentTarget: { dataset: { id: '3' } } })
    assert.equal(state.navs.at(-1), '/subpackages/device/wifi-slideshow/wifi-slideshow?id=3', '进 WiFi 轮播设置页')
    const navCount = state.navs.length
    page.openWifiSlideshow({ currentTarget: { dataset: { id: '2' } } })
    assert.equal(state.navs.length, navCount, '蓝牙版不走 WiFi 轮播页')
    assert.equal(typeof page.refreshWifiDevice, 'undefined', '「刷新状态」按钮已撤掉')
    checked('轮播设置进 WiFi 轮播页')

    page.startWifiProjection({ currentTarget: { dataset: { id: '1' } } })
    assert.equal(page.data.showMediaSheet, true, '在线的 WiFi 版点投屏直接弹拍照 / 相册')
    assert.equal(page._projectionDevice.id, '1')
    assert.equal(state.selected, null, '不改当前选中设备')
    page.data.showMediaSheet = false
    page.data.devices = page.data.devices.map(item => (item.id === '1' ? Object.assign({}, item, { wifiStatus: 'offline' }) : item))
    page.startWifiProjection({ currentTarget: { dataset: { id: '1' } } })
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
    const { page } = loadListPage({ devices: [{ id: '9', name: '蓝牙', broadcastId: 'EB-169', productDeviceId: 'AA:BB:CC:DD:EE:09' }] })
    await page.loadDevices()
    assert.equal(page.data.wifiCount, 0, '没有 WiFi 版就不出 WiFi 版标题')
    assert.equal(page.data.bleCount, 1)
    checked('只有蓝牙版时 WiFi 组不显示')
  }
  {
    const tpl = fs.readFileSync(path.join(root, 'subpackages/device/list/list.wxml'), 'utf8')
    assert.ok(/wx:if="\{\{wifiCount\}\}" class="device-group-title"/.test(tpl), 'WiFi 版标题按数量显示')
    assert.ok(/wx:if="\{\{bleCount\}\}" class="device-group-title/.test(tpl), '蓝牙版标题按数量显示')
    assert.ok(tpl.indexOf('WiFi版</text>') < tpl.indexOf('蓝牙版</text>'), 'WiFi 版在前')
    const wifiCard = tpl.slice(tpl.indexOf('wx:if="{{item.isWifi}}"'), tpl.indexOf('蓝牙版</text>'))
    assert.ok(/catchtap="startWifiProjection"/.test(wifiCard) && /catchtap="openWifiSlideshow"/.test(wifiCard), 'WiFi 卡：投屏 + 轮播设置')
    assert.ok(/<text>轮播设置<\/text>/.test(wifiCard) && wifiCard.indexOf('刷新状态</text>') === -1, '按钮文案改为轮播设置')
    assert.equal(wifiCard.indexOf('toggleConnection'), -1, 'WiFi 卡没有蓝牙连接 / 断开')
    const bleCard = tpl.slice(tpl.indexOf('wx:if="{{!item.isWifi}}"'))
    assert.ok(/catchtap="startProjection"/.test(bleCard) && /catchtap="toggleConnection"/.test(bleCard), '蓝牙卡按钮不变：投屏 + 连接 / 断开')
    const json = JSON.parse(fs.readFileSync(path.join(root, 'subpackages/device/list/list.json'), 'utf8'))
    assert.equal(json.usingComponents['signal-bars'], '/components/signal-bars/signal-bars')
    checked('模板：分组标题、WiFi 卡按钮、蓝牙卡按钮不变')
  }
  console.log(`device-list-wifi-group: ${checks} groups passed`)
}
main().catch(error => { console.error(error); process.exitCode = 1 })
