// IoT 服务（WiFi 版设备）业务接口，统一经 utils/iot-request.js 发起。
// 与 BoltFox 老服务的 utils/api.js 分开放：两边域名、返回结构和错误码都不同（见 utils/iot-errors.js）。
// 设备相关接口都会实时校验设备权限：设备未绑定到当前用户返回 403。
const iot = require('./iot-request')

// 传给后端查询的设备ID不加冒号（2026-10-27 产品口径）：App 内设备记录的 deviceNo 是 AA:BB:… 格式，这里统一去掉
function plainDeviceNo(deviceNo) {
  return String(deviceNo == null ? '' : deviceNo).replace(/[:\-\s]/g, '').toUpperCase()
}

// 投屏上传超时：文档要求 30 秒以上（服务端同步处理最长约 8 秒，图片上传另算），这里给 60 秒
const PLAY_TIMEOUT_MS = 60000

module.exports = {
  PLAY_TIMEOUT_MS,
  // 在线状态：{ deviceNo, online, lastOnlineAt }。
  // since（毫秒时间戳，可选）：配网时传本次配网开始时间，只有 lastOnlineAt 晚于它才算 online，避免旧连接误判。
  getDeviceOnline(deviceNo, since, options) {
    return iot.get('/api/device/online', { deviceNo: plainDeviceNo(deviceNo), since }, options)
  },

  // 设备信息 / 影子：{ deviceNo, online, lastOnlineAt, firmwareVersion, shadow: {...} }
  getDeviceInfo(deviceNo, options) {
    return iot.get('/api/device/info', { deviceNo: plainDeviceNo(deviceNo) }, options)
  },

  // WiFi 投屏（2026-10-27，前端对接文档 1.1 / 评审回复 v0.32）：multipart 传 deviceNo、type、file；
  // userNo 已改由服务端从 token 解析，不再传。服务端同步转 bin + 上传 OSS + 下发，最长约 8 秒，超时按文档设 30 秒以上。
  // 返回 { msgid, binUrl, binSize, status }：status=SENT（旧版为 DOWNLOADING）表示指令已下发，FAILED 表示 MQTT 下发失败。
  play(deviceNo, filePath, type, options) {
    const opts = options || {}
    return iot.upload('/api/device/play', {
      filePath,
      name: 'file',
      formData: { deviceNo: plainDeviceNo(deviceNo), type: String(type) },
      timeout: PLAY_TIMEOUT_MS,
      showError: opts.showError,
      onProgress: opts.onProgress
    })
  },

  // 投屏状态（断线兜底，文档 1.5）：{ msgid, status, sentAt, elapsedSeconds }；任务超 1 小时查询返回 4044
  getPlayStatus(msgid, options) {
    return iot.get('/api/device/play/status', { msgid }, options)
  },

  // 配网下发给设备的 MQTT 参数：{ host, port, usr, pwd }（2026-10-27 后端提供，凭据不再写在前端）。
  // 响应不缓存：请求头要求中间层不缓存，客户端不存 Storage / 全局变量，配网第 2 步现取现用、发完即丢；pwd 不进任何日志。
  getProvisioningMqtt(options) {
    return iot.get('/api/device/provisioning/mqtt', {}, Object.assign({}, options, {
      header: Object.assign({}, options && options.header, { 'Cache-Control': 'no-cache, no-store', Pragma: 'no-cache' })
    }))
  }
}
