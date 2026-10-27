// IoT 服务（WiFi 版设备）业务接口，统一经 utils/iot-request.js 发起。
// 与 BoltFox 老服务的 utils/api.js 分开放：两边域名、返回结构和错误码都不同（见 utils/iot-errors.js）。
// 设备相关接口都会实时校验设备权限：设备未绑定到当前用户返回 403。
const iot = require('./iot-request')

// 传给后端查询的设备ID不加冒号（2026-10-27 产品口径）：App 内设备记录的 deviceNo 是 AA:BB:… 格式，这里统一去掉
function plainDeviceNo(deviceNo) {
  return String(deviceNo == null ? '' : deviceNo).replace(/[:\-\s]/g, '').toUpperCase()
}

module.exports = {
  // 在线状态：{ deviceNo, online, lastOnlineAt }。
  // since（毫秒时间戳，可选）：配网时传本次配网开始时间，只有 lastOnlineAt 晚于它才算 online，避免旧连接误判。
  getDeviceOnline(deviceNo, since, options) {
    return iot.get('/api/device/online', { deviceNo: plainDeviceNo(deviceNo), since }, options)
  },

  // 设备信息 / 影子：{ deviceNo, online, lastOnlineAt, firmwareVersion, shadow: {...} }
  getDeviceInfo(deviceNo, options) {
    return iot.get('/api/device/info', { deviceNo: plainDeviceNo(deviceNo) }, options)
  },

  // 配网下发给设备的 MQTT 参数：{ host, port, usr, pwd }（2026-10-27 后端提供，凭据不再写在前端）。
  // 只在配网第 2 步现取现用，不缓存、不落本地；pwd 不进任何日志。
  getProvisioningMqtt(options) {
    return iot.get('/api/device/provisioning/mqtt', {}, options)
  }
}
