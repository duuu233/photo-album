// WiFi 版设备配网流程（2026-10-26，对接进度 STEP 2）。
//
// 页面上的四个状态与完成方（接口文档 2.4）：
//   1 手机网络正常           —— wx.getNetworkType，不是 none 即可
//   2 设备网络配置已完成     —— BluFi 连上设备（WiFi 列表页扫描时已连上的会话直接复用），下发 STA 模式 + WiFi 名称 + 密码；
//                              配了 MQTT 配置时再发 mqtt_config
//                              并等 mqtt_config_ack.result=0（来源未定，当前为 null 则跳过，见 getMqttConfig）
//   3 设备正在连接Wi-Fi      —— 发「连接 WiFi」，等设备的 WiFi 状态报告：连上即通过、明确失败即失败；
//                              接口文档口径这一步没有可靠上报，等不到报告也放行，交给第 4 步裁决
//   4 设备正在连接云端       —— 老服务绑定（绑定前 IoT 在线接口会 403）→ 轮询 GET /api/device/online?deviceNo=&since=，
//                              since 为本次配网开始时间，online=true 即成功；503 / 403 / 网络失败继续轮询，60s 超时
//
// 页面之间的交接（handoff）放内存、不进页面路由：WiFi 密码不该出现在 url 里。
const api = require('./api')
const iotApi = require('./iot-api')
const config = require('./config')
const blufi = require('./blufi')
const bluetooth = require('./bluetooth')

const STEP_TEXTS = ['手机网络正常', '设备网络配置已完成', '设备正在连接Wi-Fi', '设备正在连接云端']

const MQTT_ACK_TIMEOUT_MS = 10000
const WIFI_STATE_TIMEOUT_MS = 30000
const ONLINE_POLL_INTERVAL_MS = 2000
const ONLINE_TIMEOUT_MS = 60000

// ── 页面交接 ──
// target：搜索页选中的设备 { bleDeviceId, deviceNo, name, product }；credentials：{ ssid, password }
let target = null
let credentials = null

function setTarget(value) {
  target = value || null
  credentials = null
}

function getTarget() {
  return target
}

function setCredentials(value) {
  credentials = value || null
}

function getJob() {
  return target && credentials ? Object.assign({}, target, credentials) : null
}

// MQTT 配置来源：目前只有 config.iotMqttConfig（默认 null → 不下发）。后端出了配网会话接口后改在这里取。
async function getMqttConfig() {
  return config.iotMqttConfig || null
}

function provisionError(step, message, cause) {
  const error = new Error(message)
  error.step = step
  error.cause = cause
  return error
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function getNetworkType() {
  return new Promise(resolve => {
    if (!wx.getNetworkType) {
      resolve('unknown')
      return
    }
    wx.getNetworkType({
      success: res => resolve(res.networkType || 'unknown'),
      fail: () => resolve('unknown')
    })
  })
}

// 跑一遍配网。hooks：{ onStep(index, status), isCancelled() }。
// 成功 resolve { device }（老服务归一化后的设备记录）；失败 reject，error.step 为失败的步骤下标、message 为给用户看的文案。
async function run(job, hooks) {
  const onStep = (hooks && hooks.onStep) || function () {}
  const isCancelled = (hooks && hooks.isCancelled) || (() => false)
  const checkCancel = step => {
    if (isCancelled()) {
      throw provisionError(step, '已取消配网')
    }
  }
  const since = Date.now()
  let session = null

  try {
    // ① 手机网络
    onStep(0, 'loading')
    const networkType = await getNetworkType()
    if (networkType === 'none') {
      throw provisionError(0, '手机网络不可用，请检查网络后重试')
    }
    onStep(0, 'done')
    checkCancel(1)

    // ② 设备网络配置
    onStep(1, 'loading')
    try {
      await bluetooth.openAdapter()
      await bluetooth.whenScanStopped()
      session = await blufi.connect(job.bleDeviceId)
    } catch (error) {
      console.warn('[配网] 蓝牙连接设备失败', error && error.message)
      throw provisionError(1, '连接设备失败，请将手机靠近设备后重试', error)
    }
    checkCancel(1)
    try {
      await session.configureSta(job.ssid, job.password)
    } catch (error) {
      console.warn('[配网] 下发WiFi失败', error && error.message)
      throw provisionError(1, '设备网络配置下发失败，请靠近设备后重试', error)
    }
    const mqttConfig = await getMqttConfig(job)
    if (mqttConfig) {
      let ack = null
      try {
        ack = await session.request('mqtt_config', mqttConfig, MQTT_ACK_TIMEOUT_MS)
      } catch (error) {
        throw provisionError(1, '设备未响应网络配置，请重试', error)
      }
      if (Number(ack && ack.result) !== 0) {
        throw provisionError(1, `设备网络配置失败（错误码 ${ack && ack.result}）`)
      }
    }
    onStep(1, 'done')
    checkCancel(2)

    // ③ 设备连接 WiFi
    onStep(2, 'loading')
    const settled = session.waitFor(
      'wifiState',
      state => state.staState === blufi.STA_STATE.CONNECTED || state.staState === blufi.STA_STATE.FAIL,
      WIFI_STATE_TIMEOUT_MS
    )
    try {
      await session.connectWifi()
    } catch (error) {
      throw provisionError(2, '设备连接WiFi失败，请靠近设备后重试', error)
    }
    const state = await settled
    if (state && state.staState === blufi.STA_STATE.FAIL) {
      throw provisionError(2, '设备连接WiFi失败，请检查WiFi名称和密码，并确认是2.4G网络')
    }
    onStep(2, 'done')
    // 设备已拿到 WiFi，蓝牙不再需要：尽早释放，别占着设备
    session.close()
    session = null
    checkCancel(3)

    // ④ 绑定 + 轮询上云
    onStep(3, 'loading')
    let device = null
    try {
      const product = job.product || {}
      device = await api.bindWifiDevice({
        deviceNo: job.deviceNo,
        productId: product.productId,
        productName: product.productName,
        sizeModel: product.sizeModel,
        broadcastName: job.name
      })
    } catch (error) {
      throw provisionError(3, `设备绑定失败：${(error && error.message) || '请稍后重试'}`, error)
    }
    const deadline = Date.now() + ONLINE_TIMEOUT_MS
    while (Date.now() < deadline) {
      checkCancel(3)
      try {
        const res = await iotApi.getDeviceOnline(job.deviceNo, since, { showError: false })
        if (res && res.online) {
          onStep(3, 'done')
          return { device }
        }
      } catch (error) {
        if (error && error.action === 'relogin') {
          throw provisionError(3, '登录已失效，请重新登录', error)
        }
        // 503（权限服务暂不可用）/ 403（绑定还没生效）/ 网络抖动：不算失败，继续轮询
        console.warn('[配网] 在线查询失败，继续轮询', error && error.code, error && error.message)
      }
      await sleep(ONLINE_POLL_INTERVAL_MS)
    }
    throw provisionError(3, '设备联网超时，请检查WiFi密码或信号后重试')
  } finally {
    if (session) {
      session.close()
    }
  }
}

module.exports = {
  STEP_TEXTS,
  setTarget,
  getTarget,
  setCredentials,
  getJob,
  getMqttConfig,
  run
}
