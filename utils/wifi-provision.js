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

// 蓝牙会话事件接进配网日志：收发帧（密码帧打码）、设备 WiFi 状态报告、自定义数据、设备报错、断开。返回退订函数。
function hookSessionLog(session, log) {
  if (!session || typeof session.on !== 'function') {
    return () => {}
  }
  const offs = [
    session.on('frame', frame => {
      if (frame.dir === 'tx' && frame.isData && frame.subtype === blufi.DATA.STA_PASSWORD) {
        log(`蓝牙发 → 密码帧（${frame.length} 字节，内容已隐藏）`)
        return
      }
      log(`蓝牙${frame.dir === 'tx' ? '发 →' : '收 ←'} ${frame.hex}`)
    }),
    session.on('wifiState', state =>
      log(
        `设备WiFi状态：STA ${state.staState}（0 已连上 / 1 失败 / 2 连接中 / 3 无IP）` +
          `${state.ssid ? `，SSID ${state.ssid}` : ''}` +
          `${state.endReason !== null && state.endReason !== undefined ? `，断开原因 ${state.endReason}` : ''}` +
          `${state.rssi !== null && state.rssi !== undefined ? `，RSSI ${state.rssi}` : ''}`
      )
    ),
    session.on('custom', custom => log(`设备自定义数据：${custom.text}`)),
    session.on('deviceError', detail => log(`设备报错：${detail.message}`)),
    session.on('disconnect', () => log('设备断开了蓝牙连接'))
  ]
  return () => offs.forEach(off => off())
}

// 跑一遍配网。hooks：{ onStep(index, status), isCancelled(), onLog(text) }。
// 成功 resolve { device }（老服务归一化后的设备记录）；失败 reject，error.step 为失败的步骤下标、message 为给用户看的文案。
// onLog：配网日志（每一步的入参 / 结果、蓝牙收发帧、设备状态报告、绑定与每次在线查询），方便联调；同时打控制台 [配网]。
// WiFi 密码不进日志：只记位数，密码帧打码。
async function run(job, hooks) {
  const onStep = (hooks && hooks.onStep) || function () {}
  const isCancelled = (hooks && hooks.isCancelled) || (() => false)
  const onLog = (hooks && hooks.onLog) || function () {}
  const log = text => {
    console.log('[配网]', text)
    try {
      onLog(text)
    } catch (error) {
      // 页面日志回调出错不影响配网
    }
  }
  const checkCancel = step => {
    if (isCancelled()) {
      log('已取消配网')
      throw provisionError(step, '已取消配网')
    }
  }
  const since = Date.now()
  let session = null
  let offSessionLog = () => {}
  const product = job.product || {}
  log(
    `开始配网：设备 ${job.deviceNo || '-'}（${job.name || '-'}），蓝牙句柄 ${job.bleDeviceId || '-'}，` +
      `产品 ${product.productId || '-'} ${product.productName || ''}，WiFi「${job.ssid}」，密码 ${String(job.password || '').length} 位，since=${since}`
  )

  try {
    // ① 手机网络
    onStep(0, 'loading')
    log('① 检查手机网络')
    const networkType = await getNetworkType()
    log(`手机网络类型：${networkType}`)
    if (networkType === 'none') {
      throw provisionError(0, '手机网络不可用，请检查网络后重试')
    }
    onStep(0, 'done')
    checkCancel(1)

    // ② 设备网络配置
    onStep(1, 'loading')
    log('② 蓝牙连接设备（列表页已连上则复用）')
    try {
      await bluetooth.openAdapter()
      await bluetooth.whenScanStopped()
      session = await blufi.connect(job.bleDeviceId)
    } catch (error) {
      log(`蓝牙连接设备失败：${(error && error.message) || error}`)
      throw provisionError(1, '连接设备失败，请将手机靠近设备后重试', error)
    }
    offSessionLog = hookSessionLog(session, log)
    const info = typeof session.info === 'function' ? session.info() : {}
    log(`已连接：服务 ${info.serviceId || '-'}，单帧上限 ${info.frameLimit || '-'} 字节`)
    checkCancel(1)
    log('下发 WiFi：STA 模式（0x02）→ 名称（数据 0x02）→ 密码（数据 0x03）')
    try {
      await session.configureSta(job.ssid, job.password)
    } catch (error) {
      log(`下发 WiFi 失败：${(error && error.message) || error}`)
      throw provisionError(1, '设备网络配置下发失败，请靠近设备后重试', error)
    }
    const mqttConfig = await getMqttConfig(job)
    if (mqttConfig) {
      log(`下发 mqtt_config：host ${mqttConfig.host || '-'}，port ${mqttConfig.port || '-'}，usr ${mqttConfig.usr || '-'}`)
      let ack = null
      try {
        ack = await session.request('mqtt_config', mqttConfig, MQTT_ACK_TIMEOUT_MS)
      } catch (error) {
        log(`mqtt_config 无应答：${(error && error.message) || error}`)
        throw provisionError(1, '设备未响应网络配置，请重试', error)
      }
      log(`mqtt_config_ack：${JSON.stringify(ack)}`)
      if (Number(ack && ack.result) !== 0) {
        throw provisionError(1, `设备网络配置失败（错误码 ${ack && ack.result}）`)
      }
    } else {
      log('MQTT 配置来源未定，本次不下发 mqtt_config')
    }
    onStep(1, 'done')
    checkCancel(2)

    // ③ 设备连接 WiFi
    onStep(2, 'loading')
    log(`③ 让设备连接 WiFi（控制 0x03），最多等 ${WIFI_STATE_TIMEOUT_MS / 1000} 秒的状态报告`)
    const settled = session.waitFor(
      'wifiState',
      state => state.staState === blufi.STA_STATE.CONNECTED || state.staState === blufi.STA_STATE.FAIL,
      WIFI_STATE_TIMEOUT_MS
    )
    try {
      await session.connectWifi()
    } catch (error) {
      log(`发送连接指令失败：${(error && error.message) || error}`)
      throw provisionError(2, '设备连接WiFi失败，请靠近设备后重试', error)
    }
    const state = await settled
    if (!state) {
      log('没等到设备的 WiFi 状态报告，交给第 4 步在线查询裁决')
    }
    if (state && state.staState === blufi.STA_STATE.FAIL) {
      throw provisionError(2, '设备连接WiFi失败，请检查WiFi名称和密码，并确认是2.4G网络')
    }
    onStep(2, 'done')
    // 设备已拿到 WiFi，蓝牙不再需要：尽早释放，别占着设备
    offSessionLog()
    session.close()
    session = null
    log('已释放蓝牙连接')
    checkCancel(3)

    // ④ 绑定 + 轮询上云
    onStep(3, 'loading')
    log(`④ 老服务绑定：deviceNo ${job.deviceNo}，productId ${product.productId || '-'}`)
    let device = null
    try {
      device = await api.bindWifiDevice({
        deviceNo: job.deviceNo,
        productId: product.productId,
        productName: product.productName,
        sizeModel: product.sizeModel,
        broadcastName: job.name
      })
    } catch (error) {
      log(`绑定失败：${(error && error.message) || error}`)
      throw provisionError(3, `设备绑定失败：${(error && error.message) || '请稍后重试'}`, error)
    }
    log(`绑定成功：userProductId ${(device && (device.userProductId || device.id)) || '-'}`)
    log(`轮询在线：每 ${ONLINE_POLL_INTERVAL_MS / 1000} 秒查一次，最多 ${ONLINE_TIMEOUT_MS / 1000} 秒`)
    const deadline = Date.now() + ONLINE_TIMEOUT_MS
    let attempt = 0
    while (Date.now() < deadline) {
      checkCancel(3)
      attempt += 1
      try {
        const res = await iotApi.getDeviceOnline(job.deviceNo, since, { showError: false })
        log(`在线查询 #${attempt}：online=${res && res.online}，lastOnlineAt=${(res && res.lastOnlineAt) || '-'}`)
        if (res && res.online) {
          onStep(3, 'done')
          log('设备已上云，配网成功')
          return { device }
        }
      } catch (error) {
        log(`在线查询 #${attempt} 失败：code ${error && error.code}，${(error && error.message) || error}`)
        if (error && error.action === 'relogin') {
          throw provisionError(3, '登录已失效，请重新登录', error)
        }
        // 503（权限服务暂不可用）/ 403（绑定还没生效）/ 网络抖动：不算失败，继续轮询
      }
      await sleep(ONLINE_POLL_INTERVAL_MS)
    }
    throw provisionError(3, '设备联网超时，请检查WiFi密码或信号后重试')
  } catch (error) {
    log(`配网失败（第 ${(error && typeof error.step === 'number' ? error.step : 0) + 1} 步）：${(error && error.message) || error}`)
    throw error
  } finally {
    offSessionLog()
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
