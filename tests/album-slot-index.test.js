// 图库删除只认后端 imgIndex，并按 v1.5 §6.7.10 转成 12 字节 IMG_INDEX_MASK。
// 不读取设备占用掩码，也不按列表顺序/上传时间推算缺失索引。
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
const photo = (id, deviceId, imgIndex, uProductImgId) => ({
  id,
  deviceId,
  deviceName: '相框',
  imgIndex,
  uProductImgId,
  onDevice: true
})

// 后端索引直接采用，不读取或比对设备掩码。
ctx.photos = [photo('a', 'D1', '2', 10)]
assert.strictEqual(ctx.backendImageIndexOf('a'), 2)

// 0 是合法槽位，绝不能被当成「无索引」。
ctx.photos = [photo('a', 'D1', '0', 10)]
assert.strictEqual(ctx.backendImageIndexOf('a'), 0)

// 缺失/非法/超出 12 字节掩码范围的索引直接失败；即使传入旧式 occupied 参数也不得推算。
ctx.photos = [photo('missing', 'D1', '', 10)]
assert.strictEqual(
  ctx.backendImageIndexOf('missing', { userProductId: 'D1' }, [4]),
  -1
)
ctx.photos = [photo('invalid', 'D1', '1.5', 11)]
assert.strictEqual(ctx.backendImageIndexOf('invalid'), -1)
ctx.photos = [photo('blank', 'D1', '   ', 12)]
assert.strictEqual(ctx.backendImageIndexOf('blank'), -1)
ctx.photos = [photo('overflow', 'D1', '96', 13)]
assert.strictEqual(ctx.backendImageIndexOf('overflow'), -1)
assert.strictEqual(ctx.backendImageIndexOf('not-found'), -1)

// v1.5 §6.7.10：索引 0、2 的删除掩码固定为 12 字节，低字节在前，首字节为 0x05。
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
