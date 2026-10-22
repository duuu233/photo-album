// 广播厂商数据解析（frame-protocol.parseAdvertising，协议 6.10.7）。
//
// 布局：Company_ID(2=0xFFFF) + 屏型(1) + Device_ID(6) + 电量(1)。2026-10-22 起只认 6 字节 Device_ID，
// 4 字节老格式不再兼容；设备ID按广播原顺序取，且**不受屏型/电量是否认识影响**
//（此前屏型不认识就整条丢弃，EB-169 的 0x04 因此连设备ID一起丢失）。
const assert = require('assert')
const protocol = require('../utils/frame-protocol')

// 屏型 0x02 = 5.89寸 EF6-589（与设备广播名 EF6-589 对应）
const SCREEN_589 = 0x02

// ── EB-169 实测：第三方蓝牙工具 Manufacturer data <0xFFFF> 0x04370B00D0445A61 ──
// 正确设备ID为 37:0B:00:D0:44:5A（产品确认）；手机系统给的蓝牙地址 5A:44:D0:00:0B:37 是它的倒序。
const EB169 = [0xff, 0xff, 0x04, 0x37, 0x0b, 0x00, 0xd0, 0x44, 0x5a, 0x61]
{
  const parsed = protocol.parseAdvertising(EB169)
  assert.ok(parsed, '屏型 0x04 不在屏型表里也必须解析出设备ID')
  assert.strictEqual(parsed.deviceId, '37:0B:00:D0:44:5A', '按广播原顺序，不倒序')
  assert.strictEqual(parsed.battery, 97)
  assert.strictEqual(parsed.companyMatched, true)
  assert.strictEqual(parsed.screenType, 0, '不认识的屏型记 0，只是不给尺寸/型号')
  assert.strictEqual(parsed.screen, '')
}
{
  // 同一份数据从 ArrayBuffer 传入（微信 advertisData 的实际类型）
  const parsed = protocol.parseAdvertising(Uint8Array.from(EB169).buffer)
  assert.strictEqual(parsed.deviceId, '37:0B:00:D0:44:5A')
}
{
  // 不带 Company_ID 前缀的平台：恰好 8 字节
  const parsed = protocol.parseAdvertising(EB169.slice(2))
  assert.ok(parsed)
  assert.strictEqual(parsed.deviceId, '37:0B:00:D0:44:5A')
  assert.strictEqual(parsed.battery, 97)
  assert.strictEqual(parsed.companyMatched, false)
}

// ── 已知屏型照常给出尺寸/型号 ──
{
  const fresh = [0xff, 0xff, SCREEN_589, 0xe9, 0x48, 0xc2, 0x1e, 0xd4, 0x28, 0x5a]
  const parsed = protocol.parseAdvertising(fresh)
  assert.strictEqual(parsed.screenType, SCREEN_589)
  assert.strictEqual(parsed.model, 'EF6-589')
  assert.strictEqual(parsed.deviceId, 'E9:48:C2:1E:D4:28')
  assert.strictEqual(parsed.battery, 0x5a) // 90%
}
{
  const parsed = protocol.parseAdvertising([0xff, 0xff, SCREEN_589, 0xe9, 0x48, 0xc2, 0x1e, 0xd4, 0x28, 0x64])
  assert.strictEqual(parsed.battery, 100) // 0x64，边界值合法
}

// ── 电量非法只置空电量，设备ID照常 ──
{
  const parsed = protocol.parseAdvertising([0xff, 0xff, SCREEN_589, 0xe9, 0x48, 0xc2, 0x1e, 0xd4, 0x28, 0x65])
  assert.ok(parsed)
  assert.strictEqual(parsed.battery, undefined, '电量 0x65=101 超出合法范围')
  assert.strictEqual(parsed.deviceId, 'E9:48:C2:1E:D4:28')
}

// ── 4 字节老格式不再解析，避免给出错误的设备ID ──
// 带前缀的老包整包 8 字节，与不带前缀的新包等长：以 0xFFFF 开头的必须按带前缀处理，返回 null，
// 不能被误读成 FF:02:00:C1:B4:59 这种错误ID。
assert.strictEqual(protocol.parseAdvertising([0xff, 0xff, SCREEN_589, 0x00, 0xc1, 0xb4, 0x59, 0x2e]), null)
assert.strictEqual(protocol.parseAdvertising([SCREEN_589, 0x00, 0xc1, 0xb4, 0x59, 0x2e]), null)

// ── 长度不符一律返回 null ──
assert.strictEqual(protocol.parseAdvertising([0xff, 0xff, SCREEN_589]), null)
assert.strictEqual(protocol.parseAdvertising([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]), null)
assert.strictEqual(protocol.parseAdvertising([]), null)
assert.strictEqual(protocol.parseAdvertising(undefined), null)

console.log('advertising parse tests passed')
