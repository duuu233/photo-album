const assert = require('assert')
const activeDevice = require('../utils/active-device')
const deviceBle = require('../utils/device-ble')
const deviceIdentity = require('../utils/device-identity')

const deviceA = 'E948C21ED428'
const deviceB = 'E448C21ED428'
const deviceC = 'E948C21ED42A'
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

  // 同一条已核实会话，在首页/列表/详情三种页面对象结构中都必须认领为已连接。
  const pageRepresentations = [
    {
      id: 'record-b',
      userProductId: 'record-b',
      deviceNo: deviceB
    },
    {
      id: 'record-b',
      userProductId: 'record-b',
      productDeviceId: 'E4:48:C2:1E:D4:28'
    },
    {
      id: 'record-b',
      userProductId: 'record-b',
      firmwareDeviceId: deviceB,
      deviceId: 'ble-b'
    }
  ]
  pageRepresentations.forEach(device => {
    assert.strictEqual(activeDevice.findConnectedDeviceId(device), 'ble-b')
    assert.strictEqual(activeDevice.isDeviceConnected(device), true)
  })

  // 详情接口即使没返回设备 ID，也应从同一 userProductId 的已连接选中项继承完整身份。
  const inheritedDetail = activeDevice.inheritStableIdentity(
    {
      id: 'record-b',
      userProductId: 'record-b',
      name: '详情记录'
    },
    pageRepresentations[1]
  )
  assert.strictEqual(inheritedDetail.productDeviceId, 'E4:48:C2:1E:D4:28')
  assert.strictEqual(activeDevice.findConnectedDeviceId(inheritedDetail), 'ble-b')

  // 任一页面连接成功，都统一回写完整身份与当前 BLE 句柄，供另外两页直接认领。
  const connected = activeDevice.applyConnectedIdentity(
    { id: 'record-b', userProductId: 'record-b' },
    'ble-b',
    { deviceId: deviceB }
  )
  assert.strictEqual(connected.productDeviceId, 'E4:48:C2:1E:D4:28')
  assert.strictEqual(connected.deviceNo, 'E4:48:C2:1E:D4:28')
  assert.strictEqual(connected.firmwareDeviceId, 'E4:48:C2:1E:D4:28')
  assert.strictEqual(connected.deviceId, 'ble-b')
  assert.strictEqual(connected.connected, true)
  // 0x01 校验通过的完整 ID 同时进身份登记表，供之后任何页面按 userProductId 取回
  assert.strictEqual(deviceIdentity.recall('record-b'), 'E4:48:C2:1E:D4:28')

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

// 设备详情接口不返回设备 ID：身份必须与「当前选中的是哪一台」解耦。
// 实测故障：连了 A 之后再进 C 的详情，C 的记录拿不到完整 ID，点连接被身份闸报
// 「当前设备记录缺少完整的6字节设备ID，请删除后重新绑定」——设备好好的却让用户去重新绑定。
deviceIdentity.clear()
deviceIdentity.rememberMany([
  { userProductId: 'record-a', productDeviceId: deviceA },
  { userProductId: 'record-c', productDeviceId: deviceC }
])

// 当前选中的是 A（fallback 传 null 即「选中的不是这台」）：C 仍要认出自己的完整 ID
const detailC = activeDevice.inheritStableIdentity(
  { id: 'record-c', userProductId: 'record-c', name: 'C 的详情记录' },
  null
)
assert.strictEqual(detailC.productDeviceId, 'E9:48:C2:1E:D4:2A')
assert.strictEqual(detailC.deviceNo, 'E9:48:C2:1E:D4:2A')
// 且绝不能继承成当前选中设备(A)的身份
assert.notStrictEqual(detailC.productDeviceId, 'E9:48:C2:1E:D4:28')
// ensureDeviceConnected/connectBoundDevice 开头的身份闸看的就是这个：
// 有完整 ID 才放行去扫描重连，没有才报「请删除后重新绑定」
assert.ok(activeDevice.stableDeviceId(detailC))

// 记录自身带的完整 ID 永远压过登记表（登记表只是缺失时的兜底，不得反向覆盖后端最新值）
deviceIdentity.remember('record-a', deviceC)
assert.strictEqual(
  activeDevice.inheritStableIdentity(
    { userProductId: 'record-a', productDeviceId: deviceA },
    null
  ).productDeviceId,
  'E9:48:C2:1E:D4:28'
)

// 未登记过的设备不会凭空得到身份（缺 ID 仍如实缺，交由上层的身份闸拦截）
assert.strictEqual(
  activeDevice.inheritStableIdentity({ userProductId: 'record-unknown' }, null)
    .productDeviceId,
  undefined
)

// 无主键的记录（扫描结果等）不写登记表：若退到 fallback 的主键去登记，
// 就是把这台的完整 ID 记到另一台名下，等于用登记表制造串台。
deviceIdentity.clear()
activeDevice.inheritStableIdentity({ name: '扫描到的设备', productDeviceId: deviceC }, {
  userProductId: 'record-a',
  productDeviceId: deviceA
})
assert.strictEqual(deviceIdentity.recall('record-a'), '')

// 解绑后清除登记，避免后端主键复用时把旧设备的完整 ID 带回来
deviceIdentity.remember('record-c', deviceC)
deviceIdentity.forget('record-c')
assert.strictEqual(deviceIdentity.recall('record-c'), '')

// 退出登录整表清空：下一位用户的设备与这批 userProductId 无关
deviceIdentity.remember('record-a', deviceA)
deviceIdentity.clear()
assert.strictEqual(deviceIdentity.recall('record-a'), '')

console.log('active-device identity tests passed')
