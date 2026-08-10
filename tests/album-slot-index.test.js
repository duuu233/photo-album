// 图库「照片 → 设备物理槽位」解析（album/list.js resolveDeviceImageIndex）。
// 删除(0x12)按它定位要删设备上哪个位置，错一位就是删错图，故锁成回归用例。
// 规则与 Flutter state.dart _resolveDeviceImageIndex 逐条对齐（2026-08-03）。
//
// ⚠️ 唯一例外见下方「① 之二」：2026-08-10 小程序去掉了「真实 imgIndex 必须命中固件掩码」这道闸门
//    （它是「后端删成功、设备上没删」的根因）。Flutter 侧尚未同步 —— 在「记录槽位已空」这一种
//    情况下两端行为目前不同，App 侧跟进前请勿把这条改回去。
const assert = require('assert')

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
const device = { userProductId: 'D1', name: '相框' }
const photo = (id, deviceId, imgIndex, uProductImgId) => ({
  id,
  deviceId,
  deviceName: '相框',
  imgIndex,
  uProductImgId,
  onDevice: true
})

// ① 后端有真实 imgIndex 且该槽位在固件掩码里确实有图 → 直接用
ctx.photos = [photo('a', 'D1', '2', 10)]
assert.strictEqual(ctx.resolveDeviceImageIndex('a', device, [0, 2]), 2)

// ① 之二：记录指向的槽位在固件掩码里是空的 → **仍然直接用这个槽位**（2026-08-10 改，原为 -1）。
// 返回 -1 会让 slotIndexes 为空 → 0x12 一条都不发，可后端记录照删，正是「后端删成功、设备上没删」。
// 掩码只有 96 个 bit，只记「有没有图」、不记「是哪张图」，拿它当放行闸门两头不讨好：旧槽位被新图
// 占上时照样放行（该挡的没挡住），对不上时又静默放弃（不该挡的误伤）。真正的护栏挪到删除**之后**：
// 用 0x12 应答里的最新掩码核对目标槽位是否真的清空，没清空就不删后端记录
// （见 list.js confirmDeleteSelected 第 3 步）。
ctx.photos = [photo('a', 'D1', '2', 10)]
assert.strictEqual(ctx.resolveDeviceImageIndex('a', device, [0, 1]), 2)

// ① 之三：0 是合法槽位，绝不能被当成「无索引」
ctx.photos = [photo('a', 'D1', '0', 10)]
assert.strictEqual(ctx.resolveDeviceImageIndex('a', device, [0, 1]), 0)

// ② 无索引回退推算：候选槽位 = 占用 − 已被真实索引钉住；按上传先后第 N 张对应候选第 N 个
ctx.photos = [photo('x', 'D1', '0', 5), photo('a', 'D1', '', 10), photo('b', 'D1', '', 20)]
assert.strictEqual(ctx.resolveDeviceImageIndex('a', device, [0, 1, 3]), 1)
assert.strictEqual(ctx.resolveDeviceImageIndex('b', device, [0, 1, 3]), 3)

// ② 之二：别的设备的 imgIndex 不参与剔除候选（槽位号只在自己设备上成立）
ctx.photos = [photo('other', 'D2', '1', 1), photo('a', 'D1', '', 10)]
assert.strictEqual(ctx.resolveDeviceImageIndex('a', device, [1]), 1)

// ② 之三：候选为空但设备上确实有图 → -1，不硬套一个别人的槽位
ctx.photos = [photo('x', 'D1', '0', 5), photo('a', 'D1', '', 10)]
assert.strictEqual(ctx.resolveDeviceImageIndex('a', device, [0]), -1)

// ② 之四：设备上真的一张图都没有 → 回退到位置本身（保持旧行为）
ctx.photos = [photo('a', 'D1', '', 10)]
assert.strictEqual(ctx.resolveDeviceImageIndex('a', device, []), 0)

// ② 之五：上传先后按 uProductImgId 升序，不受后端列表顺序（常见最新在前）影响
ctx.photos = [photo('new', 'D1', '', 99), photo('old', 'D1', '', 3)]
assert.strictEqual(ctx.resolveDeviceImageIndex('old', device, [0, 1]), 0)
assert.strictEqual(ctx.resolveDeviceImageIndex('new', device, [0, 1]), 1)

// ② 之六：主键与时间都取不到时按「后端列表倒序」兜底（列表最新在前 → 越靠后越早上传）。
// Flutter 用「固定基准 − 下标秒」的合成时间得到同一顺序，两端必须同向。
ctx.photos = [photo('listFirst', 'D1', '', undefined), photo('listLast', 'D1', '', undefined)]
assert.strictEqual(ctx.resolveDeviceImageIndex('listLast', device, [0, 1]), 0)
assert.strictEqual(ctx.resolveDeviceImageIndex('listFirst', device, [0, 1]), 1)

console.log('album-slot-index: all assertions passed')
