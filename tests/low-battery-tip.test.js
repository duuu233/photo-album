// 低电量提醒（2026-08-21 产品需求）的回归用例。
//
// 锁三件事：
//   ① 两档文案与分界线：10%~4% 一段、≤3% 另一段，11% 及以上、电量未知都不弹；
//   ② 「主动点功能按钮」会弹 —— ensureConnectedForAction 是所有点击处理函数的共用入口；
//   ③ 「自动连接不弹」 —— 底层 ensureDeviceConnected（投屏预览预热、结果页图传续连走的就是它）
//      不得弹窗，否则会打断正在跑的投屏流程。
const assert = require('assert')

const modals = []
global.wx = {
  showModal(options) {
    modals.push(options)
    if (typeof options.complete === 'function') {
      options.complete({ confirm: true })
    }
  },
  showLoading() {},
  hideLoading() {},
  showToast() {}
}

const lowBattery = require('../utils/low-battery')
const activeDevice = require('../utils/active-device')
const deviceBle = require('../utils/device-ble')
const batteryUtil = require('../utils/battery')

// ① 分档
assert.strictEqual(lowBattery.contentFor(100), '')
assert.strictEqual(lowBattery.contentFor(11), '')
assert.strictEqual(lowBattery.contentFor(10), lowBattery.LOW_BATTERY_TEXT)
assert.strictEqual(lowBattery.contentFor(4), lowBattery.LOW_BATTERY_TEXT)
assert.strictEqual(lowBattery.contentFor(3), lowBattery.CRITICAL_BATTERY_TEXT)
assert.strictEqual(lowBattery.contentFor(0), lowBattery.CRITICAL_BATTERY_TEXT)
// 电量未知/非法一律不弹：没有判据就不报警
assert.strictEqual(lowBattery.contentFor(null), '')
assert.strictEqual(lowBattery.contentFor(undefined), '')
assert.strictEqual(lowBattery.contentFor(255), '')

// 文案按产品定稿逐字核对，改一个字都要在这里过一遍
assert.strictEqual(
  lowBattery.LOW_BATTERY_TEXT,
  '目前电子纸设备电量较低，请将电子纸设备放置在光线明亮处使用，并可适当减少操作频次。'
)
assert.strictEqual(
  lowBattery.CRITICAL_BATTERY_TEXT,
  '目前电子纸设备电量低于3%，即将关机，请将电子纸设备放置在阳光充足或光线明亮的区域，进行光能充电即可恢复使用。'
)

const SERIAL = 'E948C21ED428'
const BLE_ID = 'BLE-HANDLE-1'

// 让「这台设备已连接」在 active-device 眼里成立：直连句柄 + 会话里 0x01 核实过的完整 ID。
deviceBle.getActiveConnections = () => [
  { deviceId: BLE_ID, verifiedSerials: [SERIAL] }
]
deviceBle.isConnected = id => id === BLE_ID

function deviceWithBattery(battery) {
  return Object.assign(
    { id: 'record-1', deviceNo: SERIAL, deviceId: BLE_ID, connected: true },
    batteryUtil.stampBattery(battery)
  )
}

;(async () => {
  // 调用方手上已有电量时不再多读一条 0x04
  let reads = 0
  deviceBle.readBattery = () => {
    reads += 1
    return Promise.resolve(2)
  }

  modals.length = 0
  assert.strictEqual(await lowBattery.warnIfLow(BLE_ID, { battery: 7 }), true)
  assert.strictEqual(modals.length, 1)
  assert.strictEqual(modals[0].content, lowBattery.LOW_BATTERY_TEXT)
  assert.strictEqual(modals[0].showCancel, false)
  assert.strictEqual(reads, 0, '传了 battery 就不该再发 0x04')

  modals.length = 0
  assert.strictEqual(await lowBattery.warnIfLow(BLE_ID, { battery: 60 }), false)
  assert.strictEqual(modals.length, 0)

  // 没传 battery 时走电量收口层：设备记录里 15 秒内的最近值直接复用
  batteryUtil.clearCacheForTest()
  modals.length = 0
  assert.strictEqual(
    await lowBattery.warnIfLow(BLE_ID, { device: deviceWithBattery(2) }),
    true
  )
  assert.strictEqual(modals.length, 1)
  assert.strictEqual(modals[0].content, lowBattery.CRITICAL_BATTERY_TEXT)
  assert.strictEqual(reads, 0, '15 秒内的最近值应命中缓存，不再发 0x04')

  // ② 主动点功能按钮：ensureConnectedForAction 弹
  batteryUtil.clearCacheForTest()
  modals.length = 0
  const actionDevice = deviceWithBattery(9)
  assert.strictEqual(
    await activeDevice.ensureConnectedForAction(actionDevice),
    BLE_ID
  )
  assert.strictEqual(modals.length, 1, '主动操作前应弹一次低电量提醒')
  assert.strictEqual(modals[0].content, lowBattery.LOW_BATTERY_TEXT)

  // ③ 自动连接不弹：底层 ensureDeviceConnected 只负责连上
  batteryUtil.clearCacheForTest()
  modals.length = 0
  assert.strictEqual(
    await activeDevice.ensureDeviceConnected(deviceWithBattery(1)),
    BLE_ID
  )
  assert.strictEqual(modals.length, 0, '自动连接场景不得弹低电量提醒')

  // 电量健康时主动操作也不该弹
  batteryUtil.clearCacheForTest()
  modals.length = 0
  await activeDevice.ensureConnectedForAction(deviceWithBattery(80))
  assert.strictEqual(modals.length, 0)

  console.log('low-battery-tip tests passed')
})().catch(error => {
  console.error(error)
  process.exit(1)
})
