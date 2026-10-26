// BluFi（乐鑫 ESP32 蓝牙配网）协议与会话（2026-10-26，WiFi 版设备配网 STEP 2）。
//
// 设备与手机的蓝牙通信只在配网阶段使用，消息格式以乐鑫官方 BluFi（EspBlufi demo）为基线：
//   服务 0xFFFF；手机写 0xFF01，设备通知 0xFF02（与蓝牙版 FF00 主服务下的 FF01/FF02 同名不同服务，
//   这里只认 FFFF 服务下的特征）。
//
// 帧格式：type(1) | frameCtrl(1) | seq(1) | dataLen(1) | data(dataLen) | [checksum(2)]
//   · type 低 2 位：0 控制帧 / 1 数据帧；高 6 位：子类型；
//   · frameCtrl：bit0 加密、bit1 校验、bit2 方向（1=设备→手机）、bit3 要求应答、bit4 分片；
//   · seq：手机发出的每一帧递增（每条连接从 0 开始，设备按序校验，错一个整条会话作废）；
//   · 分片：带 bit4 的帧 data 前 2 字节是「剩余总长度」（小端），设备按首片的长度收齐。
//
// 本期不做安全协商（DH + AES，产品 2026-10-26 确认先不加密），也不加校验：与 EspBlufi 未协商时的行为一致，
// WiFi 密码以明文经蓝牙下发。固件若强制加密，需在这里补 DH 协商。
//
// 自定义数据（数据帧子类型 0x13）承载协议文档 2.2 的 JSON 消息（如 mqtt_config / mqtt_config_ack）。
//
// 设备扫描附近 WiFi（2026-10-26）：手机发控制帧 0x09，设备扫描后回数据帧 0x11（WiFi 列表），
// 每项为 len(1) | rssi(1，有符号 dBm) | ssid(len-1)。配网 WiFi 列表页用它代替手机自己扫（iOS 拿不到列表、
// 手机扫的也不一定是设备那边收得到的网络）；ESP32 只支持 2.4G，设备扫出来的天然就是 2.4G。
const notifyHub = require('./ble-notify-hub')

const SERVICE_UUID = 'FFFF'
const WRITE_UUID = 'FF01'
const NOTIFY_UUID = 'FF02'

const FRAME_CTRL = 0
const FRAME_DATA = 1

const CTRL = {
  ACK: 0x00,
  SET_OPMODE: 0x02,
  CONNECT_WIFI: 0x03,
  GET_WIFI_STATUS: 0x05,
  DISCONNECT_BLE: 0x08,
  GET_WIFI_LIST: 0x09
}

const DATA = {
  STA_SSID: 0x02,
  STA_PASSWORD: 0x03,
  WIFI_STATE: 0x0f,
  ERROR: 0x12,
  CUSTOM: 0x13,
  STA_END_REASON: 0x15,
  STA_RSSI: 0x16,
  WIFI_LIST: 0x11
}

const FC = {
  ENCRYPTED: 0x01,
  CHECKSUM: 0x02,
  DIR_DEVICE: 0x04,
  REQUIRE_ACK: 0x08,
  FRAG: 0x10
}

const OPMODE_STA = 0x01

// WiFi 连接状态报告里的 STA 状态（ESP_BLUFI_STA_CONN_*）
const STA_STATE = {
  CONNECTED: 0x00, // 已连上并拿到 IP
  FAIL: 0x01, // 重试用尽仍连不上
  CONNECTING: 0x02,
  NO_IP: 0x03
}

// 设备报错（数据帧 0x12）的错误码，按乐鑫 ESP-IDF esp_blufi_error_state_t
const ERROR_TEXT = {
  0: '序号错误',
  1: '校验错误',
  2: '解密错误',
  3: '加密错误',
  4: '安全初始化错误',
  5: 'DH 内存分配错误',
  6: 'DH 参数错误',
  7: '读取参数错误',
  8: '生成公钥错误',
  9: '数据格式错误',
  10: 'MD5 计算错误',
  11: 'WiFi 扫描失败',
  12: '消息状态错误'
}

function errorText(code) {
  return ERROR_TEXT[code] || '未知错误'
}

// 默认 MTU 23 时单帧最多 20 字节；协商到更大 MTU 后按 MTU-3 算，帧内 data 最多 255
const DEFAULT_FRAME_LIMIT = 20
const HEADER_LENGTH = 4
const WRITE_GAP_MS = 20
const CONNECT_TIMEOUT_MS = 10000

// ── 纯函数部分（可单测） ─────────────────────────────────────────

// UTF-8 编码 / 解码（小程序没有 TextEncoder）
function utf8Encode(text) {
  const out = []
  const str = String(text == null ? '' : text)
  for (let i = 0; i < str.length; i++) {
    let code = str.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
      const low = str.charCodeAt(i + 1)
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00)
        i++
      }
    }
    if (code < 0x80) {
      out.push(code)
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
    } else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f)
      )
    }
  }
  return out
}

function utf8Decode(bytes) {
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]
    let code = b
    if (b >= 0xf0 && i + 3 < bytes.length) {
      code = ((b & 0x07) << 18) | ((bytes[i + 1] & 0x3f) << 12) | ((bytes[i + 2] & 0x3f) << 6) | (bytes[i + 3] & 0x3f)
      i += 3
    } else if (b >= 0xe0 && i + 2 < bytes.length) {
      code = ((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f)
      i += 2
    } else if (b >= 0xc0 && i + 1 < bytes.length) {
      code = ((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f)
      i += 1
    }
    if (code >= 0x10000) {
      code -= 0x10000
      out += String.fromCharCode(0xd800 + (code >> 10), 0xdc00 + (code & 0x3ff))
    } else {
      out += String.fromCharCode(code)
    }
  }
  return out
}

function typeByte(isData, subtype) {
  return ((subtype & 0x3f) << 2) | (isData ? FRAME_DATA : FRAME_CTRL)
}

// 把一条消息编成若干帧（必要时分片）。seqStart：第一帧的序号；frameLimit：单帧最大字节数（MTU-3）。
// 返回 Uint8Array 数组，第 i 帧的序号是 seqStart + i（按 256 回绕）。
function encodeFrames(isData, subtype, payload, seqStart, frameLimit) {
  const bytes = Array.from(payload || [])
  const maxData = Math.min(255, Math.max(HEADER_LENGTH + 2, (frameLimit || DEFAULT_FRAME_LIMIT) - HEADER_LENGTH))
  const type = typeByte(isData, subtype)
  const frames = []
  const build = (fc, data) => {
    const seq = (seqStart + frames.length) & 0xff
    frames.push(Uint8Array.from([type, fc, seq, data.length].concat(data)))
  }
  if (bytes.length <= maxData) {
    build(0, bytes)
    return frames
  }
  let offset = 0
  while (offset < bytes.length) {
    const remain = bytes.length - offset
    if (remain <= maxData) {
      build(0, bytes.slice(offset))
      break
    }
    const chunk = maxData - 2
    build(FC.FRAG, [remain & 0xff, (remain >> 8) & 0xff].concat(bytes.slice(offset, offset + chunk)))
    offset += chunk
  }
  return frames
}

// 设备 → 手机的解帧器：喂入一帧原始字节，消息收齐时返回 { isData, subtype, data }，分片中途返回 null。
// 设备帧末尾若带校验（bit1），校验字节在 dataLen 之外，按长度截取即自然去掉。
function createDecoder() {
  let pending = null
  return function push(raw) {
    const bytes = Array.from(raw || [])
    if (bytes.length < HEADER_LENGTH) {
      return null
    }
    const type = bytes[0]
    const fc = bytes[1]
    const length = bytes[3]
    let data = bytes.slice(HEADER_LENGTH, HEADER_LENGTH + length)
    if (fc & FC.ENCRYPTED) {
      // 本期不协商密钥，设备不该发加密帧；收到就当作无法解析
      return { isData: (type & 0x03) === FRAME_DATA, subtype: type >> 2, data: [], encrypted: true }
    }
    if (fc & FC.FRAG) {
      pending = (pending || []).concat(data.slice(2))
      return null
    }
    if (pending) {
      data = pending.concat(data)
      pending = null
    }
    return { isData: (type & 0x03) === FRAME_DATA, subtype: type >> 2, data }
  }
}

// WiFi 连接状态报告：opmode | staState | softapConnNum | TLV(type, len, value)…
function parseWifiState(data) {
  const bytes = Array.from(data || [])
  const state = {
    opmode: bytes[0],
    staState: bytes[1],
    softapConnNum: bytes[2],
    ssid: '',
    endReason: null,
    rssi: null
  }
  let i = 3
  while (i + 1 < bytes.length) {
    const type = bytes[i]
    const len = bytes[i + 1]
    const value = bytes.slice(i + 2, i + 2 + len)
    if (type === DATA.STA_SSID) {
      state.ssid = utf8Decode(value)
    } else if (type === DATA.STA_END_REASON && value.length) {
      state.endReason = value[0]
    } else if (type === DATA.STA_RSSI && value.length) {
      state.rssi = value[0] > 127 ? value[0] - 256 : value[0]
    }
    i += 2 + len
  }
  return state
}

function toHex(bytes) {
  return Array.from(bytes || [])
    .map(b => (b < 16 ? '0' : '') + b.toString(16).toUpperCase())
    .join(' ')
}

// 设备回的 WiFi 列表：len | rssi | ssid(len-1) 依次排列。长度不合法的残尾丢弃。
// 乐鑫标准格式**只有 SSID 和 RSSI**，没有信道 / 频率（ESP32 绝大多数型号只支持 2.4G，扫到的本来就是 2.4G）。
// 每项另带 len 与原始字节 raw（十六进制），数组上挂 rawHex（整包）/ tailHex（解析不了的残尾），
// 联调时核对固件有没有在标准格式之外追加字段。
function parseWifiList(data) {
  const bytes = Array.from(data || [])
  const list = []
  let i = 0
  while (i < bytes.length) {
    const len = bytes[i]
    if (!len || i + 1 + len > bytes.length) {
      break
    }
    const rssi = bytes[i + 1] > 127 ? bytes[i + 1] - 256 : bytes[i + 1]
    list.push({
      ssid: utf8Decode(bytes.slice(i + 2, i + 1 + len)),
      rssi,
      len,
      raw: toHex(bytes.slice(i, i + 1 + len))
    })
    i += 1 + len
  }
  list.rawHex = toHex(bytes)
  list.tailHex = toHex(bytes.slice(i))
  return list
}

// 自定义数据里的 JSON 消息。协议文档表格写的是 date / ack_msg id，示例写的是 data / ack_msgid，两种都认。
function parseCustom(data) {
  const text = utf8Decode(data)
  let json = null
  try {
    json = JSON.parse(text)
  } catch (error) {
    json = null
  }
  if (!json || typeof json !== 'object') {
    return { text, action: '', body: {}, ackMsgid: '' }
  }
  const body = json.data || json.date || {}
  return {
    text,
    action: String(json.action || ''),
    body,
    ackMsgid: String(body.ack_msgid || body.ackMsgid || body.ack_msg_id || '')
  }
}

// ── 会话部分（真机） ─────────────────────────────────────────────

const sessions = {}
let hubBound = false

function matchUuid(uuid, shortCode) {
  const norm = String(uuid || '').toUpperCase().replace(/-/g, '')
  return norm.slice(4, 8) === shortCode || norm === shortCode
}

function wxp(fn, options) {
  return new Promise((resolve, reject) => {
    fn(
      Object.assign({}, options, {
        success: resolve,
        fail: error => {
          const err = new Error((error && error.errMsg) || '蓝牙操作失败')
          err.errCode = error && error.errCode
          reject(err)
        }
      })
    )
  })
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function emit(session, type, payload) {
  ;(session.listeners[type] ? Array.from(session.listeners[type]) : []).forEach(handler => {
    try {
      handler(payload)
    } catch (error) {
      console.warn('[BluFi] listener error', type, error)
    }
  })
}

function handleMessage(session, message) {
  if (message.encrypted) {
    emit(session, 'deviceError', { code: -1, message: '设备要求加密通信，当前版本暂不支持' })
    return
  }
  if (!message.isData) {
    emit(session, 'ctrl', { subtype: message.subtype, data: message.data })
    return // 控制帧（ACK 等）配网流程不需要处理，只给联调日志
  }
  if (message.subtype === DATA.WIFI_LIST) {
    const list = parseWifiList(message.data)
    console.log('[BluFi] 设备扫描到 WiFi', list.length, '个，原始回包', list.rawHex, list.tailHex ? `残尾 ${list.tailHex}` : '')
    emit(session, 'wifiList', list)
  } else if (message.subtype === DATA.WIFI_STATE) {
    const state = parseWifiState(message.data)
    console.log('[BluFi] WiFi 状态', JSON.stringify(state))
    emit(session, 'wifiState', state)
  } else if (message.subtype === DATA.CUSTOM) {
    const custom = parseCustom(message.data)
    console.log('[BluFi] 自定义数据', custom.text)
    emit(session, 'custom', custom)
  } else if (message.subtype === DATA.ERROR) {
    const code = message.data.length ? message.data[0] : -1
    console.warn('[BluFi] 设备报错', code, errorText(code))
    emit(session, 'deviceError', { code, message: `设备返回错误 ${code}：${errorText(code)}` })
  }
}

function bindHub() {
  if (hubBound) {
    return
  }
  hubBound = true
  notifyHub.subscribe('blufi', {
    onValueChange: res => {
      const session = sessions[res.deviceId]
      if (!session || !matchUuid(res.characteristicId, NOTIFY_UUID)) {
        return // 非 BluFi 会话（蓝牙版 FF00、OTA FF10）一律不管
      }
      const bytes = new Uint8Array(res.value || new ArrayBuffer(0))
      emit(session, 'frame', { dir: 'rx', hex: toHex(bytes) })
      const message = session.decoder(bytes)
      if (message) {
        handleMessage(session, message)
      }
    },
    onStateChange: res => {
      const session = sessions[res.deviceId]
      if (session && !res.connected) {
        delete sessions[res.deviceId]
        session.closed = true
        emit(session, 'disconnect', {})
      }
    }
  })
}

async function findService(deviceId) {
  // 安卓上 createBLEConnection 成功后服务常常还没就绪，多试几次
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await wxp(wx.getBLEDeviceServices, { deviceId })
    const service = (res.services || []).find(item => matchUuid(item.uuid, SERVICE_UUID))
    if (service) {
      return service.uuid
    }
    await sleep(300)
  }
  throw new Error('未找到设备的配网服务')
}

async function negotiateFrameLimit(deviceId) {
  let mtu = 0
  if (wx.setBLEMTU) {
    try {
      const res = await wxp(wx.setBLEMTU, { deviceId, mtu: 247 })
      mtu = (res && res.mtu) || 0
    } catch (error) {
      // iOS 不支持手动设置，读下面的实际值
    }
  }
  if (wx.getBLEMTU) {
    try {
      const res = await wxp(wx.getBLEMTU, { deviceId, writeType: 'write' })
      if (res && res.mtu >= 23) {
        mtu = mtu ? Math.min(mtu, res.mtu) : res.mtu
      }
    } catch (error) {
      // 读不到按默认 23
    }
  }
  return mtu >= 23 ? mtu - 3 : DEFAULT_FRAME_LIMIT
}

// 建立 BluFi 会话：连接 → 找 FFFF 服务与 FF01/FF02 → 打开通知 → 协商 MTU。返回会话对象。
async function connect(deviceId) {
  if (!deviceId) {
    throw new Error('缺少设备蓝牙标识')
  }
  bindHub()
  const existing = sessions[deviceId]
  if (existing && !existing.closed) {
    return existing.api
  }
  try {
    await wxp(wx.createBLEConnection, { deviceId, timeout: CONNECT_TIMEOUT_MS })
  } catch (error) {
    // -1 / 10010 等「已连接」类错误按已连上继续；其余失败先把半开的连接收掉再抛
    if (!/already connect/i.test(error.message)) {
      if (wx.closeBLEConnection) {
        wx.closeBLEConnection({ deviceId, fail() {} })
      }
      throw error
    }
  }
  try {
    return await setupSession(deviceId)
  } catch (error) {
    // 半路失败：会话作废并断开，别让一条半开的连接占着设备（设备被占时不广播，重试会搜不到）
    delete sessions[deviceId]
    if (wx.closeBLEConnection) {
      wx.closeBLEConnection({ deviceId, fail() {} })
    }
    throw error
  }
}

async function setupSession(deviceId) {
  const serviceId = await findService(deviceId)
  const chars = await wxp(wx.getBLEDeviceCharacteristics, { deviceId, serviceId })
  const list = chars.characteristics || []
  const write = list.find(item => matchUuid(item.uuid, WRITE_UUID))
  const notify = list.find(item => matchUuid(item.uuid, NOTIFY_UUID))
  if (!write || !notify) {
    throw new Error('设备配网特征不完整')
  }
  const session = {
    deviceId,
    serviceId,
    writeId: write.uuid,
    notifyId: notify.uuid,
    seq: 0,
    frameLimit: DEFAULT_FRAME_LIMIT,
    decoder: createDecoder(),
    listeners: {},
    closed: false,
    sending: Promise.resolve()
  }
  sessions[deviceId] = session
  await wxp(wx.notifyBLECharacteristicValueChange, {
    deviceId,
    serviceId,
    characteristicId: notify.uuid,
    state: true
  })
  session.frameLimit = await negotiateFrameLimit(deviceId)
  session.api = createApi(session)
  return session.api
}

function writeFrames(session, isData, subtype, payload) {
  // 串行发送：序号必须严格按发出顺序递增，并发写会让设备收到乱序帧
  const run = session.sending.then(async () => {
    if (session.closed) {
      throw new Error('设备蓝牙连接已断开')
    }
    const frames = encodeFrames(isData, subtype, payload, session.seq, session.frameLimit)
    for (let i = 0; i < frames.length; i++) {
      emit(session, 'frame', { dir: 'tx', hex: toHex(frames[i]) })
      await wxp(wx.writeBLECharacteristicValue, {
        deviceId: session.deviceId,
        serviceId: session.serviceId,
        characteristicId: session.writeId,
        value: frames[i].buffer
      })
      session.seq = (session.seq + 1) & 0xff
      await sleep(WRITE_GAP_MS)
    }
  })
  session.sending = run.catch(() => {})
  return run
}

function on(session, type, handler) {
  if (!session.listeners[type]) {
    session.listeners[type] = new Set()
  }
  session.listeners[type].add(handler)
  return () => session.listeners[type].delete(handler)
}

// 等第一条满足 predicate 的事件；超时 resolve(null)，不抛错（调用方自己决定超时算不算失败）
function waitFor(session, type, predicate, timeout) {
  return new Promise(resolve => {
    let timer = null
    const off = on(session, type, payload => {
      if (!predicate || predicate(payload)) {
        clearTimeout(timer)
        off()
        resolve(payload)
      }
    })
    timer = setTimeout(() => {
      off()
      resolve(null)
    }, timeout)
  })
}

function createApi(session) {
  return {
    deviceId: session.deviceId,
    on: (type, handler) => on(session, type, handler),
    waitFor: (type, predicate, timeout) => waitFor(session, type, predicate, timeout),

    // 下发 WiFi：STA 模式 → SSID → 密码（EspBlufi 配网顺序）
    async configureSta(ssid, password) {
      await writeFrames(session, false, CTRL.SET_OPMODE, [OPMODE_STA])
      await writeFrames(session, true, DATA.STA_SSID, utf8Encode(ssid))
      await writeFrames(session, true, DATA.STA_PASSWORD, utf8Encode(password))
    },

    // 让设备用已下发的 WiFi 去连接
    connectWifi() {
      return writeFrames(session, false, CTRL.CONNECT_WIFI, [])
    },

    // 会话参数（联调日志用）
    info() {
      return { deviceId: session.deviceId, serviceId: session.serviceId, frameLimit: session.frameLimit }
    },

    // 让设备扫描附近 WiFi：先把设备切到 STA 模式（0x02，设备 WiFi 没起在 STA 时乐鑫的扫描会直接失败），
    // 再发 0x09，等设备回 0x11 列表。
    //   · 收到列表 → resolve(list)；
    //   · 设备回错误报告（0x12，如 11「WiFi 扫描失败」）→ reject，error.code 为设备错误码；
    //   · 超时 → resolve(null)：固件不支持，或乐鑫示例在一个网络都没扫到时什么都不回。
    async scanWifi(timeout) {
      let offError = null
      const failed = new Promise((resolve, reject) => {
        offError = on(session, 'deviceError', detail => {
          const error = new Error(detail.message)
          error.code = detail.code
          reject(error)
        })
      })
      const wait = waitFor(session, 'wifiList', null, timeout || 12000)
      try {
        await writeFrames(session, false, CTRL.SET_OPMODE, [OPMODE_STA])
        await writeFrames(session, false, CTRL.GET_WIFI_LIST, [])
        return await Promise.race([wait, failed])
      } finally {
        offError()
      }
    },

    requestWifiStatus() {
      return writeFrames(session, false, CTRL.GET_WIFI_STATUS, [])
    },

    // 协议 2.2 的 JSON 指令：发 { msgid, action, data }，等 `${action}_ack`（按 ack_msgid 对上；设备没回 ack_msgid 时按 action 认）。
    // 超时 reject。返回应答的 data（含 result）。
    async request(action, data, timeout) {
      const msgid = String(Date.now())
      const wait = waitFor(
        session,
        'custom',
        message => message.action === `${action}_ack` && (!message.ackMsgid || message.ackMsgid === msgid),
        timeout || 10000
      )
      await writeFrames(session, true, DATA.CUSTOM, utf8Encode(JSON.stringify({ msgid, action, data })))
      const reply = await wait
      if (!reply) {
        throw new Error(`设备未应答 ${action}`)
      }
      return reply.body
    },

    close() {
      if (session.closed) {
        return
      }
      session.closed = true
      delete sessions[session.deviceId]
      if (wx.closeBLEConnection) {
        wx.closeBLEConnection({ deviceId: session.deviceId, fail() {} })
      }
    }
  }
}

module.exports = {
  CTRL,
  DATA,
  FC,
  STA_STATE,
  errorText,
  utf8Encode,
  utf8Decode,
  encodeFrames,
  createDecoder,
  parseWifiState,
  parseCustom,
  parseWifiList,
  connect
}
