// WiFi 版设备配网流程（2026-10-26 STEP 2；2026-10-27 按 docs/wifi/设备入网流程.md 2.2 调整）。
//
// 页面上的四个状态（设备入网流程 2.2「配网 4 步与指令时序」）：
//   1 手机网络正常           —— wx.getNetworkType，不是 none 即可
//   2 设备网络配置已完成     —— 先调 IoT GET /api/device/provisioning/mqtt 取 MQTT 参数（取不到就停在本步，不动设备）；
//                              BluFi 连上设备（WiFi 列表页扫描时已连上的会话直接复用），三条指令顺序固定：
//                              WiFi 信息（STA 模式 + 名称 + 密码）→ mqtt_config（等 mqtt_config_ack.result=0）→
//                              国家码 wifi_set_country_code（小程序固定 01；成功 / pending=1 / 超时都不阻塞，
//                              result 非 0 换新 msgid 重试一次，仍失败继续）；最后发「连接 WiFi」让设备退出配网，随即释放蓝牙
//                              ——步骤 3 起设备已退出配网，不能再补发指令
//   3 设备正在连接Wi-Fi      —— 设备侧没有状态上报，这一步调老服务绑定；绑定失败停在本步，不开始轮询
//                              （绑定必须先于在线查询：在线接口会调老服务 checkPermission，未绑定返回 403）
//   4 设备正在连接云端       —— 轮询 GET /api/device/online?deviceNo=&since=（since 为本次配网开始时间），online=true 即成功；
//                              503（权限服务不可用）/ 403 / 网络失败继续轮询，60s 超时；401 停止
//
// 页面之间的交接（handoff）放内存、不进页面路由：WiFi 密码不该出现在 url 里。
const api = require('./api')
const iotApi = require('./iot-api')
const blufi = require('./blufi')
const bluetooth = require('./bluetooth')

const STEP_TEXTS = ['手机网络正常', '设备网络配置已完成', '设备正在连接Wi-Fi', '设备正在连接云端']

// BLE 自定义消息的回执超时（设备入网流程 2.2 建议 5 秒）
const BLE_ACK_TIMEOUT_MS = 5000
// 国家码：小程序统一传世界通用模式 01（设备入网流程 5.2；App 才传真实国家码）
const COUNTRY_CODE = '01'
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

// MQTT 配置：每次配网现调 IoT GET /api/device/provisioning/mqtt（2026-10-27，凭据不再写在前端 config）。
// 不缓存：不存 Storage、不放模块变量，只在 run() 局部变量里活到 mqtt_config 发出为止。
// 返回 { host, port, usr, pwd }；四项缺任何一项都按取不到处理（reject），由调用方停在第 2 步。
async function getMqttConfig() {
  const data = await iotApi.getProvisioningMqtt({ showError: false })
  const mqtt = {
    host: String((data && data.host) || '').trim(),
    port: Number(data && data.port),
    usr: String((data && data.usr) || ''),
    pwd: String((data && data.pwd) || '')
  }
  if (!mqtt.host || !(mqtt.port > 0) || !mqtt.usr || !mqtt.pwd) {
    const error = new Error('MQTT 参数不完整')
    error.code = 'MQTT_CONFIG_INCOMPLETE'
    throw error
  }
  return mqtt
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

// 下发国家码 wifi_set_country_code（设备入网流程 3.2 / 5.1），始终不阻塞配网：
//   · pending=1 优先于 result：设备暂缓执行，最终生效值以心跳 country_code 为准；
//   · 无 pending、result=0：成功；无 pending、result 非 0：换新 msgid 重试一次，仍失败继续配网；
//   · 等不到回执（超时 / 写失败）：不重试，继续配网。
async function sendCountryCode(session) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let ack = null
    try {
      ack = await session.request('wifi_set_country_code', { country: COUNTRY_CODE }, BLE_ACK_TIMEOUT_MS, blufi.newMsgid())
    } catch (error) {
      return
    }
    if ((ack && Number(ack.pending) === 1) || Number(ack && ack.result) === 0) {
      return
    }
  }
}

// 跑一遍配网。hooks：{ onStep(index, status), isCancelled() }。
// 成功 resolve { device }（老服务归一化后的设备记录）；失败 reject，error.step 为失败的步骤下标、message 为给用户看的文案。
// 2026-10-27 按产品要求去掉配网日志（页面日志面板与逐步记录），WiFi 密码 / MQTT 密码本来就不记。
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
  const product = job.product || {}

  try {
    // ① 手机网络
    onStep(0, 'loading')
    if ((await getNetworkType()) === 'none') {
      throw provisionError(0, '手机网络不可用，请检查网络后重试')
    }
    onStep(0, 'done')
    checkCancel(1)

    // ② 设备网络配置：先取 MQTT 参数——取不到就不动设备（不下发 WiFi），避免设备只收到半套配置
    onStep(1, 'loading')
    let mqttConfig = null
    try {
      mqttConfig = await getMqttConfig()
    } catch (error) {
      if (error && error.action === 'relogin') {
        throw provisionError(1, '登录已失效，请重新登录', error)
      }
      throw provisionError(1, '获取设备网络配置失败，请稍后重试', error)
    }
    checkCancel(1)
    try {
      await bluetooth.openAdapter()
      await bluetooth.whenScanStopped()
      session = await blufi.connect(job.bleDeviceId)
    } catch (error) {
      throw provisionError(1, '连接设备失败，请将手机靠近设备后重试', error)
    }
    checkCancel(1)
    try {
      await session.configureSta(job.ssid, job.password)
    } catch (error) {
      throw provisionError(1, '设备网络配置下发失败，请靠近设备后重试', error)
    }
    let mqttAck = null
    try {
      mqttAck = await session.request('mqtt_config', mqttConfig, BLE_ACK_TIMEOUT_MS, blufi.newMsgid())
    } catch (error) {
      throw provisionError(1, '设备未响应网络配置，请重试', error)
    } finally {
      // 发出去（或发送失败）就不再留：后面的错误路径都碰不到密码
      mqttConfig = null
    }
    if (Number(mqttAck && mqttAck.result) !== 0) {
      throw provisionError(1, `设备网络配置失败（错误码 ${mqttAck && mqttAck.result}）`)
    }
    checkCancel(1)
    await sendCountryCode(session)
    checkCancel(1)
    // 三条指令都已下发：让设备退出配网、用下发的 WiFi 去连接（乐鑫 BluFi 控制帧 0x03）。
    // 之后设备不再接收蓝牙指令，设备侧也没有状态上报，蓝牙随即释放。
    try {
      await session.connectWifi()
    } catch (error) {
      throw provisionError(1, '设备网络配置下发失败，请靠近设备后重试', error)
    }
    onStep(1, 'done')
    session.close()
    session = null
    checkCancel(2)

    // ③ 设备连接 WiFi（设备侧无状态上报）：期间完成老服务绑定（绑定必须先于在线查询）
    onStep(2, 'loading')
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
      throw provisionError(2, `设备绑定失败：${(error && error.message) || '请稍后重试'}`, error)
    }
    onStep(2, 'done')
    checkCancel(3)

    // ④ 轮询上云：503（权限服务暂不可用）/ 403 / 网络抖动不算失败，继续轮询；401 停止
    onStep(3, 'loading')
    const deadline = Date.now() + ONLINE_TIMEOUT_MS
    let online = false
    let lastCode = null
    while (Date.now() < deadline) {
      checkCancel(3)
      try {
        const res = await iotApi.getDeviceOnline(job.deviceNo, since, { showError: false })
        lastCode = null
        if (res && res.online) {
          online = true
          break
        }
      } catch (error) {
        lastCode = error && error.code
        if (error && error.action === 'relogin') {
          throw provisionError(3, '登录已失效，请重新登录', error)
        }
      }
      await sleep(ONLINE_POLL_INTERVAL_MS)
    }
    if (!online) {
      // 一直 503 是权限服务不可用，不是设备联网失败（设备入网流程 2.2），提示稍后重试
      if (Number(lastCode) === 503) {
        throw provisionError(3, '服务暂时不可用，请稍后重试')
      }
      throw provisionError(3, '设备联网超时，请检查WiFi密码或信号后重试')
    }
    onStep(3, 'done')
    return { device }
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
