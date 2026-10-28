// WiFi 投屏渲染模式（2026-10-28）api.resolveRenderMode：
//   ① 设备记录自带 renderMode（绑定详情接口下发）直接用，不再查接口；
//   ② 设备列表记录不带：按 productId 查产品列表（getProductList）取该产品的 renderMode；
//   ③ 产品列表也没有：按设备ID（去冒号）查 getProductByDevice；
//   ④ 都取不到返回空串，不抛错（调用方据此不传该字段）。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const root = path.join(__dirname, '..')

let checks = 0
function checked(name) { checks++; console.log('PASS ' + name) }

function loadApi({ products = [], byDevice = {} } = {}) {
  const calls = []
  const modules = {
    './request': {
      async get(url, params) {
        calls.push(url.split('/').pop())
        if (url === '/Client/Product/getProductList') return { pageData: products }
        if (url === '/Client/Product/getProductByDevice') {
          const reply = byDevice[params.deviceNo]
          if (reply instanceof Error) throw reply
          return reply
        }
        throw new Error('意外的接口 ' + url)
      }
    },
    './config': require('../utils/config'),
    './device-id': require('../utils/device-id'),
    './device-thumb': require('../utils/device-thumb'),
    './md5': require('../utils/md5')
  }
  const sandbox = { module: { exports: {} }, require: target => modules[target], console: { log() {}, warn() {} }, setTimeout, clearTimeout }
  vm.runInNewContext(fs.readFileSync(path.join(root, 'utils/api.js'), 'utf8'), sandbox, { filename: 'api.js' })
  return { api: sandbox.module.exports, calls }
}

async function main() {
  {
    const { api, calls } = loadApi()
    assert.equal(await api.resolveRenderMode({ productId: 21, renderMode: ' esp32 ', productDeviceId: 'E3:48:C2:1E:D4:28' }), 'esp32')
    assert.deepEqual(calls, [], '设备自带就不查接口')
    checked('设备记录自带 renderMode')
  }
  {
    const { api, calls } = loadApi({ products: [{ productId: 20, renderMode: 'esp32' }, { productId: 21, renderMode: 'fpga16' }] })
    assert.equal(await api.resolveRenderMode({ productId: '21', productDeviceId: 'E3:48:C2:1E:D4:28' }), 'fpga16')
    assert.deepEqual(calls, ['getProductList'], '产品列表查到就不再按设备查')
    checked('按 productId 取产品列表的 renderMode')
  }
  {
    const { api, calls } = loadApi({
      products: [{ productId: 21 }],
      byDevice: { E348C21ED428: { productId: 21, productName: 'WiFi相框', renderMode: 'fpga16' } }
    })
    assert.equal(await api.resolveRenderMode({ productId: 21, productDeviceId: 'E3:48:C2:1E:D4:28' }), 'fpga16')
    assert.deepEqual(calls, ['getProductList', 'getProductByDevice'], '产品列表没配再按设备ID查')
    checked('按设备ID查产品兜底')
  }
  {
    const { api } = loadApi({ byDevice: { E348C21ED428: Object.assign(new Error('接口-系统异常'), { code: 500 }) } })
    assert.equal(await api.resolveRenderMode({ productDeviceId: 'E3:48:C2:1E:D4:28' }), '', '接口失败返回空串')
    assert.equal(await api.resolveRenderMode({}), '', '没有产品 / 设备ID 返回空串')
    assert.equal(await api.resolveRenderMode(null), '')
    checked('取不到：返回空串，不抛错')
  }
  console.log(`wifi-render-mode: ${checks} groups passed`)
}
main().catch(error => { console.error(error); process.exitCode = 1 })
