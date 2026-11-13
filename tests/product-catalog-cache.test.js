// 产品列表本地缓存（2026-11-14）：设备列表接口不带 WiFi / 蓝牙类型，首页卡片、我的设备 Tab 都按产品列表的
// broadcastId（IJ_*）认 WiFi 版。冷启动产品列表 3 秒内没回来，WiFi 设备就被当成蓝牙版，过一会才变对，
// 首页 / 列表的 loading 也白等这 3 秒。锁：
//   ① 拉到产品列表就存本地；
//   ② 下次启动有存的那份：设备列表不等产品列表接口，WiFi 设备直接认对；同时后台拉一次最新的；
//   ③ 存的那份认不出设备的 productId（后台新加了产品）：再等最新的那份；
//   ④ 详情补机型认出来的也存本地，下次启动不再调详情；
//   ⑤ 没有本地存储（wx 不可用）时照旧，不报错。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const root = path.join(__dirname, '..')

let checks = 0
function checked(name) { checks++; console.log('PASS ' + name) }

const WIFI = { productId: 31, broadcastId: 'IJ_*', sizeModel: '13.3寸' }
const BLE = { productId: 12, broadcastId: 'EC-370', sizeModel: '3.7寸' }

// catalogReply：产品列表接口的返回；传 'pending' 表示一直不回来
function loadApi({ storage, catalogReply, details = {} }) {
  const calls = []
  const modules = {
    './request': {
      get(url, params) {
        calls.push(url.split('/').pop())
        if (url === '/Client/Product/getProductList') {
          return catalogReply === 'pending' ? new Promise(() => {}) : Promise.resolve({ pageData: catalogReply })
        }
        if (url === '/Client/UserProduct/getUserProductDetail') {
          return Promise.resolve(details[params.userProductId] || {})
        }
        return Promise.reject(new Error('意外的接口 ' + url))
      }
    },
    './config': require('../utils/config'),
    './device-id': require('../utils/device-id'),
    './device-thumb': require('../utils/device-thumb'),
    './md5': require('../utils/md5')
  }
  const sandbox = {
    module: { exports: {} },
    require: target => modules[target],
    console: { log() {}, warn() {} },
    setTimeout,
    clearTimeout
  }
  if (storage) {
    sandbox.wx = {
      getStorageSync: key => (Object.prototype.hasOwnProperty.call(storage, key) ? JSON.parse(storage[key]) : ''),
      setStorageSync: (key, value) => { storage[key] = JSON.stringify(value) }
    }
  }
  vm.runInNewContext(fs.readFileSync(path.join(root, 'utils/api.js'), 'utf8'), sandbox, { filename: 'api.js' })
  return { api: sandbox.module.exports, calls }
}

function withList(api, records) {
  api.getUserProductList = () => Promise.resolve(records)
  return api
}

async function main() {
  const wifiRecord = { userProductId: 'w1', productId: 31, productName: '客厅', deviceNo: 'D0CF13F02804' }
  const bleRecord = { userProductId: 'b1', productId: 12, productName: '卧室' }

  // ① 第一次启动：没有存的，等接口；拿到后存本地
  const storage = {}
  {
    const { api } = loadApi({ storage, catalogReply: [WIFI, BLE] })
    const devices = await withList(api, [wifiRecord, bleRecord]).getDevices()
    assert.equal(devices.find(item => item.userProductId === 'w1').broadcastId, 'IJ_*')
    assert.ok(storage.product_catalog_cache, '拿到产品列表要存本地')
    assert.deepEqual(JSON.parse(storage.product_catalog_cache).map(item => item.productId), [31, 12])
    checked('拿到产品列表存本地')
  }

  // ② 下次启动：产品列表接口迟迟不回，也不等，WiFi 设备直接认对；后台照样拉一次
  {
    const { api, calls } = loadApi({ storage, catalogReply: 'pending' })
    const started = Date.now()
    const devices = await withList(api, [wifiRecord, bleRecord]).getDevices()
    assert.ok(Date.now() - started < 1000, '有存的产品列表就不能再等 3 秒')
    assert.equal(devices.find(item => item.userProductId === 'w1').broadcastId, 'IJ_*', 'WiFi 设备不能兜底成蓝牙版')
    assert.equal(devices.find(item => item.userProductId === 'b1').broadcastId, 'EC-370')
    assert.equal(calls.filter(name => name === 'getProductList').length, 1, '后台拉一次最新的')
    checked('有存的产品列表：不等接口，WiFi 认对')
  }

  // ③ 存的那份认不出（后台新加了产品 41）：再等最新的那份
  {
    const NEW = { productId: 41, broadcastId: 'IJ_*', sizeModel: '10.1寸' }
    const { api } = loadApi({ storage, catalogReply: [WIFI, BLE, NEW] })
    const devices = await withList(api, [{ userProductId: 'n1', productId: 41, productName: '新款' }]).getDevices()
    assert.equal(devices[0].broadcastId, 'IJ_*', '新产品要等最新产品列表认出来')
    assert.deepEqual(JSON.parse(storage.product_catalog_cache).map(item => item.productId), [31, 12, 41], '最新的覆盖本地')
    checked('存的认不全：等最新的')
  }

  // ④ 详情补机型认出来的存本地，下次启动直接用
  {
    const detailStorage = { product_catalog_cache: JSON.stringify([WIFI, BLE]) }
    const record = { userProductId: 'd1', productName: '没带产品' }
    const first = loadApi({ storage: detailStorage, catalogReply: [WIFI, BLE], details: { d1: { userProductId: 'd1', productId: 31 } } })
    const devices = await withList(first.api, [record]).getDevices()
    assert.equal(devices[0].broadcastId, 'IJ_*')
    assert.equal(JSON.parse(detailStorage.device_broadcast_id_cache).d1, 'IJ_*', '详情认出来的存本地')

    const second = loadApi({ storage: detailStorage, catalogReply: 'pending' })
    const again = await withList(second.api, [record]).getDevices()
    assert.equal(again[0].broadcastId, 'IJ_*')
    assert.equal(second.calls.indexOf('getUserProductDetail'), -1, '下次启动不再调详情')
    checked('详情补机型结果存本地')
  }

  // ⑤ 没有 wx（存储不可用）：照旧等接口，不报错
  {
    const { api } = loadApi({ catalogReply: [WIFI, BLE] })
    const devices = await withList(api, [wifiRecord]).getDevices()
    assert.equal(devices[0].broadcastId, 'IJ_*')
    checked('存储不可用照旧')
  }

  console.log(`product-catalog-cache: ${checks} groups passed`)
}
main().catch(error => { console.error(error); process.exitCode = 1 })
