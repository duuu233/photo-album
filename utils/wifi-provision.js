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
const config = require('./config')
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

// 日志用：pwd 只标有没有，不出原文
function maskMqtt(mqtt) {
  return Object.assign({}, mqtt, { pwd: mqtt && mqtt.pwd ? '（已隐藏）' : '' })
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
      // 手机发出的自定义数据帧有 mqtt_config（MQTT 账号密码明文）和国家码，帧事件里分不出是哪条：一律整帧打码，内容见上方「参数」行
      if (frame.dir === 'tx' && frame.isData && frame.subtype === blufi.DATA.CUSTOM) {
        log(`蓝牙发 → 自定义数据帧（${frame.length} 字节，内容已隐藏：mqtt_config 含凭据，手机发的自定义帧一律打码）`)
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

// 【流程⑥】下发国家码 wifi_set_country_code（设备入网流程 3.2 / 5.1），始终不阻塞配网：
//   · pending=1 优先于 result：设备暂缓执行，最终生效值以心跳 country_code 为准；
//   · 无 pending、result=0：成功；无 pending、result 非 0：换新 msgid 重试一次，仍失败继续配网；
//   · 等不到回执（超时 / 写失败）：不重试，继续配网。
async function sendCountryCode(session, log) {
  log(`【流程⑥】App 下发国家码（自定义消息 wifi_set_country_code，小程序固定 ${COUNTRY_CODE} 世界通用模式）`)
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const msgid = blufi.newMsgid()
    log(
      `蓝牙指令【设置WiFi国家码】action=wifi_set_country_code（设备通讯协议 2.2.4；走 BluFi 自定义数据 0x13，` +
        `${BLE_ACK_TIMEOUT_MS / 1000} 秒内等 wifi_set_country_code_ack${attempt > 1 ? '；第 2 次，换新 msgid' : ''}）`
    )
    log(`参数 ${JSON.stringify({ msgid, data: { country: COUNTRY_CODE } })}`)
    let ack = null
    try {
      ack = await session.request('wifi_set_country_code', { country: COUNTRY_CODE }, BLE_ACK_TIMEOUT_MS, msgid)
    } catch (error) {
      log(`失败 ${(error && error.message) || error}（国家码不阻塞配网，继续）`)
      return
    }
    log(`返回 ${JSON.stringify(ack)}（pending=1 暂缓执行 / result=0 成功）`)
    if (ack && Number(ack.pending) === 1) {
      log('国家码暂缓执行，最终生效值以设备心跳 country_code 为准，继续配网')
      return
    }
    if (Number(ack && ack.result) === 0) {
      return
    }
    log(`国家码设置失败（错误码 ${ack && ack.result}）${attempt < 2 ? '，换新 msgid 重试' : '，不影响 WiFi 连接，继续配网'}`)
  }
}

// 跑一遍配网。hooks：{ onStep(index, status), isCancelled(), onLog(text) }。
// 成功 resolve { device }（老服务归一化后的设备记录）；失败 reject，error.step 为失败的步骤下标、message 为给用户看的文案。
//
// ── 配网日志（onLog，同时打控制台 [配网]；配网状态页开发版 / 体验版显示、可复制）──────────────
// 每调用一个接口都按「调用了什么 → 什么参数 → 返回了什么」三行记，前缀固定，方便对照：
//   · 「接口【接口名称】<方法> <完整地址>（出处 / 用途）」+「参数 <JSON>」+「返回 <JSON>」或「失败 HTTP <状态> code <业务码>：<文案>」
//       接口名称按当日文档：IoT【在线状态】GET /api/device/online（设备入网流程 6.1）；
//       老服务【电子纸设备列表】getUserProductList、【绑定电子纸设备】addUserProduct（在 api.bindWifiDevice 里记）；
//   · 「微信接口【名称】wx.xxx」+「参数」+「返回」：如【获取网络类型】wx.getNetworkType；
//   · 「蓝牙接口 / 蓝牙指令【名称】（帧类型 / 出处）」+「参数」+「返回」：连设备（blufi.connect）；乐鑫 BluFi 标准帧
//       【Set Opmode 设置工作模式】【STA SSID】【STA Password】【Connect to AP 连接WiFi】【Wi-Fi Connection State Report】；
//       设备通讯协议 2.2.3【设置 MQTT 配置信息】mqtt_config、2.2.4【设置WiFi国家码】wifi_set_country_code；
//   · 「蓝牙发 → / 蓝牙收 ← <十六进制>」：每一帧原始字节；「设备WiFi状态 / 设备自定义数据 / 设备报错 / 设备断开了蓝牙连接」：设备主动上报；
//   · ①~④ 开头的行是步骤分隔，「配网失败（第 N 步）：原因」「设备已绑定并上云，配网成功」是结论。
// WiFi 密码不进日志：参数里只记位数，密码帧显示「密码帧（N 字节，内容已隐藏）」；mqtt_config 的 pwd 同样打码，
// 手机发出的自定义数据帧（mqtt_config / 国家码）整帧打码。
//   · 【流程N】标签对应设备入网流程第二节的编号（2026-10-27 版），只标 App 实际执行、且参数能拿到的步骤：
//     ③ 蓝牙连接、④ 下发 WiFi、⑤ 下发 MQTT、⑥ 下发国家码、⑭ 老服务绑定、⑮ 轮询在线。
//     **只打运行时真实拿到的参数**（广播名、deviceNo、蓝牙服务 / 单帧上限、SSID、密码位数、实际下发的 opmode / MQTT 配置、
//     设备回报、接口返回）；流程文档里的示例数据（热点、灯效、MQTT 示例值、服务端 login / 心跳等）App 拿不到，不写进日志。
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
  const mac = String(job.deviceNo || '').replace(/[:\-\s]/g, '').toUpperCase()

  try {
    // ① 手机网络
    onStep(0, 'loading')
    log('① 检查手机网络')
    log('微信接口【获取网络类型】wx.getNetworkType（读手机当前网络类型，配网第 1 步「手机网络正常」，接口文档 2.4）')
    log('参数 无')
    const networkType = await getNetworkType()
    log(`返回 ${JSON.stringify({ networkType })}（none 为无网络）`)
    if (networkType === 'none') {
      throw provisionError(0, '手机网络不可用，请检查网络后重试')
    }
    onStep(0, 'done')
    checkCancel(1)

    // ② 设备网络配置
    onStep(1, 'loading')
    log('② 设备网络配置')
    // 先取 MQTT 参数：取不到就不动设备（不下发 WiFi），避免设备只收到半套配置
    log(`接口【配网 MQTT 参数】GET ${config.iotBaseURL}/api/device/provisioning/mqtt（Header userToken；取下发给设备的 MQTT 参数，pwd 不进日志）`)
    log('参数 无')
    let mqttConfig = null
    try {
      mqttConfig = await getMqttConfig()
    } catch (error) {
      log(
        `失败 HTTP ${(error && error.statusCode) || '-'} code ${error && error.code}：${(error && error.message) || error}` +
          `${error && error.serverMessage ? `（服务端 msg：${error.serverMessage}）` : ''}`
      )
      if (error && error.action === 'relogin') {
        throw provisionError(1, '登录已失效，请重新登录', error)
      }
      throw provisionError(1, '获取设备网络配置失败，请稍后重试', error)
    }
    log(`返回 ${JSON.stringify(maskMqtt(mqttConfig))}`)
    checkCancel(1)
    log('【流程③】App 蓝牙扫描 → 连接设备（BluFi）')
    log('蓝牙接口【连接设备 BluFi 会话】blufi.connect（wx.createBLEConnection → getBLEDeviceServices 找 FFFF 服务 → getBLEDeviceCharacteristics 找 FF01 写 / FF02 通知 → notifyBLECharacteristicValueChange → setBLEMTU / getBLEMTU；列表页已连上则直接复用）')
    log(`参数 ${JSON.stringify({ deviceId: job.bleDeviceId })}`)
    try {
      await bluetooth.openAdapter()
      await bluetooth.whenScanStopped()
      session = await blufi.connect(job.bleDeviceId)
    } catch (error) {
      log(`失败 ${(error && error.message) || error}`)
      throw provisionError(1, '连接设备失败，请将手机靠近设备后重试', error)
    }
    offSessionLog = hookSessionLog(session, log)
    const info = typeof session.info === 'function' ? session.info() : {}
    log(`返回 ${JSON.stringify({ serviceId: info.serviceId || '', frameLimit: info.frameLimit || '' })}（frameLimit 为单帧最大字节数）`)
    checkCancel(1)
    log('【流程④】App 下发 WiFi 信息（标准 BluFi：SSID + 密码）')
    log('蓝牙指令【下发WiFi参数】乐鑫 BluFi 标准帧：控制帧 0x02【Set Opmode 设置工作模式】→ 数据帧 0x02【STA SSID】→ 数据帧 0x03【STA Password】（设备通讯协议 2.2：BluFi 以乐鑫官方为基线）')
    log(`参数 ${JSON.stringify({ opmode: 1, ssid: job.ssid, password: `${String(job.password || '').length} 位（已隐藏）` })}`)
    try {
      await session.configureSta(job.ssid, job.password)
    } catch (error) {
      log(`失败 ${(error && error.message) || error}`)
      throw provisionError(1, '设备网络配置下发失败，请靠近设备后重试', error)
    }
    log('返回 三帧已写入（BluFi 这三条设备不单独应答）')
    log('【流程⑤】App 下发 MQTT 参数（自定义消息 mqtt_config，设备回 mqtt_config_ack，result=0 表示成功）')
    const mqttMsgid = blufi.newMsgid()
    log(`蓝牙指令【设置 MQTT 配置信息】action=mqtt_config（设备通讯协议 2.2.3；走 BluFi 自定义数据 0x13，${BLE_ACK_TIMEOUT_MS / 1000} 秒内等 mqtt_config_ack）`)
    log(`参数 ${JSON.stringify({ msgid: mqttMsgid, data: maskMqtt(mqttConfig) })}`)
    let mqttAck = null
    try {
      mqttAck = await session.request('mqtt_config', mqttConfig, BLE_ACK_TIMEOUT_MS, mqttMsgid)
    } catch (error) {
      log(`失败 ${(error && error.message) || error}`)
      throw provisionError(1, '设备未响应网络配置，请重试', error)
    }
    log(`返回 ${JSON.stringify(mqttAck)}（result=0 为成功）`)
    if (Number(mqttAck && mqttAck.result) !== 0) {
      throw provisionError(1, `设备网络配置失败（错误码 ${mqttAck && mqttAck.result}）`)
    }
    checkCancel(1)
    await sendCountryCode(session, log)
    checkCancel(1)
    // 三条指令都已下发：让设备退出配网、用下发的 WiFi 去连接（乐鑫 BluFi 控制帧 0x03）。
    // 之后设备不再接收蓝牙指令，设备侧也没有状态上报，蓝牙随即释放。
    log('蓝牙指令【Connect to AP 连接WiFi】乐鑫 BluFi 控制帧 0x03（三条指令下发完毕，设备随后退出配网并连接 WiFi）')
    log('参数 无')
    try {
      await session.connectWifi()
    } catch (error) {
      log(`失败 ${(error && error.message) || error}`)
      throw provisionError(1, '设备网络配置下发失败，请靠近设备后重试', error)
    }
    log('返回 已写入')
    onStep(1, 'done')
    offSessionLog()
    session.close()
    session = null
    log('已释放蓝牙连接')
    checkCancel(2)

    // ③ 设备连接 WiFi（设备侧无状态上报）：期间完成老服务绑定
    onStep(2, 'loading')
    log('③ 设备连接 WiFi：设备侧无状态上报，期间完成老服务绑定（绑定必须先于在线查询）')
    log(`【流程⑭】老服务绑定：deviceNo=${mac || '-'}，productId=${product.productId || '-'}`)
    let device = null
    try {
      // 绑定里会调 getUserProductList（查是否已绑）/ addUserProduct（绑定）/ getUserProductList（回查），每个接口由 onLog 记三行
      device = await api.bindWifiDevice({
        deviceNo: job.deviceNo,
        productId: product.productId,
        productName: product.productName,
        sizeModel: product.sizeModel,
        broadcastName: job.name,
        onLog: log
      })
    } catch (error) {
      log(`绑定失败：${(error && error.message) || error}`)
      throw provisionError(2, `设备绑定失败：${(error && error.message) || '请稍后重试'}`, error)
    }
    log(`绑定成功：userProductId ${(device && (device.userProductId || device.id)) || '-'}`)
    onStep(2, 'done')
    checkCancel(3)

    // ④ 轮询上云
    onStep(3, 'loading')
    log('④ 设备连接云端：轮询 IoT 在线')
    log(`【流程⑮】轮询在线：deviceNo=${mac || '-'}，online=true 即设备已上云`)
    log(`轮询在线：每 ${ONLINE_POLL_INTERVAL_MS / 1000} 秒查一次，最多 ${ONLINE_TIMEOUT_MS / 1000} 秒`)
    const deadline = Date.now() + ONLINE_TIMEOUT_MS
    let attempt = 0
    let online = false
    let lastCode = null
    while (Date.now() < deadline) {
      checkCancel(3)
      attempt += 1
      log(`接口【在线状态】GET ${config.iotBaseURL}/api/device/online（设备入网流程 6.1；Header userToken；第 ${attempt} 次查询，since 之后上线才算 online）`)
      log(`参数 ${JSON.stringify({ deviceNo: job.deviceNo, since })}`)
      try {
        const res = await iotApi.getDeviceOnline(job.deviceNo, since, { showError: false })
        log(`返回 ${JSON.stringify(res)}`)
        lastCode = null
        if (res && res.online) {
          online = true
          break
        }
      } catch (error) {
        lastCode = error && error.code
        log(
          `失败 HTTP ${(error && error.statusCode) || '-'} code ${error && error.code}：${(error && error.message) || error}` +
            `${error && error.serverMessage ? `（服务端 msg：${error.serverMessage}）` : ''}` +
            `${error && error.action === 'relogin' ? '，登录失效，停止轮询' : '，继续轮询'}`
        )
        if (error && error.action === 'relogin') {
          throw provisionError(3, '登录已失效，请重新登录', error)
        }
        // 503（权限服务暂不可用）/ 403 / 网络抖动：不算失败，继续轮询
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
    log('设备已绑定并上云，配网成功')
    return { device }
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
