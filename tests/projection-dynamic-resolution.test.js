const assert = require('assert')
const protocol = require('../utils/frame-protocol')
const { resolveTransferInfo } = require('../utils/projection-device')
const activeDevice = require('../utils/active-device')
const deviceBle = require('../utils/device-ble')
const dithering = require('../utils/dithering')

const serial = 'AA:BB:CC:DD:EE:01'
const device = { productDeviceId: serial, width: 400, height: 400, shapeType: 1, screenType: 0 }
function firmware(screenType) {
  const bytes = new Uint8Array(28)
  bytes.set([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0x01])
  bytes[26] = screenType
  return protocol.parseDeviceInfo(bytes)
}
for (const screenType of [0, 1, 2, 3, 4, 255]) {
  const raw = firmware(screenType)
  const before = JSON.stringify(raw)
  const info = resolveTransferInfo(device, raw)
  assert.strictEqual(info.width, 400)
  assert.strictEqual(info.height, 400)
  assert.strictEqual(info.screenType, screenType, '保留固件值，不能抄后台方向值')
  assert.strictEqual(info.capacity, 0, '不得用旧机型容量猜新机型容量')
  assert.strictEqual(info.slotLimit, 96, '只表示 12 字节掩码上限')
  assert.strictEqual(info.resolutionSource, 'device-list')
  assert.strictEqual(info.deviceId, serial)
  assert.strictEqual(JSON.stringify(raw), before, '不得改写原始固件解析结果')
  const payload = Buffer.from(protocol.buildImgStartPayload({
    screenType: info.screenType, index: 0, width: info.width, height: info.height, dataSize: 80000, crc32: 0
  }))
  assert.strictEqual(payload[0], screenType)
  assert.strictEqual(payload.readUInt16LE(2), 400)
  assert.strictEqual(payload.readUInt16LE(4), 400)
  assert.strictEqual(payload.readUInt32LE(7), 80000)
}
for (const screenType of [1, 2]) {
  const raw = firmware(screenType)
  const info = resolveTransferInfo({ productDeviceId: serial }, raw)
  assert.strictEqual(info.width, raw.width, '无接口尺寸的旧设备兼容回退')
  assert.strictEqual(info.height, raw.height)
  assert.strictEqual(info.capacity, raw.capacity)
  assert.strictEqual(info.slotLimit, raw.capacity)
  assert.strictEqual(info.resolutionSource, 'legacy-protocol')
}
assert.strictEqual(resolveTransferInfo({ ...device, width: '400', height: '400' }, firmware(4)).width, 400)
for (const width of [0, -1, 1.5, 65536, NaN, Infinity, true, {}, 'bad', ' ']) {
  assert.throws(() => resolveTransferInfo({ ...device, width }, firmware(1)), /分辨率未配置或无效/)
}
assert.throws(() => resolveTransferInfo({ ...device, height: undefined }, firmware(1)), /分辨率未配置或无效/)
assert.throws(() => resolveTransferInfo({ productDeviceId: serial }, firmware(4)), /分辨率未配置或无效/)
assert.throws(() => resolveTransferInfo({ ...device, height: 401 }, firmware(4)), /须为正方形/)
assert.throws(() => resolveTransferInfo({ ...device, productDeviceId: 'AA:BB:CC:DD:EE:02' }, firmware(4)), /设备ID不一致/)
assert.throws(() => resolveTransferInfo({ ...device, productDeviceId: 'CCDDEE01', deviceId: serial }, firmware(4)), /设备ID不一致/)
assert.throws(() => resolveTransferInfo(device, { ...firmware(4), imgMask: [] }), /槽位信息无效/)
assert.throws(() => resolveTransferInfo(device, { ...firmware(4), screenType: undefined }), /屏幕型号无效/)
assert.throws(() => resolveTransferInfo(device, { ...firmware(4), screenType: 256 }), /屏幕型号无效/)
assert.strictEqual(dithering.typeForDevice({ width: 400, height: 400 }), '0')
assert.strictEqual(dithering.typeForDevice({ width: 480, height: 720 }), '1')
assert.strictEqual(dithering.typeForDevice({ width: 680, height: 960 }), '0')

// 放行新分辨率不能放行另一台设备；旧机型之间的尺寸筛选仍然生效。
assert.strictEqual(activeDevice.sameScreen(device, 1), true)
assert.strictEqual(activeDevice.sameScreen(device, 2), true)
assert.strictEqual(activeDevice.sameScreen({ width: 480, height: 720 }, 2), false)
assert.strictEqual(activeDevice.sameScreen({ width: 680, height: 960 }, 1), false)
const oldConnected = deviceBle.isConnected
const oldConnections = deviceBle.getActiveConnections
try {
  deviceBle.isConnected = () => true
  deviceBle.getActiveConnections = () => [{ deviceId: 'BLE-ROUND', screenType: 1, verifiedSerials: [serial] }]
  assert.strictEqual(activeDevice.findConnectedDeviceId({ ...device, deviceId: 'BLE-ROUND' }), 'BLE-ROUND')
  assert.strictEqual(activeDevice.findConnectedDeviceId({ ...device, productDeviceId: 'AA:BB:CC:DD:EE:02', deviceId: 'BLE-ROUND' }), '')
  deviceBle.getActiveConnections = () => [{ deviceId: 'BLE-ROUND', screenType: 1, serials: [serial], verifiedSerials: [] }]
  assert.strictEqual(activeDevice.findConnectedDeviceId({ ...device, deviceId: 'BLE-ROUND' }), '', '只认广播完整ID仍不能认领')
} finally {
  deviceBle.isConnected = oldConnected
  deviceBle.getActiveConnections = oldConnections
}
console.log('projection dynamic resolution tests passed')
