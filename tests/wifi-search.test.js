// WiFi 版接入搜索（2026-10-26，对接进度 STEP 1）：
//   ① 广播名匹配：后台 `IJ_*` 模板按 `*` 拆前后缀、中间正好 12 位取 deviceId；蓝牙版固定广播名沿用包含匹配；
//      广播名合内置 `IJ_*` 的一律是 WiFi 版，后台把广播 ID 写成 `IJ_`（不带 *）也不会被当成蓝牙版；
//   ② 扫描层：只有 includeWifi 的订阅者（搜索设备页）收录 WiFi 设备并标 commType，其它扫描入口照旧只认蓝牙版；
//   ③ 搜索页：WiFi 行按 deviceNo 查产品规格（每台只查一次），查到直接显示 sizeModel、没配显示「--寸」，
//      查不到/返回空壳记录/失败显示「未知设备」；未知设备点行或点底部按钮都直接弹「未知设备，请联系客服开通」
//      （本页底部提示弹层，与首页提示同一套样式）、
//      不进配网；查到的点行即进 WiFi 列表页；不缓存，重新搜索时全部重查；
//   ④ 配网前两页（2026-10-26 产品定的流程）：搜索页 → WiFi 列表页（蓝牙连设备、由设备扫描附近 WiFi，同名去重、
//      信号强在前、4 格信号；可重新搜索、手动输入）
//      → 选中即进 WiFi 账号密码页并带上名称 → 「下一步」把名称 / 密码交给配网流程，密码不进页面路由；
//      账号密码页的切换图标回到列表页；三张配网页已在 app.json 注册。
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
    './signal': require('../utils/signal'),
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
    assert.deepEqual(withWifi.map(item => item.signalLevel), [4, 3], '扫描记录带信号格数（-50 满格、-60 三格）')
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
      // 与 api.lookupProductByDevice 同形状：{ product, reason }，不抛错
      lookupProductByDevice: deviceNo => {
        queried.push(deviceNo)
        return products[deviceNo]().then(
          product => ({ product, reason: product ? '' : `${deviceNo}：返回为空` }),
          error => ({ product: null, reason: `${deviceNo}：接口失败：${error.message}` })
        )
      }
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
    'wifi-provision': { setTarget: value => { pageState.target = value } },
    blufi: { async connect(id) { pageState.connected = (pageState.connected || []).concat(id); if (pageState.connectFails) throw new Error('createBLEConnection:fail'); return {} } }
  }))
  const wifiRow = (handle, deviceNo) => ({
    id: handle, deviceId: handle, name: `IJ_${deviceNo}`, commType: 'WIFI', wifiDeviceId: deviceNo,
    realBluetooth: true, RSSI: -50, signalText: '强'
  })
  const bleRow = { id: 'b1', deviceId: 'b1', name: 'EB-169', commType: 'BLE', realBluetooth: true, RSSI: -60, broadcastDeviceId: '37:0B:00:D0:44:5A' }
  const rows = [wifiRow('w1', 'E348C21ED428'), wifiRow('w2', 'D0CF13F02FF8'), wifiRow('w3', 'AAAAAAAAAAAA'), bleRow, wifiRow('w5', 'CCCCCCCCCCCC')]

  page.applyScanResult(1, rows)
  assert.equal(page.data.devices[0].wifiStatus, 'loading')
  assert.equal(page.data.devices[0].specText, '', '查询中不出文字，尺寸位置显示小圆圈 loading（wifiStatus 驱动）')
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

  // 2026-10-26 产品口径：点搜索列表只是选中，没有其它意思；配网 / 未知设备提示都由底部按钮触发
  page.selectDevice({ currentTarget: { dataset: { id: 'w2' } } })
  assert.equal(page.data.selectedId, 'w2', '点未知设备也只是选中')
  assert.equal(page.data.showUnknownTip, false, '点行不弹窗')
  await page.confirmBind()
  assert.equal(page.data.showUnknownTip, true, '点底部「立即配网」才弹未知设备提示')
  assert.equal(page.data.unknownTipText, '未知设备，请联系客服开通')
  assert.equal(page.data.unknownTipReason, '', '正式版（取不到环境按正式版）不显示原因')
  assert.equal(state.modals.length, 0, '用本页提示弹层，不再用系统 showModal')
  assert.equal(state.navs.length, 0, '未知设备不进入配网')
  assert.equal(page.data.binding, false, '未知设备不进入蓝牙绑定流程')
  checked('点行只选中；未知设备点底部按钮弹窗拦下')

  page.data.showUnknownTip = false
  state.connectFails = true
  page.selectDevice({ currentTarget: { dataset: { id: 'w1' } } })
  await flush()
  assert.equal(state.connected, undefined, '点行不连设备')
  assert.equal(state.navs.length, 0, '点行不跳转')
  await page.confirmBind()
  await flush()
  assert.equal(state.navs.length, 0, '第一步蓝牙连设备失败：停在搜索页，不进列表页')
  assert.equal(state.toasts.at(-1).title, 'createBLEConnection:fail')
  state.connectFails = false
  await page.confirmBind()
  await flush()
  assert.deepEqual(state.connected, ['w1', 'w1'], '点「立即配网」先用蓝牙连上设备')
  assert.equal(state.navs.length, 1, '连上后才进 WiFi 列表页')
  assert.ok(
    state.navs[0].url.indexOf('/subpackages/device/wifi-list/wifi-list?deviceNo=E348C21ED428') === 0,
    `查到规格的 WiFi 设备先进 WiFi 列表页：${state.navs[0].url}`
  )
  assert.equal(page.data.selectedId, 'w1')
  assert.equal(state.target.bleDeviceId, 'w1', '配网要用的蓝牙句柄走内存交接')
  assert.equal(state.target.deviceNo, 'E348C21ED428')
  assert.equal(state.target.product.productId, 21, '查到的产品随行交给配网第 4 步绑定')
  checked('查到规格的 WiFi 设备：点「立即配网」先连设备再进 WiFi 列表页')

  page.applyScanResult(1, rows.concat(wifiRow('w4', 'BBBBBBBBBBBB')))
  page.selectDevice({ currentTarget: { dataset: { id: 'w4' } } })
  assert.equal(state.navs.length, 1, '点行只选中')
  await page.confirmBind()
  assert.equal(state.toasts.at(-1).title, '正在查询设备信息，请稍候', '规格还在查时点按钮先提示稍候')
  assert.equal(state.navs.length, 1)
  checked('规格查询中不放行')

  page.selectDevice({ currentTarget: { dataset: { id: 'b1' } } })
  assert.equal(page.data.selectedIsWifi, false, '选中蓝牙设备时按钮仍是「立即绑定」')
  assert.equal(state.navs.length, 1, '点蓝牙设备只选中，不跳转')
  await page.confirmBind()
  await flush()
  assert.equal(state.navs.length, 1, '蓝牙设备不进 WiFi 配网')
  assert.equal(state.toasts.at(-1).title, '蓝牙流程桩：到此为止', '蓝牙设备照旧走连接读 0x01 的绑定流程')
  checked('蓝牙设备的绑定流程不受影响')

  {
    // 开发版 / 体验版：未知设备提示里带上没查到的原因
    const dev = loadPage('subpackages/device/bind/bind.js', pageState => ({
      api: { scanSizeModel: () => '', lookupProductByDevice: async () => ({ product: null, reason: 'E348C21ED428：接口失败：500 系统异常；E3:48:C2:1E:D4:28：返回里没有产品 ID 和产品名称：{}' }) },
      toast: { warn: options => pageState.toasts.push(options) },
      'device-thumb': require('../utils/device-thumb'),
      'device-id': deviceIdUtil, system: {}, 'fold-adapt': { adapt: value => value }
    }), { getAccountInfoSync: () => ({ miniProgram: { envVersion: 'trial' } }) })
    dev.page.applyScanResult(1, [wifiRow('x1', 'E348C21ED428')])
    await flush()
    await flush()
    await dev.page.confirmBind()
    assert.equal(dev.page.data.showUnknownTip, true)
    assert.ok(/接口失败：500 系统异常/.test(dev.page.data.unknownTipReason) && /返回里没有产品 ID/.test(dev.page.data.unknownTipReason), '体验版把原因写在弹窗上')
    checked('开发版 / 体验版未知设备提示带原因')
  }

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

  // ── ④ WiFi 列表页 → 账号密码页 ──
  const loadList = options => {
    const world = { closed: 0, scans: 0, connects: [] }
    const session = {
      async scanWifi(timeout, onBatch) {
        world.scans++
        if (options.scanError) throw options.scanError
        if (options.batches) {
          const all = []
          world.seen = []
          for (const batch of options.batches) {
            batch.forEach(item => all.push(item))
            onBatch(all, batch)
            world.seen.push(world.page.data.wifiList.map(item => item.ssid))
          }
          return all
        }
        return options.list === undefined ? [] : options.list
      },
      on: () => () => {},
      info: () => ({ serviceId: 'FFFF', frameLimit: 244 }),
      close() { world.closed++ }
    }
    const loaded = loadPage('subpackages/device/wifi-list/wifi-list.js', () => ({
      system: { getLayoutMetrics: () => ({ statusBarHeight: 20, safeBottom: 0 }) },
      'fold-adapt': { adapt: value => value },
      bluetooth: { async openAdapter() {}, async whenScanStopped() {} },
      blufi: {
        async connect(id) { world.connects.push(id); if (options.connectError) throw new Error('fail'); return session },
        is24GChannel: require('../utils/blufi').is24GChannel
      },
      signal: require('../utils/signal'),
      'wifi-provision': { getTarget: () => (options.noTarget ? null : { bleDeviceId: 'ble-w1', deviceNo: 'E348C21ED428' }) }
    }), options.envVersion ? { getAccountInfoSync: () => ({ miniProgram: { envVersion: options.envVersion } }) } : {})
    world.page = loaded.page
    return Object.assign(loaded, { world })
  }
  {
    // 本设备回信道：只留 2.4G（ch 1~14），5G 去掉；分批回时边收边显示
    const batched = loadList({ batches: [
      [{ ssid: 'starhc520', rssi: -27, channel: 1 }, { ssid: 'starhc520_5G', rssi: -29, channel: 48 }],
      [{ ssid: 'tyw-1308', rssi: -47, channel: 6 }, { ssid: '1308_5G', rssi: -60, channel: 157 }, { ssid: 'EricRachel', rssi: -84, channel: 13 }]
    ] })
    batched.page.onLoad({})
    await flush()
    await flush()
    assert.deepEqual(batched.world.seen, [['starhc520'], ['starhc520', 'tyw-1308', 'EricRachel']], '每收到一批就刷新列表（边扫边显示）')
    assert.deepEqual(batched.page.data.wifiList.map(item => item.ssid), ['starhc520', 'tyw-1308', 'EricRachel'], '5G（ch 48 / 157）被过滤，只留 2.4G')
    assert.equal(batched.page.data.scanning, false)
    checked('按信道只留 2.4G，分批回时边收边显示')
  }
  {
    const { page: list, state: listState, world } = loadList({ list: [
      { ssid: 'Home', rssi: -70 },
      { ssid: 'Cafe', rssi: -50 },
      { ssid: 'Home', rssi: -60 },
      { ssid: '', rssi: -40 },
      { ssid: 'Far', rssi: -85 }
    ] })
    list.onLoad({ deviceNo: 'E348C21ED428', name: 'IJ_E348C21ED428', spec: encodeURIComponent('13.3寸') })
    assert.equal(list.data.scanning, true, '进页面先显示「正在搜索网络...」')
    await flush()
    await flush()
    assert.deepEqual(world.connects, ['ble-w1'], '用搜索时拿到的蓝牙句柄连设备')
    assert.equal(world.scans, 1, '让设备扫描附近 WiFi，不用手机扫')
    assert.equal(list.data.scanning, false)
    assert.deepEqual(list.data.wifiList.map(item => item.ssid), ['Cafe', 'Home', 'Far'], '同名取信号强的、隐藏网络不列、信号强在前')
    assert.deepEqual(list.data.wifiList.map(item => item.level), [4, 3, 1], '信号强度分 4 格')
    // 点一行即选中该网络，直接进账号密码页（2026-10-26 一度改为「选中 + 连接」两步，按产品要求改回）
    const navsBefore = listState.navs.length
    list.pickWifi({ currentTarget: { dataset: { ssid: 'Home' } } })
    assert.equal(listState.navs.length, navsBefore + 1, '点一行即进账号密码页')
    const url = listState.navs.at(-1).url
    assert.ok(url.indexOf('/subpackages/device/wifi-config/wifi-config?') === 0, '进账号密码页')
    assert.ok(url.indexOf('ssid=Home') > -1, '名称带过去')
    assert.equal(world.closed, 0, '去账号密码页时蓝牙连接保留，给配网复用')
    list.manualInput()
    assert.ok(/ssid=($|&)/.test(listState.navs.at(-1).url), '手动输入：名称留空进账号密码页')
    list.onUnload()
    assert.equal(world.closed, 1, '离开列表页（返回搜索页）断开蓝牙')
    checked('WiFi 列表页：蓝牙连设备 → 设备扫描 → 列表（名称 + 信号），点一行即进账号密码页')
  }
  {
    const failed = loadList({ connectError: true })
    failed.page.onLoad({})
    await flush()
    await flush()
    assert.equal(failed.page.data.scanning, false)
    assert.ok(/连接设备失败/.test(failed.page.data.tip))
    const silent = loadList({ list: null })
    silent.page.onLoad({})
    await flush()
    await flush()
    assert.ok(/设备未返回WiFi列表/.test(silent.page.data.tip), '设备没回列表（固件不支持 / 扫描失败）给提示')
    silent.page.rescan()
    await flush()
    await flush()
    assert.equal(silent.world.scans, 2, '可重新搜索')
    const scanFail = loadList({ scanError: Object.assign(new Error('设备返回错误 11：WiFi 扫描失败'), { code: 11 }) })
    scanFail.page.onLoad({})
    await flush()
    await flush()
    assert.ok(/设备返回错误 11：WiFi 扫描失败/.test(scanFail.page.data.tip), '设备报扫描失败时把错误原样告诉用户，不干等超时')
    const lost = loadList({ noTarget: true })
    lost.page.onLoad({})
    await flush()
    assert.ok(/设备信息已失效/.test(lost.page.data.tip))
    assert.equal(lost.world.connects.length, 0)
    checked('连不上设备 / 设备没回列表 / 交接信息丢失都给提示，可重新搜索或手动输入')
  }
  {
    // 2026-10-26 去掉页面调试内容（原「非正式版打出回包字段 / 联调日志」用例随之删除），各环境同一套界面；
    // 保留的判据：名称为空的隐藏网络不列、标题与手动输入入口
    const dev = loadList({ list: [{ ssid: 'Home', rssi: -60 }, { ssid: '', rssi: -40 }], envVersion: 'develop' })
    dev.page.onLoad({})
    await flush()
    await flush()
    assert.deepEqual(dev.page.data.wifiList.map(item => item.ssid), ['Home'], '开发版也不列隐藏网络、不出调试字段')
    assert.equal(dev.page.data.showRaw, undefined, '页面不再有调试开关')
    const tpl = fs.readFileSync(path.join(root, 'subpackages/device/wifi-list/wifi-list.wxml'), 'utf8').replace(/<!--[\s\S]*?-->/g, '')
    assert.ok(/设备附近的2\.4G WiFi/.test(tpl), '列表标题为「设备附近的2.4G WiFi」')
    assert.ok(/class="wifi-manual-hint"[^>]*bindtap="manualInput"[^>]*>若列表搜索不到您的wifi，请手动输入</.test(tpl), '提示语下有灰字手动输入入口')
    assert.ok(!/showRaw|logs|rawSummary|wifi-debug-log/.test(tpl), '模板里不再有调试内容')
    // 2026-10-26 再调整：「手动输入WiFi名称」不要按钮样式，回到文字样式、居中（原「底部固定按钮」断言随之改写）
    assert.ok(/class="wifi-manual-text"[^>]*bindtap="manualInput"[^>]*>手动输入WiFi名称</.test(tpl), '「手动输入WiFi名称」为文字入口')
    const css = fs.readFileSync(path.join(root, 'subpackages/device/wifi-list/wifi-list.wxss'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    const manual = /\.wifi-manual-text\s*\{([^}]*)\}/.exec(css)
    assert.ok(manual && /text-align:\s*center/.test(manual[1]), '文字居中')
    assert.ok(!/position:\s*fixed/.test(manual[1]) && !/border:/.test(manual[1]) && !/background/.test(manual[1]), '不是按钮样式（无底色、描边、固定定位）')
    assert.ok(!/wifi-item__connect|connectSelected/.test(tpl), '列表行不再有「连接」按钮')
    checked('各环境同一套界面：无调试内容，隐藏网络不列，提示语下可手动输入')
  }
  {
    const world = { credentials: null, back: 0, redirect: null }
    const { page: config, state: configState } = loadPage('subpackages/device/wifi-config/wifi-config.js', pageState => ({
      toast: { warn: options => pageState.toasts.push(options) },
      system: { getLayoutMetrics: () => ({ statusBarHeight: 20, safeBottom: 0 }) },
      'fold-adapt': { adapt: value => value },
      'wifi-provision': { getTarget: () => ({ deviceNo: 'E348C21ED428' }), setCredentials: value => { world.credentials = value } }
    }), {
      navigateBack: () => { world.back++ },
      redirectTo: options => { world.redirect = options.url }
    })
    config.onLoad({ deviceNo: 'E348C21ED428', name: 'IJ_E348C21ED428', ssid: encodeURIComponent('我家WiFi') })
    assert.equal(config.data.ssid, '我家WiFi', '名称由列表页带过来')
    config.onPasswordInput({ detail: { value: 'secret-123' } })
    assert.equal(config.data.showPassword, false, '密码默认加密显示 ****（2026-10-26 产品要求）')
    config.togglePassword()
    assert.equal(config.data.showPassword, true, '点小眼睛看明文')
    assert.equal(config.data.password, 'secret-123', '切换只改显示，不动已输入的密码')
    config.togglePassword()
    assert.equal(config.data.showPassword, false)
    config.goNext()
    const url = configState.navs.at(-1).url
    assert.ok(url.indexOf('/subpackages/device/wifi-provision/wifi-provision?') === 0)
    assert.equal(url.indexOf('secret-123'), -1, 'WiFi 密码不进页面路由')
    assert.deepEqual(JSON.parse(JSON.stringify(world.credentials)), { ssid: '我家WiFi', password: 'secret-123' }, '名称 / 密码交给配网流程')
    config.onSsidInput({ detail: { value: '' } })
    config.goNext()
    assert.equal(configState.toasts.at(-1).title, '请输入或选择WiFi名称')
    config.openWifiList()
    assert.ok(world.redirect && world.redirect.indexOf('/subpackages/device/wifi-list/wifi-list?') === 0, '页面栈里没有列表页时重新打开列表页')
    checked('账号密码页：名称带入、密码只走内存交接、切换图标回列表')
  }
  const device = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8')).subpackages.find(item => item.root === 'subpackages/device')
  assert.ok(['wifi-list/wifi-list', 'wifi-config/wifi-config', 'wifi-provision/wifi-provision'].every(page => device.pages.includes(page)))
  const wxml = fs.readFileSync(path.join(root, 'subpackages/device/bind/bind.wxml'), 'utf8').replace(/<!--[\s\S]*?-->/g, '')
  assert.ok(/comm-badge--wifi/.test(wxml) && /comm-badge--ble/.test(wxml), '搜索列表行要挂 WiFi版 / 蓝牙版 标签')
  checked('三张配网页已注册，搜索列表带通信类型标签')

  console.log(`wifi-search: ${checks} groups passed`)
}
main().catch(error => { console.error(error); process.exitCode = 1 })
