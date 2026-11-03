// 「我的上传」按设备查投屏记录（2026-11-03）：getUserProductImgRecordList 新增可选参数 deviceId
// （设备完整 6 字节 ID = 前端 productDeviceId）。传了后端按设备 ID 查、不再按用户 ID；不传维持原逻辑按用户查。
//   ① api.getProjectionRecords：调用方给了 deviceId 才带上，没给不带（其它页面行为不变）；
//   ② 「我的上传」页（subpackages/album/list）选了具体设备时带该设备的 productDeviceId；
//      选「全部」、设备列表里找不到、或设备没有完整 ID 时都不带；
//   ③ WiFi 轮播设置的选图（subpackages/device/wifi-slideshow）同规则：设备有 productDeviceId 就带，没有不带；
//   ④ 投屏记录页与「我的」页统计这次不传 deviceId。
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8')

;(async () => {
  // ① api 层
  {
    const api = require('../utils/api')
    const original = api.getUserProductImgRecordList
    const calls = []
    api.getUserProductImgRecordList = params => {
      calls.push(params)
      return Promise.resolve({ pageData: [] })
    }
    try {
      await api.getProjectionRecords({ deviceUploadState: 1, userProductId: 'U1', deviceId: 'D0:CF:13:F0:2F:F8' })
      await api.getProjectionRecords({ deviceUploadState: 1, userProductId: 'U1' })
      await api.getProjectionRecords({ deviceUploadState: 1, deviceId: undefined })
    } finally {
      api.getUserProductImgRecordList = original
    }
    assert.strictEqual(calls[0].deviceId, 'D0:CF:13:F0:2F:F8', '给了设备 ID 就带')
    assert.strictEqual(calls[0].userProductId, 'U1', '原有参数不变')
    assert.ok(!('deviceId' in calls[1]), '没给不带，维持按用户查')
    assert.ok(!('deviceId' in calls[2]), 'undefined 不发给后端')
  }

  // ② 「我的上传」页
  {
    const stubModule = (request, exports) => {
      const filename = require.resolve(request)
      require.cache[filename] = { id: filename, filename, loaded: true, children: [], paths: [], exports }
    }
    global.wx = new Proxy({ getStorageSync: () => undefined, setStorageSync: () => {} }, {
      get: (target, key) => key in target ? target[key] : () => {}
    })
    global.getApp = () => ({ globalData: {} })
    const requests = []
    stubModule('../utils/api', {
      getProjectionRecords: params => { requests.push(params); return Promise.resolve([]) }
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
    page.data = { currentFilter: '' }
    page.setData = patch => Object.assign(page.data, patch)
    page.devices = [
      { id: 'W1', userProductId: 'W1', name: 'WiFi相框', productDeviceId: 'D0:CF:13:F0:2F:F8' },
      { id: 'B1', userProductId: 'B1', name: '旧相框', productDeviceId: '' },
      { id: 'S1', userProductId: 'S1', name: '短ID相框', productDeviceId: '', rawProductDeviceId: '2FF8', deviceIdentityInvalid: true }
    ]

    const logs = []
    const originalLog = console.log
    const originalWarn = console.warn
    console.log = (...args) => logs.push(['log', args.join(' ')])
    console.warn = (...args) => logs.push(['warn', args.join(' ')])
    try {
      await page.loadRecords('W1')
      await page.loadRecords('')
      await page.loadRecords('B1')
      await page.loadRecords('X9')
      await page.loadRecords('S1')
    } finally {
      console.log = originalLog
      console.warn = originalWarn
    }
    // 测试用的重点日志：传没传、为什么，一眼能看出来
    const tagged = logs.filter(([, text]) => text.indexOf('【我的上传·deviceId】') > -1)
    assert.ok(tagged.some(([level, text]) => level === 'log' && /已传 deviceId=D0:CF:13:F0:2F:F8，userProductId=W1/.test(text) && /WiFi相框/.test(text) && /按设备查/.test(text)), '日志：已传及原因')
    assert.ok(tagged.some(([level, text]) => level === 'warn' && /未传 deviceId/.test(text) && /「全部」/.test(text)), '日志：「全部」')
    assert.ok(tagged.some(([level, text]) => level === 'warn' && /userProductId=B1/.test(text) && /没有设备 ID/.test(text)), '日志：没有设备 ID')
    assert.ok(tagged.some(([level, text]) => level === 'warn' && /userProductId=X9/.test(text) && /找不到/.test(text)), '日志：设备列表里找不到')
    assert.ok(tagged.some(([level, text]) => level === 'warn' && /userProductId=S1/.test(text) && /2FF8/.test(text) && /不是完整/.test(text)), '日志：历史短 ID')
    assert.ok(tagged.some(([, text]) => /返回 0 条记录（按设备查，userProductId=W1）/.test(text)), '日志：返回条数与查询方式')
    assert.strictEqual(requests[4].deviceId, undefined, '历史短 ID 不带')
    assert.strictEqual(requests[0].deviceId, 'D0:CF:13:F0:2F:F8', '选了设备带它的完整 ID')
    assert.strictEqual(requests[0].userProductId, 'W1')
    assert.strictEqual(requests[1].deviceId, undefined, '「全部」不带')
    assert.strictEqual(requests[2].deviceId, undefined, '没有完整 ID 不带')
    assert.strictEqual(requests[3].deviceId, undefined, '设备列表里找不到不带')
  }

  // ③ WiFi 轮播设置选图
  {
    const requests = []
    const stubModule = (request, exports) => {
      const filename = require.resolve(request)
      require.cache[filename] = { id: filename, filename, loaded: true, children: [], paths: [], exports }
    }
    let detail = null
    stubModule('../utils/api', {
      getDeviceDetail: () => Promise.resolve(detail),
      getProjectionRecords: params => { requests.push(params); return Promise.resolve([]) }
    })
    stubModule('../utils/iot-api', { getStrategy: () => Promise.resolve(null) })
    ;['../utils/toast', '../utils/wifi-status', '../utils/wifi-projection', '../utils/dithering'].forEach(name => stubModule(name, {}))
    stubModule('../utils/system', { getLayoutMetrics: () => ({}) })
    stubModule('../utils/fold-adapt', { adapt: options => options })
    let pageOptions = null
    global.Page = options => { pageOptions = options }
    const file = require.resolve('../subpackages/device/wifi-slideshow/wifi-slideshow.js')
    delete require.cache[file]
    require(file)

    const run = async device => {
      detail = device
      const page = Object.create(pageOptions)
      page.data = Object.assign({}, pageOptions.data, { id: device.id })
      page.setData = patch => Object.assign(page.data, patch)
      page.selected = []
      await page.load()
      return requests[requests.length - 1]
    }
    const withId = await run({ id: 'W1', userProductId: 'W1', productDeviceId: 'D0:CF:13:F0:2F:F8' })
    assert.strictEqual(withId.deviceId, 'D0:CF:13:F0:2F:F8', '轮播选图：有完整 ID 就带')
    assert.strictEqual(withId.userProductId, 'W1', '轮播选图：原有参数不变')
    assert.strictEqual(withId.deviceUploadState, 1)
    const logs = []
    const originalLog = console.log
    const originalWarn = console.warn
    console.log = (...args) => logs.push(['log', args.join(' ')])
    console.warn = (...args) => logs.push(['warn', args.join(' ')])
    let withoutId
    let shortId
    try {
      withoutId = await run({ id: 'W2', userProductId: 'W2', productDeviceId: '' })
      shortId = await run({ id: 'W3', userProductId: 'W3', productDeviceId: '', rawProductDeviceId: '2FF8', deviceIdentityInvalid: true })
      await run({ id: 'W4', userProductId: 'W4', productDeviceId: 'D0:CF:13:F0:2F:F9' })
    } finally {
      console.log = originalLog
      console.warn = originalWarn
    }
    assert.strictEqual(withoutId.deviceId, undefined, '轮播选图：没有完整 ID 不带')
    assert.strictEqual(shortId.deviceId, undefined, '轮播选图：历史短 ID 不带')
    // 测试用的重点日志：传没传、为什么，一眼能看出来
    const tagged = logs.filter(([, text]) => text.indexOf('【轮播选图·deviceId】') > -1)
    assert.ok(tagged.some(([level, text]) => level === 'warn' && /未传 deviceId，userProductId=W2/.test(text) && /没有设备 ID/.test(text)), '日志：没 ID 的原因')
    assert.ok(tagged.some(([level, text]) => level === 'warn' && /未传 deviceId，userProductId=W3/.test(text) && /2FF8/.test(text) && /不是完整/.test(text)), '日志：短 ID 的原因')
    assert.ok(tagged.some(([level, text]) => level === 'log' && /已传 deviceId=D0:CF:13:F0:2F:F9，userProductId=W4/.test(text) && /按设备查/.test(text)), '日志：已传及原因')
    assert.ok(tagged.some(([, text]) => /返回 0 条记录（按设备查）/.test(text)), '日志：返回条数与查询方式')
  }

  // ④ 其它调用方这次不传 deviceId
  for (const file of ['subpackages/projection/records/records.js']) {
    const source = read(file)
    const calls = source.match(/getProjectionRecords\(\{[\s\S]*?\}\)/g) || []
    assert.ok(calls.length > 0, `${file} 仍调用 getProjectionRecords`)
    calls.forEach(call => assert.ok(!/deviceId/.test(call), `${file} 不传 deviceId`))
  }
  assert.ok(!/deviceId/.test(read('utils/api.js').match(/getProjectionSuccessCount\(\) \{[\s\S]*?\n  \},/)[0]), '「我的」页统计不传 deviceId')

  console.log('album-records-device-id: ok')
})().catch(error => {
  console.error(error)
  process.exit(1)
})
