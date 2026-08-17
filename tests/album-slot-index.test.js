// 「我的相册」删除的槽位口径：
//   1) 索引只认**这条投屏记录自己的 imgIndex**（2026-08-10 起不再绕 uProductImgId 关联图库照片），
//      0 是合法槽位，缺失/非法一律 -1（整批终止，不推算）；
//   2) 下发 0x12 前按设备真实 IMG_MASK 分拨：设备上已经没有的槽位跳过、仍在的照删
//      （多手机共用一台设备时，另一端删过的那张在本机列表里还在，见 splitSlotsByDeviceMask）；
//   3) 掩码本身按 v1.5 §6.7.10 转成 12 字节、低字节在前。
const assert = require('assert')
const protocol = require('../utils/frame-protocol')

// 小程序页面文件要在 wx / Page / getApp 存在时才能 require：这里只取 Page 注册的方法对象。
global.wx = new Proxy(
  {},
  {
    get: () => (options) => {
      if (options && typeof options.fail === 'function') {
        options.fail({})
      }
    }
  }
)
global.getApp = () => ({ globalData: {} })
let pageOptions = null
global.Page = (options) => {
  pageOptions = options
}
require('../subpackages/album/list/list.js')

const ctx = Object.create(pageOptions)
// 网格瓦片的来源是投屏成功记录：id=upirId、imgIndex=写进设备的槽位。
// 2026-08-17 起待删目标里不再带 photoId(uProductImgId)：那是给「删图库照片」用的，
// 而 delUserProductImg 连同整套「我的图库」接口已从端上删除。
const record = (id, imgIndex) => ({
  id,
  imgIndex,
  userProductId: 'D1',
  deviceName: '相框'
})

// ── 1) 索引取自记录自己的 imgIndex ────────────────────────────
ctx.records = [record('a', '2')]
assert.deepStrictEqual(ctx.resolveDeleteTargets(['a']), [{ id: 'a', slot: 2 }])

// 0 是合法槽位（相框第一个位置），绝不能被当成「无索引」。
ctx.records = [record('a', '0')]
assert.strictEqual(ctx.resolveDeleteTargets(['a'])[0].slot, 0)

// 缺失/非法/超出 12 字节掩码范围的索引一律 -1，调用方据此整批终止，不推算。
ctx.records = [
  record('missing', ''),
  record('invalid', '1.5'),
  record('blank', '   '),
  record('overflow', '96')
]
assert.deepStrictEqual(
  ctx.resolveDeleteTargets(['missing', 'invalid', 'blank', 'overflow']).map(t => t.slot),
  [-1, -1, -1, -1]
)
// 记录已不在列表里（另一端删过、本页尚未刷新）同样是 -1，不会误当成 0 号位
assert.strictEqual(ctx.resolveDeleteTargets(['not-found'])[0].slot, -1)

// ── 2) 按设备真实 IMG_MASK 分拨 ───────────────────────────────
// 另一端删掉了 0 号位的 A，设备上只剩 1、2 号位的 B、C：A 跳过设备侧，B/C 照删。
const maskBC = protocol.indexesToMask([1, 2])
assert.deepStrictEqual(ctx.splitSlotsByDeviceMask([0, 1, 2], maskBC), {
  onDevice: [1, 2],
  gone: [0]
})

// 选中的都已不在设备上 → onDevice 为空，调用方跳过 0x12 直接删记录。
assert.deepStrictEqual(ctx.splitSlotsByDeviceMask([5, 6], maskBC), {
  onDevice: [],
  gone: [5, 6]
})

// 设备一张图都没有（12 个 0 的合法掩码）→ 全部跳过设备侧。
const emptyMask = protocol.indexesToMask([])
assert.deepStrictEqual(ctx.splitSlotsByDeviceMask([0, 1], emptyMask).onDevice, [])

// ⚠️ 掩码读不到（null/空数组/undefined）时一张都不能判 gone，
//    否则会变成「记录全删了、图还留在设备上」。整体按 onDevice 返回，交给 0x12 的结果码兜底。
assert.deepStrictEqual(ctx.splitSlotsByDeviceMask([0, 1], null), {
  onDevice: [0, 1],
  gone: []
})
assert.deepStrictEqual(ctx.splitSlotsByDeviceMask([0, 1], []).onDevice, [0, 1])
assert.deepStrictEqual(ctx.splitSlotsByDeviceMask([0, 1], undefined).onDevice, [0, 1])

// 掩码可以是 ArrayBuffer（BLE 回来的原始形态），同样能分拨
assert.deepStrictEqual(
  ctx.splitSlotsByDeviceMask([0, 1, 2], protocol.toArrayBuffer(maskBC)),
  { onDevice: [1, 2], gone: [0] }
)

// ── 3) 良性结果码：设备上本来就没这张图，删除按已达成继续 ──────
assert.strictEqual(protocol.isSkippableDeleteResult(0x05), true) // 图片不存在
assert.strictEqual(protocol.isSkippableDeleteResult(0x07), true) // 掩码不一致
// 这些代表「可能真的没删掉」，必须如实中止
assert.strictEqual(protocol.isSkippableDeleteResult(0x04), false) // Flash 写入失败
assert.strictEqual(protocol.isSkippableDeleteResult(0x09), false) // 传输中断
assert.strictEqual(protocol.isSkippableDeleteResult(0x0b), false) // 设备忙

// 错误对象优先认 device-ble 挂上的 resultCode，文案改了也不影响判定
const codedError = new Error('电子纸设备-随便什么文案')
codedError.resultCode = 0x07
assert.strictEqual(protocol.isSkippableDeleteError(codedError), true)
const busyError = new Error('电子纸设备-掩码不一致(该位置已有图/索引越界)')
busyError.resultCode = 0x0b
assert.strictEqual(protocol.isSkippableDeleteError(busyError), false)
// 没带结果码的老链路错误退回文案匹配（带「电子纸设备-」前缀也要能认出来）
assert.strictEqual(
  protocol.isSkippableDeleteError(
    new Error('电子纸设备-掩码不一致(该位置已有图/索引越界)')
  ),
  true
)
assert.strictEqual(
  protocol.isSkippableDeleteError(new Error('电子纸设备-当前电子纸设备繁忙，请稍后重试')),
  false
)

// ── 4) v1.5 §6.7.10：删除掩码固定 12 字节、低字节在前 ─────────
assert.deepStrictEqual(
  protocol.indexesToMask([0, 2]),
  [0x05, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
)

// 跨字节位序：索引 8 → 第 2 字节 bit0，索引 95 → 第 12 字节 bit7。
const edgeMask = protocol.indexesToMask([8, 95])
assert.strictEqual(edgeMask.length, 12)
assert.strictEqual(edgeMask[1], 0x01)
assert.strictEqual(edgeMask[11], 0x80)

console.log('album-slot-index: all assertions passed')
