const assert = require('assert')
const deviceId = require('../utils/device-id')
const protocol = require('../utils/frame-protocol')
const api = require('../utils/api')
const http = require('../utils/request')

assert.strictEqual(deviceId.isComplete('E9:48:C2:1E:D4:28'), true)
assert.strictEqual(deviceId.isComplete('E948C21ED428'), true)
assert.strictEqual(deviceId.isComplete('C21ED428'), false)
assert.strictEqual(deviceId.isComplete('ble-device-uuid'), false)
assert.strictEqual(deviceId.isComplete('00:00:00:00:00:00'), false)
assert.strictEqual(deviceId.isComplete('FF:FF:FF:FF:FF:FF'), false)
assert.strictEqual(
  deviceId.canonical('e948c21ed428'),
  'E9:48:C2:1E:D4:28'
)
assert.strictEqual(deviceId.canonical('C21ED428'), '')
assert.strictEqual(deviceId.formatBytes('C21ED428'), 'C2:1E:D4:28')
assert.strictEqual(deviceId.formatBytes('c2:1e:d4:28'), 'C2:1E:D4:28')
assert.strictEqual(deviceId.formatBytes('not-a-device-id'), '')
assert.throws(
  () => deviceId.requireComplete('C21ED428'),
  error => error && error.code === 'INCOMPLETE_DEVICE_ID'
)
assert.throws(
  () => protocol.parseDeviceInfo(new Array(27).fill(0)),
  /设备信息长度不足/
)
const infoPayload = new Array(28).fill(0)
infoPayload.splice(0, 6, 0xE9, 0x48, 0xC2, 0x1E, 0xD4, 0x28)
assert.strictEqual(
  protocol.parseDeviceInfo(infoPayload).deviceId,
  'E9:48:C2:1E:D4:28'
)
assert.throws(
  () =>
    api.addUserProduct({
      productId: 'product-a',
      productName: '相框',
      deviceId: 'C21ED428'
    }),
  error => error && error.code === 'INCOMPLETE_DEVICE_ID'
)

const originalPost = http.post
try {
  http.post = (url, data) => ({ url, data })
  const request = api.addUserProduct({
    productId: 'product-a',
    productName: '相框',
    deviceId: 'e948c21ed428'
  })
  assert.strictEqual(request.url, '/Client/UserProduct/addUserProduct')
  assert.strictEqual(request.data.deviceId, 'E9:48:C2:1E:D4:28')
} finally {
  http.post = originalPost
}

;(async () => {
  const originalGetUserProductList = api.getUserProductList
  try {
    api.getUserProductList = () =>
      Promise.resolve([
        {
          userProductId: 'record-full',
          productName: '完整设备',
          deviceId: 'e948c21ed428'
        },
        {
          userProductId: 'record-empty',
          productName: '空设备ID',
          deviceId: ''
        },
        {
          userProductId: 'record-short',
          productName: '短设备ID',
          deviceId: 'C21ED428'
        },
        {
          // 老记录：历史 4 字节短 ID 存在 deviceNo，完整 6 字节在 deviceId。
          // 候选按「第一个非空」取会取到短的 → 身份归零 → 设备明明有完整 ID，
          // 连接/OTA 仍被报「缺少完整的6字节设备ID，请删除后重新绑定」。完整值必须优先。
          userProductId: 'record-legacy-short-first',
          productName: '短ID在前的老记录',
          deviceNo: 'C21ED428',
          deviceId: 'e948c21ed42a'
        }
      ])
    const devices = await api.getDevices()
    assert.strictEqual(devices[0].productDeviceId, 'E9:48:C2:1E:D4:28')
    assert.strictEqual(devices[0].deviceId, '')
    assert.strictEqual(devices[1].productDeviceId, '')
    assert.strictEqual(devices[2].productDeviceId, '')
    assert.strictEqual(devices[2].deviceIdentityInvalid, true)
    assert.strictEqual(devices[3].productDeviceId, 'E9:48:C2:1E:D4:2A')
    assert.strictEqual(devices[3].deviceNo, 'E9:48:C2:1E:D4:2A')
    assert.strictEqual(devices[3].deviceIdentityInvalid, false)
  } finally {
    api.getUserProductList = originalGetUserProductList
  }

  console.log('device-id tests passed')
})().catch(error => {
  console.error(error)
  process.exitCode = 1
})
