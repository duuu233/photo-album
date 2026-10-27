// WiFi 版设备的云端状态（2026-10-27）：我的设备、首页设备卡、投屏入口共用。
// 不走蓝牙：在线 / 信号 / 电量都来自 IoT GET /api/device/info（在线与影子一次拿全）。
//   status：loading 查询中 / online 在线 / offline 离线 / unknown 查不到（403 未绑定、503、网络失败等）
const iotApi = require('./iot-api')
const toast = require('./toast')
const batteryUtil = require('./battery')
const signal = require('./signal')

const STATUS_TEXT = { loading: '查询中', online: '在线', offline: '离线', unknown: '状态未知' }

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
    .then(info => statusFields(info && info.online ? 'online' : 'offline', info))
    .catch(error => {
      console.warn('[WiFi状态] 查询失败', error && error.code, error && error.message)
      return statusFields('unknown')
    })
}

// 投屏入口用：确认在线才往下走。明确离线时提示并返回 false；查不到（503 / 网络等）放行，由投屏接口裁决（离线回 4041）
async function ensureOnline(device) {
  let online = null
  try {
    const res = await iotApi.getDeviceOnline((device && (device.productDeviceId || device.deviceNo)) || '', undefined, { showError: false })
    online = !!(res && res.online)
  } catch (error) {
    return true
  }
  if (!online) {
    toast.show({ title: '设备已离线，请检查设备网络', icon: 'none' })
    return false
  }
  return true
}

module.exports = {
  STATUS_TEXT,
  statusFields,
  fetchFields,
  ensureOnline
}
