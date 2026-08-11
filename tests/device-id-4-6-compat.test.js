// 广播 Device_ID 4 字节(老固件) / 6 字节(新固件) 两种场景都要能连上（2026-08-11）。
//
// 现场：设备 OTA 升级成功后「暴露出来的设备ID 从 4 位换成了 6 位」，正式入口从此连不上，
// 而调试台看着还能连（调试台 allowAll 扫描 + 按 BLE 句柄直连，既不按名字过滤也不做身份匹配）。
// 这组用例锁住三层兼容点，改回任何一处都会失败：
//   ① 广播解析：长度优选的布局解不通时回退另一种，别让整台设备从扫描列表里消失；
//   ② 候选筛选：广播 6 字节与 0x01 的 6 字节写法不同（倒序/取别的段）时仍要筛得出候选；
//   ③ 身份闸不放宽：广播值（哪怕已是 12 hex）不得认领活动会话，认领只认 0x01 读回的值。
const assert = require('assert')
const protocol = require('../utils/frame-protocol')
const activeDevice = require('../utils/active-device')
const deviceBle = require('../utils/device-ble')

const SCREEN_370 = 0x01
const SCREEN_589 = 0x02

// ── ① 广播解析：布局与假设不符时回退，不再整条丢弃 ──────────────────────
{
  // 10 字节厂商数据，但字段顺序不是「屏型1 + ID6 + 电量1」：按新布局取到的"电量"= 0xFF(255) 非法。
  // 老代码在这里返回 null → 这台设备在正式入口既没有屏型也没有 ID，筛不出候选 = 搜不到 / 连不上。
  const odd = [0xff, 0xff, SCREEN_589, 0x00, 0xc1, 0xb4, 0x59, 0x2e, 0xff, 0xff]
  const parsed = protocol.parseAdvertising(odd)
  assert.ok(parsed, '新布局解不通时必须回退老布局，而不是整条丢弃')
  assert.strictEqual(parsed.deviceId, '00:C1:B4:59')
  assert.strictEqual(parsed.battery, 46)
  assert.strictEqual(parsed.deviceIdComplete, false)
  assert.strictEqual(parsed.deviceIdLayoutFallback, true, '回退解出来的必须打标记，供上层辨别')
  assert.strictEqual(parsed.companyMatched, true)
}

{
  // 正常的新固件包：新布局解得通，就绝不回退（回退会把 ID 第 5 字节当电量，静默给错值）
  const fresh = [0xff, 0xff, SCREEN_589, 0xe9, 0x48, 0xc2, 0x1e, 0xd4, 0x28, 0x5a]
  const parsed = protocol.parseAdvertising(fresh)
  assert.strictEqual(parsed.deviceId, 'E9:48:C2:1E:D4:28')
  assert.strictEqual(parsed.battery, 0x5a)
  assert.strictEqual(parsed.deviceIdComplete, true)
  assert.strictEqual(parsed.deviceIdLayoutFallback, false)
}

{
  // 没有 0xFFFF Company_ID 前缀时不能声称"确认是本产品"——扫描白名单据此放行，宁紧勿松
  const noCompany = [SCREEN_370, 0x00, 0xc1, 0xb4, 0x59, 0x2e]
  const parsed = protocol.parseAdvertising(noCompany)
  assert.ok(parsed)
  assert.strictEqual(parsed.companyMatched, false)
}

// ── ② 候选筛选：广播 ID 的写法变了也要筛得出 ────────────────────────────
const completeId = 'E9:48:C2:1E:D4:28'
const normalized = 'E948C21ED428'

// 老固件 4 字节（是完整 ID 的后缀）——原有行为不能破
assert.strictEqual(activeDevice.broadcastCandidateMatch('C21ED428', completeId), true)
// 新固件 6 字节且与 0x01 完全一致
assert.strictEqual(activeDevice.broadcastCandidateMatch(normalized, completeId), true)
// 新固件 6 字节但字节序相反（BLE 协议层的 MAC 是小端序，固件直接内存拷贝就会是倒序）
assert.strictEqual(activeDevice.broadcastCandidateMatch('28D41EC248E9', completeId), true)
// 新固件 6 字节但取的是别的段：末 4 字节与完整 ID 的前 4 字节重合
assert.strictEqual(activeDevice.broadcastCandidateMatch('1122E948C21E', completeId), true)
// 毫无关系的另一台设备：仍然筛不出（放宽的是候选判据，不是"什么都算同一台"）
assert.strictEqual(activeDevice.broadcastCandidateMatch('A1B2C3D4E5F6', completeId), false)

// serialsMatch 本身保持严格：它还用于活动会话认领，那里没有 0x01 兜底
assert.strictEqual(activeDevice.serialsMatch('28D41EC248E9', completeId), false)

{
  // 扫描结果里这台设备播的是倒序 6 字节：必须能筛成候选（连上后仍要过 0x01 校验）
  const device = { productDeviceId: completeId, width: 680, height: 960 }
  const found = [
    { deviceId: 'ble-other', deviceNo: 'A1B2C3D4E5F6', screenType: SCREEN_589 },
    { deviceId: 'ble-target', deviceNo: '28:D4:1E:C2:48:E9', screenType: SCREEN_589 }
  ]
  const hit = activeDevice.matchScannedDevice(found, device)
  assert.ok(hit && hit.deviceId === 'ble-target', '倒序 6 字节广播必须仍能筛出候选')

  // 型号/尺寸对不上的一律不要：防串到别的型号设备（这道闸不因放宽候选而失效）
  const wrongScreen = [
    { deviceId: 'ble-370', deviceNo: '28:D4:1E:C2:48:E9', screenType: SCREEN_370 }
  ]
  assert.strictEqual(activeDevice.matchScannedDevice(wrongScreen, device), null)

  // 强匹配优先：同批设备共享 OUI，前 4 字节锚段可能偶合到邻居设备（列表里还排在前面），
  // 整串对得上的那台必须先被挑走，别让弱匹配把连接引到隔壁那台去。
  const withNeighbour = [
    { deviceId: 'ble-neighbour', deviceNo: 'E948C21E9999', screenType: SCREEN_589 },
    { deviceId: 'ble-exact', deviceNo: completeId, screenType: SCREEN_589 }
  ]
  const picked = activeDevice.matchScannedDevice(withNeighbour, device)
  assert.ok(picked && picked.deviceId === 'ble-exact', '整串对得上的候选必须优先于 4 字节锚段偶合的')
}

{
  // 兜底候选：按序列号一个都筛不出时，才在「确认是本产品广播 + 同型号」里挑信号最强的一台试连
  const device = { productDeviceId: completeId, width: 680, height: 960 }
  const found = [
    // 不是本产品广播（没解出 Company_ID）：不参与兜底
    { deviceId: 'ble-stranger', screenType: SCREEN_589, RSSI: -40 },
    // 本产品广播但型号不符：不参与兜底
    { deviceId: 'ble-370', broadcastCompanyMatched: true, screenType: SCREEN_370, RSSI: -45 },
    { deviceId: 'ble-weak', broadcastCompanyMatched: true, screenType: SCREEN_589, RSSI: -80 },
    { deviceId: 'ble-strong', broadcastCompanyMatched: true, screenType: SCREEN_589, RSSI: -55 }
  ]
  const fallback = activeDevice.matchScannedDeviceFallback(found, device)
  assert.ok(fallback && fallback.deviceId === 'ble-strong', '兜底候选取同型号里信号最强的一台')

  assert.strictEqual(
    activeDevice.matchScannedDeviceFallback(
      [{ deviceId: 'ble-stranger', screenType: SCREEN_589, RSSI: -40 }],
      device
    ),
    null,
    '不是本产品广播就没有兜底候选，不能见谁连谁'
  )
}

// ── ③ 身份闸不放宽：6 字节广播不得认领活动会话 ──────────────────────────
const otherComplete = 'A1B2C3D4E5F6'
const originalIsConnected = deviceBle.isConnected
const originalGetActiveConnections = deviceBle.getActiveConnections
try {
  // 会话连的其实是另一台设备(0x01 读回 otherComplete)，但它广播出来的 6 字节恰好等于本记录的完整 ID。
  // 广播是明文、可被伪造重放；一旦它能认领会话，投屏/删图/OTA 就会打到错的设备上。
  deviceBle.isConnected = () => true
  deviceBle.getActiveConnections = () => [
    {
      deviceId: 'ble-x',
      serials: [normalized, otherComplete],
      verifiedSerials: [otherComplete],
      screenType: SCREEN_589
    }
  ]
  assert.strictEqual(
    activeDevice.findConnectedDeviceId({
      id: 'record-mine',
      userProductId: 'record-mine',
      productDeviceId: completeId
    }),
    '',
    '广播里的 6 字节 ID 不得认领活动会话'
  )
  assert.strictEqual(
    activeDevice.findConnectedDeviceId({
      id: 'record-other',
      userProductId: 'record-other',
      productDeviceId: otherComplete
    }),
    'ble-x',
    '0x01 核实过的完整 ID 才能认领会话'
  )

  // 会话没有 verifiedSerials 字段（旧版本残留 / 尚未读过 0x01）时回落到 serials：
  // 不能因为多了一道闸就把正连着的设备判成断联。
  deviceBle.getActiveConnections = () => [
    { deviceId: 'ble-legacy', serials: [normalized], screenType: SCREEN_589 }
  ]
  assert.strictEqual(
    activeDevice.findConnectedDeviceId({
      id: 'record-mine',
      userProductId: 'record-mine',
      productDeviceId: completeId
    }),
    'ble-legacy'
  )
} finally {
  deviceBle.isConnected = originalIsConnected
  deviceBle.getActiveConnections = originalGetActiveConnections
}

console.log('device-id 4/6 字节兼容用例通过')
