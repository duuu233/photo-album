// 「选择投屏设备」弹层的设备行（2026-11-06，官方图库详情与 AI 对话共用；此前两页各写一份同样的映射）。
//
// 每一行在后端设备记录上补：
//   · pickerId：这一屏里「选中了哪一行」的标识（后端主键缺失时才退到 deviceId / 设备号 / 名称 / 序号），
//     不是设备物理身份——身份仍是完整 6 字节设备 ID；
//   · isWifi：WiFi 版挂「WiFi版」角标、选中后不连蓝牙；其余挂「蓝牙版」；
//   · statusText / statusTone：连接状态（2026-11-06 需求「设备选择框需要带出设备连接状态」）——
//       WiFi 版查一次云端状态，显示「在线 / 离线 / 休眠中 / 已关机 / 本地模式 / 状态未知」（同我的设备）；
//       蓝牙版看本机有没有这台的活动会话：「已连接」/「未连接」。
//     tone：online（WiFi 在线）/ connected（蓝牙已连接）/ off（其余），只管颜色。
//
// 2026-11-06 起所有已绑定设备都进列表（原 2026-10-29 离线 / 本地模式 / 状态未知的 WiFi 版不进列表，
// 那样「离线」永远显示不出来）；选了不可投的 WiFi 版，按「投屏」后照旧由 wifiStatus.ensureOnline 提示并停下。
//
// 蓝牙判断由调用方传 findConnectedDeviceId（active-device），本文件不依赖蓝牙模块，便于单测。
const wifiStatus = require('./wifi-status')

function pickerIdOf(item, index) {
  return String(
    item && item.id != null
      ? item.id
      : ((item && (item.deviceId || item.deviceNo || item.name)) || index)
  )
}

// bound：getDevices 返回的已绑定设备；options.isWifi(item)、options.findConnectedDeviceId(item) 由调用方给
function buildPickerDevices(bound, options) {
  const opts = options || {}
  const isWifi = typeof opts.isWifi === 'function' ? opts.isWifi : () => false
  const findConnected = typeof opts.findConnectedDeviceId === 'function' ? opts.findConnectedDeviceId : () => ''
  return Promise.all((bound || []).map((item, index) => {
    const row = Object.assign({}, item, { pickerId: pickerIdOf(item, index), isWifi: !!isWifi(item) })
    if (row.isWifi) {
      return wifiStatus.fetchFields(item).then(fields => Object.assign(row, {
        statusText: fields.wifiStatusText,
        statusTone: fields.wifiStatus === 'online' ? 'online' : 'off'
      }))
    }
    let connected = false
    try {
      connected = !!findConnected(item)
    } catch (error) {
      connected = false
    }
    return Object.assign(row, {
      statusText: connected ? '已连接' : '未连接',
      statusTone: connected ? 'connected' : 'off'
    })
  }))
}

module.exports = {
  pickerIdOf,
  buildPickerDevices
}
