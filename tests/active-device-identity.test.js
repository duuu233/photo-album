const assert = require('assert')
const activeDevice = require('../utils/active-device')

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

// 老记录若只有广播短 ID，仍保留兼容；这类记录本身无法区分短 ID 相同的两台设备。
assert.strictEqual(
  activeDevice.deviceInfoMatches(
    { productDeviceId: sharedBroadcastId },
    { deviceId: deviceA }
  ),
  true
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

console.log('active-device identity tests passed')
