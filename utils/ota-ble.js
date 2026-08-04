// 设备固件 OTA(DFU) 升级会话层 —— 依据《电子相框产品需求规格书 v1.5》§6.3 的自定义 DFU 协议实现。
// 与图传(FF00 主服务、0xAA 串行帧)完全无关：OTA 走独立的 OTA 服务 FF10，且 §6.3.3 明确「OTA 通道
// 不使用 6.4 的 0xAA 应用层帧格式」——所以旧版借用图传的 PKT_SEQ 累计确认(ACK_SEQ) 已作废，见下。
//
// ★ v1.5 关键变动（本次按新文档重写）：手机端只负责「按文件内容读取并发送」升级包，一切校验数据
//   (128 字节头信息里的 OTAINFO / 头部版本 / 面板类型 / CRC16 / 版本号 / 原始 bin CRC32) 都由固件方
//   预先打进升级包文件、并由设备端校验；手机不再自行计算 CRC32、也不组装任何头部。升级包文件结构固定为
//   [128 字节头信息][原始 bin payload]。
//
// 协议流程(§6.3.4 时序图)：
//   1) 校验位：每个 APP→设备的 OTA 请求末尾 1 字节累加 checksum = 前面所有字节之和 & 0xFF（不是 CRC16）。
//   2) START(0xF1)：OBJ_TYPE(1) + FW_SIZE(4,小端) + checksum → 设备初始化写入区，回 ACK[0xFC,0xF1,
//      RESULT,MTU(=251),PRN(=3),checksum]。RESULT!=0 立即停止并按结果码提示。
//   3) 头信息握手：第一个 DATA(0xF2) 承载升级包文件最前面的 128 字节头信息（首包长度 128，设备据此识别
//      为头信息）→ 设备校验 OTAINFO/头部版本/面板/CRC16/版本号 → 回 ACK[0xFC,0xF2,RESULT]。RESULT!=0 停止。
//   4) 数据传输：后续 DATA(0xF2) 承载从升级包第 129 字节起的原始 bin payload 分片；PRN 信用窗口——每发 PRN
//      个 DATA 包等一次设备 ACK[0xFC,0xF2,RESULT]。新协议的 DATA ACK 只回结果码(不再回「已连续接收包号」)，
//      故不做「按包号重发」；某一批超时/回错 = 传输中断，整轮升级判失败由用户重试(设备侧会等 APP 重新发起)。
//   5) END(0xF3)：payload 发完后 APP 主动发结束包 [0xF3,checksum]，设备校验 total_bytes==bin_size 且
//      CRC32(payload)==bin_crc32 → 回 ACK[0xFC,0xF3,RESULT]。RESULT==0 即升级成功，设备约 100ms 后复位运行新固件。
//
// 真机注意（开发者工具蓝牙模拟不可靠，务必真机联调，工具内可用 dryRun 校验编码）：
//   - 安卓默认 ATT MTU 仅 23（单次可写 20 字节），必须 wx.setBLEMTU 拉高，否则大 DATA 包写不进；
//     iOS 由系统自动协商。每包数据大小按真实协商到的 MTU 动态算（MTU - 3 ATT头 - 2 帧开销[操作码+校验]）。
//   - FF11 用 writeType:'writeNoResponse'，且需先 notifyBLECharacteristicValueChange 打开通知。
//
// 待与固件最终对齐的点（已就近标注 OTA_TODO，真机抓包后核对）：
//   a) FF11 特征的真实 128 位 UUID（连接时会打印实际值）；
//   b) START 帧 OBJ_TYPE 的确切取值（此处默认 0x00）；
//   c) START 帧 FW_SIZE 语义——本实现取「原始 bin payload 大小 = 文件大小 - 128」（与头信息里的 bin_size
//      对齐、也是设备 APP2 写入区大小）；若固件期望为「整包文件大小(含 128 头)」，改 computeFwSize 一处即可。

const imageCodec = require('./image-codec')

// ── 协议常量 ──────────────────────────────────────────────
const OTA_SERVICE_UUID = 'FF10'
const OTA_CHAR_CONTROL_UUID = 'FF11'
const OTA_CHAR_DATA_UUID = 'FF12'
const OTA_CHAR_ALT_CONTROL_UUID = 'FF13'
const OTA_CHAR_UUID = OTA_CHAR_CONTROL_UUID // 兼容旧导出名

const OP = {
  START: 0xf1, // APP→设备：开始（携带 OBJ_TYPE + FW_SIZE）
  DATA: 0xf2, // APP→设备：128 字节头信息握手包 / 后续 bin payload 分片
  END: 0xf3, // APP→设备：结束包（v1.5 新增，由 APP 主动发送）→ 设备整包校验后回 ACK
  ACK: 0xfc, // 设备→APP：START / DATA / END 应答的帧头(RSP_OPCODE)，后跟被应答的操作码
  RESULT: 0xf3 // 兼容旧引用：0xF3 现为 APP→设备 END 操作码，设备的最终结果以 END 的 ACK 形式返回
}

// 升级包文件最前面的头信息长度（§6.3.4）：第一个 DATA 包固定承载这 128 字节，设备据首包长度识别为头信息。
const OTA_HEADER_SIZE = 128

// OTA_TODO(b)：START 帧的对象类型。文档只写「当前作为固件对象使用」，未给确切数值，默认 0x00。
const OBJ_TYPE_FIRMWARE = 0x00
const DEFAULT_PRN = 3 // 信用窗口：每发这么多包等一次 DATA ACK（START ACK 里固件回 3）
const DEFAULT_DEVICE_MTU = 251 // 设备声明支持的 MTU；真实可写量仍以协商结果为准
// bin payload 合法范围（v1.5 §6.3：FW_SIZE 范围 0x30000 ~ 0x3C000，约 192KB ~ 240KB）。越界只告警不强拦，
// 最终以设备应答为准。注意 v1.5 已从旧的 0x3000 更正为 0x30000。
const MIN_FW_SIZE = 0x30000
const MAX_FW_SIZE = 0x3c000

// OTA 结果码 → 中文（规格书 v1.5 §6.3.2 OTA 专用码表，与图传 0x7F 通用应答码表不同！）。
// 0x0A~0x0E 为 v1.5 新增的头信息握手校验码（§6.3.4「6. 结果码」表）。未知码回落十六进制原文。
const OTA_RESULT_TEXT = {
  0x00: '成功',
  0x01: '校验/芯片信息错误',
  0x02: 'ACK 超时',
  0x03: '主机主动终止',
  0x04: '电子纸设备主动终止',
  0x05: '电子纸设备状态错误',
  0x06: '不支持的 opcode',
  0x07: '资源不足',
  0x08: '固件大小超限',
  0x09: '参数错误',
  0x0a: '协议匹配字段不匹配（非 OTA 包或文件损坏）',
  0x0b: '头部版本不兼容（工具链需升级）',
  0x0c: '固件类型与面板不匹配',
  0x0d: '头部 CRC16 校验失败（传输丢包或文件截断）',
  0x0e: '版本号校验失败（格式/产品/面板不一致）'
}

function otaResultText(code) {
  const text = OTA_RESULT_TEXT[code]
  return text || `电子纸设备返回错误码 0x${(code & 0xff).toString(16).padStart(2, '0')}`
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
//   单次可写 = MTU - 3(ATT 头)；DATA 帧固定开销 = 2（操作码1 + 校验1，v1.5 不再有 2 字节包序号）。
// 上限 244（MTU=251 时 248-2=246，为安全留一点余量取 244）。
function chunkFromMtu(mtu) {
  const writable = Math.max(20, (mtu || DEFAULT_DEVICE_MTU) - 3)
  return Math.max(1, Math.min(244, writable - 2))
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

// DATA(0xF2) 帧（v1.5）：[0xF2, ...数据..., checksum]。不再有 2 字节包序号。
// 数据可能是 128 字节头信息（首包），也可能是 bin payload 分片。
function buildDataFrame(chunk) {
  const head = [OP.DATA]
  for (let i = 0; i < chunk.length; i++) {
    head.push(chunk[i] & 0xff)
  }
  return withChecksum(head)
}

// END(0xF3) 结束帧（v1.5 新增）：[0xF3, checksum]。设备收到后做整包校验并回 ACK。
function buildEndFrame() {
  return withChecksum([OP.END])
}

// START 帧 FW_SIZE：取 bin payload 大小 = 文件总大小 - 128 字节头（见文件头 OTA_TODO(c)）。
function computeFwSize(fileSize) {
  return Math.max(0, (Number(fileSize) || 0) - OTA_HEADER_SIZE)
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

// DATA/END ACK（v1.5 §6.3.4）：[0xFC(帧头), 回显操作码(0xF2/0xF3), RESULT, checksum]，RESULT 在偏移 2；
// 兼容旧固件「不带 0xFC 帧头、直接以回显操作码打头」[0xF2/0xF3, RESULT, ...]（偏移 1）。
// v1.5 的 DATA ACK 只回结果码，不再携带「已连续接收包号」——图传(0xAA)才有 ACK_SEQ，OTA 通道不使用。
function parseAckResult(bytes) {
  const offset = bytes[0] === OP.ACK ? 2 : 1
  return { result: bytes.length > offset ? bytes[offset] & 0xff : 0xff, rawHex: bytesToHex(bytes) }
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
        cleanupSession(res.deviceId, '电子纸设备连接已断开')
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

// 把一条通知派发到等待者：START ACK / DATA ACK / END ACK。
// 设备应答帧头是 0xFC(RSP_OPCODE)，被应答的操作码回显在第 2 字节；据此区分 START/DATA/END 应答。
// 兼容「不带 0xFC 帧头、直接以操作码打头」的旧固件（echo 退回 bytes[0]）。
function dispatchNotification(session, bytes) {
  if (!bytes.length) {
    return
  }
  const echo = bytes[0] === OP.ACK ? bytes[1] : bytes[0]

  // START ACK：回显 0xF1；或正等 START 应答且不是 DATA/END，也按 START ACK 解析。
  if (echo === OP.START || (session.startWaiter && echo !== OP.DATA && echo !== OP.END)) {
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

  // DATA ACK（回显 0xF2）或 END ACK（回显 0xF3）：都只带 RESULT 结果码，交给对应 opcode 的等待者。
  if (echo === OP.DATA || echo === OP.END) {
    resolveAck(session, echo, parseAckResult(bytes))
  }
}

// 把结果码 ACK 交给当前在等这个 opcode 的等待者；若还没人在等（写完到收到 ACK 的竞态），先缓存到收件箱。
function resolveAck(session, opcode, ack) {
  const waiter = session.ackWaiter
  if (waiter && waiter.opcode === opcode) {
    waiter.resolve(ack)
    return
  }
  session.ackInbox.push({ opcode, result: ack.result, rawHex: ack.rawHex })
}

// 清理会话：让在等的请求立刻失败，移除缓存（不主动 closeBLEConnection，断开回调场景下连接已没了）。
function cleanupSession(deviceId, reason) {
  const session = sessions[deviceId]
  if (!session) {
    return
  }
  session.ready = false
  session.aborted = reason || '连接已断开'
  if (session.ackWaiter) {
    const waiter = session.ackWaiter
    session.ackWaiter = null
    waiter.reject(new Error(session.aborted))
  }
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

// 连接重试预算。⚠️ **与 device-ble 的同名常量有意不同，不是漂移，别「顺手对齐」**：
//
// device-ble 那边是分层的——内层只留 2 次，因为它上面还有一层 active-device.scanMatchConnect 的
// 「失败后重扫拿新鲜 deviceId 再连」（SCAN_CONNECT_ROUNDS），deviceId 失效那类失败由外层兜。
// **OTA 这条链路没有那个外层**（ensureOtaConnection 直接拿现成 deviceId 连，不走扫描主链），
// 所以只能靠内层多试几次来补偿，故次数取 3 而非 2。
//
// 超时逐次拉长的理由与 device-ble 一致：首次快速试错、末次耐心等，别把「本来能连上、只是慢」误杀。
// 若哪天 OTA 也接上重扫层，就该把这里收回到与 device-ble 相同的 2 次。
const CONNECT_ATTEMPTS = 3
const CONNECT_TIMEOUTS = [5000, 8000, 10000]
const CONNECT_BACKOFF_MS = [400, 800]

async function createConnectionWithRetry(deviceId, attempts = CONNECT_ATTEMPTS) {
  let lastError = null
  for (let i = 0; i < attempts; i++) {
    try {
      await wxp(wx.createBLEConnection, {
        deviceId,
        timeout: CONNECT_TIMEOUTS[Math.min(i, CONNECT_TIMEOUTS.length - 1)]
      })
      return
    } catch (error) {
      const msg = ((error && error.message) || '').toLowerCase()
      if (msg.indexOf('already') > -1 || msg.indexOf('connected') > -1) {
        return // 底层仍保有该连接（可能是 FF00 图传连接），当成功处理
      }
      lastError = error
      // 失败(含超时)后底层常残留一条「半连接」占住设备使其不再广播，必须每次失败都关掉释放——
      // 否则紧接的重试/重扫会「未搜索到该设备」(与 device-ble.createConnectionWithRetry 同款处理)
      if (wx.closeBLEConnection) {
        try {
          await wxp(wx.closeBLEConnection, { deviceId })
        } catch (closeError) {
          // 没有可关闭的连接，忽略
        }
      }
      if (i < attempts - 1) {
        await sleep(CONNECT_BACKOFF_MS[Math.min(i, CONNECT_BACKOFF_MS.length - 1)])
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

  // 单连接跨模块释放：OTA(FF10) 与普通会话(FF00) 是两个独立的 sessions 池，各自只清自己那本账。
  // 不清的话，「连着 A → 进 B 的 OTA 页」会把 A 一直占着，A 从此不广播、哪儿都搜不到。
  //
  // 只释放**其他设备**：同一 deviceId 上 FF10 与 FF00 共用同一条物理 GATT 连接
  // （见 ota.js onUnload「避免干跑时误关详情页持有的 FF00 连接」），断掉它等于把 OTA
  // 自己要用的连接也关了。
  //
  // 惰性 require 而非顶部引入：两个模块会互相引用，顶部 require 在加载期会拿到半成品导出对象。
  // 反向（普通连接释放 OTA 会话）不需要——OTA 页 onUnload 已自行断开。
  require('./device-ble').disconnectOthers(deviceId)

  ensureGlobalListener()
  await createConnectionWithRetry(deviceId)

  // 从服务发现到会话落表，任一步失败都必须关掉刚建立的连接：此时连接尚未登记进 sessions，
  // 页面退出时 isConnected() 判不到它、无人清理——设备被这条「无主连接」占住不再广播，
  // 之后怎么扫都「未搜索到该设备」，直到重启蓝牙才恢复。（与 device-ble 的失败清理策略对齐）
  try {
    return await buildOtaSession(deviceId)
  } catch (error) {
    if (wx.closeBLEConnection) {
      try {
        await wxp(wx.closeBLEConnection, { deviceId })
      } catch (closeError) {
        // 没有可关闭的连接，忽略
      }
    }
    throw error
  }
}

// 发现 FF10/FF11、打开通知、协商 MTU 并登记会话（失败清理由 ensureOtaConnection 兜底）
async function buildOtaSession(deviceId) {
  const { service } = await discoverOtaService(deviceId)
  if (!service) {
    throw new Error('未发现电子纸设备 OTA 服务(FF10)')
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
    ackWaiter: null, // 当前在等的一次 DATA/END 结果码应答 { opcode, resolve, reject }
    ackInbox: [], // 尚无人认领的结果码应答缓存（写完到收到 ACK 的竞态兜底）
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
// 等某个 opcode(0xF2 DATA / 0xF3 END) 的结果码应答：命中返回 { result, rawHex }，超时 reject('OTA_ACK_TIMEOUT')，
// 连接断开 reject。OTA 全程串行（发一批→等一次 ACK→再发下一批），同一时刻只有一个 ackWaiter。
// 竞态兜底：调用前若 ACK 已到并落入 ackInbox，这里直接取走，避免错过。
function waitAck(session, opcode, timeout) {
  return new Promise((resolve, reject) => {
    if (!session.ready) {
      reject(new Error(session.aborted || 'OTA 连接已断开'))
      return
    }
    const buffered = session.ackInbox.find(a => a.opcode === opcode)
    if (buffered) {
      session.ackInbox = session.ackInbox.filter(a => a !== buffered)
      resolve({ result: buffered.result, rawHex: buffered.rawHex })
      return
    }
    const timer = setTimeout(() => {
      if (session.ackWaiter && session.ackWaiter.timer === timer) {
        session.ackWaiter = null
      }
      reject(new Error('OTA_ACK_TIMEOUT'))
    }, timeout)
    session.ackWaiter = {
      opcode,
      timer,
      resolve: ack => {
        clearTimeout(timer)
        session.ackWaiter = null
        resolve(ack)
      },
      reject: error => {
        clearTimeout(timer)
        session.ackWaiter = null
        reject(error)
      }
    }
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
    // 带 code 供 doStart 识别：这是设备的确定性答复（大小超限/资源不足等），
    // 与「超时/写失败」不同，换特征/写类型重发同一 objType 毫无意义
    const rejected = new Error(
      'OTA 启动被拒绝：' +
        otaResultText(ack.result) +
        (ack.rawHex ? `（ACK=${ack.rawHex}）` : '')
    )
    rejected.code = 'OTA_START_REJECTED'
    throw rejected
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
  let rejectionError = null // 设备明确拒绝（RESULT≠0）的首个拒因，最优先上抛保真
  const rejectedObjTypes = {} // 被设备明确拒绝过的 objType：其余「特征×写类型」组合不再重试

  if (!attempts.length) {
    throw new Error(
      'OTA 特征不支持写入：FF11/FF12/FF13 均未声明 write 或 writeNoResponse，请检查固件 GATT 属性。'
    )
  }

  for (let i = 0; i < attempts.length; i++) {
    // 用户中断（切后台/离开页面）：握手最多「特征×写类型×objType」十余次尝试 × 2.5s 超时，
    // 不检查中断标记会让已离开的页面空转半分钟。
    if (options.shouldAbort && options.shouldAbort()) {
      throw new Error('OTA_ABORTED')
    }
    const attempt = attempts[i]
    if (rejectedObjTypes[String(attempt.objType)]) {
      continue // 该 objType 已被设备确定性拒绝，换写法重发只会拖长失败时间
    }
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
      if (error && error.code === 'OTA_START_REJECTED') {
        // 确定性拒绝：记住首个拒因并短路该 objType 的剩余组合（objType 语义不同仍各给一次机会）
        rejectionError = rejectionError || error
        rejectedObjTypes[String(attempt.objType)] = true
      } else if (!isUnsupportedWriteError(error)) {
        lastError = error
        if (error && error.message && error.message.indexOf('OTA START 应答超时') > -1) {
          timeoutError = error
        }
      }
      console.warn('[OTA] START 尝试失败：', error && error.message)
    }
  }

  // 设备的明确拒因最保真，优先上抛；其次超时（比「写失败」更接近根因）
  if (rejectionError) {
    throw rejectionError
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

// 发一帧 DATA/END 并等它的结果码应答。发送前先清空 ackInbox（本次只认这一帧的应答），
// 命中 result!=0 抛错，超时抛出带上下文的中断错误。
async function sendFrameAwaitAck(session, frame, opcode, timeout, timeoutMessage) {
  session.ackInbox = []
  await writeFrame(session, frame, session.transferTarget || 'control', session.transferWriteType)
  try {
    return await waitAck(session, opcode, timeout)
  } catch (error) {
    if (error.message === 'OTA_ACK_TIMEOUT') {
      throw new Error(timeoutMessage)
    }
    throw error // 连接断开等致命错误直接上抛
  }
}

// ── 分阶段数据传输（v1.5 §6.3.4）─────────────────────────────
// 手机只负责按文件内容读取并发送：先发 128 字节头信息握手包，再按 PRN 信用窗口发 bin payload，最后发 END。
// 一切完整性校验(CRC16/CRC32/版本/面板)由设备依据升级包里已打好的头信息完成，手机不重发、不补包——
// 某一批 ACK 超时或回错即判传输中断，整轮升级失败由用户重试（设备侧会等 APP 重新发起 DFU）。
async function transferData(session, bytes, options) {
  const onProgress = options.onProgress
  const shouldAbort = typeof options.shouldAbort === 'function' ? options.shouldAbort : () => false
  const total = bytes.length

  if (total < OTA_HEADER_SIZE) {
    throw new Error(`升级包过小（${total} 字节），缺少 128 字节头信息，可能不是有效的 OTA 升级包`)
  }

  const header = bytes.subarray(0, OTA_HEADER_SIZE) // 升级包最前面的 128 字节头信息
  const payload = bytes.subarray(OTA_HEADER_SIZE) // 从第 129 字节起的原始 bin payload
  const payloadLen = payload.length
  const chunkSize = session.chunkSize
  const totalPackets = Math.ceil(payloadLen / chunkSize)
  const prn = session.prn || DEFAULT_PRN
  const pace = Number.isFinite(options.pace) ? Math.max(0, options.pace) : 20

  session.ackWaiter = null
  session.ackInbox = []

  // ── 步骤 3：128 字节头信息握手包 ──
  emit(onProgress, {
    phase: 'header',
    percent: 15,
    sent: 0,
    total: payloadLen,
    message: '发送 128 字节头信息，等待电子纸设备校验头部'
  })
  const headerAck = await sendFrameAwaitAck(
    session,
    buildDataFrame(header),
    OP.DATA,
    5000,
    '头信息握手超时：电子纸设备未应答 128 字节头信息校验（请确认升级包与电子纸设备面板/型号匹配）'
  )
  if (headerAck.result !== 0x00) {
    // 0x0A~0x0E 明确指向「包不对/头版本/面板/CRC16/版本号」——直接把设备语义透传给用户。
    throw new Error('头信息校验未通过：' + otaResultText(headerAck.result))
  }

  // ── 步骤 4：后续 bin payload，PRN 信用窗口 ──
  emit(onProgress, {
    phase: 'transferring',
    percent: progressPercent(0, payloadLen),
    sent: 0,
    total: payloadLen,
    totalPackets,
    message: `头部校验通过，开始传输：共 ${totalPackets} 包，每包 ${chunkSize} 字节，窗口 PRN=${prn}`
  })

  let seq = 0
  while (seq < totalPackets) {
    if (shouldAbort()) {
      throw new Error('OTA_ABORTED')
    }
    if (!session.ready) {
      throw new Error(session.aborted || 'OTA 连接已断开')
    }

    const batchEnd = Math.min(seq + prn, totalPackets)
    session.ackInbox = []
    for (let k = seq; k < batchEnd; k++) {
      const chunk = payload.subarray(k * chunkSize, Math.min((k + 1) * chunkSize, payloadLen))
      // DATA 沿用 START 成功的那条特征/写类型（见 doStart）；缺省回落到控制特征 FF11。
      await writeFrame(session, buildDataFrame(chunk), session.transferTarget || 'control', session.transferWriteType)
      if (pace > 0) {
        await sleep(pace)
      }
    }

    let ack
    try {
      // 每发 PRN 个 DATA 包等一次设备应答；1s 收不到即判中断（§6.4 传输超时红线，OTA 同样适用），留 1.5s 余量。
      ack = await waitAck(session, OP.DATA, 1500)
    } catch (error) {
      if (error.message === 'OTA_ACK_TIMEOUT') {
        throw new Error(
          `OTA 传输中断：已发送 ${batchEnd}/${totalPackets} 包后，电子纸设备未在 1.5s 内应答（疑似丢包），请重试整个升级`
        )
      }
      throw error
    }
    if (ack.result !== 0x00) {
      throw new Error('电子纸设备接收数据报错：' + otaResultText(ack.result))
    }

    seq = batchEnd
    const sent = Math.min(seq * chunkSize, payloadLen)
    emit(onProgress, {
      phase: 'transferring',
      percent: progressPercent(sent, payloadLen),
      sent,
      total: payloadLen,
      message: `传输中：${sent}/${payloadLen} 字节（${seq}/${totalPackets} 包）`
    })
  }

  // ── 步骤 5：END 结束包，设备整包校验 total_bytes==bin_size 且 CRC32(payload)==bin_crc32 ──
  emit(onProgress, { phase: 'verifying', percent: 98, sent: payloadLen, total: payloadLen, message: '数据已发完，发送结束包(0xF3)，等待电子纸设备整包校验' })
  // 校验窗口需覆盖「设备最后一批落盘 + CRC32 计算」，给足时长（默认 15s，可由 finalTimeout 覆盖）。
  const finalTimeout = Number.isFinite(options.finalTimeout) ? options.finalTimeout : 15000
  let final
  try {
    final = await sendFrameAwaitAck(
      session,
      buildEndFrame(),
      OP.END,
      finalTimeout,
      `OTA 校验超时：结束包已发送，但 ${Math.round(finalTimeout / 1000)}s 内未收到电子纸设备整包校验结果(0xF3 应答)，请重试`
    )
  } catch (error) {
    if (shouldAbort()) {
      throw new Error('OTA_ABORTED')
    }
    if (!session.ready || /断开/.test((error && error.message) || '')) {
      throw new Error('OTA 传输中断：结束包已发送，但电子纸设备在返回整包校验结果前断开，升级未完成，请重试。')
    }
    throw error
  }

  if (final.result !== 0x00) {
    throw new Error('电子纸设备整包校验失败：' + otaResultText(final.result))
  }

  emit(onProgress, { phase: 'done', percent: 100, sent: payloadLen, total: payloadLen, message: '升级完成，电子纸设备校验通过，约 100ms 后复位运行新固件' })
  return { totalPackets, mtu: session.mtu, chunkSize, payloadSize: payloadLen, confirmed: true }
}

// 进度百分比：传输阶段占 15%~97%。
function progressPercent(sent, total) {
  if (!total) {
    return 97
  }
  return Math.min(97, 15 + Math.floor((sent / total) * 82))
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
  // v1.5 升级包结构固定为 [128 字节头信息][bin payload]，文件必须至少含这 128 字节头。
  if (size <= OTA_HEADER_SIZE) {
    throw new Error(`升级包过小（${size} 字节），至少应含 128 字节头信息 + bin payload，可能不是有效的 OTA 升级包`)
  }
  const payloadSize = computeFwSize(size) // = size - 128
  if (payloadSize < MIN_FW_SIZE || payloadSize > MAX_FW_SIZE) {
    console.warn(`[OTA] bin payload ${payloadSize} 字节超出建议范围 0x${MIN_FW_SIZE.toString(16)}~0x${MAX_FW_SIZE.toString(16)}（仅告警，最终以设备应答为准）`)
  }

  // v1.5：一切校验数据(含 CRC32)由固件方预先打进升级包头信息、并由设备端校验；手机不再计算/携带 CRC32。
  // 这里仅为本地展示/日志算一次 CRC32，不做拦截。
  const crc32 = imageCodec.crc32Mpeg2(bytes)

  emit(onProgress, { phase: 'prepared', percent: 10, message: '固件包已就绪', size, payloadSize, crc32 })
  return { buffer, bytes, size, payloadSize, crc32 }
}

// ── 干跑（无 BLE）：开发者工具里校验「读包 + 拆头/payload + 组帧 + 校验 + 分包」，蓝牙真机才能跑真实传输。──
async function dryRunFirmware(prepared, options = {}) {
  const onProgress = options.onProgress
  const bytes = prepared.bytes
  const total = prepared.size
  const header = bytes.subarray(0, OTA_HEADER_SIZE)
  const payload = bytes.subarray(OTA_HEADER_SIZE)
  const payloadLen = payload.length
  const chunkSize = chunkFromMtu(DEFAULT_DEVICE_MTU) // 246：按设备满 MTU 估算
  const totalPackets = Math.ceil(payloadLen / chunkSize)
  const prn = DEFAULT_PRN

  const startFrame = buildStartFrame(prepared.payloadSize, OBJ_TYPE_FIRMWARE)
  const headerFrame = buildDataFrame(header) // 首个 DATA = 128 字节头信息
  const firstPayloadFrame = buildDataFrame(payload.subarray(0, Math.min(chunkSize, payloadLen)))
  const endFrame = buildEndFrame()

  // 头信息帧自检
  if (checksum8(headerFrame.slice(0, headerFrame.length - 1)) !== headerFrame[headerFrame.length - 1]) {
    throw new Error('头信息帧校验位自检失败')
  }

  // 逐包「发送」并自校验累加校验位是否正确，模拟窗口节奏推进进度。
  let sent = 0
  for (let seq = 0; seq < totalPackets; seq++) {
    if (options.shouldAbort && options.shouldAbort()) {
      throw new Error('OTA_ABORTED')
    }
    const chunk = payload.subarray(seq * chunkSize, Math.min((seq + 1) * chunkSize, payloadLen))
    const frame = buildDataFrame(chunk)
    if (checksum8(frame.slice(0, frame.length - 1)) !== frame[frame.length - 1]) {
      throw new Error(`第 ${seq} 包校验位自检失败`)
    }
    sent = Math.min((seq + 1) * chunkSize, payloadLen)
    if (seq % prn === 0 || seq === totalPackets - 1) {
      emit(onProgress, {
        phase: 'transferring',
        percent: progressPercent(sent, payloadLen),
        sent,
        total: payloadLen,
        message: `干跑：${sent}/${payloadLen} 字节（${seq + 1}/${totalPackets} 包）`
      })
      await sleep(8)
    }
  }

  emit(onProgress, { phase: 'done', percent: 100, sent: payloadLen, total: payloadLen, message: '干跑完成（未经过真实蓝牙）' })

  return {
    dryRun: true,
    size: total,
    payloadSize: payloadLen,
    crc32: prepared.crc32,
    totalPackets,
    chunkSize,
    prn,
    startFrameHex: bytesToHex(startFrame),
    headerFrameHex: bytesToHex(headerFrame),
    firstDataFrameHex: bytesToHex(firstPayloadFrame),
    endFrameHex: bytesToHex(endFrame)
  }
}

// 给「设备返回 / 蓝牙链路 / OTA」类错误统一加「设备-」前缀（与 device-ble.js 一致），
// 便于和接口错误(「接口-」)、小程序本地错误(「小程序-」)区分来源。
// 幂等：已带「接口-」「设备-」前缀，或为纯大写下划线的内部控制信号(如 OTA_ABORTED) 时原样返回。
function prefixDeviceError(error) {
  const e =
    error instanceof Error ? error : new Error((error && error.message) || 'OTA 升级失败')
  const msg = e.message || 'OTA 升级失败'
  if (/^(?:接口-|设备-|电子纸设备-)/.test(msg) || /^[A-Z][A-Z0-9_]*$/.test(msg)) {
    return e
  }
  e.message = '电子纸设备-' + msg
  return e
}

// ── 对外主流程 ────────────────────────────────────────────
// upgradeFirmware(deviceId, pkg, options)
//   pkg:     { localPath | packageUrl | inlineBase64 | mock, sizeBytes?, checksum?, version? }
//   options: { onProgress(patch), shouldAbort(), pace?, objType?, dryRun?, startTimeout?, finalTimeout? }
async function upgradeFirmware(deviceId, pkg, options = {}) {
  const onProgress = options.onProgress

  // dryRun：纯本地校验编码与分包，不连蓝牙（开发者工具蓝牙模拟不可靠时用）。
  // 干跑错误属小程序本地计算，不加「设备-」前缀，交由上层按需加「小程序-」。
  if (options.dryRun) {
    const prepared = await prepareFirmware(pkg, options)
    return dryRunFirmware(prepared, options)
  }

  // 真机 DFU：读包 + 握手 + 传输全程与设备/蓝牙交互，出错统一补「设备-」前缀（OTA_ABORTED 等内部信号除外）。
  try {
    const prepared = await prepareFirmware(pkg, options)

    emit(onProgress, { phase: 'connecting', percent: 12, message: '连接 OTA 服务(FF10)' })
    const session = await ensureOtaConnection(deviceId)

    emit(onProgress, {
      phase: 'starting',
      percent: 14,
      message: `握手中（MTU ${session.mtu}）`
    })
    // START 携带 FW_SIZE = bin payload 大小（文件大小 - 128 头，见 computeFwSize）。
    await doStart(session, prepared.payloadSize, options)

    const result = await transferData(session, prepared.bytes, Object.assign({}, options, { crc32: prepared.crc32 }))
    return Object.assign({ size: prepared.size, crc32: prepared.crc32 }, result)
  } catch (error) {
    throw prefixDeviceError(error)
  }
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
  OTA_HEADER_SIZE,
  OBJ_TYPE_FIRMWARE,
  DEFAULT_PRN,
  MIN_FW_SIZE,
  MAX_FW_SIZE,
  otaResultText,
  checksum8,
  buildStartFrame,
  buildDataFrame,
  buildEndFrame,
  prepareFirmware,
  upgradeFirmware,
  disconnect,
  isConnected,
  setMonitor
}
