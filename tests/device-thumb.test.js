// 设备图按机型区分（2026-10-22）：EB-169（圆屏）→ home-device-circle-thumb，
// EC-370 → home-device-rectangle-thumb，其余机型与认不出的 → 原来的 home-device-thumb。
//
// 锁四件事：
//   ① 机型判断口径：broadcastId 优先；搜索结果才看蓝牙广播名；已绑定记录的 name 是用户起的，不参与；
//      都取不到时 shapeType === 1 按圆屏；
//   ② 设备列表接口直接下发 broadcastId 就用它；没带的记录 api 按 productId 从产品列表回填，不按产品图等其它字段猜；
//   ③ 产品列表拉不到不能挡住设备列表，也不弹错误，设备图退回默认；失败不缓存，下次还能拿到；
//   ④ 三张图都真实存在（引用不存在的图小程序不报错，只会渲染成空白）。
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const deviceThumb = require('../utils/device-thumb')
const http = require('../utils/request')
const api = require('../utils/api')

const DEFAULT = '/assets/images/home-device-thumb.png'
const CIRCLE = '/assets/images/home-device-circle-thumb.png'
const RECTANGLE = '/assets/images/home-device-rectangle-thumb.png'

// ── ④ 图都在 ─────────────────────────────────────────────
for (const file of [DEFAULT, CIRCLE, RECTANGLE]) {
  assert.ok(fs.existsSync(path.join(root, file.slice(1))), `${file} 必须存在`)
}
assert.equal(deviceThumb.DEFAULT_THUMB, DEFAULT)

// ── ① 判断口径 ───────────────────────────────────────────
{
  const { thumbOf } = deviceThumb
  assert.equal(thumbOf({ broadcastId: 'EB-169' }), CIRCLE)
  assert.equal(thumbOf({ broadcastId: 'eb-169' }), CIRCLE, '大小写不敏感，与扫描白名单同口径')
  assert.equal(thumbOf({ broadcastId: 'EC-370' }), RECTANGLE)
  // EF6-370 与 EC-370 只差前缀，老机型不能被认成新机型
  assert.equal(thumbOf({ broadcastId: 'EF6-370' }), DEFAULT)
  assert.equal(thumbOf({ broadcastId: 'EF6-589' }), DEFAULT)
  assert.equal(thumbOf(null), DEFAULT)
  assert.equal(thumbOf({}), DEFAULT)

  // 搜索结果：广播名带前后缀照样认（包含匹配），name / localName 都看
  assert.equal(thumbOf({ realBluetooth: true, name: 'EB-169-5A44' }), CIRCLE)
  assert.equal(thumbOf({ realBluetooth: true, name: '设备 0B37', localName: 'EC-370' }), RECTANGLE)
  assert.equal(thumbOf({ realBluetooth: true, name: 'EF6-589' }), DEFAULT)

  // 已绑定记录的 name 是用户起的：碰巧写成机型名也不能据此换图，否则改个名图就变了
  assert.equal(thumbOf({ name: 'EB-169', productName: 'EB-169' }), DEFAULT)
  // broadcastId 比广播名可靠：两者都有时以 broadcastId 为准
  assert.equal(thumbOf({ realBluetooth: true, name: 'EB-169', broadcastId: 'EC-370' }), RECTANGLE)

  // 兜底：后台「形状类型」圆形（数字 1，与投屏预览同口径）
  assert.equal(thumbOf({ shapeType: 1 }), CIRCLE)
  assert.equal(thumbOf({ shapeType: 0 }), DEFAULT)
  assert.equal(thumbOf({ shapeType: '1' }), DEFAULT)
  assert.equal(thumbOf({ shapeType: 1, broadcastId: 'EC-370' }), RECTANGLE, '认得出机型就不看形状')
}

// ── ②③ 已绑定记录回查产品列表 ────────────────────────────
;(async () => {
  const originalGet = http.get
  const originalList = api.getUserProductList
  const originalDetail = api.getUserProductDetail
  const catalog = [
    { productId: 11, broadcastId: 'EB-169', productImg: 'https://oss/round.png' },
    { productId: 12, broadcastId: 'EC-370', productImg: 'https://oss/rect.png' },
    { productId: 13, broadcastId: 'EF6-589', productImg: 'https://oss/frame.png' },
    { productId: 14, broadcastId: 'EF6-370', productImg: 'https://oss/frame.png' }
  ]
  const records = [
    { userProductId: 'r-by-id', productId: 12, productName: '客厅' },
    { userProductId: 'r-by-id-string', productId: '11', productName: '卧室' },
    // 设备列表接口的实际形态：productId 与 broadcastId 一起下发，不依赖产品列表
    { userProductId: 'r-list', productId: 12, broadcastId: 'EC-370', productName: '书房' },
    { userProductId: 'r-img-only', productImg: 'https://oss/round.png', productName: '老相框' },
    { userProductId: 'r-own', productId: 11, broadcastId: 'EC-370', productName: '自带广播ID' },
    { userProductId: 'r-unknown-round', productId: 99, shapeType: 1, productName: '圆的' },
    { userProductId: 'r-user-name', productName: 'EB-169' }
  ]
  let productCalls = 0
  let lastOptions = null
  try {
    api.getUserProductList = () => Promise.resolve(records)

    // ③ 产品列表失败：设备列表照常返回，一律默认图（圆屏兜底除外），且不弹错误提示
    http.get = (url, data, options) => {
      assert.equal(url, '/Client/Product/getProductList')
      productCalls += 1
      lastOptions = options
      return Promise.reject(new Error('网络异常'))
    }
    const offline = await api.getDevices()
    assert.equal(offline.length, records.length)
    assert.equal(lastOptions.showError, false, '拉产品列表失败不能弹错误提示')
    assert.deepEqual(
      offline.map(item => item.thumb),
      [DEFAULT, DEFAULT, RECTANGLE, DEFAULT, RECTANGLE, CIRCLE, DEFAULT]
    )

    // 失败没有缓存：下一次能拿到产品列表
    http.get = () => {
      productCalls += 1
      return Promise.resolve({ pageData: catalog })
    }
    const devices = await api.getDevices()
    const byId = id => devices.find(item => item.userProductId === id)
    assert.equal(productCalls, 2)
    assert.equal(byId('r-by-id').broadcastId, 'EC-370')
    assert.equal(byId('r-by-id').thumb, RECTANGLE)
    assert.equal(byId('r-by-id-string').thumb, CIRCLE, 'productId 数字/字符串都要认')
    assert.equal(byId('r-list').thumb, RECTANGLE)
    assert.equal(byId('r-img-only').thumb, DEFAULT, '没有 productId / broadcastId 不按产品图猜机型')
    assert.equal(byId('r-own').thumb, RECTANGLE, '记录自带 broadcastId 时不被产品列表覆盖')
    assert.equal(byId('r-unknown-round').thumb, CIRCLE)
    assert.equal(byId('r-user-name').thumb, DEFAULT)

    // 成功后整次会话复用，不再重复拉
    api.getUserProductDetail = () => Promise.resolve({ userProductId: 'd-1', productId: 11, productName: '圆屏' })
    const detail = await api.getDeviceDetail('d-1')
    assert.equal(productCalls, 2)
    assert.equal(detail.thumb, CIRCLE)
  } finally {
    http.get = originalGet
    api.getUserProductList = originalList
    api.getUserProductDetail = originalDetail
  }
  console.log('device-thumb ok')
})().catch(error => {
  console.error(error)
  process.exit(1)
})
