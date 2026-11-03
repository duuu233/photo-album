// 「我的上传」切出去再回来不重新加载（2026-11-03 改缓存）。原来 onShow 每次清空网格重拉，必闪「加载中」、已选被清。
//   ① 首次显示正常加载；首屏还在请求中再 onShow 不重复发；
//   ② 本页在前台时切后台（页面 onHide 与 onAppHide 同时发生）、10 分钟内回来：不发任何请求，照片 / 已选 / 翻页原样；
//   ③ 后台超过 10 分钟、从下一级页面返回、或在下一级页面切过后台再返回：静默刷新——不清网格、不转圈，
//      已翻到第 k 页就一次取 k × 21 条，之后翻页从第 k+1 页接着取；已选里仍在的保留；
//   ④ 静默刷新失败保留现有内容，不切「加载失败」；当前设备没了才按正常流程（转圈）切到新设备；
//   ⑤ onUnload 取消 onAppHide 监听。
const assert = require('assert')

const stubModule = (request, exports) => {
  const filename = require.resolve(request)
  require.cache[filename] = { id: filename, filename, loaded: true, children: [], paths: [], exports }
}

let appHideHandler = null
let offCalled = false
global.wx = new Proxy({
  getStorageSync: () => undefined,
  setStorageSync: () => {},
  onAppHide: fn => { appHideHandler = fn },
  offAppHide: fn => { if (fn === appHideHandler) offCalled = true }
}, {
  get: (target, key) => key in target ? target[key] : () => {}
})
global.getApp = () => ({ globalData: {} })

const calls = { devices: 0, records: [] }
let devicesReply = null
const recordReplies = []
stubModule('../utils/api', {
  getDevices: () => {
    calls.devices++
    return devicesReply()
  },
  getProjectionRecordsPage: params => {
    calls.records.push(params)
    return new Promise((resolve, reject) => recordReplies.push({ resolve, reject }))
  },
  getUserProductClearImg: () => Promise.resolve(0)
})
;['../utils/iot-api', '../utils/wifi-status', '../utils/device-ble', '../utils/device-info', '../utils/media'].forEach(name => stubModule(name, {}))
stubModule('../utils/toast', { warn: () => {}, show: () => {}, error: () => {} })
stubModule('../utils/active-device', { friendlyConnectMessage: m => m, findConnectedDeviceId: () => '' })
stubModule('../utils/system', { getLayoutMetrics: () => ({}) })
stubModule('../utils/upload-limit', { albumPickLimit: () => 10 })
stubModule('../utils/fold-adapt', { adapt: options => options })
let pageOptions = null
global.Page = options => { pageOptions = options }
delete require.cache[require.resolve('../subpackages/album/list/list.js')]
require('../subpackages/album/list/list.js')

const page = Object.create(pageOptions)
page.data = JSON.parse(JSON.stringify(pageOptions.data))
const loadingHistory = []
page.setData = patch => Object.keys(patch).forEach(key => {
  const m = key.match(/^(\w+)\[(\d+)\]$/)
  if (m) {
    page.data[m[1]] = page.data[m[1]].slice()
    page.data[m[1]][Number(m[2])] = patch[key]
  } else {
    page.data[key] = patch[key]
    if (key === 'loading') loadingHistory.push(patch[key])
    if (key === 'filteredPhotos') loadingHistory.push(`photos:${patch[key].length}`)
  }
})

const DEVICES = [{ id: 'W1', userProductId: 'W1', name: 'WiFi相框', productDeviceId: 'D0:CF:13:F0:2F:F8' }]
devicesReply = () => Promise.resolve(DEVICES)
const recs = (from, n) => Array.from({ length: n }, (_, i) => ({ id: String(from + i), status: 'success', img: 'x', imgThumb: 'x' }))
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)) }
let now = 1000000
Date.now = () => now
const appToBackground = () => { now += 1; page.onHide(); appHideHandler() }

;(async () => {
  const originalLog = console.log
  const originalWarn = console.warn
  console.log = () => {}
  console.warn = () => {}
  try {
    page.onLoad()
    assert.ok(typeof appHideHandler === 'function', 'onLoad 注册 onAppHide')

    // ① 首次显示：正常加载
    page.onShow()
    page.onShow() // 首屏还在请求中
    await settle()
    assert.strictEqual(calls.devices, 1, '首屏在途不重复请求')
    assert.strictEqual(calls.records.length, 1)
    assert.strictEqual(page.data.loading, true)
    recordReplies.shift().resolve({ records: recs(1, 21), rowCount: 21, recordCount: 50, hasMore: true })
    await settle()
    assert.strictEqual(page.data.filteredPhotos.length, 21)

    // 翻到第 2 页、选两张
    await Promise.resolve().then(() => {
      const p = page.onReachBottom()
      recordReplies.shift().resolve({ records: recs(22, 21), rowCount: 21, recordCount: 50, hasMore: true })
      return p
    })
    assert.strictEqual(page.data.filteredPhotos.length, 42)
    page.setData({ selectedMap: { 2: true, 30: true }, selectedCount: 2 })

    // ② 本页在前台切后台，5 分钟后回来：一个请求都不发
    appToBackground()
    now += 5 * 60 * 1000
    loadingHistory.length = 0
    page.onShow()
    await settle()
    assert.strictEqual(calls.devices, 1, '切后台回来不拉设备')
    assert.strictEqual(calls.records.length, 2, '切后台回来不拉记录')
    assert.strictEqual(page.data.filteredPhotos.length, 42, '照片原样')
    assert.deepStrictEqual(page.data.selectedMap, { 2: true, 30: true }, '已选原样')
    assert.deepStrictEqual(loadingHistory, [], '没有转圈、没有清网格')

    // ③ 从下一级页面返回：静默刷新，按已翻页数一次取 42 条
    page.onHide()
    now += 3000
    page.onShow()
    await settle()
    assert.strictEqual(calls.devices, 2, '静默刷新会拉设备列表')
    const refresh = calls.records[calls.records.length - 1]
    assert.strictEqual(refresh.pageIndex, 1)
    assert.strictEqual(refresh.pageSize, 42, '已翻 2 页 → 一次取 42 条')
    assert.strictEqual(refresh.deviceId, 'D0:CF:13:F0:2F:F8', '查询条件不变')
    assert.strictEqual(page.data.loading, false, '静默刷新不转圈')
    assert.strictEqual(page.data.filteredPhotos.length, 42, '回包前网格不清')
    // 回包：新投了一张（id 0），id 30 已被删
    recordReplies.shift().resolve({ records: recs(0, 1).concat(recs(1, 29), recs(31, 12)), rowCount: 42, recordCount: 51, hasMore: true })
    await settle()
    assert.strictEqual(page.data.filteredPhotos[0].id, '0', '新记录出现在最前')
    assert.strictEqual(page.data.filteredPhotos.length, 42)
    assert.deepStrictEqual(page.data.selectedMap, { 2: true }, '已选里不在列表的去掉，其余保留')
    assert.strictEqual(page.data.selectedCount, 1)
    assert.deepStrictEqual(loadingHistory.filter(item => item === true || item === 'photos:0'), [], '全程没有转圈、没有清网格')
    // 之后翻页从第 3 页、每页 21 条接着取
    const more = page.onReachBottom()
    const next = calls.records[calls.records.length - 1]
    assert.strictEqual(next.pageIndex, 3)
    assert.strictEqual(next.pageSize, 21)
    recordReplies.shift().resolve({ records: recs(43, 9), rowCount: 9, recordCount: 51, hasMore: false })
    await more
    assert.strictEqual(page.data.filteredPhotos.length, 51)

    // ③ 之二：后台超过 10 分钟 → 静默刷新（已翻 3 页 → 63 条）
    appToBackground()
    now += 11 * 60 * 1000
    page.onShow()
    await settle()
    assert.strictEqual(calls.records[calls.records.length - 1].pageSize, 63, '后台太久也静默刷新')
    assert.strictEqual(page.data.loading, false)
    recordReplies.shift().resolve({ records: recs(0, 51), rowCount: 51, recordCount: 51, hasMore: false })
    await settle()
    assert.strictEqual(page.data.filteredPhotos.length, 51)

    // ③ 之三：进了下一级页面、在那边切过后台，再返回本页 → 仍静默刷新（那边可能投了新图）
    page.onHide()
    now += 60 * 1000
    appHideHandler()
    now += 60 * 1000
    const before = calls.records.length
    page.onShow()
    await settle()
    assert.strictEqual(calls.records.length, before + 1, '在下一级页面切过后台，返回仍刷新')

    // ④ 静默刷新失败：保留内容，不切「加载失败」
    recordReplies.shift().reject(new Error('net'))
    await settle()
    assert.strictEqual(page.data.loadError, false)
    assert.strictEqual(page.data.filteredPhotos.length, 51, '失败保留现有照片')

    // ④ 之二：设备列表失败也保留
    devicesReply = () => Promise.reject(new Error('net'))
    page.onHide()
    page.onShow()
    await settle()
    assert.strictEqual(page.data.loadError, false)
    assert.strictEqual(page.data.filteredPhotos.length, 51)

    // ④ 之三：当前设备没了 → 正常流程切到新设备（转圈、清已选）
    devicesReply = () => Promise.resolve([{ id: 'B2', userProductId: 'B2', name: '新相框', productDeviceId: '' }])
    page.setData({ selectedMap: { 5: true }, selectedCount: 1 })
    page.onHide()
    page.onShow()
    await settle()
    assert.strictEqual(page.data.currentFilter, 'B2')
    assert.strictEqual(page.data.loading, true, '换设备按正常加载')
    assert.deepStrictEqual(page.data.selectedMap, {})
    assert.strictEqual(calls.records[calls.records.length - 1].pageSize, 21, '换设备从第 1 页、21 条取')
    recordReplies.shift().resolve({ records: [], rowCount: 0, recordCount: 0, hasMore: false })
    await settle()

    // ⑤ 卸载取消监听
    page.onUnload()
    assert.ok(offCalled, 'onUnload 取消 onAppHide')
  } finally {
    console.log = originalLog
    console.warn = originalWarn
  }
  console.log('album-cache-on-show: ok')
})().catch(error => {
  console.error(error)
  process.exit(1)
})
