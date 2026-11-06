// 「我的上传」删除写请求日志（2026-11-06）：原来删除只在控制台记摘要（记录删除结果、云端返回），
// 看不到发了哪个接口、带了什么参数；网络层那行 [HTTP] / [IoT] 只进联调浮窗、不进控制台。
//   ① api.deleteProjectionRecords(ids, { onLog })：逐条记「接口【删除相册记录】POST 路径 参数 {id}」，
//      结束记「→ 返回 …」或「→ 失败 code message」；失败照旧计入 failedIds；不给 onLog 行为不变；
//   ② iotApi.deletePhotos(payload, { onLog })：记**实际发出的** body（deviceNo 已去冒号）与返回 / 失败，
//      失败照旧抛出；其余 options（showError）原样交给 iot.post；
//   ③ 「我的上传」页：蓝牙版、WiFi 版两条删除链路都把 onLog 传下去，日志带 [相册删除] / [相册删除][WiFi] 前缀打进 console。
const assert = require('assert')

const stubModule = (request, exports) => {
  const filename = require.resolve(request)
  require.cache[filename] = { id: filename, filename, loaded: true, children: [], paths: [], exports }
}

const storage = {}
global.wx = new Proxy({
  getStorageSync: key => storage[key],
  setStorageSync: (key, value) => { storage[key] = value },
  showLoading: () => {},
  hideLoading: () => {}
}, {
  get: (target, key) => key in target ? target[key] : options => {
    if (options && typeof options.fail === 'function') options.fail({})
  }
})
global.getApp = () => ({ globalData: {} })

;(async () => {
  // ① 老服务删相册记录
  {
    const posts = []
    stubModule('../utils/request', {
      post: (url, data, options) => {
        posts.push({ url, data, options })
        return data.id === 'b'
          ? Promise.reject(Object.assign(new Error('接口-记录不存在'), { code: 500 }))
          : Promise.resolve({ code: 200, msg: 'ok' })
      }
    })
    const api = require('../utils/api')
    const lines = []
    const result = await api.deleteProjectionRecords(['a', 'b'], { onLog: text => lines.push(text) })
    assert.deepStrictEqual(lines, [
      '接口【删除相册记录】POST /Client/UserProduct/delUserProductImgRecord 参数 {"id":"a"}',
      '→ 返回 {"code":200,"msg":"ok"}',
      '接口【删除相册记录】POST /Client/UserProduct/delUserProductImgRecord 参数 {"id":"b"}',
      '→ 失败 500 接口-记录不存在'
    ], '逐条记参数与返回 / 失败')
    assert.deepStrictEqual(result, { total: 2, failed: 1, failedIds: ['b'] }, '失败照旧计入 failedIds')
    assert.deepStrictEqual(posts[0].options, { mock: false, showError: false }, '请求选项不变')

    posts.length = 0
    const plain = await api.deleteProjectionRecords(['a'])
    assert.deepStrictEqual(plain, { total: 1, failed: 0, failedIds: [] }, '不给 onLog 行为不变')
    console.log('PASS 删除相册记录：逐条请求日志')
  }

  // ② IoT 删云端照片
  {
    const posts = []
    let reply = { deleted: 1, deviceNotified: true }
    stubModule('../utils/iot-request', {
      post: (url, data, options) => {
        posts.push({ url, data, options })
        return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply)
      }
    })
    const iotApi = require('../utils/iot-api')
    const lines = []
    const options = { showError: false, onLog: text => lines.push(text) }
    const res = await iotApi.deletePhotos({ deviceNo: 'd0:cf:13:f0:2f:f8', imgUrls: ['https://oss/a.bin'], nextImageUrl: 'https://oss/c.bin' }, options)
    assert.deepStrictEqual(res, reply)
    assert.deepStrictEqual(lines, [
      '接口【删除云端照片】POST /api/device/photo/delete 参数 {"deviceNo":"D0CF13F02FF8","imgUrls":["https://oss/a.bin"],"nextImageUrl":"https://oss/c.bin"}',
      '→ 返回 {"deleted":1,"deviceNotified":true}'
    ], '记实际发出的 body（deviceNo 去冒号）与返回')
    assert.strictEqual(posts[0].options.showError, false, '其余选项原样交给 iot.post')

    lines.length = 0
    reply = Object.assign(new Error('接口(IoT)-服务暂不可用'), { code: 503 })
    await assert.rejects(() => iotApi.deletePhotos({ deviceNo: 'D0CF13F02FF8', imgUrls: ['x'] }, options), /服务暂不可用/, '失败照旧抛出')
    assert.deepStrictEqual(lines[1], '→ 失败 503 接口(IoT)-服务暂不可用')

    reply = {}
    lines.length = 0
    await iotApi.deletePhotos({ deviceNo: 'D0CF13F02FF8', all: true })
    assert.deepStrictEqual(lines, [], '不给 onLog 不记')
    console.log('PASS 删除云端照片：请求日志')
  }

  // ③ 「我的上传」页把 onLog 传给两条删除链路
  {
    const calls = { records: [], cloud: [] }
    stubModule('../utils/api', {
      deleteProjectionRecords: (ids, options) => {
        calls.records.push(options)
        options.onLog('记录请求行')
        return Promise.resolve({ total: ids.length, failed: 0, failedIds: [] })
      }
    })
    stubModule('../utils/iot-api', {
      deletePhotos: (payload, options) => {
        calls.cloud.push(options)
        options.onLog('云端请求行')
        return Promise.resolve({ deleted: 1, deviceNotified: true })
      }
    })
    stubModule('../utils/wifi-status', { projectBlockedTip: () => Promise.resolve('') })
    stubModule('../utils/device-ble', { deleteImage: () => Promise.resolve() })
    stubModule('../utils/device-info', { read: () => Promise.resolve({ imgMask: [0x01].concat(new Array(11).fill(0)) }) })
    stubModule('../utils/toast', { warn: () => {}, show: () => {}, error: () => {} })
    stubModule('../utils/active-device', { friendlyConnectMessage: message => message })
    stubModule('../utils/media', {})
    stubModule('../utils/system', { getLayoutMetrics: () => ({}) })
    stubModule('../utils/upload-limit', { albumPickLimit: () => 10 })
    stubModule('../utils/fold-adapt', { adapt: options => options })

    let pageOptions = null
    global.Page = options => { pageOptions = options }
    require('../subpackages/album/list/list.js')

    const wifiDevice = { id: 'W1', userProductId: 'W1', name: 'WiFi相框', broadcastId: 'IJ_*', productDeviceId: 'D0:CF:13:F0:2F:F8' }
    const bleDevice = { id: 'B1', userProductId: 'B1', name: '蓝牙相框', broadcastId: 'EF6-370', productDeviceId: 'AA:BB:CC:DD:EE:01' }
    const makePage = (records, selected) => {
      const ctx = Object.create(pageOptions)
      ctx.data = {
        selectedMap: selected.reduce((map, id) => Object.assign(map, { [id]: true }), {}),
        filteredPhotos: records.map(item => ({ id: item.id })),
        currentFilter: records[0].userProductId,
        showDeleteConfirm: true,
        deleteClosing: false
      }
      ctx.setData = patch => Object.assign(ctx.data, patch)
      ctx.records = records
      ctx.devices = [wifiDevice, bleDevice]
      ctx.loadPhotos = () => {}
      return ctx
    }

    const log = console.log
    const warn = console.warn
    const printed = []
    console.log = function () { printed.push(Array.prototype.slice.call(arguments)) }
    console.warn = () => {}
    try {
      await makePage([
        { id: 'a', userProductId: 'W1', imgBle: 'https://oss/a.bin' },
        { id: 'c', userProductId: 'W1', imgBle: 'https://oss/c.bin' }
      ], ['a']).confirmDeleteSelected()

      const ble = makePage([{ id: 'p', userProductId: 'B1', imgIndex: '0' }], ['p'])
      ble.ensureConnectedDevice = () => Promise.resolve({ deviceId: 'BLE-1', id: 'B1' })
      await ble.confirmDeleteSelected()
    } finally {
      console.log = log
      console.warn = warn
    }

    assert.strictEqual(calls.records.length, 2, '两条链路都删了记录')
    assert.ok(calls.records.every(options => typeof options.onLog === 'function'), '记录删除带 onLog')
    assert.strictEqual(calls.cloud.length, 1)
    assert.strictEqual(calls.cloud[0].showError, false, '云端删除仍不弹自动错误')
    assert.strictEqual(typeof calls.cloud[0].onLog, 'function', '云端删除带 onLog')
    const has = (tag, text) => printed.some(args => args[0] === tag && args[1] === text)
    assert.ok(has('[相册删除][WiFi]', '记录请求行'), 'WiFi 记录请求打进 console')
    assert.ok(has('[相册删除][WiFi]', '云端请求行'), 'WiFi 云端请求打进 console')
    assert.ok(has('[相册删除]', '记录请求行'), '蓝牙版记录请求打进 console')
    console.log('PASS 我的上传：两条删除链路都写请求日志')
  }

  console.log('album-delete-request-log: 3 groups passed')
})().catch(error => { console.error(error); process.exitCode = 1 })
