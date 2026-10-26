module.exports = {
  baseURL: 'https://api.boltfox.cn',
  // mock 总开关：默认走真实接口，仅本地联调时手动改 true；正式版(release)无论此值如何都强制走真实请求(见 request.js)
  useMock: false,
  // 普通请求单次超时(毫秒)。网络失败会静默重试(见 request.js)，用户端最长约 30s 才看到超时提示。
  timeout: 10000,
  // 文件上传单次超时(毫秒)：上传体积大且服务端还要转码，给更长时间；上传不做自动重试(避免重复上传)。
  uploadTimeout: 20000,
  // WiFi 版设备的 IoT 服务（2026-10-26 起对接）：与 baseURL 是两套服务，鉴权沿用同一个登录 token（Header userToken）。
  // 客户端见 utils/iot-request.js、utils/iot-ws.js；小程序后台需把 iotBaseURL 加入 request 合法域名、iotWsURL 加入 socket 合法域名。
  iotBaseURL: 'https://iot.boltfox.cn',
  iotWsURL: 'wss://iot.boltfox.cn/ws/push',
  // 配网时经蓝牙下发给设备的 MQTT 配置（协议 2.2.3 mqtt_config：{ host, port, usr, pwd }）。
  // 来源待后端 / 固件确认（2026-10-26 产品确认先留接口位、不下发）：为 null 时配网跳过 mqtt_config，
  // 设备沿用出厂配置。拿到后优先改成由接口下发（见 utils/wifi-provision.js getMqttConfig），不要在这里写真实凭证。
  iotMqttConfig: null
}
