// 设备最多可存张数（规格书 v1.6 §5.2，2026-10-23）：EF6-370 95、EF6-589 51、EB-169 25、EC-370 11。
//
// 锁三件事：
//   ① 先按机型（broadcastId，大小写不敏感的包含匹配），认不出再按屏型；新屏型 0x04 只有 EB-169 → 25；
//      都认不出返回 0（未知，详情页显示 --），不拿旧机型容量猜；
//   ② EC-370 屏型同样报 0x01，0x01 本身只能给出 95——必须按机型给 11；
//   ③ 投屏选槽位：机型认得出就按机型容量，EC-370 不会选到 11 号及以后的槽位。
const assert = require('node:assert/strict')
const protocol = require('../utils/frame-protocol')
const { resolveTransferInfo } = require('../utils/projection-device')

// ── ① 机型优先，其次屏型 ─────────────────────────────────
assert.equal(protocol.capacityOf('EC-370', 0x01), 11)
assert.equal(protocol.capacityOf('ec-370-ABCD', 0x01), 11)
assert.equal(protocol.capacityOf('EB-169', 0x04), 25)
assert.equal(protocol.capacityOf('EF6-370', 0x01), 95)
assert.equal(protocol.capacityOf('EF6-589', 0x02), 51)
// 屏型报了不认识的码，机型认得出照样给容量
assert.equal(protocol.capacityOf('EC-370', 0x09), 11)
// 机型认不出：按屏型
assert.equal(protocol.capacityOf('', 0x01), 95)
assert.equal(protocol.capacityOf(undefined, 0x02), 51)
assert.equal(protocol.capacityOf('', 0x04), 25)
assert.equal(protocol.capacityOf('', 0x03), 0, '7.3寸占位无容量')
assert.equal(protocol.capacityOf('', 0x09), 0, '不认识的屏型不猜')
// broadcastId 不是广播名（如带成了设备ID）时等于认不出
assert.equal(protocol.capacityOf('37:0B:00:D0:44:5A', 0x04), 25)

// ── ② 0x01 解析：屏型给出的容量 ──────────────────────────
function firmware(screenType) {
  const bytes = new Uint8Array(28)
  bytes.set([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0x01])
  bytes[8] = 0x07 // 已存 3 张
  bytes[26] = screenType
  return protocol.parseDeviceInfo(bytes)
}
assert.equal(firmware(0x04).capacity, 25, 'EB-169 的 0x04 要读得出容量')
assert.equal(firmware(0x04).width, 0, '0x04 不给尺寸，尺寸以设备列表为准')
assert.equal(firmware(0x01).capacity, 95)
assert.equal(firmware(0x09).capacity, 0)
assert.equal(firmware(0x04).imgCount, 3)

// ── ③ 投屏槽位上限 ───────────────────────────────────────
const serial = 'AA:BB:CC:DD:EE:01'
{
  const info = resolveTransferInfo(
    { productDeviceId: serial, broadcastId: 'EC-370', width: 480, height: 720 },
    firmware(0x01)
  )
  assert.equal(info.capacity, 11)
  assert.equal(info.slotLimit, 11)
}
{
  const info = resolveTransferInfo(
    { productDeviceId: serial, broadcastId: 'EB-169', width: 400, height: 400, shapeType: 1 },
    firmware(0x04)
  )
  assert.equal(info.capacity, 25)
  assert.equal(info.slotLimit, 25)
}
{
  // 认不出机型：维持原口径（同尺寸取 0x01 容量）
  const info = resolveTransferInfo(
    { productDeviceId: serial, width: 480, height: 720 },
    firmware(0x01)
  )
  assert.equal(info.capacity, 95)
}

console.log('device-capacity tests passed')
