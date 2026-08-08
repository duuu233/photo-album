// 图库「照片 → 设备物理槽位」解析（album/list.js resolveDeviceImageIndex）。
// 删除(0x12)与刷新屏幕(0x24)都按它定位，错一位就是删错/刷错图，故锁成回归用例。
// 规则与 Flutter state.dart _resolveDeviceImageIndex 逐条对齐（2026-08-03）。
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

// ① 之二：记录指向的槽位已空（在另一端删过 / 一键清空过）→ -1，不能照着旧记录删/刷别人的图
ctx.photos = [photo('a', 'D1', '2', 10)]
assert.strictEqual(ctx.resolveDeviceImageIndex('a', device, [0, 1]), -1)

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
