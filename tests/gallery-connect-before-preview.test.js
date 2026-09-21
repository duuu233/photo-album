// 官方图库「连接并投屏」要**先真的连上**再进预览（2026-09-21 报障：官方图库 → 选图 → 投屏 →
// 选设备点「连接并投屏」，进了预览页还是提示未连接）。
//
// 弹层里的设备来自后端列表，记录里没有本机 BLE 句柄（deviceId）。原来原样写进 pendingProjection、
// 指望预览页后台预热去连，预热没连完/静默失败时预览页就报「未连接」。现在：
//   ① 没有活动会话 → ensureConnectedForAction 先连，连上后带着句柄进预览（顺序：连 → 下载 → 跳转）；
//   ② 连不上 → 停在本页，不下载、不跳转，按钮复位；
//   ③ 已有活动会话 → 直接认领，不再扫描，低电量照旧提醒一次；
//   ④ 图片下载超时 → 中文提示，不再把「downloadFile:fail timeout」原样 toast 出去（同日需求 2）。
const assert = require('assert')

const storage = {}
let trace = []
let toasts = []
let downloadMode = 'ok' // ok | timeout

global.wx = {
  getStorageSync: key => storage[key],
  setStorageSync: (key, value) => {
    storage[key] = value
  },
  showLoading: () => {},
  hideLoading: () => {},
  navigateTo: options => trace.push(`navigate:${options.url}`),
  navigateBack: () => {},
  downloadFile: options => {
    trace.push('download')
    if (downloadMode === 'timeout') {
      options.fail({ errMsg: 'downloadFile:fail timeout' })
    } else {
      options.success({ statusCode: 200, tempFilePath: 'wxfile://tmp/photo.jpg' })
    }
  }
}
global.getApp = () => ({ requireLogin: () => true, globalData: {} })

const stubModule = (request, exports) => {
  const filename = require.resolve(request)
  require.cache[filename] = {
    id: filename,
    filename,
    loaded: true,
    children: [],
    paths: [],
    exports
  }
}

let connectedId = '' // findConnectedDeviceId 的返回：非空 = 已有活动会话
let connectResult = '' // ensureConnectedForAction 的返回：非空 = 连上了
stubModule('../utils/active-device', {
  getActiveDevice: () => null,
  isDeviceConnected: () => !!connectedId,
  findConnectedDeviceId: () => connectedId,
  ensureConnectedForAction: async () => {
    trace.push('connect')
    return connectResult
  },
  applyConnectedIdentity: (device, deviceId) =>
    Object.assign({}, device, { deviceId, bleDeviceId: deviceId, connected: true })
})
stubModule('../utils/low-battery', {
  warnIfLow: async deviceId => trace.push(`warnIfLow:${deviceId}`)
})
stubModule('../utils/gallery-api', { getPhotoDetail: async () => ({}) })
stubModule('../utils/api', { getDevices: async () => [] })
stubModule('../utils/toast', {
  show: options => toasts.push(typeof options === 'string' ? options : options.title),
  warn: options => toasts.push(typeof options === 'string' ? options : options.title)
})
stubModule('../utils/fold-adapt', { adapt: options => options })

let pageOptions = null
global.Page = options => {
  pageOptions = options
}
require('../subpackages/gallery/detail/detail.js')

const backendDevice = { id: '12', name: '客厅相框', deviceNo: 'AABBCCDDEEFF' } // 后端记录：没有 deviceId

function newPage() {
  const ctx = Object.create(pageOptions)
  ctx.data = {
    photo: { id: 'p1', title: '向日葵', url: 'https://cdn.example.com/p1.jpg', favorited: false },
    projecting: false,
    devicePicker: { show: false, loading: false, devices: [] }
  }
  ctx.setData = patch => Object.assign(ctx.data, patch)
  return ctx
}

function reset() {
  trace = []
  toasts = []
  delete storage.pendingProjection
  downloadMode = 'ok'
}

async function main() {
  // ① 未连接 → 先连、再下载、再进预览，pendingProjection 里的设备带本机句柄
  reset()
  connectedId = ''
  connectResult = 'BLE-9'
  {
    const page = newPage()
    await page.startProjection(backendDevice)
    assert.deepStrictEqual(trace, [
      'connect',
      'download',
      'navigate:/subpackages/projection/preview/preview'
    ])
    const pending = storage.pendingProjection
    assert.strictEqual(pending.device.deviceId, 'BLE-9', '进预览时设备必须已带本机 BLE 句柄')
    assert.strictEqual(pending.device.connected, true)
    assert.strictEqual(pending.device.deviceNo, 'AABBCCDDEEFF')
    assert.strictEqual(page.data.projecting, false)
  }

  // ② 连不上 → 不下载、不跳转，按钮复位（失败原因由 ensureConnectedForAction 自己提示）
  reset()
  connectedId = ''
  connectResult = ''
  {
    const page = newPage()
    await page.startProjection(backendDevice)
    assert.deepStrictEqual(trace, ['connect'])
    assert.strictEqual(storage.pendingProjection, undefined)
    assert.strictEqual(page.data.projecting, false)
    assert.strictEqual(page._projecting, false)
  }

  // ③ 已有活动会话 → 直接认领，不扫描；低电量照旧提醒一次
  reset()
  connectedId = 'BLE-1'
  connectResult = ''
  {
    const page = newPage()
    await page.startProjection(backendDevice)
    assert.deepStrictEqual(trace, [
      'warnIfLow:BLE-1',
      'download',
      'navigate:/subpackages/projection/preview/preview'
    ])
    assert.strictEqual(storage.pendingProjection.device.deviceId, 'BLE-1')
  }

  // ④ 图片下载超时 → 中文提示，不出现英文原文
  reset()
  connectedId = 'BLE-1'
  downloadMode = 'timeout'
  {
    const page = newPage()
    await page.startProjection(backendDevice)
    assert.deepStrictEqual(toasts, ['图片下载超时，请检查网络后重试'])
    assert.ok(!/[A-Za-z]/.test(toasts[0]), '提示里不该有英文')
    assert.strictEqual(storage.pendingProjection, undefined)
    assert.strictEqual(page.data.projecting, false)
  }

  console.log('gallery-connect-before-preview.test.js: all passed')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
