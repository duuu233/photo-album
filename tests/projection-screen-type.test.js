// 投屏 type 取产品屏幕方向（2026-10-28）api.resolveScreenType：
//   ① 按 productId 查产品列表（getProductList）取该产品的 screenType（0=竖屏、1=横屏），0 是合法值；
//   ② 产品列表没配再按设备ID（去冒号）查 getProductByDevice；
//   ③ 都取不到返回空串，不抛错（调用方按分辨率回退旧口径）；
//   ④ 设备对象上同名的 screenType 是固件 / 广播的型号字节，不拿来用；
//   ⑤ 蓝牙版结果页出帧、WiFi 结果页、轮播设置页都按它取 type。
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
    const { api, calls } = loadApi({ products: [{ productId: 20, screenType: 1 }, { productId: 21, screenType: 0 }] })
    assert.equal(await api.resolveScreenType({ productId: '20', productDeviceId: 'E3:48:C2:1E:D4:28' }), '1')
    assert.equal(await api.resolveScreenType({ productId: 21, productDeviceId: 'E3:48:C2:1E:D4:28' }), '0', '0（竖屏）照常返回')
    assert.deepEqual(calls, ['getProductList'], '产品列表查到就不再按设备查，且整次会话只拉一次')
    checked('按 productId 取产品列表的 screenType')
  }
  {
    const { api, calls } = loadApi({
      products: [{ productId: 21, screenType: null }],
      byDevice: { E348C21ED428: { productId: 21, productName: 'WiFi相框', screenType: 1 } }
    })
    assert.equal(await api.resolveScreenType({ productId: 21, productDeviceId: 'E3:48:C2:1E:D4:28', screenType: 2 }), '1', '不用设备对象自带的型号字节')
    assert.deepEqual(calls, ['getProductList', 'getProductByDevice'], '产品列表没配再按设备ID查')
    checked('按设备ID查产品兜底')
  }
  {
    const { api } = loadApi({ byDevice: { E348C21ED428: Object.assign(new Error('接口-系统异常'), { code: 500 }) } })
    assert.equal(await api.resolveScreenType({ productDeviceId: 'E3:48:C2:1E:D4:28', screenType: 1 }), '', '接口失败返回空串')
    assert.equal(await api.resolveScreenType({}), '', '没有产品 / 设备ID 返回空串')
    assert.equal(await api.resolveScreenType(null), '')
    checked('取不到：返回空串，不抛错')
  }
  {
    const result = fs.readFileSync(path.join(root, 'subpackages/projection/result/result.js'), 'utf8')
    assert.ok(/type: await this\.ditherTypeFor\(device, info\)/.test(result), '蓝牙版出帧 type 按设备记录取产品屏幕方向')
    assert.ok(/\.resolveScreenType\(device\)/.test(result) && /screenType \|\| dithering\.typeForDevice\(info\)/.test(result), '产品没配才按分辨率回退')
    assert.ok(/this\._screenTypePromise = null/.test(result), '每轮投屏重新查一次')
    const wifiResult = fs.readFileSync(path.join(root, 'subpackages/projection/wifi-result/wifi-result.js'), 'utf8')
    assert.ok(/api\.resolveScreenType\(device\)/.test(wifiResult), 'WiFi 结果页取产品屏幕方向')
    checked('三处投屏入口都按产品 screenType 取 type')
  }
  console.log(`projection-screen-type: ${checks} groups passed`)
}
main().catch(error => { console.error(error); process.exitCode = 1 })
