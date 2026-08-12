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
// 真机注意（开发者工具的蓝牙模拟不可靠，OTA 必须真机联调）：
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

// 头信息里的「固件类型」(偏移 9)：1 = 3D7 面板(3.7 寸 480×720)，2 = 5D89 面板(5.89 寸 680×960)。
// 与 frame-protocol.SCREEN_TYPES 的 0x01/0x02 一一对应，供本地按设备尺寸预检面板是否刷对。
const OTA_PANELS = {
  1: { name: '3D7', label: '3.7寸', width: 480, height: 720 },
  2: { name: '5D89', label: '5.89寸', width: 680, height: 960 }
}

// OTA_TODO(b)：START 帧的对象类型。文档只写「当前作为固件对象使用」，未给确切数值，默认 0x00。
const OBJ_TYPE_FIRMWARE = 0x00
const DEFAULT_PRN = 3 // 信用窗口：每发这么多包等一次 DATA ACK（START ACK 里固件回 3）
const DEFAULT_DEVICE_MTU = 251 // 设备声明支持的 MTU；真实可写量仍以协商结果为准
// bin payload 合法范围：**照规格书原文取 0x3000 ~ 0x3C000**（§6.3.3 START 请求表，v1.5 文档与
// 2026-08-11 的文档截图两处印的都是 0x3000）。此前端上自作主张把下限"更正"成 0x30000（192KB），
// 而现场固件的 bin payload 约 164KB —— 落在原文范围内，却被这个更正判成"超出建议范围"，
// 每次升级都打一条误导性告警。越界一律只告警不拦，最终以设备应答（0x08 固件大小超限）为准。
const MIN_FW_SIZE = 0x3000
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

// ── 全链路 console 日志（2026-08-11）────────────────────────────
// 真机 OTA 出问题时最缺的是「端上到底发了什么、设备到底回了什么、卡在哪一步、隔了多久」。
// 这里把从点「升级」到「升级成功」的每个节点都打到 console，一行一个节点：
//   [OTA#3 +12.4s] START 应答 { result: 0, 含义: '成功', prn: 3, ... }
// 编号 #n 区分同一次会话里的多轮升级（失败重试会重新编号），+时间是从本轮开始起算的相对耗时——
// 排查「卡了多久才超时」「设备隔多久才应答」全靠它，比绝对时间戳好读。
//
// 数据帧(0xF2 payload 分片)默认按 PRN 信用窗口聚合打印：673 包逐帧打 hex 会把控制台冲爆、
// 反而看不见控制流。需要逐帧原文时传 options.verboseFrames = true（会额外打每包的前 12 字节）。
let logRun = 0
let logStartedAt = 0

function otaLogReset() {
  logRun += 1
  logStartedAt = Date.now()
  return logRun
}

function elapsedText() {
  if (!logStartedAt) {
    return '+0.00s'
  }
  return '+' + ((Date.now() - logStartedAt) / 1000).toFixed(2) + 's'
}

function otaLog(step, detail) {
  const prefix = `[OTA#${logRun} ${elapsedText()}] ${step}`
  if (detail === undefined) {
    console.log(prefix)
  } else {
    console.log(prefix, detail)
  }
}

function otaWarn(step, detail) {
  const prefix = `[OTA#${logRun} ${elapsedText()}] ${step}`
  if (detail === undefined) {
    console.warn(prefix)
  } else {
    console.warn(prefix, detail)
  }
}

// 结果码统一打成「0x00 成功」这种可读形式，免得对着裸数字翻码表
function resultDesc(result) {
  return `0x${(result & 0xff).toString(16).padStart(2, '0')} ${otaResultText(result)}`
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

function readU16LE(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8)) >>> 0
}

function readU32LE(bytes, offset) {
  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>>
    0
  )
}

// 解析升级包最前面的 128 字节头信息（§6.3.4 字段表）。**只读不改**：这 128 字节由固件方预先打好，
// APP 原样发送、不改写任何字段；这里解析只为「发之前先看一眼包对不对」和日志排查。
function inspectOtaHeader(bytes) {
  const head = bytes.subarray(0, OTA_HEADER_SIZE)
  let magic = ''
  for (let i = 0; i < 7; i++) {
    magic += String.fromCharCode(head[i])
  }
  const versionLength = Math.min(readU16LE(head, 20), 104)
  let version = ''
  for (let i = 0; i < versionLength; i++) {
    const code = head[24 + i]
    if (!code) {
      break
    }
    version += String.fromCharCode(code)
  }
  return {
    magicOk: magic === 'OTAINFO' && head[7] === 0x00,
    headerVersion: head[8],
    panel: head[9],
    headerLength: readU16LE(head, 10),
    binSize: readU32LE(head, 12),
    binCrc32: readU32LE(head, 16),
    versionLength,
    headerCrc16: readU16LE(head, 22),
    version
  }
}

function panelText(panel) {
  const spec = OTA_PANELS[panel]
  return spec ? `${spec.name}（${spec.label}）` : `未知面板类型 ${panel}`
}

// 设备记录的屏幕类型/分辨率 → 头信息里的固件类型；判不出返回 0（不参与拦截）。
// screenType 与面板号同源（0x01 3.7寸=3D7、0x02 5.89寸=5D89，见 frame-protocol.SCREEN_TYPES）。
function panelOfDevice(device) {
  const screenType = Number(device && device.screenType) || 0
  if (OTA_PANELS[screenType]) {
    return screenType
  }
  const w = Number(device && device.width) || 0
  const h = Number(device && device.height) || 0
  if (!w || !h) {
    return 0
  }
  const keys = Object.keys(OTA_PANELS)
  for (let i = 0; i < keys.length; i++) {
    const spec = OTA_PANELS[keys[i]]
    if ((w === spec.width && h === spec.height) || (w === spec.height && h === spec.width)) {
      return Number(keys[i])
    }
  }
  return 0
}

// 发包前的本地预检：传错文件/下载截断应该在碰蓝牙之前就拦住，而不是刷到设备上再等它回错误码。
// 只拦「一望即知不对」的三类（缺 OTAINFO 标识、头部长度不是 128、声明 bin 大小与文件对不上）
// 与「面板明确刷错」；CRC16/CRC32 只记日志不拦——规格书没写这两个校验用的多项式口径，
// 本地算法与固件不一致时误拦会把好包挡在门外，这两项本来就该由设备校验（0x0D / 0x09）。
function assertPackageLooksRight(bytes, payloadSize, options) {
  const header = inspectOtaHeader(bytes)
  otaLog('步骤0 升级包头信息（本地预检，只读不改）：', {
    magicOk: header.magicOk,
    headerVersion: header.headerVersion,
    panel: header.panel,
    headerLength: header.headerLength,
    binSize: header.binSize,
    actualPayload: payloadSize,
    binCrc32: '0x' + header.binCrc32.toString(16).toUpperCase(),
    localCrc32Mpeg2: '0x' + (imageCodec.crc32Mpeg2(bytes.subarray(OTA_HEADER_SIZE)) >>> 0).toString(16).toUpperCase(),
    headerCrc16: '0x' + header.headerCrc16.toString(16).toUpperCase(),
    version: header.version
  })

  if (!header.magicOk) {
    throw new Error(
      '升级包无效：文件开头没有 "OTAINFO" 标识（§6.3.4 头信息），这不是一个 OTA 升级包 —— 多半是传错了文件或下载被截断。'
    )
  }
  if (header.headerLength !== OTA_HEADER_SIZE) {
    throw new Error(
      `升级包无效：头信息声明头部长度 ${header.headerLength} 字节，规格固定为 ${OTA_HEADER_SIZE} 字节，文件不是本协议的升级包。`
    )
  }
  if (header.binSize !== payloadSize) {
    throw new Error(
      `升级包不完整：头信息声明 bin 大小 ${header.binSize} 字节，文件实际只有 ${payloadSize} 字节（不含 128 字节头）。请重新下载或确认是否传错了包。`
    )
  }
  const expectPanel = Number(options && options.expectPanel) || 0
  if (expectPanel && header.panel && header.panel !== expectPanel) {
    throw new Error(
      `升级包面板不匹配：这是 ${panelText(header.panel)} 的固件，当前电子纸设备是 ${panelText(expectPanel)}。刷错面板会变砖，已终止。`
    )
  }
  const wantVersion = String((options && options.expectVersion) || '').trim()
  if (wantVersion && header.version && header.version.indexOf(wantVersion) === -1) {
    // 只告警：后端版本号写法（如 V1.0.2）与包内版本串（BR1601A02_..._V102）本就可能不同形，
    // 拦下去会误伤；真不匹配设备会在头信息握手回 0x0E。
    console.warn(
      `[OTA] 升级包内版本号 "${header.version}" 与后端下发的新版本 "${wantVersion}" 不同形，请留意是否传错包`
    )
  }
  return header
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
// 两个回调都留引用：蓝牙栈硬复位后要先 off 再重挂（理由见 device-ble.rebindGlobalListeners）
let valueChangeHandler = null
let connectionStateHandler = null

function ensureGlobalListener() {
  if (globalListenerBound) {
    return
  }
  globalListenerBound = true

  if (wx.onBLECharacteristicValueChange) {
    valueChangeHandler = res => {
      const session = sessions[res.deviceId]
      if (!session || !isSessionCharacteristic(session, res.characteristicId)) {
        return // 非本模块管理的设备/特征（如 FF00 图传通知）一律忽略
      }
      const bytes = Array.from(new Uint8Array(res.value || new ArrayBuffer(0)))
      reportFrame('RX', res.deviceId, bytes, res.characteristicId)
      // 设备回的每一帧原文都打出来：结果码之外，帧头/回显操作码对不对也常是问题所在
      otaLog('RX 收到电子纸设备应答', {
        原文: bytesToHex(bytes),
        特征: res.characteristicId
      })
      dispatchNotification(session, bytes)
    }
    wx.onBLECharacteristicValueChange(valueChangeHandler)
  }

  if (wx.onBLEConnectionStateChange) {
    connectionStateHandler = res => {
      if (!res.connected) {
        if (sessions[res.deviceId]) {
          otaWarn('连接状态变化：电子纸设备已断开（OTA 会话作废）', { deviceId: res.deviceId })
        }
        cleanupSession(res.deviceId, '电子纸设备连接已断开')
      }
    }
    wx.onBLEConnectionStateChange(connectionStateHandler)
  }
}

// 蓝牙栈硬复位后重挂本模块的全局监听。做法与理由完全同 device-ble.rebindGlobalListeners
//（必须先 off 再 on；off 不可用就什么都不做，绝不能让 OTA 的每帧应答被派发两遍）。
function rebindGlobalListeners() {
  if (!wx.offBLECharacteristicValueChange || !wx.offBLEConnectionStateChange) {
    return false
  }
  if (valueChangeHandler) {
    wx.offBLECharacteristicValueChange(valueChangeHandler)
  }
  if (connectionStateHandler) {
    wx.offBLEConnectionStateChange(connectionStateHandler)
  }
  valueChangeHandler = null
  connectionStateHandler = null
  globalListenerBound = false
  ensureGlobalListener()
  return true
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
    otaLog('步骤1 连接：复用已就绪的 OTA 会话', {
      deviceId,
      MTU: sessions[deviceId].mtu,
      每包字节: sessions[deviceId].chunkSize
    })
    return sessions[deviceId]
  }
  if (!wx.createBLEConnection) {
    throw new Error('当前微信版本不支持蓝牙 OTA')
  }
  otaLog('步骤1 连接：建立 OTA 连接并发现 FF10 服务', { deviceId })

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
  // OTA 的 FF10 连接不经过 device-ble 的 createConnectionWithRetry，得自己登记「碰过 BLE」，
  // 否则它留下的残留连接会因为 bleTouched=false 被判成「没什么可复位的」（见 device-ble.noteBleTouched）
  require('./device-ble').noteBleTouched()

  ensureGlobalListener()
  await createConnectionWithRetry(deviceId)

  // 从服务发现到会话落表，任一步失败都必须关掉刚建立的连接：此时连接尚未登记进 sessions，
  // 页面退出时 isConnected() 判不到它、无人清理——设备被这条「无主连接」占住不再广播，
  // 之后怎么扫都「未搜索到该设备」，直到重启蓝牙才恢复。（与 device-ble 的失败清理策略对齐）
  try {
    const session = await buildOtaSession(deviceId)
    otaLog('步骤1 连接：OTA 会话就绪', {
      服务: session.serviceId,
      控制特征: session.controlCharId,
      数据特征: session.dataCharId,
      备用控制特征: session.altControlCharId || 'none',
      已开通知: (session.notifyCharIds || []).join('|') || 'none',
      MTU: session.mtu,
      每包字节: session.chunkSize,
      写入方式: session.controlWriteType
    })
    return session
  } catch (error) {
    otaWarn('步骤1 连接失败：', (error && error.message) || error)
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

  // 控制类帧(START/END/头信息)每帧都打原文；bin payload 分片默认按窗口聚合（见文件头日志说明），
  // session.verboseFrames 打开后逐包也打（只打前 12 字节，够核对帧头/操作码/校验位就行）。
  const isPayloadChunk = bytes[0] === OP.DATA && bytes.length !== OTA_HEADER_SIZE + 2
  if (!isPayloadChunk) {
    otaLog('TX 发送帧', {
      操作码: '0x' + (bytes[0] & 0xff).toString(16),
      长度: bytes.length,
      原文: bytes.length > 24 ? bytesToHex(bytes.slice(0, 24)) + ' …' : bytesToHex(bytes),
      特征: characteristicId,
      写入方式: writeType || 'default'
    })
  } else if (session.verboseFrames) {
    otaLog('TX 数据分片', {
      长度: bytes.length,
      前12字节: bytesToHex(bytes.slice(0, 12))
    })
  }

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
        otaWarn('TX 写入被拒绝（特征不支持该写入方式）', (error && error.message) || error)
        throw error
      }
      if (++attempt > 4) {
        otaWarn(`TX 写入连续失败 ${attempt} 次，放弃`, (error && error.message) || error)
        throw error
      }
      otaWarn(`TX 写入失败，80ms 后第 ${attempt} 次重试`, (error && error.message) || error)
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
    rejected.result = ack.result // 供上层识别 0x05「设备状态错误」并做复位重试
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

    otaLog(`步骤2 START(0xF1) 第 ${i + 1}/${attempts.length} 次尝试`, {
      特征: attempt.target,
      写入方式: attempt.writeType,
      objType: '0x' + attempt.objType.toString(16).padStart(2, '0'),
      FW_SIZE: size,
      帧原文: bytesToHex(frame),
      应答超时ms: timeout
    })

    try {
      await writeFrame(session, frame, attempt.target, attempt.writeType)
      const ack = await waiter.promise
      otaLog('步骤2 START 应答', {
        原文: ack.rawHex,
        结果: resultDesc(ack.result),
        设备MTU: ack.mtu || '(未给,用默认)',
        PRN信用窗口: ack.prn || '(未给,用默认)'
      })
      applyStartAck(session, ack)
      // 关键：设备在哪条特征上应答了 START，后续 DATA 就走同一条（本机 OTA 全程在 FF11 上收发，
      // 规格书 §6.3.3）。此前 DATA 硬编码写到 FF12(dataChar)，设备收不到 → 永远不回 DATA ACK → 卡在 -1。
      session.transferTarget = attempt.target
      session.transferWriteType = attempt.writeType
      otaLog('步骤2 START 握手通过，后续 DATA 沿用同一条特征', {
        特征: session.transferTarget,
        写入方式: session.transferWriteType,
        生效每包字节: session.chunkSize,
        生效PRN: session.prn
      })
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
      otaWarn(`步骤2 START 第 ${i + 1} 次尝试失败：`, (error && error.message) || error)
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
  // 超时给到 10s：设备收到 START 后要初始化写入区（含 Flash 擦除），再校验头部 CRC16/版本号，
  // 这段忙碌期不回应答是常见的。5s 曾把「设备还在准备」误判成握手失败。
  // ⚠️ 文案不要暗示「面板/型号不匹配」：那种情况设备会明确回 0x0C，能走到超时只可能是它没应答。
  const headerTimeout = Number.isFinite(options.headerTimeout) ? options.headerTimeout : 10000
  // START ACK 一回来设备就开始初始化写入区（擦 Flash），这段时间它可能顾不上收包——
  // FF11 只有无应答写（§6.3.2），这时丢包是静默的，谁都不会报错。先让它喘一口气再发头信息。
  // ⚠️ 只等一小会儿(300ms)：等太久有反向风险——若固件也有「超过约 1s 没等到下一包就中断」
  // 的口径（§6.4 图传就是 1s），长延时反而会让设备先把这轮 DFU 判死、再收到头信息就回 0x05。
  // 「设备还在忙」那一侧交给下面的退避重发覆盖，两种可能都不押死。
  const headerDelay = Number.isFinite(options.headerDelayMs) ? options.headerDelayMs : 300
  // 同一条会话内重发几次头信息。设备**按首包长度识别头信息**（§6.3.4），只要它还没收下过头信息，
  // 重发的这一包依然会被当成头信息处理；比断链重连再来一轮便宜得多，也不用惊动用户。
  // 代价：万一设备其实收下了、只是应答帧丢了，重发的 128 字节会被算进 bin 数据，
  // END 的整包校验会以 0x09 暴露出来（下面据此给出提示），不会把错的固件刷进去。
  const headerAttempts = Math.max(1, Number.isFinite(options.headerAttempts) ? options.headerAttempts : 3)
  const headerFrame = buildDataFrame(header)
  otaLog('步骤3 头信息握手：准备发送 128 字节头信息包', {
    帧长: headerFrame.length, // = 1(opcode) + 128(头信息) + 1(checksum)
    头信息字节数: header.length,
    前12字节: bytesToHex(headerFrame.slice(0, 12)),
    发送前延时ms: Number.isFinite(options.headerDelayMs) ? options.headerDelayMs : 300,
    最多重发次数: Math.max(1, Number.isFinite(options.headerAttempts) ? options.headerAttempts : 3),
    单次等待ms: Number.isFinite(options.headerTimeout) ? options.headerTimeout : 10000,
    待传bin字节: payloadLen,
    分包: `${totalPackets} 包 × ${chunkSize} 字节`,
    PRN窗口: prn
  })
  if (headerDelay > 0) {
    await sleep(headerDelay)
  }
  const headerRetryDelay = Number.isFinite(options.headerRetryDelayMs)
    ? options.headerRetryDelayMs
    : 1500
  let headerAck = null
  let headerError = null
  for (let attempt = 1; attempt <= headerAttempts; attempt++) {
    // 中断要能及时收手：头信息握手最坏是 3 次 × 10s 等待 + 退避，不查中断标记的话，
    // 用户切后台/退页面后这里还会空转半分钟，链路也就多占设备半分钟（设备被占着时不广播）。
    // 与 doStart / 数据窗口同一套口径。
    if (shouldAbort()) {
      throw new Error('OTA_ABORTED')
    }
    if (attempt > 1) {
      session.headerResent = true
      // 退避重发：设备刚说「状态不对」或干脆没应答，多半还没从上一轮 DFU / 擦写忙态里出来，
      // 立刻重发只会再撞一次。等一等再来，一次比一次久。
      await sleep(headerRetryDelay * (attempt - 1))
      emit(onProgress, {
        phase: 'header',
        percent: 15,
        sent: 0,
        total: payloadLen,
        message: `头信息未通过，重发第 ${attempt} 次…`
      })
    }

    let ack = null
    try {
      ack = await sendFrameAwaitAck(
        session,
        headerFrame,
        OP.DATA,
        headerTimeout,
        `头信息握手超时：${Math.round(headerTimeout / 1000)}s 内未收到电子纸设备对 128 字节头信息的校验应答`
      )
    } catch (error) {
      if (!/头信息握手超时/.test((error && error.message) || '')) {
        throw error // 连接断开等致命错误直接上抛
      }
      otaWarn(`步骤3 头信息第 ${attempt}/${headerAttempts} 次无应答（等满 ${headerTimeout}ms）`)
      headerError = error
      continue
    }

    otaLog(`步骤3 头信息第 ${attempt} 次应答`, {
      原文: ack.rawHex,
      结果: resultDesc(ack.result)
    })
    if (ack.result === 0x00) {
      headerAck = ack
      break
    }
    if (ack.result === 0x05) {
      // 「设备状态错误」说的是**此刻不能受理**，不是「这个包不对」——包不对是 0x0A~0x0E。
      // 属于可重试：等设备从忙态/上一轮 DFU 状态里出来再发一次。
      otaWarn(`步骤3 头信息第 ${attempt} 次被回 0x05（设备状态错误），退避后重发：`, ack.rawHex)
      headerError = new Error(
        '头信息校验未通过：' + otaResultText(0x05) + `（ACK=${ack.rawHex}）`
      )
      continue
    }
    // 0x0A~0x0E 明确指向「包不对/头版本/面板/CRC16/版本号」：重发一万次也一样，
    // 直接把设备语义透传给用户。
    throw new Error(
      '头信息校验未通过：' +
        otaResultText(ack.result) +
        (ack.rawHex ? `（ACK=${ack.rawHex}）` : '')
    )
  }
  if (!headerAck) {
    // 打上 code：此刻设备一个 payload 字节都没收下，上层可以安全地断链复位后整轮重来。
    headerError.message += `（同一连接内已发 ${headerAttempts} 次头信息）`
    headerError.code = 'OTA_HEADER_STUCK'
    throw headerError
  }

  // ── 步骤 4：后续 bin payload，PRN 信用窗口 ──
  otaLog('步骤4 数据传输开始', {
    总包数: totalPackets,
    每包字节: chunkSize,
    PRN窗口: prn,
    总字节: payloadLen,
    每包间隔ms: pace
  })
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
    // 收尾不足一个信用窗口的那一批：设备按 PRN 每收满 prn 包才回一次 ACK，最后凑不满窗口的
    // 1~2 包本来就等不到 DATA ACK。673 包 / PRN=3 时最后一窗只有 1 包，现场表现正是
    // 「已发送 673/673 包后，设备未在 1.5s 内应答（疑似丢包）」——数据其实已全部发出。
    const isTailWindow = batchEnd === totalPackets && batchEnd - seq < prn
    session.ackInbox = []
    for (let k = seq; k < batchEnd; k++) {
      const chunk = payload.subarray(k * chunkSize, Math.min((k + 1) * chunkSize, payloadLen))
      // DATA 沿用 START 成功的那条特征/写类型（见 doStart）；缺省回落到控制特征 FF11。
      await writeFrame(session, buildDataFrame(chunk), session.transferTarget || 'control', session.transferWriteType)
      if (pace > 0) {
        await sleep(pace)
      }
    }

    otaLog(`步骤4 已发窗口 [${seq + 1}~${batchEnd}]/${totalPackets} 包`, {
      本窗包数: batchEnd - seq,
      字节区间: `${seq * chunkSize}~${Math.min(batchEnd * chunkSize, payloadLen)}`,
      收尾窗口: isTailWindow ? '是（不足一个 PRN 窗口，ACK 可选）' : '否',
      等待DATA_ACK: isTailWindow ? '可选' : '必须（1.5s）'
    })

    let ack
    try {
      // 每发 PRN 个 DATA 包等一次设备应答；1s 收不到即判中断（§6.4 传输超时红线，OTA 同样适用），留 1.5s 余量。
      ack = await waitAck(session, OP.DATA, 1500)
      otaLog(`步骤4 窗口 [${seq + 1}~${batchEnd}] DATA 应答`, {
        原文: ack.rawHex,
        结果: resultDesc(ack.result)
      })
    } catch (error) {
      if (error.message === 'OTA_ACK_TIMEOUT') {
        if (isTailWindow) {
          // 收尾窗口的 ACK 一律按「可选」处理，直接进 END：整包完不完整由 END(0xF3) 的
          // total_bytes == bin_size 与 CRC32 校验裁决（不匹配设备回 0x09），真丢包一样会被抓住，
          // 不会因为放过这次等待而误报升级成功。
          otaWarn('步骤4 收尾窗口未收到 DATA ACK（不足一个 PRN 窗口，属预期），继续发送结束包')
          ack = null
        } else {
          otaWarn(`步骤4 传输中断：已发 ${batchEnd}/${totalPackets} 包，1.5s 内没等到 DATA ACK`)
          throw new Error(
            `OTA 传输中断：已发送 ${batchEnd}/${totalPackets} 包后，电子纸设备未在 1.5s 内应答（疑似丢包），请重试整个升级`
          )
        }
      } else {
        throw error
      }
    }
    if (ack && ack.result !== 0x00) {
      otaWarn(`步骤4 窗口 [${seq + 1}~${batchEnd}] 被设备判错，终止传输`, resultDesc(ack.result))
      const dataError = new Error('电子纸设备接收数据报错：' + otaResultText(ack.result))
      if (ack.result === 0x05) {
        // 0x05「设备状态错误」= **此刻不能受理**，不是「这批数据不对」（数据不对是 0x01/0x09）。
        // 传输途中冒出来通常是设备端的 DFU 状态机被上一轮没走完的升级卡住了（反复对同一台设备升级时最常见）。
        // 与 START/头信息的 0x05 同一套处理：打上 code → 上层断链复位 → 等设备退出 DFU 态 → 整轮从 START 重来。
        // 从 START 重来是安全的：START 本身会重置设备的写入区与 total_bytes，不存在「接着上次的半截数据写」。
        // 此前这里是直接判死，用户看到的就是「电子纸设备-电子纸设备接收数据报错：电子纸设备状态错误」，
        // 只能自己再点一次升级，而不断链的话下一次 START 照样被回 0x05。
        dataError.code = 'OTA_DATA_STATE_ERROR'
        dataError.result = ack.result
      }
      throw dataError
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
  otaLog('步骤5 数据已全部发出，发送结束包 END(0xF3)，等待整包校验', {
    已发字节: payloadLen,
    已发包数: totalPackets,
    校验等待ms: finalTimeout,
    本轮是否重发过头信息: !!session.headerResent
  })
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

  otaLog('步骤5 END 应答（设备整包校验结果）', {
    原文: final.rawHex,
    结果: resultDesc(final.result)
  })

  if (final.result !== 0x00) {
    // 0x09 = total_bytes/CRC32 对不上。若本轮重发过头信息，最可能的解释是「设备其实收下了第一包、
    // 只是应答丢了」，重发的 128 字节被算进了 bin 数据——把这条线索一并给出，免得又去查信号。
    const hint =
      final.result === 0x09 && session.headerResent
        ? '（本轮重发过头信息包：若设备其实已收下第一包，重发的 128 字节会被计入 bin 数据而导致本校验失败，请重试一次）'
        : ''
    throw new Error('电子纸设备整包校验失败：' + otaResultText(final.result) + hint)
  }

  otaLog('步骤5 整包校验通过：升级成功，设备约 100ms 后复位运行新固件', {
    总包数: totalPackets,
    总字节: payloadLen,
    每包字节: chunkSize,
    MTU: session.mtu
  })
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

async function loadFirmwareBuffer(pkg) {
  if (pkg.buffer) {
    otaLog('步骤0 固件包来源：内存 buffer')
    return pkg.buffer
  }
  if (pkg.localPath) {
    otaLog('步骤0 固件包来源：代码包内本地文件', pkg.localPath)
    return readFileBuffer(pkg.localPath) // 代码包内的本地固件（当前没有调用方）
  }
  if (pkg.tempFilePath) {
    otaLog('步骤0 固件包来源：已下载的临时文件', pkg.tempFilePath)
    return readFileBuffer(pkg.tempFilePath)
  }
  if (pkg.inlineBase64 && wx.base64ToArrayBuffer) {
    otaLog('步骤0 固件包来源：内联 base64')
    return wx.base64ToArrayBuffer(pkg.inlineBase64)
  }
  if (pkg.packageUrl) {
    otaLog('步骤0 固件包来源：开始下载', pkg.packageUrl)
    const filePath = await downloadFirmware(pkg.packageUrl)
    otaLog('步骤0 固件包下载完成', filePath)
    return readFileBuffer(filePath)
  }
  throw new Error('缺少固件包来源（packageUrl / localPath / inlineBase64）')
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

  // 发之前先看一眼这个包对不对（传错文件/下载截断/面板刷错），别等刷到设备上才失败。
  const header = assertPackageLooksRight(bytes, payloadSize, options)

  // v1.5：一切校验数据(含 CRC32)由固件方预先打进升级包头信息、并由设备端校验；手机不再计算/携带 CRC32。
  // 这里仅为本地展示/日志算一次 CRC32，不做拦截。
  const crc32 = imageCodec.crc32Mpeg2(bytes)

  otaLog('步骤0 固件包就绪', {
    文件总字节: size,
    bin字节: payloadSize,
    头信息字节: OTA_HEADER_SIZE,
    本地CRC32: '0x' + (crc32 >>> 0).toString(16).toUpperCase(),
    包内版本: header.version,
    面板: panelText(header.panel)
  })
  emit(onProgress, { phase: 'prepared', percent: 10, message: '固件包已就绪', size, payloadSize, crc32 })
  return { buffer, bytes, size, payloadSize, crc32 }
}

// （2026-08-11：`dryRunFirmware` 随「OTA测试升级」模块一并删除。它只在开发者工具里
//   校验读包/组帧/分包，从不碰蓝牙；留着会让「升级成功」有两种含义，真机联调时反而误导。）

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
//   pkg:     { packageUrl | localPath | inlineBase64, sizeBytes?, checksum?, version? }
//   options: { onProgress(patch), shouldAbort(), pace?, objType?, startTimeout?, finalTimeout? }
// 设备 DFU 状态机停在上一次没走完的升级里：START 会被回 0x05「设备状态错误」。
// 复用同一条 GATT 连接再怎么重发都是 0x05，必须先把链路断掉让设备复位。
function isStuckDfuState(error) {
  return !!(error && error.code === 'OTA_START_REJECTED' && error.result === 0x05)
}

const DFU_STATE_RESET_WAIT_MS = 3000 // 断链后留给设备退出 DFU 状态的时间

// 「设备侧 OTA 状态没复位」的三种表现。前两种连一个 payload 字节都还没被设备收下；
// 第三种收下了一部分，但整轮从 START 重来同样安全——START 本身会重置设备的写入区与 total_bytes，
// 不存在「接着上次的半截数据往下写」：
//   · START 被回 0x05：上一轮 DFU 半途中断，状态机还停在升级态；
//   · 头信息握手过不去（无应答，或一直被回 0x05 设备状态错误）：START 应答正常，
//     却收不下这 128 字节头信息。——规格书 §8 步骤 2 明确设备要回 ACK；
//     面板/型号/CRC 不对是回 0x0A~0x0E，所以「不应答」和「0x05」都只能是设备端状态没复位。
//   · 传数据途中某个信用窗口被回 0x05（2026-08-11 补）：同样是「此刻不能受理」而不是「数据不对」，
//     反复对同一台设备升级时最常见。此前直接判死，用户只看到「接收数据报错：设备状态错误」，
//     而不断链复位的话下一次点升级连 START 都过不去。
function isWedgedDfuSession(error) {
  return (
    isStuckDfuState(error) ||
    !!(error && error.code === 'OTA_HEADER_STUCK') ||
    !!(error && error.code === 'OTA_DATA_STATE_ERROR')
  )
}

function wedgedRetryError(error) {
  if (isStuckDfuState(error)) {
    return new Error(
      'OTA 启动被拒绝：电子纸设备仍停在上一次未完成的升级状态（' +
        otaResultText(0x05) +
        '）。请把电子纸设备断电重启后再试。'
    )
  }
  if (error && error.code === 'OTA_DATA_STATE_ERROR') {
    return new Error(
      '电子纸设备在传输途中一直报「设备状态错误」：断电重启电子纸设备后再升一次。' +
        '（这是设备端 OTA 状态没有复位，不是升级包的问题——包不对时设备回的是 0x01/0x09/0x0A~0x0E。）'
    )
  }
  if (error && error.code === 'OTA_HEADER_STUCK') {
    const rejected = /状态错误/.test((error && error.message) || '')
    return new Error(
      rejected
        ? '电子纸设备一直报「设备状态错误」：它接受了 START，却在两轮连接、多次重发里始终不肯受理' +
          ' 128 字节头信息，说明设备端的 OTA 状态没有复位。请把电子纸设备断电重启后再试。' +
          '（升级包本身不对时设备会回 0x0A~0x0E，而不是 0x05。）'
        : '头信息握手无应答：电子纸设备接受了 START，却在两轮连接、多次重发里都没有回复' +
          ' 128 字节头信息的校验结果。请把电子纸设备断电重启后再试' +
          '（升级包与面板/型号不匹配时设备会明确回 0x0C，而不是不应答）。'
    )
  }
  return error
}

// 一轮完整的 DFU：连接 FF10 → START → 头信息握手 → 传数据 → END。
async function runDfuAttempt(deviceId, prepared, options) {
  const onProgress = options.onProgress

  emit(onProgress, { phase: 'connecting', percent: 12, message: '连接 OTA 服务(FF10)' })
  const session = await ensureOtaConnection(deviceId)
  // 逐帧原文开关（默认按窗口聚合，见文件头日志说明）
  session.verboseFrames = !!options.verboseFrames

  emit(onProgress, {
    phase: 'starting',
    percent: 14,
    message: `握手中（MTU ${session.mtu}）`
  })
  // START 携带 FW_SIZE = bin payload 大小（文件大小 - 128 头，见 computeFwSize）。
  await doStart(session, prepared.payloadSize, options)

  return transferData(
    session,
    prepared.bytes,
    Object.assign({}, options, { crc32: prepared.crc32 })
  )
}

async function upgradeFirmware(deviceId, pkg, options = {}) {
  const onProgress = options.onProgress
  const shouldAbort = typeof options.shouldAbort === 'function' ? options.shouldAbort : () => false

  // 本轮日志计时归零：下面每条 [OTA#n +x.xxs] 的相对耗时都从这里起算
  otaLogReset()
  otaLog('====== 开始固件升级 ======', {
    deviceId,
    目标版本: pkg && pkg.version,
    包地址: (pkg && pkg.packageUrl) || (pkg && pkg.localPath) || '(内存/内联)',
    声明大小: (pkg && pkg.sizeBytes) || '(未给)',
    逐帧日志: !!options.verboseFrames
  })

  // 「这一轮到底碰没碰过设备」（2026-08-12）：准备升级包（下载/读文件/解析 128 字节头信息）
  // 全程不碰蓝牙，它失败时设备与链路都还是好好的。此前这类失败也会走收尾复位，把用户**已经连着的
  // 那条连接断掉、直连缓存删掉**——一次网络抖动就要求用户重新扫描连接，正是「升级失败影响原有功能」。
  // 只有真的开始与设备交互（连 FF10 / 发 START 及之后）才需要断链复位。
  let deviceTouched = false
  // 真机 DFU：读包 + 握手 + 传输全程与设备/蓝牙交互，出错统一补「设备-」前缀（OTA_ABORTED 等内部信号除外）。
  try {
    const prepared = await prepareFirmware(pkg, options)
    deviceTouched = true

    let result
    try {
      result = await runDfuAttempt(deviceId, prepared, options)
    } catch (error) {
      if (!isWedgedDfuSession(error) || shouldAbort()) {
        throw error
      }
      // 设备还停在上一轮没走完的 DFU 里：断链 → 等它复位 → 重连整轮重来，
      // 让用户「再点一次升级」就能自愈，而不是从此每次都被挡住、只能去重启设备。
      otaWarn('设备侧 OTA 状态未复位，断链复位后整轮重试一次：', (error && error.message) || error)
      emit(onProgress, {
        phase: 'starting',
        percent: 13,
        message: '电子纸设备仍停在上一次升级状态，正在断开复位后重试…'
      })
      // 断链 + 清掉这条链路上的所有缓存，别让重试轮沿用上一轮的会话/读数。
      // ⚠️ hardReset:false —— 这条路紧接着就要用同一个适配器重连设备（runDfuAttempt 直接
      //    createBLEConnection、不走扫描主链），把适配器关掉会让整轮重试必然失败。
      await resetAfterUpgrade(deviceId, '设备状态未复位，准备整轮重来', { hardReset: false })
      await sleep(
        Number.isFinite(options.stateResetWaitMs)
          ? options.stateResetWaitMs
          : DFU_STATE_RESET_WAIT_MS
      )
      if (shouldAbort()) {
        throw new Error('OTA_ABORTED')
      }
      otaLog('断链复位完成，整轮重来（第 2 轮）')
      try {
        result = await runDfuAttempt(deviceId, prepared, options)
      } catch (retryError) {
        throw wedgedRetryError(retryError)
      }
    }

    otaLog('====== 固件升级成功 ======', {
      文件字节: prepared.size,
      bin字节: prepared.payloadSize,
      总包数: result && result.totalPackets,
      每包字节: result && result.chunkSize,
      MTU: result && result.mtu
    })
    // 成功同样要收尾：设备约 100ms 后复位，这条连接与本机所有关于它的缓存立刻全部作废（见 resetAfterUpgrade）。
    // await：收尾里含蓝牙栈硬复位，必须在 upgradeFirmware 返回之前落地——否则页面已经显示
    // 「升级成功」、用户马上回详情页点连接，适配器却正在关闭途中，又是一次「连不上」。
    await resetAfterUpgrade(deviceId, '升级成功，设备即将复位')
    return Object.assign({ size: prepared.size, crc32: prepared.crc32 }, result)
  } catch (error) {
    otaWarn('====== 固件升级失败/中断 ======', (error && error.message) || error)
    if (!deviceTouched) {
      // 还没碰过设备就失败了（包下载失败/文件读不出/包本身不合法）：设备与这条连接都完好，
      // 断链清缓存只会白白把用户已有的连接拆掉。打上标记，让页面也别做记录级的收尾复位。
      otaWarn('本轮尚未与设备发生任何交互，保留现有连接与缓存（不做收尾复位）')
      const packageError =
        error instanceof Error ? error : new Error((error && error.message) || 'OTA 升级失败')
      packageError.code = packageError.code || 'OTA_PACKAGE_FAILED'
      packageError.deviceUntouched = true
      // 这类失败的来源是网络/文件/升级包，不是设备：别给它扣「电子纸设备-」的帽子，
      // 否则用户看到「电子纸设备-固件包下载失败(404)」会去排查设备（前缀约定见 prefixDeviceError）。
      throw packageError
    }
    // 失败/中断后必须断开 OTA 链路：设备的 DFU 状态机停在半途，留着同一条连接再 START 必被回
    // 0x05「设备状态错误」——现场实测就是第一次传输超时后，之后每次点升级都是 0x05。
    // 断链让设备自行复位；下次升级由 ota.js 的 ensureConnectedDevice 重新扫连。
    // 同成功路径：await 到硬复位落地再把错误抛给页面（页面一显示失败，用户就会去点重试/回详情页连接）。
    await resetAfterUpgrade(deviceId, '升级失败/中断')
    throw prefixDeviceError(error)
  }
}

function disconnect(deviceId) {
  otaLog('主动断开 OTA 链路（让设备的 DFU 状态机复位）', { deviceId })
  cleanupSession(deviceId, '已主动断开 OTA 连接')
  if (wx.closeBLEConnection && deviceId) {
    // 关链路的结果必须落到日志里：会话账本已经在上面清掉了，若这次 close 静默失败，
    // 这条连接就成了「谁都看不见、谁也关不掉」的无主连接，占着设备使其不再广播
    //（表现为升级失败后怎么都搜不到设备，杀掉小程序才恢复）。
    // 自愈由 device-ble.releaseStrayConnections 在下次扫描前兜底，这里只负责把线索留下。
    wx.closeBLEConnection({
      deviceId,
      fail: error =>
        otaWarn('断开 OTA 链路失败（可能残留无主连接，下次扫描前会被清道夫释放）', {
          deviceId,
          errMsg: (error && error.errMsg) || error
        })
    })
  }
}

// 一轮 OTA 收尾后的统一复位（2026-08-11）：**无论成功还是失败都要走一遍**。
//
// 为什么成功也要清：END 校验通过后设备约 100ms 就复位运行新固件，这条 GATT 连接随即作废。
// 但端上此刻还留着一整套「看着都还在」的状态：
//   · ota-ble 的 OTA 会话（ready=true）；
//   · device-ble 的 FF00 会话——它与 FF10 是**同一条物理连接**，OTA 走的就是它；
//   · device-info 里 0x01 的读数、battery 的 15 秒电量缓存；
//   · device-conn-cache 里「稳定ID → 上次的微信 deviceId」直连句柄。
// 这些残留正是现场那两个偶发症状的来源：升级完回去点「获取设备信息」一直超时（写进了一条死链路，
// 要等微信的断开回调姗姗来迟才作废）、以及紧接着重连时直连快路径拿旧句柄去连一台正在重启的设备。
//
// 失败/中断同样清：设备的 DFU 状态机可能停在半途，链路留着只会让下一次 START 继续被回 0x05。
//
// 全部 best-effort：清缓存失败绝不能影响「这一轮 OTA 到底成没成」的结论。
//
// 2026-08-13（续修 08-12 那轮）：收尾**必须连蓝牙适配器一起复位**（options.hardReset !== false）。
// 现场反馈「升级成功或失败都还是要重进小程序才连得上」——只调 closeBLEConnection 不够：
// 设备在 OTA 收尾这一刻正处于「即将复位/刚被中断」的状态，微信侧常留下一条它自己都报不出来的
// 连接对象（getConnectedBluetoothDevices 按已发现服务筛，半连接根本不在结果里），
// 设备被它占着就不再广播，此后怎么扫都「未搜索到」。closeBluetoothAdapter 才是
// 「重进小程序」的等价物，见 device-ble.resetBluetoothStack。
//
// 返回 Promise（硬复位是异步的）。调用方可 await，也可 fire-and-forget（页面卸载路径）。
// hardReset:false 只用于**升级中途**的断链复位（wedged DFU 整轮重来）：那条路紧接着还要
// 用同一个适配器重连设备，不能把它关掉。
function resetAfterUpgrade(deviceId, reason, options = {}) {
  otaLog(`收尾复位（${reason}）：断开链路并清掉本机所有与这台设备相关的缓存`, { deviceId })
  try {
    disconnect(deviceId)
  } catch (error) {
    // 连接已经没了，忽略
  }
  // 惰性 require：与 ensureOtaConnection 里同一个理由——两个模块互相引用，顶部 require 会拿到半成品。
  try {
    const deviceBle = require('./device-ble')
    deviceBle.disconnect(deviceId) // 同一条物理连接上的 FF00 会话，一并作废
    require('./device-info').clear() // 0x01 读数（张数/掩码/播放配置）随重启全部作废
    require('./battery').forget(deviceId) // 15 秒电量缓存：设备重启后旧值只会误导
  } catch (error) {
    otaWarn('收尾复位时清缓存失败（不影响升级结果）：', (error && error.message) || error)
  }

  if (options.hardReset === false) {
    return Promise.resolve(false)
  }
  try {
    return require('./device-ble')
      .resetBluetoothStack(`OTA 收尾（${reason}）`)
      .catch(error => {
        otaWarn('蓝牙栈硬复位失败（不影响升级结果）：', (error && error.message) || error)
        return false
      })
  } catch (error) {
    otaWarn('蓝牙栈硬复位不可用（不影响升级结果）：', (error && error.message) || error)
    return Promise.resolve(false)
  }
}

function isConnected(deviceId) {
  const session = sessions[deviceId]
  return !!(session && session.ready)
}

// 是否还持有任意 OTA 会话。上层（active-device）在决定「能不能做蓝牙栈硬复位」时要看这一条：
// 升级正在跑就绝不能关适配器。
function hasAnyActiveConnection() {
  return Object.keys(sessions).some(id => sessions[id] && sessions[id].ready)
}

// 清空本模块所有 OTA 会话（只清账本，不发 closeBLEConnection）。
// 专供 device-ble.resetBluetoothStack：适配器一关，这些会话必然全断，账本必须同步作废，
// 否则 isConnected 会谎报「OTA 还连着」，下一轮升级会复用一条已经不存在的会话。
function clearSessions(reason) {
  Object.keys(sessions).forEach(id => cleanupSession(id, reason || 'OTA 会话已作废'))
}

module.exports = {
  OP,
  OTA_SERVICE_UUID,
  OTA_CHAR_UUID,
  OTA_CHAR_CONTROL_UUID,
  OTA_CHAR_DATA_UUID,
  OTA_CHAR_ALT_CONTROL_UUID,
  OTA_HEADER_SIZE,
  OTA_PANELS,
  inspectOtaHeader,
  panelOfDevice,
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
  // 一轮 OTA 的统一收尾（断链 + 清这条链路上的全部缓存）。除 upgradeFirmware 内部的成功/失败/重试
  // 三条路径外，**升级页中断退出时也要调它**：只断 OTA 会话会把 FF00 会话与 0x01/电量读数留在原地，
  // 详情页随后会拿着一条死链路发指令一直超时。
  resetAfterUpgrade,
  isConnected,
  hasAnyActiveConnection,
  clearSessions,
  rebindGlobalListeners,
  setMonitor
}
