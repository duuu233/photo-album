// 调试台传输参数（发包窗口 / 0x21 数据字节 / MTU）与「真实投屏默认值不受影响」的回归。
//
// 背景（2026-08-07）：设备侧优化后一次可缓 50 包、单包图片数据由 236 字节放宽到 489（MTU 500）。
// 这三项只在调试台放开成可调参数，真实投屏必须原样保持「窗口 10 / 每包 ≤236 / 请求 MTU 247」。
const assert = require('assert')
const deviceBle = require('../utils/device-ble')
const dithering = require('../utils/dithering')

// ── 真实投屏的默认口径：一个数字都不能变 ────────────────────────────────
assert.strictEqual(
  deviceBle.IMG_DATA_CHUNK_MAX,
  236,
  '真实投屏建连时仍按每包 236 字节算分包'
)
assert.strictEqual(
  deviceBle.MTU_REQUEST_DEFAULT,
  247,
  '真实投屏建连仍请求 MTU 247'
)

// 建连时算出的会话分包大小：即便链路 MTU 被调试台顶到 500，也仍夹在 236 —— 真实投屏读的是它，
// 所以调试台改 MTU 不会顺带改变真实投屏的分包大小。
assert.strictEqual(deviceBle.chunkFromMtu(247), 236)
assert.strictEqual(deviceBle.chunkFromMtu(500), 236)
assert.strictEqual(deviceBle.chunkFromMtu(185), 174, '低 MTU 时按 MTU-11 收缩')

// ── 调试台显式指定每包字节数：按 MTU 能承载的上限夹取 ──────────────────
// 整帧 = 数据 + 8 字节固定开销(SOF/CMD/LEN/CRC)，蓝牙单次可写 = MTU-3 → 数据 ≤ MTU-11。
assert.strictEqual(
  deviceBle.effectiveChunkSize({ mtu: 500, dataChunk: 236 }, 489),
  489,
  'MTU 500 正好装得下 489 字节数据（489+8=497=500-3）'
)
assert.strictEqual(
  deviceBle.effectiveChunkSize({ mtu: 247, dataChunk: 236 }, 489),
  236,
  'MTU 顶不上去时夹回 MTU-11，绝不能写出会被静默丢弃的大包'
)
assert.strictEqual(
  deviceBle.effectiveChunkSize({ mtu: 500, dataChunk: 236 }, undefined),
  236,
  '不传（真实投屏）时用会话值，行为不变'
)
assert.strictEqual(
  deviceBle.effectiveChunkSize({ mtu: 500, dataChunk: 236 }, 0),
  236,
  '非法值回落会话值'
)

// ── 发包窗口：默认仍 10（真实投屏），上限放宽到 50（调试台）────────────
assert.strictEqual(deviceBle.TRANSFER_WINDOW_MAX, 50)

const storage = {}
global.wx = {
  getStorageSync: key => (key in storage ? storage[key] : ''),
  setStorageSync: (key, value) => {
    storage[key] = value
  },
  removeStorageSync: key => {
    delete storage[key]
  }
}

assert.strictEqual(
  deviceBle.getTransferWindow(),
  10,
  '没同步过时真实投屏仍用 10 包窗口'
)
assert.strictEqual(deviceBle.setTransferWindow(50), 50, '设备侧新支持的 50 包可落库')
assert.strictEqual(deviceBle.getTransferWindow(), 50)
assert.strictEqual(deviceBle.setTransferWindow(999), 50, '超过上限夹到 50')
assert.strictEqual(deviceBle.setTransferWindow(0), 10, '非法值回落默认 10')

// ── 大/小尺寸判定：调试台按广播ID(EF6-370/EF6-589)定分辨率后，出帧 type 与真实投屏同源 ──
assert.strictEqual(dithering.typeForDevice({ width: 480, height: 720 }), '1', '小尺寸')
assert.strictEqual(dithering.typeForDevice({ width: 680, height: 960 }), '0', '大尺寸')

console.log('debug-transfer-params tests passed')
