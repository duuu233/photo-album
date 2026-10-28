// 「我的上传」WiFi 版照片（2026-10-27，docs/wifi/XT相框通讯协议_V1.4_更新说明.md 第九节）：
//   ① 删除不连蓝牙、不认槽位：先删老服务相册记录，再把**真删掉了的**那些记录的 imgBle 交给 IoT 删云端 bin；
//      带 nextImageUrl = 相册里剩下的第一张（删到屏上当前图时服务端自动换图）；
//   ② 提示：全成功但没切图「已删除；若相框未更新，请手动切换或重新设置轮播」（2026-10-27 追加内容第三节：
//      服务端反推不到当前图时不切图）；确认弹窗对 WiFi 照片多一句「删除后相框可能需手动切换才会更新」；
//      deviceAction=PLAY_NEXT「已切换到下一张」；
//      deviceNotified=false 提示设备离线；部分记录失败报张数；
//      云端删除失败单独说；
//   ③ 再次投屏：确认在线后带 isWifi 进预览页，不走蓝牙连接；休眠 / 离线被 ensureOnline 拦下；
//   ④ 蓝牙版照片仍走原链路（ensureConnectedDevice）。
const assert = require('assert')

const storage = {}
const navs = []
global.wx = new Proxy({
  getStorageSync: key => storage[key],
  setStorageSync: (key, value) => { storage[key] = value },
  navigateTo: options => navs.push(options.url),
  showLoading: () => {},
  hideLoading: () => {}
}, {
  get: (target, key) => key in target ? target[key] : options => {
    if (options && typeof options.fail === 'function') options.fail({})
  }
})
global.getApp = () => ({ globalData: {} })

const stubModule = (request, exports) => {
  const filename = require.resolve(request)
  require.cache[filename] = { id: filename, filename, loaded: true, children: [], paths: [], exports }
}

const calls = { records: [], cloud: [], ble: 0, online: [] }
let recordReply = null
let cloudReply = null
let onlineReply = true
const toasts = []

stubModule('../utils/api', {
  deleteProjectionRecords: ids => {
    calls.records.push(ids.slice())
    return Promise.resolve(recordReply || { total: ids.length, failed: 0, failedIds: [] })
  }
})
stubModule('../utils/iot-api', {
  deletePhotos: payload => {
    calls.cloud.push(JSON.parse(JSON.stringify(payload)))
    return cloudReply instanceof Error ? Promise.reject(cloudReply) : Promise.resolve(cloudReply || { deleted: 1, deviceNotified: true })
  }
})
stubModule('../utils/wifi-status', {
  ensureOnline: device => { calls.online.push(device.id); return Promise.resolve(onlineReply) }
})
stubModule('../utils/device-ble', { deleteImage: () => { calls.ble++; return Promise.resolve() } })
stubModule('../utils/device-info', { read: () => { calls.ble++; return Promise.resolve({}) } })
stubModule('../utils/toast', {
  warn: options => toasts.push(options.title),
  show: options => toasts.push(options.title),
  error: options => toasts.push(options.title)
})
stubModule('../utils/active-device', {
  friendlyConnectMessage: message => message,
  ensureConnectedForAction: () => { calls.ble++; return Promise.resolve('BLE-1') }
})
stubModule('../utils/media', {})
stubModule('../utils/system', { getLayoutMetrics: () => ({}) })
stubModule('../utils/upload-limit', { albumPickLimit: () => 10 })
stubModule('../utils/fold-adapt', { adapt: options => options })

let pageOptions = null
global.Page = options => { pageOptions = options }
require('../subpackages/album/list/list.js')

const wifiDevice = { id: 'W1', userProductId: 'W1', name: 'WiFi相框', broadcastId: 'IJ_*', productDeviceId: 'D0:CF:13:F0:2F:F8' }
const bleDevice = { id: 'B1', userProductId: 'B1', name: '蓝牙相框', broadcastId: 'EF6-370', productDeviceId: 'AA:BB:CC:DD:EE:01' }
const rec = (id, owner, extra) => Object.assign({ id, userProductId: owner, status: 'success', img: `https://img/${id}.jpg` }, extra)

function makePage(records, selected) {
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
  ctx.reloaded = 0
  ctx.loadPhotos = () => { ctx.reloaded++ }
  return ctx
}

const reset = () => {
  calls.records = []; calls.cloud = []; calls.ble = 0; calls.online = []
  toasts.length = 0; navs.length = 0; recordReply = null; cloudReply = null; onlineReply = true
}

;(async () => {
  const log = console.log
  const warn = console.warn
  console.log = () => {}
  console.warn = () => {}
  try {
    const wifiRecords = () => [
      rec('a', 'W1', { imgBle: 'https://oss/a.bin' }),
      rec('b', 'W1', { imgBle: 'https://oss/b.bin' }),
      rec('c', 'W1', { imgBle: 'https://oss/c.bin' })
    ]
    {
      reset()
      const page = makePage(wifiRecords(), ['a', 'b'])
      await page.confirmDeleteSelected()
      assert.deepEqual(calls.records, [['a', 'b']], '先删老服务记录')
      assert.deepEqual(calls.cloud, [{ deviceNo: 'D0:CF:13:F0:2F:F8', imgUrls: ['https://oss/a.bin', 'https://oss/b.bin'], nextImageUrl: 'https://oss/c.bin' }], '再删云端 bin，带下一张')
      assert.equal(calls.ble, 0, '不碰蓝牙')
      assert.deepEqual(toasts, ['已删除；若相框未更新，请手动切换或重新设置轮播'])
      assert.equal(page.reloaded, 1)
      log('PASS WiFi 删除：先记录后云端，带 nextImageUrl，不连蓝牙')
    }
    {
      reset()
      const page = makePage(wifiRecords(), ['a'])
      page.data.showDeleteConfirm = false
      page.data.selectedCount = 1
      page.showDeleteDialog()
      assert.equal(page.data.showDeleteConfirm, true)
      assert.equal(page.data.deleteWifi, true, 'WiFi 照片：确认弹窗多一句')
      const ble = makePage([rec('p', 'B1', { imgIndex: '0' })], ['p'])
      ble.data.selectedCount = 1
      ble.showDeleteDialog()
      assert.equal(ble.data.deleteWifi, false, '蓝牙照片不加')
      const tpl = require('fs').readFileSync(require('path').join(__dirname, '../subpackages/album/list/list.wxml'), 'utf8')
      assert.ok(/wx:if="\{\{deleteWifi\}\}" class="confirm-desc">删除后相框可能需手动切换才会更新。/.test(tpl))
      log('PASS WiFi 删除确认弹窗提示可能需手动切换')
    }
    {
      reset()
      recordReply = { total: 2, failed: 1, failedIds: ['b'] }
      const page = makePage(wifiRecords(), ['a', 'b'])
      await page.confirmDeleteSelected()
      assert.deepEqual(calls.cloud[0].imgUrls, ['https://oss/a.bin'], '只删记录真删掉了的那张')
      assert.deepEqual(toasts, ['已删除 1 张，1 张未删除成功，请稍后重试'])
      reset()
      cloudReply = { deleted: 1, deviceNotified: false }
      await makePage(wifiRecords(), ['c']).confirmDeleteSelected()
      assert.equal(calls.cloud[0].nextImageUrl, 'https://oss/a.bin', '下一张取剩下的第一张')
      assert.deepEqual(toasts, ['已删除；设备离线，相框换图将在设备联网后进行'])
      reset()
      cloudReply = { deleted: 1, current: true, deviceAction: 'PLAY_NEXT', deviceNotified: true }
      await makePage(wifiRecords(), ['a']).confirmDeleteSelected()
      assert.deepEqual(toasts, ['已删除，相框已切换到下一张'], '以响应的 deviceAction 为准')
      reset()
      cloudReply = Object.assign(new Error('接口(IoT)-服务暂不可用'), { code: 503 })
      await makePage(wifiRecords(), ['a']).confirmDeleteSelected()
      assert.deepEqual(toasts, ['照片已从我的上传删除，相框播放列表更新失败：服务暂不可用'])
      reset()
      recordReply = { total: 1, failed: 1, failedIds: ['a'] }
      await makePage(wifiRecords(), ['a']).confirmDeleteSelected()
      assert.equal(calls.cloud.length, 0, '记录一条没删掉就不删云端')
      assert.deepEqual(toasts, ['删除失败，请稍后重试'])
      reset()
      await makePage([rec('a', 'W1', { imgBle: 'https://oss/a.bin' }), rec('x', 'W1')], ['a', 'x']).confirmDeleteSelected()
      assert.deepEqual(calls.cloud[0].imgUrls, ['https://oss/a.bin'], '没有 imgBle 的旧记录只删记录')
      assert.equal('nextImageUrl' in calls.cloud[0], false, '剩下的都没 imgBle 时不带下一张')
      log('PASS WiFi 删除：部分失败 / 设备离线 / 云端失败 / 无 imgBle')
    }
    {
      reset()
      const page = makePage(wifiRecords(), ['a', 'c'])
      await page.retryProjection()
      assert.deepEqual(calls.online, ['W1'], '先确认在线')
      assert.equal(calls.ble, 0, '不连蓝牙')
      assert.equal(storage.pendingProjection.device.isWifi, true)
      assert.deepEqual(storage.pendingProjection.images, [{ url: 'https://img/a.jpg' }, { url: 'https://img/c.jpg' }])
      assert.deepEqual(navs, ['/subpackages/projection/preview/preview'])
      reset()
      onlineReply = false
      await makePage(wifiRecords(), ['a']).retryProjection()
      assert.deepEqual(navs, [], '休眠 / 离线被拦下（提示由 ensureOnline 弹）')
      log('PASS WiFi 再次投屏：确认在线、不连蓝牙')
    }
    {
      reset()
      const bleRecords = [rec('p', 'B1', { imgIndex: '0' })]
      const page = makePage(bleRecords, ['p'])
      let connected = 0
      page.ensureConnectedDevice = () => { connected++; return Promise.resolve(null) }
      await page.confirmDeleteSelected()
      assert.equal(connected, 1, '蓝牙版照片仍走原连接链路')
      assert.equal(calls.cloud.length, 0)
      log('PASS 蓝牙版照片不受影响')
    }
  } finally {
    console.log = log
    console.warn = warn
  }
  console.log('album-wifi-delete: 5 groups passed')
})().catch(error => { console.error(error); process.exitCode = 1 })
