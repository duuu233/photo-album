// 固件升级判断（2026-11-13）utils/firmware-gate：
//   ① 升级类型：updateType 1 = 强制升级、2 = 强提醒升级，3 弱提示 / 4 不提示及其它不弹（只亮红点）；
//   ② 判断前提：WiFi 版在线才判、蓝牙版已连接才判；有新版本与详情页红点同一套判定；WiFi 有进行中的升级不弹；
//      列表页 / 首页只判强制升级（forceOnly），强提醒不弹；
//   ③ 弹框：强制升级取消 → 操作不继续；强提醒取消 → 操作继续；立即升级 → 进升级页、操作不继续（蓝牙带 auto=1）；
//   ④ 详情页按钮包装：不用弹时同步执行原方法（行为不变），强制升级取消不执行；
//   ⑤ 列表页 / 首页现查：离线 / 未连接 / 进行中 / 查询失败一律放行，不查详情接口；
//   ⑦ 本地缓存与强提醒一次（2026-11-13 产品复核）：列表页 / 首页每次启动第一次点现查（loading）并写缓存，
//      之后按缓存判断不再请求；详情页进入时写缓存；升级完成改成无需升级；强提醒每台设备每次启动只弹一次；
//   ⑥ 接入位置：两个详情页的功能按钮、进入后判断，列表页投屏 / 轮播设置、首页拍照 / 相册投屏；启动时不再弹。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const root = path.join(__dirname, '..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')

const storage = {}
const navs = []
const loadings = []
const modals = []
let modalReply = { confirm: false }
global.wx = {
  getStorageSync: key => storage[key],
  setStorageSync: (key, value) => { storage[key] = value },
  removeStorageSync: key => { delete storage[key] },
  navigateTo: options => navs.push(options.url),
  showLoading: options => loadings.push(options.title),
  hideLoading() {},
  showModal: options => { modals.push(options); options.success(modalReply) }
}
let selected = null
global.getApp = () => ({ setSelectedDevice: value => { selected = value } })

const stubModule = (request, exports) => {
  const filename = require.resolve(request)
  require.cache[filename] = { id: filename, filename, loaded: true, children: [], paths: [], exports }
}
const calls = []
let infoReply = null
let detailReply = null
let liveId = ''
let peekInfo = null
let swVersion = ''
stubModule('../utils/iot-api', {
  getDeviceInfo: async deviceNo => { calls.push(`info:${deviceNo}`); if (infoReply instanceof Error) throw infoReply; return infoReply },
  getOtaStatus: async () => ({})
})
stubModule('../utils/toast', { show() {}, warn() {} })
stubModule('../utils/api', {
  getDeviceDetail: async (id, options) => { calls.push(`detail:${id}:${options && options.showError}`); if (detailReply instanceof Error) throw detailReply; return detailReply }
})
stubModule('../utils/active-device', { findConnectedDeviceId: () => liveId })
stubModule('../utils/device-info', { peek: () => (peekInfo ? { info: peekInfo, at: 1 } : null) })
stubModule('../utils/device-ble', { getSwVersion: async () => { calls.push('ble:0x03'); return swVersion } })
const gate = require('../utils/firmware-gate')

let checks = 0
const checked = name => { checks++; console.log(`ok - ${name}`) }
const reset = () => { gate.resetSession(); loadings.length = 0; calls.length = 0; navs.length = 0; modals.length = 0; selected = null; modalReply = { confirm: false } }

const PKG = { newVersionNo: '0.6.2', downloadPath: 'https://oss/fw.bin' }

async function main() {
  {
    assert.equal(gate.modeOf({ updateType: 1 }), 'force')
    assert.equal(gate.modeOf({ updateType: '1' }), 'force', '字符串 1 也算')
    assert.equal(gate.modeOf({ updateType: 2 }), 'remind')
    assert.equal(gate.modeOf({ updateType: 3 }), '', '弱提示升级：不弹，只亮红点（改动前逻辑）')
    assert.equal(gate.modeOf({ updateType: 4 }), '', '不提示升级：不弹')
    assert.equal(gate.modeOf({}), '', '没给不弹')
    assert.equal(gate.decide(Object.assign({ updateType: 3 }, PKG), { connected: true, hasUpdate: true }).mode, '', '弱提示红点亮也不弹')
    checked('升级类型取后台 compulsory：1 强制、2 强提醒，3 / 4 不弹')
  }
  {
    // 蓝牙：已连接 + 版本不同 + 有效 .bin 才算；读不到版本退回 isUpdate
    assert.equal(gate.bleHasUpdate(PKG, '0.6.1'), true)
    assert.equal(gate.bleHasUpdate(PKG, '0.6.2'), false, '版本相同')
    assert.equal(gate.bleHasUpdate({ newVersionNo: '0.6.2', downloadPath: 'https://oss/fw.zip' }, '0.6.1'), false, '下载地址不是 .bin 不弹')
    assert.equal(gate.bleHasUpdate(Object.assign({ isUpdate: 1 }, PKG), ''), true, '读不到版本退回 isUpdate')
    assert.equal(gate.bleHasUpdate(PKG, ''), false)
    assert.equal(gate.wifiHasUpdate(PKG, '0.6.1'), true)
    assert.equal(gate.wifiHasUpdate(PKG, '0.6.2'), false)
    assert.equal(gate.wifiHasUpdate(PKG, ''), false, 'WiFi 读不到当前版本 = 无法判断，不弹')

    const force = Object.assign({ updateType: 1 }, PKG)
    const remind = Object.assign({ updateType: 2 }, PKG)
    assert.deepEqual(gate.decide(force, { isWifi: true, online: true, currentVersion: '0.6.1' }), { mode: 'force', version: '0.6.2' })
    assert.equal(gate.decide(force, { isWifi: true, online: false, currentVersion: '0.6.1' }).mode, '', 'WiFi 离线不判')
    assert.equal(gate.decide(force, { isWifi: true, online: true, inflight: true, currentVersion: '0.6.1' }).mode, '', '进行中的升级不弹')
    assert.equal(gate.decide(force, { connected: false, currentVersion: '0.6.1' }).mode, '', '蓝牙未连接不判')
    assert.equal(gate.decide(remind, { connected: true, currentVersion: '0.6.1' }).mode, 'remind')
    assert.equal(gate.decide(remind, { connected: true, currentVersion: '0.6.1', forceOnly: true }).mode, '', '列表页 / 首页只判强制升级')
    assert.equal(gate.decide(force, { connected: true, currentVersion: '0.6.1', forceOnly: true }).mode, 'force')
    assert.equal(gate.decide(force, { connected: true, hasUpdate: false, currentVersion: '0.6.1' }).mode, '', '详情页按红点结果：红点不亮不弹')
    assert.equal(gate.decide(force, { connected: true, hasUpdate: true }).mode, 'force', '红点亮就弹')
    checked('判断前提与判定')
  }
  {
    const device = Object.assign({ id: '9', updateType: 1 }, PKG)
    reset()
    assert.equal(await gate.prompt(device, { mode: 'force', version: '0.6.2' }, { liveId: 'ble-1' }), false, '强制升级取消：不继续')
    assert.equal(modals[0].title, '固件升级')
    assert.equal(modals[0].confirmText, '立即升级')
    assert.equal(modals[0].cancelText, '取消')
    assert.ok(modals[0].content.indexOf('0.6.2') > -1)
    assert.equal(navs.length, 0)
    reset()
    assert.equal(await gate.prompt(device, { mode: 'remind', version: '0.6.2' }), true, '强提醒取消：照常继续')
    reset()
    modalReply = { confirm: true }
    assert.equal(await gate.prompt(device, { mode: 'remind', version: '0.6.2' }, { liveId: 'ble-1' }), false, '立即升级：这次操作不继续')
    assert.equal(navs[0], '/subpackages/device/ota/ota?id=9&auto=1', '蓝牙进升级页并自动开始')
    assert.equal(selected.deviceId, 'ble-1', '蓝牙先把这台设为选中设备（带当下连接）')
    reset()
    modalReply = { confirm: true }
    await gate.prompt(device, { mode: 'force', version: '0.6.2' }, { isWifi: true })
    assert.equal(navs[0], '/subpackages/device/wifi-ota/wifi-ota?id=9', 'WiFi 进步骤页')
    reset()
    assert.equal(await gate.prompt(device, { mode: '', version: '' }), true, '不用弹直接继续')
    assert.equal(modals.length, 0)
    checked('弹框：强制 / 强提醒 / 立即升级')
  }
  {
    // 详情页按钮包装
    const seen = []
    const definition = gate.wrapActions({
      firmwareGate() { return this.pass },
      open(arg) { seen.push(arg); return 'done' }
    }, ['open'])
    const page = Object.create(definition)
    page.pass = true
    assert.equal(page.open('a'), 'done', '不用弹：同步执行，返回值不变')
    assert.deepEqual(seen, ['a'])
    page.pass = Promise.resolve(false)
    assert.equal(await page.open('b'), undefined)
    assert.deepEqual(seen, ['a'], '强制升级取消：不执行')
    page.pass = Promise.resolve(true)
    assert.equal(await page.open('c'), 'done', '强提醒取消：照常执行')
    assert.throws(() => gate.wrapActions({}, ['nope']), /nope/, '方法名写错直接报错')
    checked('详情页按钮包装')
  }
  {
    // 列表页 / 首页现查
    const wifi = { id: '21', isWifi: true, productDeviceId: 'E3:48:C2:1E:D4:28' }
    reset()
    infoReply = { online: false, status: 'OFFLINE', firmwareVersion: '0.6.1' }
    detailReply = Object.assign({ updateType: 1 }, PKG)
    assert.equal(await gate.guardAction(wifi), true, '离线放行')
    assert.deepEqual(calls, ['info:E348C21ED428'], '离线不查详情接口')
    reset()
    infoReply = { online: true, status: 'ONLINE', firmwareVersion: '0.6.1' }
    assert.equal(await gate.guardAction(wifi), false, '在线 + 强制升级 + 取消 → 不继续')
    assert.ok(calls.indexOf('detail:21:false') > -1, '现查详情接口拿新版本 / 升级方式，静默不弹错')
    assert.equal(modals.length, 1)
    assert.deepEqual(loadings, ['检查固件版本'], '第一次点：loading 现查')
    reset()
    detailReply = Object.assign({ updateType: 2 }, PKG)
    assert.equal(await gate.guardAction(wifi), true, '强提醒在列表页 / 首页不弹')
    assert.equal(modals.length, 0)
    reset()
    detailReply = Object.assign({ updateType: 1 }, PKG)
    storage['ota_inflight:E348C21ED428'] = { type: 'ota', msgid: '1', deviceNo: 'E348C21ED428' }
    assert.equal(await gate.guardAction(wifi), true, '有进行中的升级不弹')
    assert.equal(calls.length, 0)
    delete storage['ota_inflight:E348C21ED428']
    reset()
    infoReply = new Error('503')
    assert.equal(await gate.guardAction(wifi), true, '查询失败放行')
    infoReply = { online: true, status: 'ONLINE', firmwareVersion: '0.6.1' }

    const ble = { id: '9', broadcastId: 'EF6-370' }
    reset()
    liveId = ''
    assert.equal(await gate.guardAction(ble), true, '蓝牙未连接放行')
    assert.equal(calls.length, 0, '未连接不读版本、不查接口')
    reset()
    liveId = 'ble-1'
    peekInfo = { firmwareVersion: '0.6.1' }
    assert.equal(await gate.guardAction(ble), false, '已连接 + 强制升级 + 取消 → 不继续')
    assert.equal(calls.indexOf('ble:0x03'), -1, '本次连接登记过版本就不再读 0x03')
    reset()
    peekInfo = null
    swVersion = '0.6.2'
    assert.equal(await gate.guardAction(ble), true, '读 0x03 得到已是新版本 → 放行')
    assert.ok(calls.indexOf('ble:0x03') > -1)
    reset()
    detailReply = new Error('网络')
    swVersion = '0.6.1'
    assert.equal(await gate.guardAction(ble), true, '详情接口失败放行')
    liveId = ''
    checked('列表页 / 首页现查')
  }
  {
    // ⑦ 本地缓存：本次启动第一次点现查并写缓存，再点不请求、取消后照样再弹；升级完成后不再弹
    const wifi = { id: '31', isWifi: true, productDeviceId: 'E3:48:C2:1E:D4:31', wifiStatus: 'online' }
    reset()
    infoReply = { online: true, status: 'ONLINE', firmwareVersion: '0.6.1' }
    detailReply = Object.assign({ updateType: 1 }, PKG)
    assert.equal(await gate.guardAction(wifi), false)
    assert.equal(calls.length, 2, '第一次：查设备信息 + 详情')
    assert.deepEqual(storage.fw_gate_cache['31'].mode, 'force', '结果写进本地缓存')
    calls.length = 0
    loadings.length = 0
    assert.equal(await gate.guardAction(wifi), false, '取消后再点：照样弹')
    assert.equal(await gate.guardAction(wifi), false)
    assert.equal(calls.length, 0, '再点不请求接口')
    assert.equal(loadings.length, 0, '按缓存判断不再 loading')
    assert.equal(modals.length, 3)
    assert.equal(await gate.guardAction(Object.assign({}, wifi, { wifiStatus: 'offline' })), true, '列表里已知离线不判')
    assert.equal(await gate.guardAction(Object.assign({}, wifi, { wifiStatus: 'offline' }), { online: true }), false, '首页已确认在线：不看记录里的 wifiStatus')
    gate.markUpgraded('31')
    modals.length = 0
    assert.equal(await gate.guardAction(wifi), true, '升级完成：缓存改成无需升级，不再弹')
    assert.equal(modals.length, 0)
    assert.equal(calls.length, 0)
    gate.resetSession()
    detailReply = Object.assign({ updateType: 1 }, PKG)
    assert.equal(await gate.guardAction(wifi), false, '重新打开小程序：第一次点重新现查')
    assert.equal(calls.length, 2)

    // 详情页进入：强制每次进都弹并写缓存，强提醒每台设备每次启动只弹一次
    const force = Object.assign({ id: '41', updateType: 1 }, PKG)
    const remind = Object.assign({ id: '42', updateType: 2 }, PKG)
    reset()
    assert.equal(await gate.checkOnEnter(force, { connected: true, hasUpdate: true }), false)
    assert.equal(await gate.checkOnEnter(force, { connected: true, hasUpdate: true }), false, '强制：再进再弹')
    assert.equal(gate.cachedDecision('41').mode, 'force', '进入时的判定写进缓存（列表页 / 首页直接用）')
    assert.equal(await gate.checkOnEnter(remind, { connected: true, hasUpdate: true }), true, '强提醒取消：照常')
    assert.equal(await gate.checkOnEnter(remind, { connected: true, hasUpdate: true }), true)
    assert.equal(modals.length, 3, '强提醒本次启动只弹一次')
    gate.resetSession()
    await gate.checkOnEnter(remind, { connected: true, hasUpdate: true })
    assert.equal(modals.length, 4, '重新打开小程序再提醒')
    await gate.checkOnEnter(Object.assign({ id: '43', updateType: 3 }, PKG), { connected: true, hasUpdate: true })
    assert.equal(modals.length, 4, '弱提示进入也不弹')
    checked('本地缓存、升级完成更新缓存、强提醒每次启动一次')
  }
  {
    const strip = text => text.replace(/\/\/[^\n]*/g, '')
    const bleDetail = strip(read('subpackages/device/detail/detail.js'))
    assert.ok(/firmwareGate\.wrapActions\(\{[\s\S]*\}, \['renameDevice', 'goSlideshow', 'clearCopies'\]\)/.test(bleDetail), '蓝牙详情：重命名 / 轮播设置 / 一键清空先判断')
    assert.ok(/await this\.firmwareGate\(\)[\s\S]*?showMediaSheet: true/.test(bleDetail), '蓝牙详情：投屏连上之后判断再弹拍照 / 相册')
    assert.ok(/this\.checkFirmwareOnEnter\(\)\n  \},/.test(bleDetail), '蓝牙详情：加载完判断一次（进入后）')
    assert.ok(/hasUpdate: !!this\.data\.firmwareHasUpdate/.test(bleDetail), '蓝牙详情：判定用红点结果')
    assert.ok(/hasUpdate: !!this\.data\.firmwareHasUpdate, forceOnly: true \}/.test(bleDetail) && /firmwareGate\.checkOnEnter\(device,/.test(bleDetail), '蓝牙详情：按钮只判强制，进入时强制 + 强提醒')
    assert.ok(/hasUpdate: !!this\.data\.otaHasUpdate, forceOnly: true \}/.test(strip(read('subpackages/device/wifi-detail/wifi-detail.js'))), 'WiFi 详情：按钮只判强制')
    assert.ok(/firmwareGate\.checkOnEnter\(this\.data\.device,/.test(strip(read('subpackages/device/wifi-detail/wifi-detail.js'))), 'WiFi 详情：进入时强制 + 强提醒')
    assert.ok(/require\('\.\.\/\.\.\/\.\.\/utils\/firmware-gate'\)\.markUpgraded\(this\.data\.id\)/.test(strip(read('subpackages/device/ota/ota.js'))), '蓝牙升级成功：更新缓存')
    assert.ok(/firmwareGate\.markUpgraded\(this\.data\.id\)/.test(strip(read('subpackages/device/wifi-ota/wifi-ota.js'))), 'WiFi 主固件升级完成：更新缓存')
    const wifiDetail = strip(read('subpackages/device/wifi-detail/wifi-detail.js'))
    assert.ok(/\}, \['startProjection', 'openSlideshow', 'openInfo', 'openMessages', 'openTf', 'openShare', 'clearCopies'\]\)/.test(wifiDetail), 'WiFi 详情：功能按钮先判断')
    assert.ok(/this\.data\.status !== 'online'/.test(wifiDetail) && /hasUpdate: !!this\.data\.otaHasUpdate/.test(wifiDetail), 'WiFi 详情：在线才判、用红点结果')
    assert.ok(/this\.checkFirmwareOnEnter\(\)/.test(wifiDetail), 'WiFi 详情：拿到状态后判断一次（进入后）')
    const list = strip(read('subpackages/device/list/list.js'))
    assert.equal((list.match(/firmwareGate\.guardAction\(device\)/g) || []).length, 3, '列表页：蓝牙投屏、WiFi 投屏、WiFi 轮播设置')
    const home = strip(read('pages/home/home.js'))
    assert.equal((home.match(/firmwareGate\.guardAction\(/g) || []).length, 2, '首页拍照 / 相册投屏：WiFi 与蓝牙两支')
    assert.ok(!/checkForcedFirmwareUpgrade|exitMiniProgram/.test(strip(read('app.js'))), '启动时不再弹强制升级、不再关闭小程序')
    checked('接入位置')
  }
  console.log(`firmware-gate: ${checks} groups passed`)
}
main().catch(error => { console.error(error); process.exitCode = 1 })
