// 固件升级提醒 utils/firmware-gate（2026-11-13 产品改口：强制升级整套去掉，只保留强提醒 / 弱提示）：
//   ① 升级类型：updateType 2 = 强提醒弹（1 原强制按强提醒）；3 弱提示 / 4 不提示及其它不弹，只亮红点；
//   ② 弹的前提：WiFi 版在线、蓝牙版已连接，且详情页红点亮（hasUpdate）；
//   ③ 弹框：立即升级 → 进升级页（蓝牙带 auto=1）；取消 → 留在详情页；
//   ④ 进入详情页：强提醒每台设备每次启动只弹一次，取消后不再弹，重新打开小程序（resetSession）再弹；
//   ⑤ 接入位置：只在两个详情页进入后判断；功能按钮、列表页、首页都不判，loading 现查、本地缓存、升级完成更新缓存一并去掉。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const root = path.join(__dirname, '..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')

const navs = []
const modals = []
let modalReply = { confirm: false }
global.wx = {
  navigateTo: options => navs.push(options.url),
  showModal: options => { modals.push(options); options.success(modalReply) }
}
let selected = null
global.getApp = () => ({ setSelectedDevice: value => { selected = value } })

const gate = require('../utils/firmware-gate')

let checks = 0
const checked = name => { checks++; console.log(`ok - ${name}`) }
const reset = () => { gate.resetSession(); navs.length = 0; modals.length = 0; selected = null; modalReply = { confirm: false } }

const PKG = { newVersionNo: '0.6.2', downloadPath: 'https://oss/fw.bin' }

async function main() {
  {
    assert.equal(gate.modeOf({ updateType: 2 }), 'remind')
    assert.equal(gate.modeOf({ updateType: '2' }), 'remind', '字符串 2 也算')
    assert.equal(gate.modeOf({ updateType: 1 }), 'remind', '原强制升级：后台已隐藏，存量数据按强提醒')
    assert.equal(gate.modeOf({ updateType: 3 }), '', '弱提示升级：不弹，只亮红点')
    assert.equal(gate.modeOf({ updateType: 4 }), '', '不提示升级：不弹')
    assert.equal(gate.modeOf({}), '', '没给不弹')
    assert.equal(gate.FORCE, undefined, '强制升级已去掉')
    checked('升级类型：只有强提醒弹')
  }
  {
    const remind = Object.assign({ updateType: 2 }, PKG)
    assert.deepEqual(gate.decide(remind, { isWifi: true, online: true, hasUpdate: true }), { mode: 'remind', version: '0.6.2' })
    assert.equal(gate.decide(remind, { isWifi: true, online: false, hasUpdate: true }).mode, '', 'WiFi 离线不判')
    assert.equal(gate.decide(remind, { connected: false, hasUpdate: true }).mode, '', '蓝牙未连接不判')
    assert.equal(gate.decide(remind, { connected: true, hasUpdate: false }).mode, '', '红点不亮不弹')
    assert.equal(gate.decide(remind, { connected: true, hasUpdate: true }).mode, 'remind', '红点亮就弹')
    assert.equal(gate.decide(Object.assign({ updateType: 3 }, PKG), { connected: true, hasUpdate: true }).mode, '', '弱提示红点亮也不弹')
    assert.equal(gate.decide(null, { connected: true, hasUpdate: true }).mode, '')
    checked('弹的前提与判定')
  }
  {
    const device = Object.assign({ id: '9', updateType: 2 }, PKG)
    reset()
    assert.equal(await gate.prompt(device, { mode: 'remind', version: '0.6.2' }, { liveId: 'ble-1' }), true, '取消：留在详情页')
    assert.equal(modals[0].title, '固件升级')
    assert.equal(modals[0].confirmText, '立即升级')
    assert.equal(modals[0].cancelText, '取消')
    assert.ok(modals[0].content.indexOf('0.6.2') > -1)
    assert.equal(navs.length, 0)
    reset()
    modalReply = { confirm: true }
    assert.equal(await gate.prompt(device, { mode: 'remind', version: '0.6.2' }, { liveId: 'ble-1' }), false, '立即升级')
    assert.equal(navs[0], '/subpackages/device/ota/ota?id=9&auto=1', '蓝牙进升级页并自动开始')
    assert.equal(selected.deviceId, 'ble-1', '蓝牙先把这台设为选中设备（带当下连接）')
    reset()
    modalReply = { confirm: true }
    await gate.prompt(device, { mode: 'remind', version: '0.6.2' }, { isWifi: true })
    assert.equal(navs[0], '/subpackages/device/wifi-ota/wifi-ota?id=9', 'WiFi 进步骤页')
    reset()
    assert.equal(await gate.prompt(device, { mode: '', version: '' }), true, '不用弹')
    assert.equal(modals.length, 0)
    checked('弹框：立即升级 / 取消')
  }
  {
    const remind = Object.assign({ id: '42', updateType: 2 }, PKG)
    reset()
    assert.equal(await gate.checkOnEnter(remind, { connected: true, hasUpdate: true }), true, '取消：留在详情页')
    assert.equal(await gate.checkOnEnter(remind, { connected: true, hasUpdate: true }), true)
    assert.equal(modals.length, 1, '取消后本次启动不再弹')
    await gate.checkOnEnter(Object.assign({ id: '44', updateType: 2 }, PKG), { isWifi: true, online: true, hasUpdate: true })
    assert.equal(modals.length, 2, '按设备计：另一台照弹')
    gate.resetSession()
    await gate.checkOnEnter(remind, { connected: true, hasUpdate: true })
    assert.equal(modals.length, 3, '重新打开小程序再提醒')
    await gate.checkOnEnter(Object.assign({ id: '43', updateType: 3 }, PKG), { connected: true, hasUpdate: true })
    assert.equal(modals.length, 3, '弱提示进入不弹')
    await gate.checkOnEnter(Object.assign({ id: '45', updateType: 2 }, PKG), { connected: true, hasUpdate: false })
    assert.equal(modals.length, 3, '红点不亮不弹')
    checked('进入详情页：强提醒每次启动一次')
  }
  {
    const strip = text => text.replace(/\/\/[^\n]*/g, '')
    const bleDetail = strip(read('subpackages/device/detail/detail.js'))
    const wifiDetail = strip(read('subpackages/device/wifi-detail/wifi-detail.js'))
    assert.ok(/this\.checkFirmwareOnEnter\(\)\n  \},/.test(bleDetail), '蓝牙详情：加载完判断一次（进入后）')
    assert.ok(/firmwareGate\.checkOnEnter\(device, \{ connected: true, hasUpdate: !!this\.data\.firmwareHasUpdate \}/.test(bleDetail), '蓝牙详情：判定用红点结果')
    assert.ok(/firmwareGate\.checkOnEnter\(this\.data\.device, \{ isWifi: true, online: true, hasUpdate: !!this\.data\.otaHasUpdate \}/.test(wifiDetail), 'WiFi 详情：在线才判、用红点结果')
    assert.ok(/this\.checkFirmwareOnEnter\(\)/.test(wifiDetail), 'WiFi 详情：拿到状态后判断一次（进入后）')
    for (const [name, source] of [['蓝牙详情', bleDetail], ['WiFi 详情', wifiDetail]]) {
      assert.ok(!/wrapActions|firmwareGate\(\)|forceOnly/.test(source), `${name}：功能按钮不再判断`)
    }
    for (const file of ['subpackages/device/list/list.js', 'pages/home/home.js', 'subpackages/device/ota/ota.js', 'subpackages/device/wifi-ota/wifi-ota.js']) {
      assert.ok(!/firmware-gate|guardAction|markUpgraded/.test(strip(read(file))), `${file}：不再判断 / 不再写缓存`)
    }
    assert.ok(!/fw_gate_cache|showLoading/.test(read('utils/firmware-gate.js')), '不再 loading 现查、不再本地缓存')
    assert.ok(!/checkForcedFirmwareUpgrade|exitMiniProgram/.test(strip(read('app.js'))), '启动时不弹、不关闭小程序')
    checked('接入位置：只在详情页进入后')
  }
  console.log(`firmware-gate: ${checks} groups passed`)
}
main().catch(error => { console.error(error); process.exitCode = 1 })
