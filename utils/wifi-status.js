// WiFi 版设备的云端状态（2026-10-27）：我的设备、首页设备卡、投屏入口共用。
// 不走蓝牙：在线 / 信号 / 电量都来自 IoT GET /api/device/info（在线与影子一次拿全）。
//   status：loading 查询中 / online 在线 / sleeping 休眠中 / shutdown 已关机 / local 本地模式 / offline 离线 /
//           unknown 查不到（403 未绑定、503、网络失败等）或不认识的状态值
// 休眠中（2026-10-27，docs/wifi/休眠状态对接说明.md）：接口与 WS 新增 status=ONLINE / OFFLINE / SLEEPING，
//   SLEEPING 时 online=false；旧服务端没有 status 时按 online 回退。休眠中设备收不到指令（接口仍回 4041），
//   入口直接提示「设备休眠中，唤醒后可操作」，不提示「设备离线，请检查网络」。
// 已关机（V1.4 更新说明三）：设备主动关机上报后 status=SHUTDOWN（灰色「已关机」），不再发离线通知；
//   开机重新登录后恢复 ONLINE。优先级 ONLINE > SHUTDOWN > SLEEPING > OFFLINE 由服务端算好，前端照抄。
// 本地模式（2026-10-29，docs/wifi/前端对接20261029.md）：设备切到 TF 卡本地播放后 status=LOCAL_TF（online=false），
//   显示「本地模式」，远程操作一律提示「当前设备状态：本地模式，请恢复设备网络再试」；恢复只能在设备端重新入网。
//   优先级 ONLINE > SHUTDOWN > LOCAL_TF > SLEEPING > OFFLINE。同一文档要求：不认识的新枚举值按「状态未知」降级。
const iotApi = require('./iot-api')
const toast = require('./toast')
const batteryUtil = require('./battery')
const signal = require('./signal')

const STATUS_TEXT = { loading: '查询中', online: '在线', sleeping: '休眠中', shutdown: '已关机', local: '本地模式', offline: '离线', unknown: '状态未知' }
const OFFLINE_TIP = '设备已离线，请检查设备网络'
const SLEEPING_TIP = '设备休眠中，唤醒后可操作'
const SHUTDOWN_TIP = '设备已关机，开机后可操作'
const LOCAL_TIP = '当前设备状态：本地模式，请恢复设备网络再试'
const NOT_ONLINE_TIP = '设备不在线'
const STATE_OF = { ONLINE: 'online', SLEEPING: 'sleeping', SHUTDOWN: 'shutdown', OFFLINE: 'offline', LOCAL_TF: 'local' }

// 接口 / WS 返回 → online / sleeping / shutdown / local / offline / unknown：
// 认 status；没有 status（旧服务端）按 online 回退；有但不认识按「状态未知」降级（2026-10-29 对接文档一.4）
function deviceState(info) {
  const status = String((info && info.status) || '').toUpperCase()
  if (STATE_OF[status]) {
    return STATE_OF[status]
  }
  if (status) {
    return 'unknown'
  }
  return info && info.online ? 'online' : 'offline'
}

// 不能操作时的提示（休眠 / 关机 / 本地模式 / 离线）；其余返回空串
function blockedTip(status) {
  if (status === 'local') {
    return LOCAL_TIP
  }
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

// 投屏严格口径（2026-10-29：「我的上传」投屏、预览页「开始投屏」）：只放行在线；离线 / 本地模式 / 查不到（状态未知）
// 一律给 NOT_ONLINE_TIP，休眠 / 关机沿用各自提示。返回给用户看的提示，可投时返回空串。
async function projectBlockedTip(device) {
  let state = 'unknown'
  try {
    const res = await iotApi.getDeviceOnline((device && (device.productDeviceId || device.deviceNo)) || '', undefined, { showError: false })
    state = deviceState(res)
  } catch (error) {
    state = 'unknown'
  }
  if (state === 'online') {
    return ''
  }
  if (state === 'sleeping' || state === 'shutdown') {
    return blockedTip(state)
  }
  return NOT_ONLINE_TIP
}

// 保存类操作前查一次（轮播保存等）：明确不可操作给对应提示；查不到返回空串，交给接口裁决
async function queryBlockedTip(device) {
  try {
    const res = await iotApi.getDeviceOnline((device && (device.productDeviceId || device.deviceNo)) || '', undefined, { showError: false })
    return blockedTip(deviceState(res))
  } catch (error) {
    return ''
  }
}

// 选择投屏设备列表（AI 生图、官方图库，2026-10-29）：WiFi 版查一次状态，离线 / 本地模式 / 状态未知的不进列表；
// 蓝牙版原样保留。isWifi(item) 由调用方给（broadcast-match.isWifiDevice），这里不依赖蓝牙模块。
const PICKER_HIDDEN = ['offline', 'local', 'unknown']
function filterPickable(devices, isWifi) {
  const list = devices || []
  return Promise.all(list.map(item => {
    if (!isWifi(item)) {
      return true
    }
    return fetchFields(item).then(fields => PICKER_HIDDEN.indexOf(fields.wifiStatus) === -1)
  })).then(keep => list.filter((item, index) => keep[index]))
}

module.exports = {
  STATUS_TEXT,
  OFFLINE_TIP,
  SLEEPING_TIP,
  SHUTDOWN_TIP,
  LOCAL_TIP,
  NOT_ONLINE_TIP,
  deviceState,
  blockedTip,
  statusFields,
  fetchFields,
  ensureOnline,
  projectBlockedTip,
  queryBlockedTip,
  filterPickable
}
