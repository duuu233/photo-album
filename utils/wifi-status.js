// WiFi 版设备的云端状态（2026-10-27）：我的设备、首页设备卡、投屏入口共用。
// 不走蓝牙：在线 / 信号 / 电量都来自 IoT GET /api/device/info（在线与影子一次拿全）。
//   status：loading 查询中 / online 在线 / sleeping 休眠中 / shutdown 已关机 / offline 离线 / unknown 查不到（403 未绑定、503、网络失败等）
// 休眠中（2026-10-27，docs/wifi/休眠状态对接说明.md）：接口与 WS 新增 status=ONLINE / OFFLINE / SLEEPING，
//   SLEEPING 时 online=false；旧服务端没有 status 时按 online 回退。休眠中设备收不到指令（接口仍回 4041），
//   入口直接提示「设备休眠中，唤醒后可操作」，不提示「设备离线，请检查网络」。
// 已关机（V1.4 更新说明三）：设备主动关机上报后 status=SHUTDOWN（灰色「已关机」），不再发离线通知；
//   开机重新登录后恢复 ONLINE。优先级 ONLINE > SHUTDOWN > SLEEPING > OFFLINE 由服务端算好，前端照抄。
const iotApi = require('./iot-api')
const toast = require('./toast')
const batteryUtil = require('./battery')
const signal = require('./signal')

const STATUS_TEXT = { loading: '查询中', online: '在线', sleeping: '休眠中', shutdown: '已关机', offline: '离线', unknown: '状态未知' }
const OFFLINE_TIP = '设备已离线，请检查设备网络'
const SLEEPING_TIP = '设备休眠中，唤醒后可操作'
const SHUTDOWN_TIP = '设备已关机，开机后可操作'
const KNOWN_STATUS = ['ONLINE', 'SLEEPING', 'SHUTDOWN', 'OFFLINE']

// 接口 / WS 返回 → online / sleeping / shutdown / offline：认 status，没有或不认识时按 online 回退
function deviceState(info) {
  const status = String((info && info.status) || '').toUpperCase()
  if (KNOWN_STATUS.indexOf(status) > -1) {
    return status.toLowerCase()
  }
  return info && info.online ? 'online' : 'offline'
}

// 不能操作时的提示（休眠 / 关机 / 离线）；其余返回空串
function blockedTip(status) {
  if (status === 'sleeping') {
    return SLEEPING_TIP
  }
  if (status === 'shutdown') {
    return SHUTDOWN_TIP
  }
  return status === 'offline' ? OFFLINE_TIP : ''
}

// 卡片展示字段（字段名带 wifi 前缀，与蓝牙版的 connected / batteryText 互不干扰）
function statusFields(status, info) {
  const shadow = (info && info.shadow) || {}
  const online = status === 'online'
  const battery = online ? batteryUtil.normalizeBattery(shadow.battery) : null
  return {
    wifiStatus: status,
    wifiStatusText: STATUS_TEXT[status] || STATUS_TEXT.unknown,
    wifiSignalLevel: online ? signal.rssiToLevel(shadow.wifiRssi) : 0,
    wifiBatteryText: battery === null ? '' : `${battery}%`,
    wifiBatteryIcon: battery === null ? '' : batteryUtil.getBatteryIcon(battery)
  }
}

// 查一台设备的状态字段；失败给「状态未知」，不弹错误
function fetchFields(device) {
  return iotApi
    .getDeviceInfo((device && (device.productDeviceId || device.deviceNo)) || '', { showError: false })
    .then(info => statusFields(deviceState(info), info))
    .catch(error => {
      console.warn('[WiFi状态] 查询失败', error && error.code, error && error.message)
      return statusFields('unknown')
    })
}

// 投屏入口用：确认在线才往下走。明确离线 / 休眠时提示并返回 false；查不到（503 / 网络等）放行，由投屏接口裁决（离线回 4041）
async function ensureOnline(device) {
  let state = ''
  try {
    const res = await iotApi.getDeviceOnline((device && (device.productDeviceId || device.deviceNo)) || '', undefined, { showError: false })
    state = deviceState(res)
  } catch (error) {
    return true
  }
  const tip = blockedTip(state)
  if (tip) {
    toast.show({ title: tip, icon: 'none' })
    return false
  }
  return true
}

module.exports = {
  STATUS_TEXT,
  OFFLINE_TIP,
  SLEEPING_TIP,
  SHUTDOWN_TIP,
  deviceState,
  blockedTip,
  statusFields,
  fetchFields,
  ensureOnline
}
