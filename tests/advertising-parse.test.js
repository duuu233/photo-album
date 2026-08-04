// 广播厂商数据解析（frame-protocol.parseAdvertising，协议 6.10.7）。
//
// 2026-08-04：Device_ID 由 4 字节扩到 6 字节（完整 MAC），灰度期新老固件并存，
// 解析必须两种布局都认。锁成回归用例的原因：老代码把 Device_ID 的第 5 个字节当电量时，
// **校验碰巧通过就会静默给出错误的设备ID + 错误的电量**，没有任何报错，线上极难发现。
const assert = require('assert')
const protocol = require('../utils/frame-protocol')

// 屏型 0x02 = 5.89寸 EF6-589（与设备广播名 EF6-589 对应）
const SCREEN_589 = 0x02
const SCREEN_370 = 0x01

// ── 老固件：Company_ID(2) + 屏型(1) + Device_ID(4) + 电量(1) = 8 字节 ──
// 取自真机抓包：<FFFF> 0200 C1B4 592E（设备名 EF6-589、电量 0x2E=46%）
{
  const old = [0xff, 0xff, SCREEN_589, 0x00, 0xc1, 0xb4, 0x59, 0x2e]
  const parsed = protocol.parseAdvertising(old)
  assert.ok(parsed, '老固件广播必须能解析')
  assert.strictEqual(parsed.screenType, SCREEN_589)
  assert.strictEqual(parsed.model, 'EF6-589')
  assert.strictEqual(parsed.deviceId, '00:C1:B4:59')
  assert.strictEqual(parsed.battery, 46)
  // 4 字节不是完整身份，展示层据此知道它还不能与详情页对齐
  assert.strictEqual(parsed.deviceIdComplete, false)
}

// ── 新固件：Company_ID(2) + 屏型(1) + Device_ID(6) + 电量(1) = 10 字节 ──
{
  const fresh = [0xff, 0xff, SCREEN_589, 0xe9, 0x48, 0xc2, 0x1e, 0xd4, 0x28, 0x5a]
  const parsed = protocol.parseAdvertising(fresh)
  assert.ok(parsed, '新固件广播必须能解析')
  assert.strictEqual(parsed.screenType, SCREEN_589)
  assert.strictEqual(parsed.deviceId, 'E9:48:C2:1E:D4:28')
  assert.strictEqual(parsed.battery, 0x5a) // 90%
  assert.strictEqual(parsed.deviceIdComplete, true)
}

// ── 长度够 8 就**只按新版解**，绝不回退老版 ──
// 这条是防「静默错值」的关键：若回退成 4 字节布局，会把 ID 第 5 字节(0x28=40)当电量，
// 校验能通过 → 悄悄给出 deviceId=E9:48:C2:1E、battery=40，全错且无任何报错。
{
  const fresh = [0xff, 0xff, SCREEN_589, 0xe9, 0x48, 0xc2, 0x1e, 0x28, 0x99, 0x5a]
  const parsed = protocol.parseAdvertising(fresh)
  assert.ok(parsed)
  assert.strictEqual(parsed.deviceId, 'E9:48:C2:1E:28:99')
  assert.strictEqual(parsed.battery, 0x5a)
}

// ── 不带 Company_ID 前缀的平台（偏移 0）同样支持两种长度 ──
{
  const oldNoCompany = [SCREEN_370, 0x00, 0xc1, 0xb4, 0x59, 0x2e]
  const parsed = protocol.parseAdvertising(oldNoCompany)
  assert.ok(parsed)
  assert.strictEqual(parsed.model, 'EF6-370')
  assert.strictEqual(parsed.deviceId, '00:C1:B4:59')
  assert.strictEqual(parsed.deviceIdComplete, false)
}
{
  const freshNoCompany = [SCREEN_370, 0xe9, 0x48, 0xc2, 0x1e, 0xd4, 0x28, 0x64]
  const parsed = protocol.parseAdvertising(freshNoCompany)
  assert.ok(parsed)
  assert.strictEqual(parsed.deviceId, 'E9:48:C2:1E:D4:28')
  assert.strictEqual(parsed.battery, 100) // 0x64，边界值合法
  assert.strictEqual(parsed.deviceIdComplete, true)
}

// ── 非相框广播一律返回 null（屏型不认识 / 电量非法 / 长度不够） ──
assert.strictEqual(protocol.parseAdvertising([0xff, 0xff, 0x09, 0x01, 0x02, 0x03, 0x04, 0x05]), null)
assert.strictEqual(
  protocol.parseAdvertising([0xff, 0xff, SCREEN_589, 0x00, 0xc1, 0xb4, 0x59, 0x65]),
  null,
  '电量 0x65=101 超出合法范围，不是本产品广播'
)
assert.strictEqual(protocol.parseAdvertising([0xff, 0xff, SCREEN_589]), null)
assert.strictEqual(protocol.parseAdvertising([]), null)

console.log('advertising parse tests passed')
