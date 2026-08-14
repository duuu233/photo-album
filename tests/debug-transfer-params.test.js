// 图传传输参数（发包窗口 / 0x21 数据字节 / MTU）的默认口径与夹取规则。
//
// 背景（2026-08-07）：设备侧优化后一次可缓 50 包、单包图片数据由 236 字节放宽到 489（MTU 500）。
// 这三项当时只在调试台放开成可调参数，真实投屏仍走「窗口 10 / 每包 ≤236 / 请求 MTU 247」。
// 2026-08-14：调试台真机跑通后，这一组**同步成真实投屏的默认值**——两条链路自此同参数。
// 本用例锁的就是新默认值，以及「链路顶不到 MTU 500 时必须自动收缩」这条不变量。
const assert = require('assert')
const deviceBle = require('../utils/device-ble')
const dithering = require('../utils/dithering')

// ── 真实投屏的默认口径（2026-08-14 起 = 调试台那一组）─────────────────────
assert.strictEqual(
  deviceBle.IMG_DATA_CHUNK_MAX,
  489,
  '建连时按每包 489 字节算分包（0x21 的 PAYLOAD 上限 491 = PKT_SEQ(2)+489）'
)
assert.strictEqual(
  deviceBle.MTU_REQUEST_DEFAULT,
  500,
  '建连请求 MTU 500（489+8=497，正好卡满单次可写上限 MTU-3）'
)

// 建连时算出的会话分包大小：顶不到 MTU 500 的链路必须自动收缩到「数据 ≤ MTU-11」，
// 否则写下去会被静默丢弃、图传直接卡死。老口径（MTU 247 → 236）在这里原样成立。
assert.strictEqual(deviceBle.chunkFromMtu(500), 489)
assert.strictEqual(deviceBle.chunkFromMtu(247), 236, 'MTU 顶不上去时退回老的 236')
assert.strictEqual(deviceBle.chunkFromMtu(185), 174, '低 MTU 时按 MTU-11 收缩')

// ── 显式指定每包字节数（调试台的「0x21 数据字节」输入框）：按 MTU 能承载的上限夹取 ──
// 整帧 = 数据 + 8 字节固定开销(SOF/CMD/LEN/CRC)，蓝牙单次可写 = MTU-3 → 数据 ≤ MTU-11。
assert.strictEqual(
  deviceBle.effectiveChunkSize({ mtu: 500, dataChunk: 489 }, 489),
  489,
  'MTU 500 正好装得下 489 字节数据（489+8=497=500-3）'
)
assert.strictEqual(
  deviceBle.effectiveChunkSize({ mtu: 247, dataChunk: 236 }, 489),
  236,
  'MTU 顶不上去时夹回 MTU-11，绝不能写出会被静默丢弃的大包'
)
assert.strictEqual(
  deviceBle.effectiveChunkSize({ mtu: 500, dataChunk: 489 }, undefined),
  489,
  '不传（真实投屏）时用会话值'
)
assert.strictEqual(
  deviceBle.effectiveChunkSize({ mtu: 500, dataChunk: 489 }, 0),
  489,
  '非法值回落会话值'
)

// ── 发包窗口：默认与上限齐平为 50（配套 AIMD 自适应，卡了自己会减半退让）──────
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
  50,
  '没同步过时真实投屏用 50 包窗口'
)
assert.strictEqual(
  deviceBle.setTransferWindow(10),
  10,
  '「保存给真实投屏」写下的旧值仍优先于默认值（存储值是显式的人工决定）'
)
assert.strictEqual(deviceBle.getTransferWindow(), 10)
assert.strictEqual(deviceBle.setTransferWindow(999), 50, '超过上限夹到 50')
assert.strictEqual(deviceBle.setTransferWindow(0), 50, '非法值回落默认 50')

// ── 大/小尺寸判定：调试台按广播ID(EF6-370/EF6-589)定分辨率后，出帧 type 与真实投屏同源 ──
assert.strictEqual(dithering.typeForDevice({ width: 480, height: 720 }), '1', '小尺寸')
assert.strictEqual(dithering.typeForDevice({ width: 680, height: 960 }), '0', '大尺寸')

console.log('debug-transfer-params tests passed')
