// 「我的上传」WiFi 版照片（2026-10-27，docs/wifi/XT相框通讯协议_V1.4_更新说明.md 第九节）：
//   ① 删除不连蓝牙、不认槽位：先删老服务相册记录，再把**真删掉了的**那些记录的 imgBle 交给 IoT 删云端 bin；
//      带 nextImageUrl = 相册里剩下的第一张（删到屏上当前图时服务端自动换图）；
//   ② 提示：全成功但没切图「已删除；若相框未更新，请手动切换或重新设置轮播」（2026-10-27 追加内容第三节：
//      服务端反推不到当前图时不切图）；确认弹窗对 WiFi 照片多一句「删除后相框可能需手动切换才会更新」；
//      deviceAction=PLAY_NEXT「已切换到下一张」；
//      deviceNotified=false 提示设备离线；部分记录失败报张数；
//      云端删除失败单独说；
//   ③ 再次投屏：确认在线后带 isWifi 进预览页，不走蓝牙连接；离线 / 本地模式 / 状态未知被拦下
//      （2026-10-29 起改走 wifiStatus.projectBlockedTip，提示「设备不在线」；原 ensureOnline 对「查不到」放行，
//      产品要求「我的上传」切到这类设备点投屏要提示不在线，所以换了判据，拦截断言不变）；
//   ④ 蓝牙版照片仍走原链路（ensureConnectedDevice）；
//   ⑤ 2026-11-06：按设备 ID 查出的共享成员 / 重绑前上传的照片（记录的 userProductId 不在本人设备列表里）
//      不再提示「未找到照片所属电子纸设备」：按完整设备 ID、再按当前选中设备归属，照常删除（接口已支持）；
//   ⑥ 2026-11-10：全删（已加载的全选、没有下一页，记录与云端都删成功）后调 restore-builtin，带 scene=DELETE_ALL_PHOTOS
//      与产品 renderMode；SENT 提示「相框将恢复显示内置图片」，SKIPPED / 出错照原提示；没全删、有下一页、部分失败、云端失败都不调。
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

const calls = { records: [], cloud: [], ble: 0, online: [], restore: [] }
let restoreReply = null
let recordReply = null
let cloudReply = null
let onlineReply = true
const toasts = []

stubModule('../utils/api', {
  deleteProjectionRecords: ids => {
    calls.records.push(ids.slice())
    return Promise.resolve(recordReply || { total: ids.length, failed: 0, failedIds: [] })
  },
  resolveRenderMode: () => Promise.resolve('fpga16')
})
stubModule('../utils/iot-api', {
  deletePhotos: payload => {
    calls.cloud.push(JSON.parse(JSON.stringify(payload)))
    return cloudReply instanceof Error ? Promise.reject(cloudReply) : Promise.resolve(cloudReply || { deleted: 1, deviceNotified: true })
  },
  restoreBuiltin: payload => {
    calls.restore.push(JSON.parse(JSON.stringify(payload)))
    return restoreReply instanceof Error ? Promise.reject(restoreReply) : Promise.resolve(restoreReply || { deviceNo: 'D0CF13F02FF8', status: 'SENT' })
  },
  RESTORE_SCENE_DELETE_ALL_PHOTOS: 'DELETE_ALL_PHOTOS'
})
stubModule('../utils/wifi-status', {
  projectBlockedTip: device => { calls.online.push(device.id); return Promise.resolve(onlineReply ? '' : '设备不在线') }
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
  calls.records = []; calls.cloud = []; calls.ble = 0; calls.online = []; calls.restore = []
  toasts.length = 0; navs.length = 0; recordReply = null; cloudReply = null; onlineReply = true; restoreReply = null
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
      assert.deepEqual(toasts, ['已删除，相框将恢复显示内置图片'], '这两张就是全部：全删后恢复内置图片（⑥）')
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
      assert.deepEqual(navs, [], '离线 / 本地模式 / 状态未知被拦下')
      assert.deepEqual(toasts, ['设备不在线'], '提示设备不在线')
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
    {
      // ⑤ WiFi 版：一张自己的 + 一张共享成员的（userProductId 不在本人设备里，带完整设备 ID）+ 一张什么都没带的
      reset()
      const records = [
        rec('m', 'W1', { imgBle: 'https://oss/m.bin' }),
        rec('o', 'OTHER-9', { imgBle: 'https://oss/o.bin', productDeviceId: 'D0:CF:13:F0:2F:F8' }),
        rec('n', 'OTHER-8', { imgBle: 'https://oss/n.bin' }),
        rec('k', 'W1', { imgBle: 'https://oss/k.bin' })
      ]
      const page = makePage(records, ['m', 'o', 'n'])
      page.data.currentFilter = 'W1'
      assert.equal(page.resolveOwnerDevice(['o']).device, wifiDevice, '按完整设备 ID 归属')
      assert.equal(page.resolveOwnerDevice(['n']).device, wifiDevice, '设备 ID 也没有：归到当前选中的那台')
      assert.equal(page.resolveOwnerDevice(['m', 'o', 'n']).mixed, false, '归属后是同一台，不算跨设备')
      await page.confirmDeleteSelected()
      assert.ok(!toasts.some(text => /未找到照片所属/.test(text)), '不再提示未找到所属设备')
      assert.deepEqual(calls.records, [['m', 'o', 'n']], '三张记录都删')
      assert.deepEqual(calls.cloud.map(item => item.imgUrls), [['https://oss/m.bin', 'https://oss/o.bin', 'https://oss/n.bin']], '云端三张都删')
      assert.equal(calls.ble, 0)
      log('PASS 共享成员上传的 WiFi 照片照常删除')
    }
    {
      // ⑤ 蓝牙版：共享成员的照片归到当前蓝牙设备，照常去连那台（不再拦下）；真跨设备仍拦
      reset()
      const records = [rec('x', 'OTHER-1', { imgIndex: '1' }), rec('y', 'B1', { imgIndex: '2' }), rec('z', 'W1', { imgIndex: '3' })]
      const page = makePage(records, ['x', 'y'])
      page.data.currentFilter = 'B1'
      const device = await page.ensureConnectedDevice(['x', 'y'])
      assert.equal(device && device.userProductId, 'B1', '归到当前蓝牙设备并连接')
      assert.equal(device.deviceId, 'BLE-1')
      assert.ok(!toasts.some(text => /未找到照片所属/.test(text)))
      assert.equal(await page.ensureConnectedDevice(['y', 'z']), null, '对上的是两台不同的本人设备：仍拦下')
      assert.deepEqual(toasts, ['只能操作同一台电子纸设备的照片'])
      log('PASS 共享成员上传的蓝牙照片归到当前设备')
    }
    {
      // ⑥ 全删后恢复内置图片
      reset()
      const page = makePage(wifiRecords(), ['a', 'b', 'c'])
      await page.confirmDeleteSelected()
      assert.deepEqual(calls.cloud, [{ deviceNo: 'D0:CF:13:F0:2F:F8', imgUrls: ['https://oss/a.bin', 'https://oss/b.bin', 'https://oss/c.bin'] }], '全删不带下一张')
      assert.deepEqual(calls.restore, [{ deviceNo: 'D0:CF:13:F0:2F:F8', scene: 'DELETE_ALL_PHOTOS', renderMode: 'fpga16' }], '删完再调 restore-builtin，带 scene 与 renderMode')
      assert.deepEqual(toasts, ['已删除，相框将恢复显示内置图片'])
      assert.equal(page.reloaded, 1)

      reset()
      restoreReply = { deviceNo: 'D0CF13F02FF8', status: 'SKIPPED' }
      await makePage(wifiRecords(), ['a', 'b', 'c']).confirmDeleteSelected()
      assert.equal(calls.restore.length, 1)
      assert.deepEqual(toasts, ['已删除；若相框未更新，请手动切换或重新设置轮播'], 'SKIPPED 照原提示')

      reset()
      restoreReply = Object.assign(new Error('接口(IoT)-无权限'), { code: 403 })
      await makePage(wifiRecords(), ['a', 'b', 'c']).confirmDeleteSelected()
      assert.equal(calls.restore.length, 1)
      assert.deepEqual(toasts, ['已删除；若相框未更新，请手动切换或重新设置轮播'], '恢复出错不改删除结果')

      reset()
      await makePage(wifiRecords(), ['a', 'b']).confirmDeleteSelected()
      assert.equal(calls.restore.length, 0, '没全删不调')

      reset()
      const more = makePage(wifiRecords(), ['a', 'b', 'c'])
      more.data.hasMore = true
      await more.confirmDeleteSelected()
      assert.equal(calls.restore.length, 0, '还有下一页没加载：不算全删')

      reset()
      recordReply = { total: 3, failed: 1, failedIds: ['b'] }
      await makePage(wifiRecords(), ['a', 'b', 'c']).confirmDeleteSelected()
      assert.equal(calls.restore.length, 0, '有记录没删掉：不调')

      reset()
      cloudReply = Object.assign(new Error('接口(IoT)-服务暂不可用'), { code: 503 })
      await makePage(wifiRecords(), ['a', 'b', 'c']).confirmDeleteSelected()
      assert.equal(calls.restore.length, 0, '云端删除失败：不调')
      log('PASS WiFi 全删后调 restore-builtin（scene=DELETE_ALL_PHOTOS）')
    }
  } finally {
    console.log = log
    console.warn = warn
  }
  console.log('album-wifi-delete: 8 groups passed')
})().catch(error => { console.error(error); process.exitCode = 1 })
