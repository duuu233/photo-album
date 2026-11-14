// 设备图按机型区分（2026-10-22）：EB-169（圆屏）→ home-device-circle-thumb，
// EC-370 → home-device-rectangle-thumb，其余机型与认不出的 → 原来的 home-device-thumb。
//
// 锁四件事：
//   ① 机型判断口径：broadcastId 优先；搜索结果才看蓝牙广播名；已绑定记录的 name 是用户起的，不参与；
//      都取不到时 shapeType === 1 按圆屏；
//   ② 设备列表接口直接下发 productId / broadcastId（2026-11-14 后端补上）：getDevices 只调列表接口，
//      按记录自带的 broadcastId 出图，不再拉产品列表、不再逐台调详情补机型（原 ②③' 回查逻辑有意删除）；
//   ③ 设备详情接口不带 broadcastId：getDeviceDetail 按 productId 从产品列表回填，不按产品图等其它字段猜；
//      产品列表拉不到不能挡住详情，也不弹错误，设备图退回默认；失败不缓存，下次还能拿到；成功整次会话复用；
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

// ── ② 设备列表按记录自带字段 ─────────────────────────────
// ── ③ 设备详情按 productId 回查产品列表 ──────────────────
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
  // 设备列表接口的实际形态（2026-11-14）：productId 与 broadcastId 一起下发
  const records = [
    { userProductId: 'r-rect', productId: 12, broadcastId: 'EC-370', productName: '书房', versionType: 1 },
    { userProductId: 'r-round', productId: 11, broadcastId: 'eb-169', productName: '卧室', versionType: 1 },
    { userProductId: 'r-frame', productId: 14, broadcastId: 'EF6-370', productName: '客厅', versionType: 1 },
    { userProductId: 'r-wifi', productId: 31, broadcastId: 'IJ_*', productName: 'IJ_101', versionType: 2 },
    // 没带 broadcastId 的记录不再回查：默认图（圆形产品按 shapeType 兜底）
    { userProductId: 'r-none', productId: 12, productName: '没带' },
    { userProductId: 'r-none-round', shapeType: 1, productName: '圆的' },
    // 用户起的名字碰巧是机型名也不能据此换图
    { userProductId: 'r-user-name', productName: 'EB-169' }
  ]
  const calls = []
  let lastOptions = null
  try {
    api.getUserProductList = () => Promise.resolve(records)
    http.get = (url, data, options) => {
      calls.push(url)
      lastOptions = options
      if (url === '/Client/Product/getProductList') {
        return Promise.reject(new Error('网络异常'))
      }
      return Promise.reject(new Error('意外的接口 ' + url))
    }

    // ② 设备列表：只调列表接口，按自带 broadcastId 出图
    const devices = await api.getDevices()
    const byId = id => devices.find(item => item.userProductId === id)
    assert.deepEqual(calls, [], '设备列表不拉产品列表、不调详情')
    assert.equal(byId('r-rect').thumb, RECTANGLE)
    assert.equal(byId('r-round').thumb, CIRCLE, '大小写不敏感')
    assert.equal(byId('r-frame').thumb, DEFAULT)
    assert.equal(byId('r-wifi').thumb, DEFAULT)
    assert.equal(byId('r-wifi').productId, 31, 'productId 透传（投屏取渲染模式用）')
    assert.equal(byId('r-none').thumb, DEFAULT, '没带 broadcastId 不再回查')
    assert.equal(byId('r-none-round').thumb, CIRCLE)
    assert.equal(byId('r-user-name').thumb, DEFAULT)

    // ③ 详情：产品列表失败照常返回、默认图、不弹错误
    api.getUserProductDetail = () => Promise.resolve({ userProductId: 'd-1', productId: 11, productName: '圆屏' })
    const offline = await api.getDeviceDetail('d-1')
    assert.equal(offline.thumb, DEFAULT)
    assert.equal(lastOptions.showError, false, '拉产品列表失败不能弹错误提示')
    const failedCalls = calls.length

    // 失败不缓存：下次能拿到，按 productId 回填
    http.get = (url, data, options) => {
      calls.push(url)
      assert.equal(url, '/Client/Product/getProductList')
      return Promise.resolve({ pageData: catalog })
    }
    const detail = await api.getDeviceDetail('d-1')
    assert.equal(calls.length, failedCalls + 1)
    assert.equal(detail.broadcastId, 'EB-169')
    assert.equal(detail.thumb, CIRCLE)

    // 详情自带 broadcastId 时不被覆盖；成功后整次会话复用，不再重复拉
    api.getUserProductDetail = () => Promise.resolve({ userProductId: 'd-2', productId: 11, broadcastId: 'EC-370' })
    assert.equal((await api.getDeviceDetail('d-2')).thumb, RECTANGLE)
    api.getUserProductDetail = () => Promise.resolve({ userProductId: 'd-3', productImg: 'https://oss/round.png' })
    assert.equal((await api.getDeviceDetail('d-3')).thumb, DEFAULT, '没有 productId / broadcastId 不按产品图猜机型')
    assert.equal(calls.length, failedCalls + 1, '产品列表整次会话只拉一次')
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
