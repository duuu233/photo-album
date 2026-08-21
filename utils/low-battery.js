// 低电量提醒收口层（2026-08-21 产品需求）。
//
// 口径：**用户主动点**任意需要连接电子纸设备的功能按钮（连接、投屏、相册再投/删除、轮播设置、
// 一键清空、固件升级…）时，电量 ≤10% 就弹一次提示；**自动连接的场景不弹**——投屏预览页的预热
// 连接、结果页图传前的续连、OTA 自动开始那一跳，用户并没有按下按钮，弹窗只会打断正在跑的流程。
//
// 两档文案由产品定稿，一字不改：
//   10%~4%：提示放到光线明亮处、减少操作频次；
//   ≤3%   ：告知即将关机，去阳光/明亮处光能充电即可恢复。
//
// 收口点（改这两处即可覆盖全站，页面不必各写一套判断）：
//   ① active-device.ensureConnectedForAction —— 「操作前确保已连接」的唯一入口，调用方清一色是点击处理函数；
//   ② 首页/设备列表/设备详情的「连接」「投屏」按钮 —— 它们走 connectBoundDevice（底层链路，
//      自动连接也会复用），所以不塞在链路里，由页面在连接成功/已连接时各调一次。
// 底层 ensureDeviceConnected / connectBoundDevice 一律不弹，「自动连接不弹」因此是结构上成立的，
// 而不是靠调用方自觉。
const batteryUtil = require('./battery')

// 低电量档：10%~4% 提示节制使用；≤3% 告知即将关机。
const LOW_BATTERY_MAX = 10
const CRITICAL_BATTERY_MAX = 3

const LOW_BATTERY_TEXT =
  '目前电子纸设备电量较低，请将电子纸设备放置在光线明亮处使用，并可适当减少操作频次。'
const CRITICAL_BATTERY_TEXT =
  '目前电子纸设备电量低于3%，即将关机，请将电子纸设备放置在阳光充足或光线明亮的区域，进行光能充电即可恢复使用。'

// 该电量该弹哪段话；不低电量或电量未知（null）返回 ''，调用方据此决定弹不弹。
// 电量未知一律不弹：没有判据就不报警，与详情页「未连接整行 '--'、红点恒灭」同一套态度。
function contentFor(value) {
  const battery = batteryUtil.normalizeBattery(value)
  if (battery === null || battery > LOW_BATTERY_MAX) {
    return ''
  }
  return battery <= CRITICAL_BATTERY_MAX ? CRITICAL_BATTERY_TEXT : LOW_BATTERY_TEXT
}

// 同一时刻只留一个提醒：两条异步链路先后连上同一台设备时，不叠两个一模一样的弹窗。
let showing = false

function showTip(content) {
  if (showing) {
    return Promise.resolve(false)
  }
  showing = true
  return new Promise(resolve => {
    wx.showModal({
      title: '电量提醒',
      content,
      showCancel: false,
      confirmText: '知道了',
      complete: () => {
        showing = false
        resolve(true)
      }
    })
  })
}

// 主动操作前的低电量提醒。返回 Promise<boolean>：是否真的弹了窗。
//   deviceId          本次会话有效的 BLE deviceId（未连接就没有电量可读，直接不弹）
//   options.device    设备记录，作为电量兜底值（页面/selectedDevice 上最近一次有效电量）
//   options.battery   调用方手上已有的电量（如 connectBoundDevice 刚返回的 info.battery），
//                     给了就不再多读一次 0x04
//
// **不阻断**调用方的动作：弹窗只是告知，用户点「知道了」后原动作照常继续。之所以 await 而不是
// 甩出去，是为了不和紧随其后的 wx.showLoading（保存中/清空中/升级中）抢同一块屏。
async function warnIfLow(deviceId, options) {
  const opts = options || {}
  let battery = batteryUtil.normalizeBattery(opts.battery)
  if (battery === null) {
    const id = String(deviceId || '')
    if (!id) {
      return false
    }
    // 走电量收口层：15 秒内复用最近一次 0x04，过期才真读，读失败回落最近有效值。
    // 所以「点一下就弹一次」不会变成「点一下就多发一条 BLE 指令」。
    const state = await batteryUtil.readLatestBattery(id, { fallback: opts.device })
    battery = batteryUtil.normalizeBattery(state && state.battery)
  }
  const content = contentFor(battery)
  if (!content) {
    return false
  }
  console.info('[低电量提醒] 主动操作前提示', { deviceId, battery })
  return showTip(content)
}

module.exports = {
  LOW_BATTERY_MAX,
  CRITICAL_BATTERY_MAX,
  LOW_BATTERY_TEXT,
  CRITICAL_BATTERY_TEXT,
  contentFor,
  warnIfLow
}
