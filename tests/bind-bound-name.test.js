// 搜索设备列表标题（2026-11-04）：这台设备在当前用户名下有名称就显示该名称（优先级最高），没有显示蓝牙广播名；
// 按完整 6 字节设备ID 匹配（蓝牙版取广播设备ID，WiFi 版取广播名里的 deviceNo）。只加显示用的 title，
// 行里的 name 仍是广播名（绑定时的产品匹配、默认昵称照旧用它）。
// 运行：node tests/bind-bound-name.test.js
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const root = path.join(__dirname, '..')
const deviceIdUtil = require('../utils/device-id')
const api = require('../utils/api')
const http = require('../utils/request')

let checks = 0
function checked(name) { checks++; console.log('PASS ' + name) }

function loadBindPage(names) {
  let definition
  let resolveNames
  const pending = new Promise(resolve => { resolveNames = resolve })
  const dependencies = {
    api: {
      scanSizeModel: () => '',
      lookupProductByDevice: async () => ({ product: null, reason: '桩' }),
      getBoundDeviceNames: () => pending
    },
    toast: { warn() {} },
    permission: {},
    bluetooth: { stopDiscovery() {} },
    'device-ble': {},
    'active-device': { friendlyConnectMessage: text => text },
    'device-id': deviceIdUtil,
    'device-name': {}, system: {}, 'fold-adapt': { adapt: value => value },
    'device-thumb': require('../utils/device-thumb'),
    'wifi-provision': {}, blufi: {},
    'broadcast-match': require('../utils/broadcast-match')
  }
  vm.runInNewContext(fs.readFileSync(path.join(root, 'subpackages/device/bind/bind.js'), 'utf8'), {
    require: target => dependencies[target.split('/').at(-1)],
    getApp: () => ({ globalData: {} }),
    Page: value => { definition = value },
    wx: {},
    console: { log() {}, warn() {} }, setTimeout: () => 0
  }, { filename: 'bind.js' })
  const page = { ...definition, data: JSON.parse(JSON.stringify(definition.data)), scanSeq: 1, setData(values) { Object.assign(this.data, values) } }
  return { page, finish: () => resolveNames(names) }
}

const bleRow = (deviceId, name, broadcastDeviceId) => ({ deviceId, id: deviceId, name, broadcastDeviceId, realBluetooth: true })
const wifiRow = (deviceId, deviceNo) => ({ deviceId, id: deviceId, name: `IJ_${deviceNo}`, commType: 'WIFI', wifiDeviceId: deviceNo, realBluetooth: true })
const flush = () => new Promise(resolve => setImmediate(resolve))

async function main() {
  {
    const calls = []
    const originalGet = http.get
    try {
      http.get = (url, data, options) => {
        calls.push({ url, data, options })
        return Promise.resolve({ pageData: [
          { productName: ' 客厅相框 ', productDeviceId: '370B00D0445A' },
          { productName: '书房', deviceNo: 'AABBCCDD', deviceId: 'E3:48:C2:1E:D4:28' },
          { productName: '', productDeviceId: '112233445566' },
          { productName: '短ID', deviceNo: 'AABBCCDD' },
          { productName: '重复的后一条', productDeviceId: '37:0B:00:D0:44:5A' },
          null
        ] })
      }
      const names = await api.getBoundDeviceNames()
      assert.deepEqual(JSON.parse(JSON.stringify(names)), {
        '37:0B:00:D0:44:5A': '客厅相框',
        'E3:48:C2:1E:D4:28': '书房'
      }, '按完整 6 字节设备ID 索引；靠前的短 ID 不挡完整 ID；名称为空 / 只有短 ID 的不收；重复取第一条')
      assert.equal(calls[0].url, '/Client/UserProduct/getUserProductList')
      assert.equal(calls[0].options.showError, false, '静默请求，不弹错')
      http.get = () => Promise.reject(new Error('network'))
      assert.deepEqual(JSON.parse(JSON.stringify(await api.getBoundDeviceNames())), {}, '失败返回空表')
    } finally {
      http.get = originalGet
    }
    checked('getBoundDeviceNames')
  }
  {
    const names = { '37:0B:00:D0:44:5A': '客厅相框', 'E3:48:C2:1E:D4:28': '书房WiFi' }
    const { page, finish } = loadBindPage(names)
    assert.equal(page.data.namesLoading, true, '进页面时名称处先显示 loading')
    page.loadBoundNames()
    // 名称还没回来：行数据里是广播名，但模板按 namesLoading 显示 loading，不先露出广播名（2026-11-05）
    page.applyScanResult(1, [bleRow('h1', 'EB-169', '37:0B:00:D0:44:5A'), wifiRow('h2', 'E348C21ED428'), bleRow('h3', 'EF6-589', 'AA:BB:CC:DD:EE:01')])
    assert.deepEqual(page.data.devices.map(item => item.title || item.name), ['EB-169', 'IJ_E348C21ED428', 'EF6-589'])
    assert.equal(page.data.namesLoading, true, '名称没回来前保持 loading')
    finish()
    await flush()
    assert.equal(page.data.namesLoading, false, '名称回来后结束 loading')
    assert.deepEqual(page.data.devices.map(item => item.title || item.name), ['客厅相框', '书房WiFi', 'EF6-589'], '名称回来后补到已搜到的行上；没绑定过的仍显示广播名')
    assert.deepEqual(page.data.devices.map(item => item.name), ['EB-169', 'IJ_E348C21ED428', 'EF6-589'], 'name 仍是广播名，绑定逻辑不受影响')
    page.applyScanResult(1, [bleRow('h1', 'EB-169', '37:0B:00:D0:44:5A'), bleRow('h4', 'EB-169', '370B00D0')])
    assert.deepEqual(page.data.devices.map(item => item.title || item.name), ['客厅相框', 'EB-169'], '之后搜到的行直接带名称；广播里只有短 ID 的不匹配')
    checked('搜索列表标题：用户名下的名称优先，没有显示广播名')
  }
  {
    // 名称先于扫描结果回来（列表还空）也要结束 loading，否则之后搜到的行一直转圈
    const { page, finish } = loadBindPage({})
    page.loadBoundNames()
    finish()
    await flush()
    assert.equal(page.data.namesLoading, false, '列表为空时名称回来也结束 loading')
    page.applyScanResult(1, [bleRow('h1', 'EB-169', 'AA:BB:CC:DD:EE:02')])
    assert.deepEqual(page.data.devices.map(item => item.title || item.name), ['EB-169'], '没绑定过的显示广播名')
    checked('名称先回来：结束 loading，之后的行直接显示')
  }
  {
    const tpl = fs.readFileSync(path.join(root, 'subpackages/device/bind/bind.wxml'), 'utf8')
    // 2026-11-05：名称查回来前显示 loading，原「<text class="nearby-name">」改为 wx:else 分支（判据「标题优先 title」不变）
    assert.ok(/<view wx:if="\{\{namesLoading\}\}" class="nearby-name nearby-name--loading"><view class="spec-spinner"><\/view><\/view>\s*<text wx:else class="nearby-name">\{\{item\.title \|\| item\.name\}\}<\/text>/.test(tpl), '列表标题优先 title，查询中显示 loading')
    const source = fs.readFileSync(path.join(root, 'subpackages/device/bind/bind.js'), 'utf8')
    assert.ok(/this\.loadProductCatalog\(\)\n    this\.loadBoundNames\(\)\n    this\.scan\(\)/.test(source), '进页面与扫描并行拉名称')
    assert.ok(/const BOUND_NAMES_WAIT_MS = 5000/.test(source) && /setTimeout\(\(\) => \{\n      if \(!this\.boundNames && !this\.unloaded && this\.data\.namesLoading\) \{\n        this\.setData\(\{ namesLoading: false \}\)/.test(source), '最多等 5 秒，超时先显示广播名')
    const css = fs.readFileSync(path.join(root, 'subpackages/device/bind/bind.wxss'), 'utf8')
    assert.ok(/\.nearby-name--loading \{[^}]*height: 44rpx/.test(css), 'loading 占一行名称高度，切换时行高不变')
    checked('模板与进页加载')
  }
  console.log(`bind-bound-name: ${checks} groups passed`)
}
main().catch(error => { console.error(error); process.exitCode = 1 })
