// 设备固件 OTA(DFU) 升级会话层 —— 依据《产品需求规格书》6.3.2 / 6.3.3 的自定义 DFU 协议实现。
// 与图传(FF00 主服务、0xAA 串行帧)完全无关：OTA 走独立的 OTA 服务 FF10。
// v1.4 文档定义 FF11 为控制特征、FF12 为数据特征；旧固件若只暴露 FF11，则回退为单特征收发。
//
// 协议要点：
//   1) 校验：每个 APP→设备的包，末尾 1 字节累加校验 checksum = 前面所有字节之和 & 0xFF（不是 CRC16）。
//   2) START(0xF1)：OBJ_TYPE(1) + FW_SIZE(4,小端) + checksum → 设备回 ACK，带 MTU(251) 与 PRN(3)。
//   3) DATA (0xF2)：PKT_SEQ(2,小端) + DATA + checksum。每发 PRN 个包等一次设备 DATA ACK，
//      ACK 带「已连续收到的最后包号」。包号没往前走 = 那一包丢了，从 ACK 包号 + 1 重发。
//   4) APP 不发 END：设备自行累计到固件大小后，自动算 CRC32、校验、写 BootSetting，回 0xF3 最终结果，
//      约 100ms 后重启跑新固件。
//
// 真机注意（开发者工具蓝牙模拟不可靠，务必真机联调，工具内可用 dryRun 校验编码）：
//   - 安卓默认 ATT MTU 仅 23（单次可写 20 字节），必须 wx.setBLEMTU 拉高，否则 244 字节 DATA 包写不进；
//     iOS 由系统自动协商。每包数据大小按真实协商到的 MTU 动态算（MTU - 3 ATT头 - 4 帧开销）。
//   - FF11 用 writeType:'writeNoResponse'，且需先 notifyBLECharacteristicValueChange 打开通知。
//
// 待与固件最终对齐的点（已就近标注 OTA_TODO，真机抓包后核对）：
//   a) FF11 特征的真实 128 位 UUID（连接时会打印实际值）；
//   b) START 帧 OBJ_TYPE 的确切取值（此处默认 0x00）；
//   c) START/DATA ACK 已按 §6.3.3 对齐（帧头 0xFC + 回显操作码）；唯 0xF3 最终结果的 RESULT 偏移待真机确认。

const imageCodec = require('./image-codec')

// ── 协议常量 ──────────────────────────────────────────────
const OTA_SERVICE_UUID = 'FF10'
const OTA_CHAR_CONTROL_UUID = 'FF11'
const OTA_CHAR_DATA_UUID = 'FF12'
const OTA_CHAR_ALT_CONTROL_UUID = 'FF13'
const OTA_CHAR_UUID = OTA_CHAR_CONTROL_UUID // 兼容旧导出名

const OP = {
  START: 0xf1, // APP→设备：开始
  DATA: 0xf2, // APP→设备：固件数据 / 设备→APP：DATA ACK（回已连续接收包号）
  RESULT: 0xf3, // 设备→APP：最终结果（CRC32 校验 + 写 BootSetting 之后）
  ACK: 0xfc // 设备→APP：START / DATA 应答的帧头(RSP_OPCODE)，后跟被应答的操作码(0xF1/0xF2)
}

// OTA_TODO(b)：START 帧的对象类型。文档只写「当前作为固件对象使用」，未给确切数值，默认 0x00。
const OBJ_TYPE_FIRMWARE = 0x00
const DEFAULT_PRN = 3 // 信用窗口：每发这么多包等一次 DATA ACK
const DEFAULT_DEVICE_MTU = 251 // 设备声明支持的 MTU；真实可写量仍以协商结果为准
// 固件大小合法范围（6.3.x）：0x3000 ~ 0x3C000（约 12KB ~ 240KB）。越界只告警不强拦，最终以设备应答为准。
const MIN_FW_SIZE = 0x3000
const MAX_FW_SIZE = 0x3c000

// OTA 结果码 → 中文（规格书 §6.3.2 OTA 专用码表，与图传 0x7F 通用应答码表不同！）。
// 未知码回落十六进制原文，遵循「设备返回什么提示什么」。
const OTA_RESULT_TEXT = {
  0x00: '成功',
  0x01: '校验/芯片信息错误',
  0x02: 'ACK 超时',
  0x03: '主机主动终止',
  0x04: '设备主动终止',
  0x05: '设备状态错误',
  0x06: '不支持的 opcode',
  0x07: '资源不足',
  0x08: '固件大小超限',
  0x09: '参数错误'
}

function otaResultText(code) {
  const text = OTA_RESULT_TEXT[code]
  return text || `设备返回错误码 0x${(code & 0xff).toString(16).padStart(2, '0')}`
}

// 每台设备一个 OTA 会话；与 device-ble 的 FF00 会话互不影响（各自过滤 deviceId/特征）。
const sessions = {}
let globalListenerBound = false

// 收发监听器：联调时把每帧 16 进制原始字节打印出来，与硬件日志对照（OTA 调试页/上层可注入）。
let monitor = null

function setMonitor(fn) {
  monitor = typeof fn === 'function' ? fn : null
}

function reportFrame(dir, deviceId, bytes, note) {
  if (!monitor) {
    return
  }
  try {
    monitor({ dir, deviceId, hex: bytesToHex(bytes), note: note || '', time: Date.now() })
  } catch (error) {
    // 监听器自身异常不能影响蓝牙收发
  }
}

// ── 基础工具 ──────────────────────────────────────────────
function wxp(fn, options) {
  return new Promise((resolve, reject) => {
    fn(
      Object.assign({}, options, {
        success: resolve,
        fail: error => reject(new Error((error && error.errMsg) || '蓝牙操作失败'))
      })
    )
  })
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function bytesToHex(input) {
  return Array.from(input || [])
    .map(b => (b & 0xff).toString(16).padStart(2, '0').toUpperCase())
    .join(' ')
}

// 微信返回的是 128 位全 UUID（如 0000FF11-0000-...），匹配时取去横杠后第 5-8 个字符的 16 位短码；
// 也兼容设备直接上报 16 位短 UUID（"FF11"/"0000FF11"）。
function matchUuid(uuid, shortCode) {
  const code = String(shortCode || '').toUpperCase()
  const norm = String(uuid || '')
    .toUpperCase()
    .replace(/-/g, '')
  return norm.slice(4, 8) === code || norm === code
}

function toArrayBuffer(bytes) {
  return new Uint8Array(bytes).buffer
}

// 1 字节累加校验：前面所有字节之和 & 0xFF。
function checksum8(bytes) {
  let sum = 0
  for (let i = 0; i < bytes.length; i++) {
    sum += bytes[i] & 0xff
  }
  return sum & 0xff
}

// 给一帧追加 1 字节累加校验，返回新数组。
function withChecksum(bytes) {
  const out = bytes.slice()
  out.push(checksum8(out))
  return out
}

function readUint16LE(bytes, offset) {
  return ((bytes[offset] | (bytes[offset + 1] << 8)) >>> 0)
}

// 选写类型：FF11 文档为 Write Without Response，优先无应答写。
function pickWriteType(char) {
  const props = (char && char.properties) || {}
  if (props.writeNoResponse) {
    return 'writeNoResponse'
  }
  return props.write ? 'write' : ''
}

function writeTypeVariants(char) {
  const props = (char && char.properties) || {}
  const list = []
  if (props.writeNoResponse) {
    list.push('writeNoResponse')
  }
  if (props.write) {
    list.push('write')
  }
  return list
}

function isUnsupportedWriteError(error) {
  const message = ((error && error.message) || '').toLowerCase()
  return (
    message.indexOf('10007') > -1 ||
    message.indexOf('not support') > -1 ||
    message.indexOf('property') > -1 ||
    message.indexOf('characteristics error') > -1
  )
}

// 由 MTU 推算每个 DATA 包能装的固件字节数：
//   单次可写 = MTU - 3(ATT 头)；DATA 帧固定开销 = 4（操作码1 + 包序号2 + 校验1）。
// 上限 244（MTU=251 时 248-4=244，见文档）。OTA_TODO(c)：若固件要求 OTA 固定包长，把这里改成定值。
function chunkFromMtu(mtu) {
  const writable = Math.max(20, (mtu || DEFAULT_DEVICE_MTU) - 3)
  return Math.max(1, Math.min(244, writable - 4))
}

// ── 组帧 ──────────────────────────────────────────────────
function buildStartFrame(size, objType) {
  return withChecksum([
    OP.START,
    objType & 0xff,
    size & 0xff,
    (size >> 8) & 0xff,
    (size >> 16) & 0xff,
    (size >>> 24) & 0xff
  ])
}

function buildDataFrame(seq, chunk) {
  const head = [OP.DATA, seq & 0xff, (seq >> 8) & 0xff]
  for (let i = 0; i < chunk.length; i++) {
    head.push(chunk[i] & 0xff)
  }
  return withChecksum(head)
}

// ── 解帧（设备 → APP，字段布局依规格书 §6.3.3）───────────────
// START ACK 权威布局：[0xFC(帧头), 0xF1(回显START), RESULT, MTU(1,=251), PRN(1), checksum]。
//   —— 早期版本把帧头 0xFC 误当错误码、又把 MTU 当 2 字节小端读，导致合法应答被判为无效而丢弃、START 超时。
// 兼容「不带 0xFC 帧头、直接回显 0xF1」的旧固件。MTU/PRN 越界则回落 0，由 applyStartAck 用默认值兜底。
function parseStartAck(bytes) {
  let i = 0
  if (bytes[i] === OP.ACK) {
    i += 1 // 跳过应答帧头 0xFC
  }
  if (bytes[i] === OP.START) {
    i += 1 // 跳过回显的 START 操作码 0xF1
  }
  const result = bytes.length > i ? bytes[i] & 0xff : 0xff
  let mtu = bytes.length > i + 1 ? bytes[i + 1] & 0xff : 0
  let prn = bytes.length > i + 2 ? bytes[i + 2] & 0xff : 0
  if (!(mtu >= 23 && mtu <= 517)) {
    mtu = 0
  }
  if (!(prn >= 1 && prn <= 64)) {
    prn = 0
  }
  const valid = bytes[0] === OP.ACK || bytes[0] === OP.START
  return {
    result,
    mtu,
    prn,
    valid,
    rawHex: bytesToHex(bytes)
  }
}

// DATA ACK 权威布局(§6.3.3)：[0xFC(帧头), 0xF2(回显DATA), RESULT, SEQ(2,小端), checksum]，
// SEQ 在偏移 3；兼容旧固件 [0xF2, SEQ(2,小端), checksum]（偏移 1）。取「已连续接收的最后包号」。
function parseDataAckSeq(bytes) {
  const offset = bytes[0] === OP.ACK ? 3 : 1
  return readUint16LE(bytes, offset)
}

// 0xF3 最终结果：[0xF3, RESULT, checksum]，或带 0xFC 帧头 [0xFC, 0xF3, RESULT, checksum]。
// ⚠️ 规格书时序图疑似在 0xF3 后另有 1 字节子操作码再到 RESULT——真机抓一帧确认后再调整偏移。
function parseResult(bytes) {
  const offset = bytes[0] === OP.ACK ? 2 : 1
  return { result: bytes.length > offset ? bytes[offset] & 0xff : 0xff }
}

// ── 连接 / 会话 ────────────────────────────────────────────
function ensureGlobalListener() {
  if (globalListenerBound) {
    return
  }
  globalListenerBound = true

  if (wx.onBLECharacteristicValueChange) {
    wx.onBLECharacteristicValueChange(res => {
      const session = sessions[res.deviceId]
      if (!session || !isSessionCharacteristic(session, res.characteristicId)) {
        return // 非本模块管理的设备/特征（如 FF00 图传通知）一律忽略
      }
      const bytes = Array.from(new Uint8Array(res.value || new ArrayBuffer(0)))
      reportFrame('RX', res.deviceId, bytes, res.characteristicId)
      dispatchNotification(session, bytes)
    })
  }

  if (wx.onBLEConnectionStateChange) {
    wx.onBLEConnectionStateChange(res => {
      if (!res.connected) {
        cleanupSession(res.deviceId, '设备连接已断开')
      }
    })
  }
}

function isSessionCharacteristic(session, characteristicId) {
  return (
    characteristicId === session.controlCharId ||
    characteristicId === session.dataCharId ||
    characteristicId === session.altControlCharId ||
    characteristicId === session.charId ||
    (session.notifyCharIds || []).indexOf(characteristicId) > -1
  )
}

// 把一条通知派发到等待者：START ACK / DATA ACK / 最终结果。
// 设备应答帧头是 0xFC(RSP_OPCODE)，被应答的操作码回显在第 2 字节；据此区分 START/DATA ACK。
// 兼容「不带 0xFC 帧头、直接以操作码打头」的旧固件（echo 退回 bytes[0]）。
function dispatchNotification(session, bytes) {
  if (!bytes.length) {
    return
  }
  const echo = bytes[0] === OP.ACK ? bytes[1] : bytes[0]

  // START ACK：回显 0xF1；或正等 START 应答且不是 DATA/最终结果，也按 START ACK 解析。
  if (echo === OP.START || (session.startWaiter && echo !== OP.DATA && echo !== OP.RESULT)) {
    const ack = parseStartAck(bytes)
    if (!ack.valid) {
      console.warn('[OTA] 忽略无法识别的应答帧：', ack.rawHex)
      return
    }
    if (session.startWaiter) {
      const waiter = session.startWaiter
      session.startWaiter = null
      waiter(ack)
    }
    return
  }

  // 最终结果 0xF3（设备收齐后自算 CRC32 主动上报）
  if (echo === OP.RESULT) {
    session.finalResult = parseResult(bytes)
    wakeWaiters(session)
    return
  }

  // DATA ACK：回显 0xF2
  if (echo === OP.DATA) {
    const seq = parseDataAckSeq(bytes)
    if (seq > session.lastAckSeq) {
      session.lastAckSeq = seq
    }
    wakeWaiters(session)
  }
}

function wakeWaiters(session) {
  session.ackWaiters.splice(0).forEach(wake => wake())
}

// 清理会话：让在等的请求立刻失败，移除缓存（不主动 closeBLEConnection，断开回调场景下连接已没了）。
function cleanupSession(deviceId, reason) {
  const session = sessions[deviceId]
  if (!session) {
    return
  }
  session.ready = false
  session.aborted = reason || '连接已断开'
  wakeWaiters(session)
  if (session.startWaiter) {
    const waiter = session.startWaiter
    session.startWaiter = null
    waiter(null)
  }
  delete sessions[deviceId]
}

async function negotiateMtu(deviceId) {
  let mtu = 0

  if (wx.setBLEMTU) {
    try {
      const res = await wxp(wx.setBLEMTU, { deviceId, mtu: DEFAULT_DEVICE_MTU })
      if (res && res.mtu) {
        mtu = res.mtu
      }
    } catch (error) {
      // iOS 不支持手动设置，走下面的读取/兜底
    }
  }

  if (!mtu && wx.getBLEMTU) {
    try {
      const res = await wxp(wx.getBLEMTU, { deviceId, writeType: 'writeNoResponse' })
      if (res && res.mtu) {
        mtu = res.mtu
      }
    } catch (error) {
      // 读不到就用兜底值
    }
  }

  return mtu || 185
}

async function createConnectionWithRetry(deviceId, attempts = 2) {
  let lastError = null
  for (let i = 0; i < attempts; i++) {
    try {
      await wxp(wx.createBLEConnection, { deviceId, timeout: 10000 })
      return
    } catch (error) {
      const msg = ((error && error.message) || '').toLowerCase()
      if (msg.indexOf('already') > -1 || msg.indexOf('connected') > -1) {
        return // 底层仍保有该连接（可能是 FF00 图传连接），当成功处理
      }
      lastError = error
      if (i < attempts - 1) {
        await sleep(400)
      }
    }
  }
  throw lastError || new Error('蓝牙连接失败')
}

// 发现 OTA 服务 FF10：连接成功后服务/特征可能尚未就绪，带短重试避免误报「未找到」。
async function discoverOtaService(deviceId, attempts = 6, interval = 250) {
  let lastUuids = []
  for (let i = 0; i < attempts; i++) {
    const res = await wxp(wx.getBLEDeviceServices, { deviceId })
    const services = res.services || []
    lastUuids = services.map(s => s.uuid)
    const service = services.find(s => matchUuid(s.uuid, OTA_SERVICE_UUID))
    if (service) {
      return { service, uuids: lastUuids }
    }
    if (i < attempts - 1) {
      await sleep(interval)
    }
  }
  console.warn('[OTA] 未匹配到 OTA 服务(FF10)，设备暴露的服务 UUID 列表：', lastUuids)
  return { service: null, uuids: lastUuids }
}

async function discoverOtaChars(deviceId, serviceId, attempts = 4, interval = 200) {
  for (let i = 0; i < attempts; i++) {
    const res = await wxp(wx.getBLEDeviceCharacteristics, { deviceId, serviceId })
    const chars = res.characteristics || []
    const controlChar = chars.find(c => matchUuid(c.uuid, OTA_CHAR_CONTROL_UUID))
    const dataChar = chars.find(c => matchUuid(c.uuid, OTA_CHAR_DATA_UUID))
    const altControlChar = chars.find(c => matchUuid(c.uuid, OTA_CHAR_ALT_CONTROL_UUID))
    if (controlChar) {
      return {
        controlChar,
        dataChar: dataChar || controlChar,
        altControlChar,
        chars
      }
    }
    if (i < attempts - 1) {
      await sleep(interval)
    }
  }
  return { controlChar: null, dataChar: null, altControlChar: null, chars: [] }
}

async function enableNotifyIfSupported(deviceId, serviceId, char) {
  const props = (char && char.properties) || {}
  if (!(props.notify || props.indicate)) {
    return false
  }
  await wxp(wx.notifyBLECharacteristicValueChange, {
    deviceId,
    serviceId,
    characteristicId: char.uuid,
    state: true
  })
  return true
}

// 建立 OTA 连接并发现 FF10/FF11、打开通知、协商 MTU，缓存会话。已就绪直接复用。
async function ensureOtaConnection(deviceId) {
  if (sessions[deviceId] && sessions[deviceId].ready) {
    return sessions[deviceId]
  }
  if (!wx.createBLEConnection) {
    throw new Error('当前微信版本不支持蓝牙 OTA')
  }

  ensureGlobalListener()
  await createConnectionWithRetry(deviceId)

  const { service } = await discoverOtaService(deviceId)
  if (!service) {
    throw new Error('未发现设备 OTA 服务(FF10)')
  }

  const found = await discoverOtaChars(deviceId, service.uuid)
  const controlChar = found.controlChar
  const dataChar = found.dataChar
  const altControlChar = found.altControlChar
  if (!controlChar) {
    throw new Error('未找到 OTA 控制特征(FF11)')
  }
  console.log('[OTA] 特征列表：', (found.chars || []).map(char => ({
    uuid: char.uuid,
    properties: char.properties
  })))

  const notifyCharIds = []
  if (await enableNotifyIfSupported(deviceId, service.uuid, controlChar)) {
    notifyCharIds.push(controlChar.uuid)
  }
  if (dataChar.uuid !== controlChar.uuid) {
    if (await enableNotifyIfSupported(deviceId, service.uuid, dataChar)) {
      notifyCharIds.push(dataChar.uuid)
    }
  }
  if (
    altControlChar &&
    altControlChar.uuid !== controlChar.uuid &&
    altControlChar.uuid !== dataChar.uuid
  ) {
    if (await enableNotifyIfSupported(deviceId, service.uuid, altControlChar)) {
      notifyCharIds.push(altControlChar.uuid)
    }
  }

  const mtu = await negotiateMtu(deviceId)
  const session = {
    deviceId,
    serviceId: service.uuid,
    charId: controlChar.uuid,
    controlCharId: controlChar.uuid,
    dataCharId: dataChar.uuid,
    altControlCharId: altControlChar ? altControlChar.uuid : '',
    notifyCharIds,
    writeType: pickWriteType(controlChar),
    controlWriteType: pickWriteType(controlChar),
    dataWriteType: pickWriteType(dataChar),
    altControlWriteType: pickWriteType(altControlChar),
    controlWriteTypes: writeTypeVariants(controlChar),
    dataWriteTypes: writeTypeVariants(dataChar),
    altControlWriteTypes: writeTypeVariants(altControlChar),
    mtu,
    deviceMtu: DEFAULT_DEVICE_MTU,
    prn: DEFAULT_PRN,
    chunkSize: chunkFromMtu(Math.min(mtu, DEFAULT_DEVICE_MTU)),
    lastAckSeq: -1,
    finalResult: null,
    ackWaiters: [],
    startWaiter: null,
    aborted: '',
    ready: true
  }
  sessions[deviceId] = session
  return session
}

// 裸写一帧到 FF11（带「发送缓冲忙就退避重试」：无应答写在缓冲暂满时会失败，稍等再试）。
async function writeFrame(session, bytes, target, writeTypeOverride) {
  const useDataChar = target === 'data'
  const useAltControlChar = target === 'altControl'
  const characteristicId = useDataChar
    ? session.dataCharId
    : useAltControlChar
      ? session.altControlCharId
      : session.controlCharId
  const writeType =
    writeTypeOverride !== undefined
      ? writeTypeOverride
      : useDataChar
        ? session.dataWriteType
        : useAltControlChar
          ? session.altControlWriteType
          : session.controlWriteType

  let attempt = 0
  for (;;) {
    try {
      reportFrame('TX', session.deviceId, bytes, characteristicId)
      const params = {
        deviceId: session.deviceId,
        serviceId: session.serviceId,
        characteristicId,
        value: toArrayBuffer(bytes)
      }
      if (writeType) {
        params.writeType = writeType
      }
      await wxp(wx.writeBLECharacteristicValue, params)
      return
    } catch (error) {
      if (isUnsupportedWriteError(error)) {
        throw error
      }
      if (++attempt > 4) {
        throw error
      }
      await sleep(80)
    }
  }
}

// ── 等待原语 ──────────────────────────────────────────────
// 等到「已连续接收包号」越过 minExclusive（至少又确认一个新包），或收到最终结果，或超时 reject。
function waitAckAdvanceOrFinal(session, minExclusive, timeout) {
  return new Promise((resolve, reject) => {
    const done = () => session.finalResult || session.lastAckSeq > minExclusive
    if (!session.ready) {
      reject(new Error(session.aborted || '连接已断开'))
      return
    }
    if (done()) {
      resolve()
      return
    }
    const onWake = () => {
      if (!session.ready) {
        cleanup()
        reject(new Error(session.aborted || '连接已断开'))
        return
      }
      if (done()) {
        cleanup()
        resolve()
      }
    }
    const cleanup = () => {
      clearTimeout(timer)
      const i = session.ackWaiters.indexOf(onWake)
      if (i >= 0) {
        session.ackWaiters.splice(i, 1)
      }
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('OTA_ACK_TIMEOUT'))
    }, timeout)
    session.ackWaiters.push(onWake)
  })
}

// 等待设备的 0xF3 最终结果（设备算 CRC32 + 写 BootSetting 可能要几秒）。
function waitFinalResult(session, timeout) {
  return new Promise((resolve, reject) => {
    if (session.finalResult) {
      resolve(session.finalResult)
      return
    }
    const onWake = () => {
      if (session.finalResult) {
        cleanup()
        resolve(session.finalResult)
      } else if (!session.ready) {
        cleanup()
        reject(new Error(session.aborted || '连接已断开'))
      }
    }
    const cleanup = () => {
      clearTimeout(timer)
      const i = session.ackWaiters.indexOf(onWake)
      if (i >= 0) {
        session.ackWaiters.splice(i, 1)
      }
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('OTA 等待设备校验结果超时'))
    }, timeout)
    session.ackWaiters.push(onWake)
  })
}

// ── START 握手 ────────────────────────────────────────────
function startTimeoutError(session, attempt) {
  const writeType =
    attempt && attempt.writeType ? attempt.writeType : 'default'
  const objType =
    attempt && Number.isInteger(attempt.objType)
      ? '0x' + attempt.objType.toString(16).padStart(2, '0')
      : '--'

  return new Error(
    'OTA START 应答超时' +
      `（target=${(attempt && attempt.target) || '--'}, writeType=${writeType}, objType=${objType}, service=${session.serviceId}, control=${session.controlCharId}, data=${session.dataCharId}, altControl=${session.altControlCharId || 'none'}, notify=${(session.notifyCharIds || []).join('|') || 'none'}）`
  )
}

function createStartAckWaiter(session, timeout, attempt) {
  let timer = null
  let waiter = null
  const promise = new Promise((resolve, reject) => {
    waiter = ack => {
      clearTimeout(timer)
      if (session.startWaiter === waiter) {
        session.startWaiter = null
      }
      resolve(ack)
    }
    session.startWaiter = waiter
    timer = setTimeout(() => {
      if (session.startWaiter === waiter) {
        session.startWaiter = null
        reject(startTimeoutError(session, attempt))
      }
    }, timeout)
  })

  return {
    promise,
    cancel() {
      clearTimeout(timer)
      if (session.startWaiter === waiter) {
        session.startWaiter = null
      }
    }
  }
}

function uniqueNumbers(list) {
  const out = []
  ;(list || []).forEach(value => {
    if (Number.isInteger(value) && out.indexOf(value) === -1) {
      out.push(value)
    }
  })
  return out
}

function buildStartAttempts(session, options) {
  const objTypes = Number.isInteger(options.objType)
    ? [options.objType]
    : uniqueNumbers([OBJ_TYPE_FIRMWARE, 0x01])
  const targets = ['control']

  if (session.dataCharId && session.dataCharId !== session.controlCharId) {
    targets.push('data')
  }
  if (
    session.altControlCharId &&
    session.altControlCharId !== session.controlCharId &&
    session.altControlCharId !== session.dataCharId
  ) {
    targets.push('altControl')
  }

  const attempts = []
  targets.forEach(target => {
    const writeTypes =
      target === 'data'
        ? session.dataWriteTypes
        : target === 'altControl'
          ? session.altControlWriteTypes
          : session.controlWriteTypes
    if (!writeTypes || !writeTypes.length) {
      return
    }
    objTypes.forEach(objType => {
      writeTypes.forEach(writeType => {
        attempts.push({ target, writeType, objType })
      })
    })
  })
  return attempts
}

function applyStartAck(session, ack) {
  if (!ack) {
    throw new Error(session.aborted || 'OTA 连接已断开')
  }
  if (ack.result !== 0x00) {
    throw new Error(
      'OTA 启动被拒绝：' +
        otaResultText(ack.result) +
        (ack.rawHex ? `（ACK=${ack.rawHex}）` : '')
    )
  }

  if (ack.prn) {
    session.prn = ack.prn
  }
  const effectiveMtu = Math.min(session.mtu, ack.mtu || session.deviceMtu)
  session.chunkSize = chunkFromMtu(effectiveMtu)
}

async function doStart(session, size, options) {
  const attempts = buildStartAttempts(session, options)
  const timeout = Number.isFinite(options.startTimeout)
    ? options.startTimeout
    : attempts.length > 1
      ? 2500
      : 5000
  let lastError = null
  let timeoutError = null

  if (!attempts.length) {
    throw new Error(
      'OTA 特征不支持写入：FF11/FF12/FF13 均未声明 write 或 writeNoResponse，请检查固件 GATT 属性。'
    )
  }

  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i]
    const frame = buildStartFrame(size, attempt.objType)
    const waiter = createStartAckWaiter(session, timeout, attempt)

    console.log('[OTA] START 尝试：', {
      target: attempt.target,
      writeType: attempt.writeType,
      objType: attempt.objType,
      frame: bytesToHex(frame)
    })

    try {
      await writeFrame(session, frame, attempt.target, attempt.writeType)
      const ack = await waiter.promise
      applyStartAck(session, ack)
      // 关键：设备在哪条特征上应答了 START，后续 DATA 就走同一条（本机 OTA 全程在 FF11 上收发，
      // 规格书 §6.3.3）。此前 DATA 硬编码写到 FF12(dataChar)，设备收不到 → 永远不回 DATA ACK → 卡在 -1。
      session.transferTarget = attempt.target
      session.transferWriteType = attempt.writeType
      console.log('[OTA] START 应答：', ack)
      return ack
    } catch (error) {
      waiter.cancel()
      if (!isUnsupportedWriteError(error)) {
        lastError = error
        if (error && error.message && error.message.indexOf('OTA START 应答超时') > -1) {
          timeoutError = error
        }
      }
      console.warn('[OTA] START 尝试失败：', error && error.message)
    }
  }

  if (timeoutError) {
    throw timeoutError
  }
  if (lastError) {
    throw lastError
  }
  throw new Error(
    'OTA START 写入失败：所有可写特征/写入类型均失败，请查看 [OTA] 特征列表与 START 尝试日志。'
  )
}

// ── 窗口化数据传输 ─────────────────────────────────────────
// 信用窗口：每发 PRN 个包等一次 DATA ACK；ACK 不前进就从 ACK 包号 + 1 重发。卡顿时缩窗 + 减速破死结。
// 等待超时必须远小于 1s：固件超过 1 秒没收到下一包即判定传输中断（图传卡死的红线，OTA 同样适用）。
async function transferData(session, bytes, options) {
  const onProgress = options.onProgress
  const shouldAbort = typeof options.shouldAbort === 'function' ? options.shouldAbort : () => false
  const total = bytes.length
  const chunkSize = session.chunkSize
  const totalPackets = Math.ceil(total / chunkSize)
  const prn = session.prn || DEFAULT_PRN
  const pace = Number.isFinite(options.pace) ? Math.max(0, options.pace) : 20

  session.lastAckSeq = -1
  session.finalResult = null

  let nextSeq = 0 // 下一个要发的包号（= 已确认的最后包号 + 1）
  let retries = 0

  emit(onProgress, {
    phase: 'transferring',
    percent: 15,
    sent: 0,
    total,
    totalPackets,
    message: `开始传输，共 ${totalPackets} 包，每包 ${chunkSize} 字节，窗口 PRN=${prn}`
  })

  while (nextSeq < totalPackets && !session.finalResult) {
    if (shouldAbort()) {
      throw new Error('OTA_ABORTED')
    }
    if (!session.ready) {
      throw new Error(session.aborted || 'OTA 连接已断开')
    }

    // 卡住后逐步收敛：每多重试一次窗口缩一包、每包间隔拉大一截，让被反复丢弃的待收包在设备空闲时单独抵达。
    const burst = retries === 0 ? prn : Math.max(1, prn - retries)
    const sendPace = retries === 0 ? pace : Math.min(150, pace + 30 * retries)
    const windowEnd = Math.min(nextSeq + burst, totalPackets)

    for (let seq = nextSeq; seq < windowEnd && !session.finalResult; seq++) {
      const chunk = bytes.subarray(seq * chunkSize, Math.min((seq + 1) * chunkSize, total))
      // DATA 沿用 START 成功的那条特征/写类型（见 doStart）；缺省回落到控制特征 FF11。
      await writeFrame(
        session,
        buildDataFrame(seq, chunk),
        session.transferTarget || 'control',
        session.transferWriteType
      )
      if (sendPace > 0) {
        await sleep(sendPace)
      }
    }

    if (session.finalResult) {
      break // 设备已收齐并给出最终结果（末尾不足 PRN 的尾包会直接走 0xF3，而非 DATA ACK）
    }

    // 尾窗特判：最后一包（不足 PRN 的残包）设备不会回 DATA ACK——它要收满固件大小后才直接回 0xF3。
    // 若把"没等到 ACK"当停滞去重发，会把已收满的设备再喂一遍尾包 → 累计字节数超过固件大小 → 设备判错并断开
    // （表现为卡在 97% 反复"补发第 N 包"后"设备连接已断开"）。故最后一包一旦发出，就跳出发送循环，
    // 交给下方 waitFinalResult 去等 0xF3 / 设备重启，绝不重发尾包。
    if (windowEnd >= totalPackets) {
      break
    }

    try {
      await waitAckAdvanceOrFinal(session, nextSeq - 1, 600)
    } catch (error) {
      if (error.message !== 'OTA_ACK_TIMEOUT') {
        throw error // 连接断开等致命错误直接上抛
      }
      if (++retries > 15) {
        throw new Error(
          `OTA 中断：设备停在已接收第 ${session.lastAckSeq} 包不再前进（共 ${totalPackets} 包）。` +
            `可能设备忙或处理不过来。当前 MTU=${session.mtu}、每包 ${chunkSize} 字节`
        )
      }
      emit(onProgress, {
        phase: 'retry',
        percent: progressPercent(Math.min(nextSeq * chunkSize, total), total),
        sent: Math.min(nextSeq * chunkSize, total),
        total,
        stuckAt: session.lastAckSeq,
        retries,
        message: `补发数据（设备停在第 ${session.lastAckSeq} 包，第 ${retries} 次重试）`
      })
      await sleep(Math.min(150, 50 * retries)) // 极短退避：保证「等待+退避」远小于设备 1s 超时
      nextSeq = session.lastAckSeq + 1 // 从设备已确认的下一个包重发
      continue
    }

    nextSeq = session.lastAckSeq + 1
    retries = 0
    const sent = Math.min(nextSeq * chunkSize, total)
    emit(onProgress, {
      phase: 'transferring',
      percent: progressPercent(sent, total),
      sent,
      total,
      message: `传输中：${sent}/${total} 字节`
    })
  }

  // 数据已全部送达：APP 不发 END，等设备自行算 CRC32 + 写 BootSetting 后回 0xF3。
  emit(onProgress, { phase: 'verifying', percent: 99, sent: total, total, message: '写入完成，等待设备校验' })

  let final = null
  try {
    final = await waitFinalResult(session, options.finalTimeout || 10000)
  } catch (error) {
    // 走到这里，固件数据已 100% 发完且每包都被设备累计确认。此后拿不到显式的 0xF3，无论是
    // 「等待时设备断开」还是「等 0xF3 超时」，绝大多数是同一回事：设备收满→写好 BootSetting→立即
    // 重启进入新固件，来不及/根本不回 0xF3（部分固件只重启、从不发 0xF3）。两种都按「已发送完毕、
    // 设备重启中、请核对版本」返回 confirmed:false——不谎报"确认成功"，也不把成功升级误判成失败。
    const disconnected = /断开/.test((error && error.message) || '')
    emit(onProgress, {
      phase: 'done',
      percent: 100,
      sent: total,
      total,
      message: disconnected
        ? '数据已全部发送，设备已断开——通常表示已写入并重启进入新固件。请在设备端确认固件版本是否已更新。'
        : '数据已全部发送，但未在超时内收到设备校验结果(0xF3)——通常表示设备已写入并直接重启进入新固件。请在设备端确认固件版本是否已更新。'
    })
    return {
      totalPackets,
      mtu: session.mtu,
      chunkSize,
      rebooted: disconnected,
      confirmed: false,
      finalTimedOut: !disconnected
    }
  }

  if (final.result !== 0x00) {
    throw new Error('设备校验失败：' + otaResultText(final.result))
  }

  emit(onProgress, { phase: 'done', percent: 100, sent: total, total, message: '升级完成，设备即将重启' })
  return { totalPackets, mtu: session.mtu, chunkSize, confirmed: true }
}

// 进度百分比：传输阶段占 15%~98%。
function progressPercent(sent, total) {
  if (!total) {
    return 98
  }
  return Math.min(98, 15 + Math.floor((sent / total) * 83))
}

function emit(onProgress, patch) {
  if (typeof onProgress === 'function') {
    onProgress(patch)
  }
}

// ── 固件包加载 ────────────────────────────────────────────
function readFileBuffer(filePath) {
  const fs = wx.getFileSystemManager()
  const tryRead = path =>
    new Promise((resolve, reject) => {
      fs.readFile({
        filePath: path,
        success: res => resolve(res.data),
        fail: error => reject(new Error((error && error.errMsg) || '读取固件包失败'))
      })
    })

  // 代码包内文件在不同基础库下「带/不带前导斜杠」表现不一，两种都试一次。
  return tryRead(filePath).catch(() => {
    const alt = filePath.charAt(0) === '/' ? filePath.slice(1) : '/' + filePath
    return tryRead(alt).catch(() => {
      throw new Error(`读取固件包失败：${filePath}（确认文件已随代码包打包）`)
    })
  })
}

function downloadFirmware(url) {
  return new Promise((resolve, reject) => {
    wx.downloadFile({
      url,
      success: res => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`固件包下载失败(${res.statusCode})`))
          return
        }
        resolve(res.tempFilePath)
      },
      fail: error => reject(new Error((error && error.errMsg) || '固件包下载失败'))
    })
  })
}

function mockFirmwareBuffer(size, version) {
  const total = Math.max(MIN_FW_SIZE, Number(size) || 65536)
  const seed = String(version || 'mock')
  const bytes = new Uint8Array(total)
  for (let i = 0; i < total; i++) {
    bytes[i] = (i * 31 + seed.charCodeAt(i % seed.length)) & 0xff
  }
  return bytes.buffer
}

async function loadFirmwareBuffer(pkg) {
  if (pkg.buffer) {
    return pkg.buffer
  }
  if (pkg.localPath) {
    return readFileBuffer(pkg.localPath) // 代码包内本地固件（测试流程用 docs/ 下的 .bin）
  }
  if (pkg.tempFilePath) {
    return readFileBuffer(pkg.tempFilePath)
  }
  if (pkg.inlineBase64 && wx.base64ToArrayBuffer) {
    return wx.base64ToArrayBuffer(pkg.inlineBase64)
  }
  if (pkg.packageUrl) {
    const filePath = await downloadFirmware(pkg.packageUrl)
    return readFileBuffer(filePath)
  }
  if (pkg.mock) {
    return mockFirmwareBuffer(pkg.sizeBytes, pkg.version)
  }
  throw new Error('缺少固件包来源（localPath / packageUrl / inlineBase64）')
}

function normalizeChecksum(checksum) {
  const text = String(checksum || '').trim()
  if (/^0x[0-9a-f]+$/i.test(text)) {
    return parseInt(text, 16) >>> 0
  }
  if (/^\d+$/.test(text)) {
    return Number(text) >>> 0
  }
  return null
}

async function prepareFirmware(pkg, options = {}) {
  const onProgress = options.onProgress
  emit(onProgress, { phase: 'preparing', percent: 5, message: '准备固件包' })

  const buffer = await loadFirmwareBuffer(pkg)
  const bytes = new Uint8Array(buffer)
  const size = bytes.length

  if (!size) {
    throw new Error('固件包为空')
  }

  const expectedSize = Number(pkg.sizeBytes) || 0
  if (expectedSize && size !== expectedSize) {
    throw new Error(`固件包大小不一致：期望 ${expectedSize} 字节，实际 ${size} 字节`)
  }
  if (size < MIN_FW_SIZE || size > MAX_FW_SIZE) {
    console.warn(`[OTA] 固件大小 ${size} 字节超出建议范围 0x${MIN_FW_SIZE.toString(16)}~0x${MAX_FW_SIZE.toString(16)}`)
  }

  // CRC32 仅用于本地完整性核对/展示；START 不携带 CRC32，校验由设备自行完成（协议要求）。
  const crc32 = imageCodec.crc32Mpeg2(bytes)
  const expectedCrc = normalizeChecksum(pkg.checksum)
  if (expectedCrc !== null && expectedCrc !== crc32) {
    throw new Error('固件包本地 CRC32 校验失败')
  }

  emit(onProgress, { phase: 'prepared', percent: 10, message: '固件包已就绪', size, crc32 })
  return { buffer, bytes, size, crc32 }
}

// ── 干跑（无 BLE）：开发者工具里校验「读包 + 组帧 + 校验 + 分包」，蓝牙真机才能跑真实传输。──
async function dryRunFirmware(prepared, options = {}) {
  const onProgress = options.onProgress
  const bytes = prepared.bytes
  const total = prepared.size
  const chunkSize = chunkFromMtu(DEFAULT_DEVICE_MTU) // 244：按设备满 MTU 估算
  const totalPackets = Math.ceil(total / chunkSize)
  const prn = DEFAULT_PRN

  const startFrame = buildStartFrame(total, OBJ_TYPE_FIRMWARE)
  const firstChunk = bytes.subarray(0, Math.min(chunkSize, total))
  const firstDataFrame = buildDataFrame(0, firstChunk)

  // 逐包「发送」并自校验累加校验位是否正确，模拟窗口节奏推进进度。
  let sent = 0
  for (let seq = 0; seq < totalPackets; seq++) {
    if (options.shouldAbort && options.shouldAbort()) {
      throw new Error('OTA_ABORTED')
    }
    const chunk = bytes.subarray(seq * chunkSize, Math.min((seq + 1) * chunkSize, total))
    const frame = buildDataFrame(seq, chunk)
    if (checksum8(frame.slice(0, frame.length - 1)) !== frame[frame.length - 1]) {
      throw new Error(`第 ${seq} 包校验位自检失败`)
    }
    sent = Math.min((seq + 1) * chunkSize, total)
    if (seq % prn === 0 || seq === totalPackets - 1) {
      emit(onProgress, {
        phase: 'transferring',
        percent: progressPercent(sent, total),
        sent,
        total,
        message: `干跑：${sent}/${total} 字节（${seq + 1}/${totalPackets} 包）`
      })
      await sleep(8)
    }
  }

  emit(onProgress, { phase: 'done', percent: 100, sent: total, total, message: '干跑完成（未经过真实蓝牙）' })

  return {
    dryRun: true,
    size: total,
    crc32: prepared.crc32,
    totalPackets,
    chunkSize,
    prn,
    startFrameHex: bytesToHex(startFrame),
    firstDataFrameHex: bytesToHex(firstDataFrame)
  }
}

// ── 对外主流程 ────────────────────────────────────────────
// upgradeFirmware(deviceId, pkg, options)
//   pkg:     { localPath | packageUrl | inlineBase64 | mock, sizeBytes?, checksum?, version? }
//   options: { onProgress(patch), shouldAbort(), pace?, objType?, dryRun?, startTimeout?, finalTimeout? }
async function upgradeFirmware(deviceId, pkg, options = {}) {
  const onProgress = options.onProgress
  const prepared = await prepareFirmware(pkg, options)

  // dryRun：纯本地校验编码与分包，不连蓝牙（开发者工具蓝牙模拟不可靠时用）。
  if (options.dryRun) {
    return dryRunFirmware(prepared, options)
  }

  emit(onProgress, { phase: 'connecting', percent: 12, message: '连接 OTA 服务(FF10)' })
  const session = await ensureOtaConnection(deviceId)

  emit(onProgress, {
    phase: 'starting',
    percent: 14,
    message: `握手中（MTU ${session.mtu}）`
  })
  await doStart(session, prepared.size, options)

  const result = await transferData(session, prepared.bytes, Object.assign({}, options, { crc32: prepared.crc32 }))
  return Object.assign({ size: prepared.size, crc32: prepared.crc32 }, result)
}

function disconnect(deviceId) {
  cleanupSession(deviceId, '已主动断开 OTA 连接')
  if (wx.closeBLEConnection && deviceId) {
    wx.closeBLEConnection({ deviceId })
  }
}

function isConnected(deviceId) {
  const session = sessions[deviceId]
  return !!(session && session.ready)
}

module.exports = {
  OP,
  OTA_SERVICE_UUID,
  OTA_CHAR_UUID,
  OTA_CHAR_CONTROL_UUID,
  OTA_CHAR_DATA_UUID,
  OTA_CHAR_ALT_CONTROL_UUID,
  OBJ_TYPE_FIRMWARE,
  DEFAULT_PRN,
  MIN_FW_SIZE,
  MAX_FW_SIZE,
  otaResultText,
  checksum8,
  buildStartFrame,
  buildDataFrame,
  prepareFirmware,
  upgradeFirmware,
  disconnect,
  isConnected,
  setMonitor
}
