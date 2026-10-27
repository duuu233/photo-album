// 搜索列表的设备ID（2026-10-22）：只取本次广播厂商数据里的 6 字节 Device_ID，按原顺序展示，
// 安卓/iOS 同一来源；取不到统一显示 --。不用微信 BLE deviceId（安卓是字节序相反的系统蓝牙地址、
// iOS 是随机 UUID），也不用共享扫描会话里之前累计的结果。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const root = path.join(__dirname, '..')
const deviceIdUtil = require('../utils/device-id')
const protocol = require('../utils/frame-protocol')

// EB-169 实测：设备ID 37:0B:00:D0:44:5A，手机系统蓝牙地址 5A:44:D0:00:0B:37
const REAL_ID = '37:0B:00:D0:44:5A'
const SYSTEM_MAC = '5A:44:D0:00:0B:37'
const EB169_AD = [0xff, 0xff, 0x04, 0x37, 0x0b, 0x00, 0xd0, 0x44, 0x5a, 0x61]
let checks = 0
function checked(name) { checks++; console.log('PASS ' + name) }

function loadBindPage() {
  let definition
  const state = {}
  const dependencies = {
    // 2026-10-23 起 applyScanResult 按广播名补 sizeModel（api.scanSizeModel），桩要提供它，
    // 否则列表渲染直接抛错；本用例不关心尺寸，按「匹配不到」返回空串
    api: { scanSizeModel: () => '' },
    toast: { warn() {} },
    permission: { getCurrentLocation: async () => ({ latitude: 0, longitude: 0 }) },
    bluetooth: { openAdapter: async () => {}, stopDiscovery() {}, showEmptyResultGuide() {}, discoverDevices: async options => { state.scanOptions = options; return [] } },
    'device-ble': {},
    'active-device': { friendlyConnectMessage: text => text },
    'device-id': deviceIdUtil,
    'device-name': {}, system: {}, 'fold-adapt': { adapt: value => value },
    // 2026-10-22 搜索结果按广播名算设备图，注入真实模块（纯函数，无副作用）
    'device-thumb': require('../utils/device-thumb')
  }
  vm.runInNewContext(fs.readFileSync(path.join(root, 'subpackages/device/bind/bind.js'), 'utf8'), {
    require: target => dependencies[target.split('/').at(-1)],
    getApp: () => ({ globalData: {} }),
    Page: value => { definition = value },
    wx: { showLoading() {}, hideLoading() {}, navigateBack() {} },
    console: { log() {}, warn() {} }, setTimeout: () => 0
  }, { filename: 'bind.js' })
  const page = { ...definition, data: JSON.parse(JSON.stringify(definition.data)), scanSeq: 1, setData(values) { Object.assign(this.data, values) } }
  return { page, state }
}

function loadBluetooth() {
  let handler
  const sandbox = { module: { exports: {} }, require: target => target === './frame-protocol' ? protocol : {}, console, setTimeout, clearTimeout, wx: {
    openBluetoothAdapter() {},
    onBluetoothDeviceFound: value => { handler = value }, offBluetoothDeviceFound() {},
    startBluetoothDevicesDiscovery: options => options.success({}),
    stopBluetoothDevicesDiscovery: options => options.success && options.success({})
  } }
  vm.runInNewContext(fs.readFileSync(path.join(root, 'utils/bluetooth.js'), 'utf8'), sandbox, { filename: 'bluetooth.js' })
  return { bluetooth: sandbox.module.exports, emit: devices => handler({ devices }) }
}

const raw = (handle, ad = EB169_AD, name = 'EB-169') => ({ deviceId: handle, name, RSSI: -63, advertisData: Uint8Array.from(ad).buffer })

async function main() {
  // ── 列表展示：只认广播里的完整 6 字节，否则 -- ──
  const { page } = loadBindPage()
  const row = values => ({ id: SYSTEM_MAC, deviceId: SYSTEM_MAC, name: 'EB-169', realBluetooth: true, ...values })
  page.applyScanResult(1, [row({ broadcastDeviceId: REAL_ID })])
  assert.equal(page.data.devices[0].deviceCode, REAL_ID)
  checked('广播6字节按原顺序展示')

  for (const example of [
    row({ broadcastDeviceId: '' }), // 安卓：只有系统蓝牙地址
    row({ id: 'UUID-HANDLE', deviceId: '0F7A3C2E-9B1D-4E55-8A6B-2C9D1E0F4A77', broadcastDeviceId: '' }), // iOS
    row({ broadcastDeviceId: '00:C1:B4:59' }), // 4 字节
    row({ broadcastDeviceId: '00:00:00:00:00:00' }),
    row({ broadcastDeviceId: 'FF:FF:FF:FF:FF:FF' }),
    row({ broadcastDeviceId: '', deviceNo: REAL_ID, productDeviceId: REAL_ID, deviceCode: REAL_ID }) // 旧字段/缓存
  ]) {
    page.applyScanResult(1, [example])
    assert.equal(page.data.devices[0].deviceCode, '--', '系统蓝牙地址、UUID、短ID、无效ID、旧字段都不能当设备ID')
  }
  checked('取不到完整广播ID时统一显示--，不用系统地址/UUID/缓存兜底')

  const searching = loadBindPage()
  searching.page.data.devices = [row({ deviceCode: REAL_ID })]
  searching.page.data.selectedId = SYSTEM_MAC
  await searching.page.scan()
  assert.equal(searching.page.data.devices.length, 0)
  assert.equal(searching.state.scanOptions.freshOnly, true)
  checked('每轮搜索清空列表，并只接收本次新广播')

  // ── 扫描层：EB-169 真实广播 → 列表字段 ──
  {
    const { bluetooth, emit } = loadBluetooth()
    const updates = []
    const scan = bluetooth.discoverDevices({ allowAll: true, freshOnly: true, timeout: 30, onUpdate: list => updates.push(list) })
    emit([raw(SYSTEM_MAC)])
    const result = await scan
    assert.equal(result[0].broadcastDeviceId, REAL_ID)
    assert.equal(result[0].battery, 97)
    assert.equal(result[0].broadcastCompanyMatched, true)
    assert.equal(result[0].advertisHex, 'FF FF 04 37 0B 00 D0 44 5A 61')
    assert.equal(updates.length, 1)
    checked('EB-169 广播（屏型0x04）解析出设备ID、电量与原始数据')
  }

  // ── 白名单：设备名缺席时，带 0xFFFF 的本产品广播不因屏型不认识被挡 ──
  {
    const { bluetooth, emit } = loadBluetooth()
    // 非 allowAll：白名单走 loadAllowedBroadcastIds，api 桩取不到时退回内置兜底名单
    const scan = bluetooth.discoverDevices({ freshOnly: true, timeout: 30 })
    await new Promise(resolve => setTimeout(resolve, 0))
    emit([raw(SYSTEM_MAC, EB169_AD, ''), raw('stranger', [0x01, 0x02, 0x03], '')])
    const result = await scan
    assert.deepEqual(Array.from(result, item => item.deviceId), [SYSTEM_MAC])
    checked('名称缺席时按 0xFFFF 厂商数据放行，不再要求屏型认识')
  }

  // ── 不用共享扫描会话的存量结果 ──
  {
    const { bluetooth, emit } = loadBluetooth()
    const freshUpdates = []
    const first = bluetooth.discoverDevices({ allowAll: true, timeout: 100 })
    emit([raw(SYSTEM_MAC), raw('old-only')])
    const fresh = bluetooth.discoverDevices({ allowAll: true, freshOnly: true, timeout: 40, onUpdate: list => freshUpdates.push(JSON.parse(JSON.stringify(list))) })
    assert.equal(freshUpdates.length, 0, '新订阅不能立即收到之前存下的设备')
    emit([raw(SYSTEM_MAC)])
    assert.equal(freshUpdates.length, 1, '相同广播首次在新订阅收到时也要通知页面')
    assert.deepEqual(freshUpdates[0].map(item => item.deviceId), [SYSTEM_MAC])
    checked('共享扫描存量不进入新搜索，新收到的广播即时展示')

    emit([raw(SYSTEM_MAC, [0xff, 0xff, 0x04, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0x01, 0x61])])
    assert.equal(freshUpdates.length, 2, '只变化广播设备ID也必须触发更新')
    assert.equal(freshUpdates[1][0].broadcastDeviceId, 'AA:BB:CC:DD:EE:01')
    emit([{ deviceId: SYSTEM_MAC, name: 'EB-169', RSSI: -50 }])
    assert.equal(freshUpdates.at(-1)[0].broadcastDeviceId, '', '最新一帧不含ID时不沿用前一帧')
    checked('广播设备ID变化即更新，缺ID不沿用旧值')

    const empty = bluetooth.discoverDevices({ allowAll: true, freshOnly: true, timeout: 20 })
    assert.equal((await empty).length, 0, '本轮未收到任何广播，不回落历史设备')
    assert.deepEqual(Array.from(await fresh, item => item.deviceId), [SYSTEM_MAC])
    await first
    checked('本轮无新广播时列表为空')
  }

  console.log(`search-device-id: ${checks} groups passed`)
}
main().catch(error => { console.error(error); process.exitCode = 1 })
