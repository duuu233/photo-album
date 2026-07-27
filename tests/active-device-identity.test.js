const assert = require('assert')
const activeDevice = require('../utils/active-device')
const deviceBle = require('../utils/device-ble')

const deviceA = 'E948C21ED428'
const deviceB = 'E448C21ED428'
const sharedBroadcastId = 'C21ED428'

// 广播只带 4 字节时，同批次设备可能同时命中；它只能用于筛候选，不能作为最终身份。
assert.strictEqual(activeDevice.serialsMatch(sharedBroadcastId, deviceA), true)
assert.strictEqual(activeDevice.serialsMatch(sharedBroadcastId, deviceB), true)

// 一旦 0x01 已读到完整 ID，完整 ID 冲突必须压过相同的广播短 ID。
assert.strictEqual(
  activeDevice.serialSetsMatch(
    [sharedBroadcastId, deviceB],
    [sharedBroadcastId, deviceA]
  ),
  false
)
assert.strictEqual(
  activeDevice.serialSetsMatch(
    [sharedBroadcastId, deviceA],
    [sharedBroadcastId, deviceA]
  ),
  true
)

assert.strictEqual(
  activeDevice.deviceInfoMatches({ productDeviceId: deviceA }, { deviceId: deviceA }),
  true
)
assert.strictEqual(
  activeDevice.deviceInfoMatches({ productDeviceId: deviceA }, { deviceId: deviceB }),
  false
)

// 设备身份统一要求完整 6 字节 ID；只有广播短 ID 的老记录不得再通过身份校验。
assert.strictEqual(
  activeDevice.deviceInfoMatches(
    { productDeviceId: sharedBroadcastId },
    { deviceId: deviceA }
  ),
  false
)

// 两条后端用户设备记录都有主键时，主键不同不得因短 ID 相同而合并连接状态。
assert.strictEqual(
  activeDevice.devicesMatch(
    {
      id: 'record-a',
      userProductId: 'record-a',
      productDeviceId: sharedBroadcastId
    },
    {
      id: 'record-b',
      userProductId: 'record-b',
      productDeviceId: sharedBroadcastId
    }
  ),
  false
)

// 一侧是后端记录、另一侧是旧 selectedDevice：只有相同的广播短 ID 不足以复制 BLE 句柄。
assert.strictEqual(
  activeDevice.devicesMatch(
    {
      id: 'record-a',
      userProductId: 'record-a',
      productDeviceId: deviceA
    },
    {
      id: 'legacy-selection',
      productDeviceId: sharedBroadcastId
    }
  ),
  false
)

// 绑定后尚未回查 userProductId 的临时对象，只要双方完整硬件 ID 相等仍可安全合并。
assert.strictEqual(
  activeDevice.devicesMatch(
    {
      id: 'record-a',
      userProductId: 'record-a',
      productDeviceId: deviceA
    },
    {
      id: 'temporary-bind-result',
      productDeviceId: deviceA
    }
  ),
  true
)

// 即便 A 的页面对象误带了 B 的 BLE 句柄，活动会话的完整 ID 也必须阻止 A 认领它。
const originalIsConnected = deviceBle.isConnected
const originalGetActiveConnections = deviceBle.getActiveConnections
try {
  deviceBle.isConnected = deviceId => deviceId === 'ble-b'
  deviceBle.getActiveConnections = () => [
    {
      deviceId: 'ble-b',
      serials: [sharedBroadcastId, deviceB]
    }
  ]

  assert.strictEqual(
    activeDevice.findConnectedDeviceId({
      id: 'record-a',
      userProductId: 'record-a',
      productDeviceId: deviceA,
      deviceId: 'ble-b'
    }),
    ''
  )
  assert.strictEqual(
    activeDevice.findConnectedDeviceId({
      id: 'record-b',
      userProductId: 'record-b',
      productDeviceId: deviceB,
      deviceId: 'ble-b'
    }),
    'ble-b'
  )
  assert.strictEqual(
    activeDevice.findConnectedDeviceId({
      id: 'legacy-short-record',
      userProductId: 'legacy-short-record',
      productDeviceId: sharedBroadcastId,
      deviceId: 'ble-b'
    }),
    ''
  )

  const reconciled = activeDevice.reconcileConnectionFlags([
    {
      id: 'record-a',
      userProductId: 'record-a',
      productDeviceId: deviceA,
      deviceId: 'ble-b'
    },
    {
      id: 'record-b',
      userProductId: 'record-b',
      productDeviceId: deviceB,
      deviceId: 'ble-b'
    }
  ])
  assert.strictEqual(reconciled[0].connected, false)
  assert.strictEqual(reconciled[0].deviceId, '')
  assert.strictEqual(reconciled[1].connected, true)
  assert.strictEqual(reconciled[1].deviceId, 'ble-b')
} finally {
  deviceBle.isConnected = originalIsConnected
  deviceBle.getActiveConnections = originalGetActiveConnections
}

console.log('active-device identity tests passed')
