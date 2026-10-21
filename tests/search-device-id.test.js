const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const root = path.join(__dirname, '..')
const deviceIdUtil = require('../utils/device-id')
const protocol = require('../utils/frame-protocol')
const REAL_ID = 'E9:48:C2:1E:D4:28'
const HANDLE = '90:80:70:60:50:40'
let checks = 0
function checked(name) { checks++; console.log('PASS ' + name) }

function loadPage(readInfo) {
  let definition
  const state = { reads: [], listReads: 0, selected: [], disconnected: [], warnings: [] }
  const app = { globalData: {}, setSelectedDevice: value => state.selected.push(value) }
  const dependencies = {
    api: { getDevices: async () => { state.listReads++; return [{ id: 'record-a', deviceNo: REAL_ID, screenType: 2 }] } },
    toast: { warn: value => state.warnings.push(value) },
    permission: { getCurrentLocation: async () => ({ latitude: 0, longitude: 0 }) },
    bluetooth: { openAdapter: async () => {}, stopDiscovery() {}, discoverDevices: async options => { state.scanOptions = options; return [] } },
    'device-ble': {
      readDeviceInfo: async id => { state.reads.push(id); return readInfo() },
      getConnectionInterval: async () => ({ units: 24, ms: 30 }),
      disconnect: id => state.disconnected.push(id)
    },
    'active-device': { sameScreen: () => true, serialSetsMatch: (left, right) => left.some(item => right.includes(item)), friendlyConnectMessage: text => text },
    'device-id': deviceIdUtil,
    'device-name': {}, system: {}, 'fold-adapt': { adapt: value => value }
  }
  vm.runInNewContext(fs.readFileSync(path.join(root, 'subpackages/device/bind/bind.js'), 'utf8'), {
    require: target => dependencies[target.split('/').at(-1)],
    getApp: () => app,
    Page: value => { definition = value },
    wx: { showLoading() {}, hideLoading() {}, navigateBack() {} },
    console: { log() {}, warn() {} }, setTimeout: () => 0
  }, { filename: 'bind.js' })
  const page = { ...definition, data: JSON.parse(JSON.stringify(definition.data)), scanSeq: 1, setData(values) { Object.assign(this.data, values) } }
  return { page, state }
}
function device(values = {}) {
  return { id: HANDLE, deviceId: HANDLE, name: 'EF6-589', realBluetooth: true, screenType: 2, ...values }
}

async function main() {
  const { page } = loadPage(async () => ({ deviceId: REAL_ID }))
  const examples = [
    device({ broadcastDeviceId: REAL_ID, broadcastDeviceIdComplete: true }),
    device({ broadcastDeviceId: '00:C1:B4:59' }),
    device({ broadcastDeviceId: '11:22:33:44:32:00', broadcastLayoutFallback: true }),
    device({ deviceNo: REAL_ID, productDeviceId: REAL_ID, firmwareDeviceId: REAL_ID, deviceCode: REAL_ID }),
    device({ deviceId: 'UUID-DEVICE-HANDLE' }),
    device({ broadcastDeviceId: '' })
  ]
  for (const example of examples) {
    page.applyScanResult(1, [example])
    assert.equal(page.data.devices[0].deviceCode, '--', '广播、连接地址、后端或缓存字段均不能代替本次真实读取')
  }
  checked('广播完整/短ID、填充误读、MAC/UUID、旧业务字段全部显示--')

  let resolveRead
  const live = loadPage(() => new Promise(resolve => { resolveRead = resolve }))
  live.page.applyScanResult(1, [device(), device({ id: 'other', deviceId: 'other' })])
  live.page.data.devices[0].deviceCode = 'OLD-VALUE'
  const binding = live.page.bindById(HANDLE)
  assert.equal(live.page.data.devices[0].deviceCode, '--', '每次连接前清空上一轮读数')
  assert.deepEqual(live.state.reads, [HANDLE], '连接按BLE句柄读取当前设备')
  resolveRead({ deviceId: REAL_ID.toLowerCase(), screenType: 2, battery: 50 })
  await binding
  assert.equal(live.page.data.devices[0].deviceCode, REAL_ID)
  assert.equal(live.page.data.devices[1].deviceCode, '--', '只更新当前设备')
  assert.equal(live.state.selected[0].firmwareDeviceId, REAL_ID)
  checked('每次重新读取0x01，合法完整ID仅回填对应设备')

  for (const result of [null, { deviceId: '00:C1:B4:59' }, { deviceId: '00:00:00:00:00:00' }, { deviceId: 'FF:FF:FF:FF:FF:FF' }]) {
    const invalid = loadPage(async () => result)
    invalid.page.applyScanResult(1, [device({ broadcastDeviceId: REAL_ID, firmwareDeviceId: REAL_ID })])
    await invalid.page.bindById(HANDLE)
    assert.equal(invalid.page.data.devices[0].deviceCode, '--')
    assert.equal(invalid.state.listReads, 0, '非法真实身份不进入绑定判重或保存')
  }
  checked('0x01缺失、短ID、全0/全FF时保持--，不退回广播或旧值')

  const failed = loadPage(async () => { throw new Error('read failed') })
  failed.page.applyScanResult(1, [device({ deviceNo: REAL_ID })])
  await failed.page.bindById(HANDLE)
  assert.equal(failed.page.data.devices[0].deviceCode, '--')
  assert.deepEqual(failed.state.disconnected, [HANDLE])
  checked('本次真实读取失败时保持--并释放连接')

  let finishOld
  const stale = loadPage(() => new Promise(resolve => { finishOld = resolve }))
  stale.page.applyScanResult(1, [device()])
  const previous = stale.page.bindById(HANDLE)
  stale.page.scanSeq = 2
  stale.page.applyScanResult(2, [device()])
  finishOld({ deviceId: REAL_ID, screenType: 2 })
  await previous
  assert.equal(stale.page.data.devices[0].deviceCode, '--', '旧读取结果不得回填新搜索列表')
  stale.page.applyScanResult(1, [device({ deviceCode: REAL_ID })])
  assert.equal(stale.page.data.devices[0].deviceCode, '--', '旧扫描回调不得复用已核实ID')
  checked('重新搜索清空已读ID，旧扫描/旧读取不回填新列表')

  const searching = loadPage(async () => ({ deviceId: REAL_ID }))
  searching.page.data.devices = [device({ deviceCode: REAL_ID })]
  searching.page.data.selectedId = HANDLE
  await searching.page.scan()
  assert.equal(searching.page.data.devices.length, 0)
  assert.equal(searching.page.data.selectedId, '')
  assert.equal(searching.state.scanOptions.freshOnly, true)
  checked('搜索页每轮清空设备/选择，并要求仅接收新广播')

  let handler
  const scanner = { module: { exports: {} }, require: target => target === './frame-protocol' ? protocol : {}, console, setTimeout, clearTimeout, wx: {
    openBluetoothAdapter() {},
    onBluetoothDeviceFound: value => { handler = value }, offBluetoothDeviceFound() {},
    startBluetoothDevicesDiscovery: options => options.success({}),
    stopBluetoothDevicesDiscovery: options => options.success && options.success({})
  } }
  vm.runInNewContext(fs.readFileSync(path.join(root, 'utils/bluetooth.js'), 'utf8'), scanner, { filename: 'bluetooth.js' })
  const bluetooth = scanner.module.exports, oldUpdates = [], freshUpdates = []
  const first = bluetooth.discoverDevices({ allowAll: true, timeout: 100, onUpdate: list => oldUpdates.push(JSON.parse(JSON.stringify(list))) })
  const raw = (handle, bytes = [0xe9,0x48,0xc2,0x1e,0xd4,0x28]) => ({ deviceId: handle, name: 'EF6-589', RSSI: -50, advertisData: Uint8Array.from([255,255,2,...bytes,90]).buffer })
  handler({ devices: [raw(HANDLE), raw('old-only')] })
  const fresh = bluetooth.discoverDevices({ allowAll: true, freshOnly: true, timeout: 40, onUpdate: list => freshUpdates.push(JSON.parse(JSON.stringify(list))) })
  assert.equal(freshUpdates.length, 0, '新订阅不能立即收到共享扫描里之前存下的设备')
  handler({ devices: [raw(HANDLE)] })
  assert.equal(freshUpdates.length, 1, '相同广播首次在新订阅收到时也要通知页面')
  assert.deepEqual(freshUpdates[0].map(item => item.deviceId), [HANDLE])
  checked('共享扫描存量不进入新搜索，新收到相同广播仍即时展示')
  handler({ devices: [raw(HANDLE, [0xaa,0xbb,0xcc,0xdd,0xee,0x01])] })
  assert.equal(freshUpdates.length, 2, '只变化广播ID也必须触发更新')
  assert.equal(freshUpdates[1][0].broadcastDeviceId, 'AA:BB:CC:DD:EE:01')
  checked('只有广播ID变化也更新，不再留住旧条目数据')
  handler({ devices: [{ deviceId: HANDLE, name: 'EF6-589', RSSI: -50 }] })
  assert.equal(freshUpdates.at(-1)[0].broadcastDeviceId, '', '最新帧不含ID时不得沿用前一帧ID')
  const empty = bluetooth.discoverDevices({ allowAll: true, freshOnly: true, timeout: 20 })
  assert.equal((await empty).length, 0, '本轮未收到任何广播，不回落历史设备')
  const result = await fresh
  assert.deepEqual(Array.from(result, item => item.deviceId), [HANDLE])
  assert.equal(result[0].broadcastDeviceId, '')
  await first
  checked('最新帧缺ID清空旧值；无新广播时列表为空')
  console.log(`search-device-id: ${checks} groups passed`)
}
main().catch(error => { console.error(error); process.exitCode = 1 })
