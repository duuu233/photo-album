// WiFi 设备产品规格查询（2026-10-26）：
//   ① 设备 ID 只传不带冒号的 12 位（2026-10-27 产品：传给后端查询的设备ID不加冒号；原「查不到再用带冒号的查」已取消）；
//   ② 没查到时给出原因（接口失败 / 返回为空 / 返回里没有产品 ID 和产品名称），搜索页在开发版 / 体验版把它写到未知设备提示上；
//   ③ 不抛错；getProductByDevice 只是取 product 的简写。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const root = path.join(__dirname, '..')

let checks = 0
function checked(name) { checks++; console.log('PASS ' + name) }

function loadApi(replies) {
  const calls = []
  const modules = {
    './request': {
      async get(url, params) {
        calls.push(params.deviceNo)
        const reply = replies[params.deviceNo]
        if (reply instanceof Error) throw reply
        return reply
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
    const { api, calls } = loadApi({ E348C21ED428: { productId: 21, productName: 'WiFi相框', sizeModel: '13.3寸' } })
    const result = await api.lookupProductByDevice('E348C21ED428')
    assert.equal(result.product.sizeModel, '13.3寸')
    assert.equal(result.reason, '')
    assert.deepEqual(calls, ['E348C21ED428'], '不带冒号查到就不再查带冒号的')
    checked('不带冒号的写法查到')
  }
  {
    const { api, calls } = loadApi({ E348C21ED428: null, 'E3:48:C2:1E:D4:28': { productId: 21, productName: 'WiFi相框' } })
    const result = await api.lookupProductByDevice('E3:48:C2:1E:D4:28')
    assert.equal(result.product, null, '不再用带冒号的写法补查')
    assert.deepEqual(calls, ['E348C21ED428'], '传进来带冒号也去掉冒号再查，只查一次')
    checked('只传不带冒号的设备ID，不再补查带冒号的')
  }
  {
    const failure = Object.assign(new Error('接口-系统异常'), { code: 500 })
    const { api } = loadApi({ E348C21ED428: failure })
    const result = await api.lookupProductByDevice('E348C21ED428')
    assert.equal(result.product, null)
    assert.ok(/E348C21ED428：接口失败：500 系统异常/.test(result.reason), result.reason)
    assert.equal(await api.getProductByDevice('E348C21ED428'), null, 'getProductByDevice 只取 product')
    const { api: noName } = loadApi({ E348C21ED428: { sizeModel: '13.3寸', width: 1600 } })
    assert.ok(/E348C21ED428：返回里没有产品 ID 和产品名称/.test((await noName.lookupProductByDevice('E348C21ED428')).reason))
    checked('没查到：给出原因，不抛错')
  }
  {
    const { api } = loadApi({ E348C21ED428: null })
    assert.ok(/E348C21ED428：返回为空/.test((await api.lookupProductByDevice('E348C21ED428')).reason))
    const { api: empty } = loadApi({ E348C21ED428: {} })
    assert.ok(/E348C21ED428：返回为空对象/.test((await empty.lookupProductByDevice('E348C21ED428')).reason))
    checked('返回为空 / 空对象的原因')
  }
  console.log(`wifi-product-lookup: ${checks} groups passed`)
}
main().catch(error => { console.error(error); process.exitCode = 1 })
