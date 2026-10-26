// WiFi 版接入搜索（2026-10-26，对接进度 STEP 1）：
//   ① 广播名匹配：后台 `IJ_*` 模板按 `*` 拆前后缀、中间正好 12 位取 deviceId；蓝牙版固定广播名沿用包含匹配；
//      广播名合内置 `IJ_*` 的一律是 WiFi 版，后台把广播 ID 写成 `IJ_`（不带 *）也不会被当成蓝牙版；
//   ② 扫描层：只有 includeWifi 的订阅者（搜索设备页）收录 WiFi 设备并标 commType，其它扫描入口照旧只认蓝牙版；
//   ③ 搜索页：WiFi 行按 deviceNo 查产品规格（每台只查一次），查到直接显示 sizeModel、没配显示「--寸」，
//      查不到/返回空壳记录/失败显示「未知设备」；未知设备点行或点底部按钮都直接弹「未知设备，请联系客服开通」
//      （本页底部提示弹层，与首页提示同一套样式）、
//      不进配网；查到的点行即进 WiFi 配置页；不缓存，重新搜索时全部重查；
//   ④ WiFi 配置页（STEP 2）：进页面统一先弹列表、不自动回填（产品 2026-10-26 拍板），列表只留 2.4G、同名去重、
//      当前连接的排第一并打标、其余信号强在前，点选即回填；「下一步」把名称 / 密码交给配网流程，密码不进页面路由；两张新页面已在 app.json 注册。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const root = path.join(__dirname, '..')
const match = require('../utils/broadcast-match')
const protocol = require('../utils/frame-protocol')
const deviceIdUtil = require('../utils/device-id')

let checks = 0
function checked(name) { checks++; console.log('PASS ' + name) }
const flush = () => new Promise(resolve => setImmediate(resolve))

function loadBluetooth(productIds) {
  let handler
  const modules = {
    './frame-protocol': protocol,
    './broadcast-match': match,
    './api': { getProductBroadcastIds: async () => productIds }
  }
  const sandbox = { module: { exports: {} }, require: target => modules[target] || {}, console, setTimeout, clearTimeout, wx: {
    openBluetoothAdapter() {},
    onBluetoothDeviceFound: value => { handler = value }, offBluetoothDeviceFound() {},
    startBluetoothDevicesDiscovery: options => options.success({}),
    stopBluetoothDevicesDiscovery: options => options.success && options.success({})
  } }
  vm.runInNewContext(fs.readFileSync(path.join(root, 'utils/bluetooth.js'), 'utf8'), sandbox, { filename: 'bluetooth.js' })
  return { bluetooth: sandbox.module.exports, emit: devices => handler({ devices }) }
}

function loadPage(file, dependencies, wxExtra) {
  let definition
  const state = { modals: [], navs: [], toasts: [] }
  vm.runInNewContext(fs.readFileSync(path.join(root, file), 'utf8'), {
    require: target => dependencies(state)[target.split('/').at(-1)],
    getApp: () => ({ globalData: {} }),
    Page: value => { definition = value },
    wx: Object.assign({
      showLoading() {}, hideLoading() {}, navigateBack() {},
      showModal: options => state.modals.push(options),
      navigateTo: options => state.navs.push(options)
    }, wxExtra),
    console: { log() {}, warn() {} }, setTimeout: () => 0, clearTimeout() {}
  }, { filename: path.basename(file) })
  const page = { ...definition, data: JSON.parse(JSON.stringify(definition.data)), scanSeq: 1, setData(values) { Object.assign(this.data, values) } }
  return { page, state }
}

async function main() {
  // ── ① 匹配规则（对接进度文档的验收用例）──
  assert.deepEqual(
    JSON.parse(JSON.stringify(match.classify({ name: 'IJ_E348C21ED428' }, ['IJ_*']))),
    { commType: 'WIFI', broadcastId: 'IJ_*', wifiDeviceId: 'E348C21ED428' }
  )
  assert.equal(match.classify({ name: 'IJ_E348C21ED428ABC' }, ['IJ_*ABC']).wifiDeviceId, 'E348C21ED428')
  assert.equal(match.classify({ name: 'ij_e348c21ed428' }, ['IJ_*']).wifiDeviceId, 'E348C21ED428', '大小写不敏感，deviceId 统一大写')
  assert.equal(match.classify({ name: '', localName: 'IJ_D0CF13F02FF8' }, ['IJ_*']).wifiDeviceId, 'D0CF13F02FF8', 'localName 同样认')
  checked('IJ_* / IJ_*ABC 命中并取出中间 12 位 deviceId')

  for (const name of ['IJ_E348C21ED42', 'IJ_E348C21ED4281', 'IJ_', 'XIJ_E348C21ED428', 'IJ_E348C21ED42!']) {
    assert.equal(match.classify({ name }, ['IJ_*']), null, `${name} 不该命中：被 * 替换的部分必须正好 12 位`)
  }
  assert.equal(match.matchWildcard('IJ_E348C21ED428', 'IJ_*ABC'), '', '后缀对不上不命中')
  assert.equal(match.matchWildcard('IJ_E348C21ED428', 'IJ_**'), '', '多个 * 视为配置错误')
  checked('中间不是 12 位 / 前后缀对不上都不命中')

  const ids = ['EF6-370', 'EB-169', 'IJ_*']
  assert.deepEqual(JSON.parse(JSON.stringify(match.classify({ name: 'EF6-370' }, ids))), { commType: 'BLE', broadcastId: 'EF6-370' })
  assert.deepEqual(JSON.parse(JSON.stringify(match.classify({ name: 'EB-169' }, ids))), { commType: 'BLE', broadcastId: 'EB-169' })
  assert.equal(match.classify({ name: 'EF6-589' }, ['EF6-370', 'EB-169']), null)
  // 2026-10-26 追加内置 IJ_* 模板：原断言「后台没配 IJ_* 就不命中」随之改为「仍认作 WiFi 版」，
  // 守的判据换成更要紧的那条——WiFi 设备绝不能被归为蓝牙版（否则不查规格、拦不住未知设备）
  assert.equal(match.classify({ name: 'IJ_E348C21ED428' }, ['EF6-370', 'EB-169']).commType, 'WIFI', '后台没配 IJ_* 时按内置模板仍认作 WiFi 版')
  const loose = match.classify({ name: 'IJ_E348C21ED428' }, ['EF6-370', 'IJ_'])
  assert.equal(loose.commType, 'WIFI', '后台把广播 ID 写成不带 * 的 IJ_ 时，不能按包含匹配归成蓝牙版')
  assert.equal(loose.wifiDeviceId, 'E348C21ED428')
  assert.equal(match.classify({ name: 'EF6-370-A1' }, ['EF6-370']).commType, 'BLE', '蓝牙版沿用包含匹配，带后缀的现网广播名照样认')
  checked('蓝牙版固定广播名只命中对应设备')

  // ── ② 扫描层 ──
  {
    const { bluetooth, emit } = loadBluetooth(ids)
    const wifiScan = bluetooth.discoverDevices({ freshOnly: true, includeWifi: true, timeout: 30 })
    const bleScan = bluetooth.discoverDevices({ freshOnly: true, timeout: 30 })
    await new Promise(resolve => setTimeout(resolve, 0))
    emit([
      { deviceId: 'h-wifi', name: 'IJ_E348C21ED428', RSSI: -50 },
      { deviceId: 'h-ble', name: 'EB-169', RSSI: -60 },
      { deviceId: 'h-bad', name: 'IJ_123', RSSI: -40 }
    ])
    const withWifi = await wifiScan
    assert.deepEqual(Array.from(withWifi, item => item.deviceId), ['h-wifi', 'h-ble'], '按 RSSI 排序，名字不合模板的 IJ_ 设备不收')
    assert.equal(withWifi[0].commType, 'WIFI')
    assert.equal(withWifi[0].wifiDeviceId, 'E348C21ED428')
    assert.equal(withWifi[1].commType, 'BLE')
    const bleOnly = await bleScan
    assert.deepEqual(Array.from(bleOnly, item => item.deviceId), ['h-ble'], '其它扫描入口（连接前扫描/自动重连）不收 WiFi 设备')
    assert.equal(bleOnly[0].commType, undefined, '不传 includeWifi 时返回的记录与接入前一致')
    checked('只有 includeWifi 的订阅者收录 WiFi 设备并标 commType')
  }
  {
    // 后台把 WiFi 广播 ID 写成不带 * 的 IJ_：搜索页仍标 WIFI，其它扫描入口仍不收（不能靠包含匹配混进蓝牙候选）
    const { bluetooth, emit } = loadBluetooth(['EB-169', 'IJ_'])
    const wifiScan = bluetooth.discoverDevices({ freshOnly: true, includeWifi: true, timeout: 30 })
    const bleScan = bluetooth.discoverDevices({ freshOnly: true, timeout: 30 })
    await new Promise(resolve => setTimeout(resolve, 0))
    emit([{ deviceId: 'h-wifi', name: 'IJ_E348C21ED428', RSSI: -50 }])
    const withWifi = await wifiScan
    assert.equal(withWifi.length, 1)
    assert.equal(withWifi[0].commType, 'WIFI')
    assert.equal(withWifi[0].wifiDeviceId, 'E348C21ED428')
    assert.equal((await bleScan).length, 0)
    checked('后台广播 ID 写成 IJ_ 时 WiFi 设备不会被当成蓝牙版')
  }

  // ── ③ 搜索页 ──
  const never = new Promise(() => {})
  const products = {
    E348C21ED428: () => Promise.resolve({ productId: 21, productName: 'WiFi相框', sizeModel: '13.3寸' }),
    CCCCCCCCCCCC: () => Promise.resolve({ productId: 22, productName: 'WiFi相框', sizeModel: '' }),
    D0CF13F02FF8: () => Promise.resolve(null),
    AAAAAAAAAAAA: () => Promise.reject(new Error('timeout')),
    BBBBBBBBBBBB: () => never
  }
  const queried = []
  const { page, state } = loadPage('subpackages/device/bind/bind.js', pageState => ({
    api: {
      scanSizeModel: () => '',
      getProductByDevice: deviceNo => { queried.push(deviceNo); return products[deviceNo]() }
    },
    toast: { warn: options => pageState.toasts.push(options) },
    permission: { getCurrentLocation: async () => ({ latitude: 0, longitude: 0 }) },
    bluetooth: {
      openAdapter: async () => {}, stopDiscovery() {}, showEmptyResultGuide() {}, whenScanStopped: async () => {},
      discoverDevices: async options => { pageState.scanOptions = options; return [] }
    },
    'device-ble': { readDeviceInfo: async () => { throw new Error('蓝牙流程桩：到此为止') }, disconnect() {} },
    'active-device': { friendlyConnectMessage: text => text },
    'device-id': deviceIdUtil,
    'device-name': {}, system: {}, 'fold-adapt': { adapt: value => value },
    'device-thumb': require('../utils/device-thumb'),
    'wifi-provision': { setTarget: value => { pageState.target = value } }
  }))
  const wifiRow = (handle, deviceNo) => ({
    id: handle, deviceId: handle, name: `IJ_${deviceNo}`, commType: 'WIFI', wifiDeviceId: deviceNo,
    realBluetooth: true, RSSI: -50, signalText: '强'
  })
  const bleRow = { id: 'b1', deviceId: 'b1', name: 'EB-169', commType: 'BLE', realBluetooth: true, RSSI: -60, broadcastDeviceId: '37:0B:00:D0:44:5A' }
  const rows = [wifiRow('w1', 'E348C21ED428'), wifiRow('w2', 'D0CF13F02FF8'), wifiRow('w3', 'AAAAAAAAAAAA'), bleRow, wifiRow('w5', 'CCCCCCCCCCCC')]

  page.applyScanResult(1, rows)
  assert.equal(page.data.devices[0].wifiStatus, 'loading')
  assert.equal(page.data.devices[0].specText, '规格查询中…')
  assert.equal(page.data.devices[0].deviceCode, 'E348C21ED428', 'WiFi 行的设备ID 是广播名里的 12 位 deviceNo')
  assert.equal(page.data.devices[3].commType, 'BLE')
  assert.equal(page.data.devices[3].deviceCode, '37:0B:00:D0:44:5A', '蓝牙行仍取广播 6 字节')
  assert.equal(page.data.selectedId, 'w1')
  assert.equal(page.data.selectedIsWifi, true, '选中 WiFi 设备时底部按钮改「立即配网」')
  page.applyScanResult(1, rows)
  assert.deepEqual(queried, ['E348C21ED428', 'D0CF13F02FF8', 'AAAAAAAAAAAA', 'CCCCCCCCCCCC'], '同一次搜索每台只查一次')
  await flush()
  await flush()
  const byId = id => page.data.devices.find(item => item.id === id)
  assert.equal(byId('w1').wifiStatus, 'found')
  assert.equal(byId('w1').specText, '13.3寸', '尺寸直接读 sizeModel')
  assert.equal(byId('w5').specText, '--寸', '查到了但没配 sizeModel 显示 --寸')
  assert.equal(byId('w2').specText, '未知设备', '查不到 → 未知设备')
  assert.equal(byId('w3').specText, '未知设备', '接口失败/超时 → 未知设备，不重试')
  checked('WiFi 行按 deviceNo 查规格：尺寸读 sizeModel（没配 --寸），查不到/失败为未知设备')

  page.selectDevice({ currentTarget: { dataset: { id: 'w2' } } })
  assert.equal(page.data.showUnknownTip, true, '点未知设备那一行就直接弹窗')
  assert.equal(page.data.unknownTipText, '未知设备，请联系客服开通')
  assert.equal(state.modals.length, 0, '用本页提示弹层，不再用系统 showModal')
  assert.equal(page.data.selectedId, 'w1', '未知设备不被选中')
  page.data.showUnknownTip = false
  page.data.selectedId = 'w3'
  await page.confirmBind()
  assert.equal(page.data.showUnknownTip, true, '未知设备被默认选中时，点底部按钮同样弹窗')
  assert.equal(state.navs.length, 0, '未知设备不进入配网')
  assert.equal(page.data.binding, false, '未知设备不进入蓝牙绑定流程')
  checked('未知设备点行 / 点按钮都直接弹窗拦下')

  page.selectDevice({ currentTarget: { dataset: { id: 'w1' } } })
  assert.equal(state.navs.length, 1, '点查到规格的 WiFi 设备即进配置页')
  assert.ok(
    state.navs[0].url.indexOf('/subpackages/device/wifi-config/wifi-config?deviceNo=E348C21ED428') === 0,
    `查到规格的 WiFi 设备进 WiFi 配置页：${state.navs[0].url}`
  )
  assert.equal(page.data.selectedId, 'w1')
  assert.equal(state.target.bleDeviceId, 'w1', '配网要用的蓝牙句柄走内存交接')
  assert.equal(state.target.deviceNo, 'E348C21ED428')
  assert.equal(state.target.product.productId, 21, '查到的产品随行交给配网第 4 步绑定')
  await page.confirmBind()
  assert.equal(state.navs.length, 2, '选中后点底部按钮同样进配置页')
  checked('查到规格的 WiFi 设备进入 WiFi 配置页')

  page.applyScanResult(1, rows.concat(wifiRow('w4', 'BBBBBBBBBBBB')))
  page.selectDevice({ currentTarget: { dataset: { id: 'w4' } } })
  assert.equal(state.toasts.at(-1).title, '正在查询设备信息，请稍候', '规格还在查时先提示稍候')
  assert.equal(state.navs.length, 2)
  checked('规格查询中不放行')

  page.selectDevice({ currentTarget: { dataset: { id: 'b1' } } })
  assert.equal(page.data.selectedIsWifi, false, '选中蓝牙设备时按钮仍是「立即绑定」')
  assert.equal(state.navs.length, 2, '点蓝牙设备只选中，不跳转')
  await page.confirmBind()
  await flush()
  assert.equal(state.navs.length, 2, '蓝牙设备不进 WiFi 配网')
  assert.equal(state.toasts.at(-1).title, '蓝牙流程桩：到此为止', '蓝牙设备照旧走连接读 0x01 的绑定流程')
  checked('蓝牙设备的绑定流程不受影响')

  await page.scan()
  assert.equal(state.scanOptions.includeWifi, true, '搜索设备页同时搜蓝牙版与 WiFi 版')
  page.applyScanResult(page.scanSeq, [wifiRow('w1', 'E348C21ED428'), wifiRow('w2', 'D0CF13F02FF8')])
  // 2026-10-26 改为不缓存：原断言「查到的不重复查」随之改为「全部重查」，判据仍是「重新搜索时查询结果不沿用上一轮」
  assert.deepEqual(queried.slice(5), ['E348C21ED428', 'D0CF13F02FF8'], '重新搜索：不缓存，查到的和查不到的都重查')
  checked('重新搜索时全部重查（不缓存）')

  // ── 规格接口返回归一：只认产品身份 ──
  {
    const api = require('../utils/api')
    assert.equal(api.normalizeWifiProduct({ productId: 21, productName: 'WiFi相框', sizeModel: '13.3寸' }).sizeModel, '13.3寸')
    assert.equal(api.normalizeWifiProduct([{ productId: '21', sizeModel: null }]).sizeModel, '', '列表形状取第一条；没配尺寸为空串')
    assert.equal(api.normalizeWifiProduct({ list: [{ productId: 21, sizeModel: '13.3寸' }], total: 1 }).sizeModel, '13.3寸', '分页形状取第一条')
    assert.equal(api.normalizeWifiProduct({ product: { productId: 21, sizeModel: '13.3寸' } }).sizeModel, '13.3寸', '包在 product 字段里')
    assert.equal(api.normalizeWifiProduct({ list: [], total: 0 }), null, '空分页算查不到')
    for (const empty of [null, undefined, '', [], {}, { productId: 0, productName: null, sizeModel: null }, { productId: '0' }, { sizeModel: '13.3寸' }]) {
      assert.equal(api.normalizeWifiProduct(empty), null, `${JSON.stringify(empty)} 应算查不到`)
    }
    checked('空数据 / 空壳记录 / 只有尺寸没有产品身份都算查不到')
  }

  // ── ④ WiFi 配置页与页面注册 ──
  const loadConfig = (connected, platform = 'android') => {
    const world = { listHandler: null, credentials: null }
    const loaded = loadPage('subpackages/device/wifi-config/wifi-config.js', pageState => ({
      toast: { warn: options => pageState.toasts.push(options) },
      system: { getLayoutMetrics: () => ({ statusBarHeight: 20, safeBottom: 0 }) },
      'fold-adapt': { adapt: value => value },
      'wifi-provision': { getTarget: () => ({ deviceNo: 'E348C21ED428' }), setCredentials: value => { world.credentials = value } }
    }), {
      getDeviceInfo: () => ({ platform }),
      startWifi: ({ success }) => success({}),
      getConnectedWifi: ({ success, fail }) => (connected ? success({ wifi: connected }) : fail({ errCode: 12005 })),
      onGetWifiList: handler => { world.listHandler = handler },
      getWifiList: ({ success }) => success({})
    })
    return Object.assign(loaded, { world })
  }
  {
    // 2026-10-26 改为统一先弹列表：原断言「2.4G 直接回填、不弹列表」随之改为「不回填、弹列表，当前网络排第一」
    const { page: config, world } = loadConfig({ SSID: 'Home-2.4', frequency: 2437 })
    config.onLoad({ deviceNo: 'E348C21ED428', name: 'IJ_E348C21ED428' })
    await flush()
    await flush()
    assert.equal(config.data.ssid, '', '连着 2.4G 也不自动回填')
    assert.equal(config.data.showWifiList, true, '进页面统一先弹列表')
    world.listHandler({ wifiList: [
      { SSID: 'Cafe', frequency: 2462, signalStrength: 90 },
      { SSID: 'Home-2.4', frequency: 2437, signalStrength: 40 }
    ] })
    assert.deepEqual(config.data.wifiList.map(item => item.ssid), ['Home-2.4', 'Cafe'], '当前连接的排第一')
    assert.equal(config.data.wifiList[0].current, true)
    checked('连着 2.4G 也统一先弹列表，当前网络排第一')
  }
  {
    const { page: config, state: configState, world } = loadConfig({ SSID: 'Home5G', frequency: 5180 })
    config.onLoad({ deviceNo: 'E348C21ED428', name: 'IJ_E348C21ED428' })
    await flush()
    await flush()
    assert.equal(config.data.ssid, '', '5G 不回填')
    assert.equal(config.data.showWifiList, true, '连的是 5G：直接弹列表')
    world.listHandler({ wifiList: [
      { SSID: 'Home-2.4', frequency: 2437, signalStrength: 60 },
      { SSID: 'Home5G', frequency: 5180, signalStrength: 99 },
      { SSID: 'Home-2.4', frequency: 2412, signalStrength: 80 },
      { SSID: 'Cafe', frequency: 2462, signalStrength: 90 },
      { SSID: '', frequency: 2412, signalStrength: 70 }
    ] })
    assert.deepEqual(config.data.wifiList.map(item => item.ssid), ['Cafe', 'Home-2.4'], '只留 2.4G、同名去重、信号强在前')
    config.goNext()
    assert.equal(configState.toasts.at(-1).title, '请输入或选择WiFi名称')
    config.pickWifi({ currentTarget: { dataset: { ssid: 'Home-2.4' } } })
    assert.equal(config.data.ssid, 'Home-2.4', '点一下即回填名称')
    assert.equal(config.data.showWifiList, false, '选中后列表直接收起，无需确认')
    config.onPasswordInput({ detail: { value: 'secret-123' } })
    config.goNext()
    const url = configState.navs.at(-1).url
    assert.ok(url.indexOf('/subpackages/device/wifi-provision/wifi-provision?') === 0)
    assert.equal(url.indexOf('secret-123'), -1, 'WiFi 密码不进页面路由')
    assert.deepEqual(JSON.parse(JSON.stringify(world.credentials)), { ssid: 'Home-2.4', password: 'secret-123' }, '名称 / 密码交给配网流程')
    checked('5G / 没连 WiFi 直接弹 2.4G 列表，点选回填，下一步不带密码')
  }
  {
    const { page: config } = loadConfig(null)
    config.onLoad({})
    await flush()
    await flush()
    assert.equal(config.data.showWifiList, true, '没连 WiFi：直接弹列表')
    checked('没连 WiFi 直接弹列表')
  }
  {
    // 2026-10-26 真机反馈：连着 5G 被回填。iOS 不回频段，判不了就按「不是 2.4G」弹列表，绝不回填
    const { page: config } = loadConfig({ SSID: 'Home5G' }, 'ios')
    config.onLoad({})
    await flush()
    await flush()
    assert.equal(config.data.ssid, '', 'iOS 频段未知：不回填')
    assert.equal(config.data.showWifiList, true, 'iOS 频段未知：直接弹列表')
    assert.equal(config.data.wifiList[0].ssid, 'Home5G')
    assert.equal(config.data.wifiList[0].current, true, '当前连接的网络放在列表里，标「当前连接」')
    assert.equal(config.data.iosNearbyEntry, true, 'iOS 另给「获取附近WiFi」入口')
    config.pickWifi({ currentTarget: { dataset: { ssid: 'Home5G', band: '' } } })
    assert.ok(/2\.4G/.test(config.data.bandHint), '选了频段未知的网络：提示确认是 2.4G')

    const ghz = loadConfig({ SSID: 'Home5G', frequency: 5 })
    ghz.page.onLoad({})
    await flush()
    await flush()
    assert.equal(ghz.page.data.ssid, '', '频段按 GHz 给的 5G 同样不回填')
    assert.equal(ghz.page.data.showWifiList, true)
    checked('5G / 频段判不了一律弹列表，只有确认 2.4G 才回填')
  }
  const device = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8')).subpackages.find(item => item.root === 'subpackages/device')
  assert.ok(device.pages.includes('wifi-config/wifi-config') && device.pages.includes('wifi-provision/wifi-provision'))
  const wxml = fs.readFileSync(path.join(root, 'subpackages/device/bind/bind.wxml'), 'utf8').replace(/<!--[\s\S]*?-->/g, '')
  assert.ok(/comm-badge--wifi/.test(wxml) && /comm-badge--ble/.test(wxml), '搜索列表行要挂 WiFi版 / 蓝牙版 标签')
  checked('两张配网页已注册，搜索列表带通信类型标签')

  console.log(`wifi-search: ${checks} groups passed`)
}
main().catch(error => { console.error(error); process.exitCode = 1 })
