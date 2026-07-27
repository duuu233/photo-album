// 电子相框 BLE 协议编解码层（依据《电子相框产品需求规格书 v1.4》第 6 章实现）。
// 纯函数、无副作用，便于单测；与具体的微信蓝牙 API 解耦，由 utils/device-ble.js 调用。
//
// 串行帧格式（6.4.1）：
//   SOF(1=0xAA) | CMD(1) | LEN(2, 小端 = PAYLOAD 字节数) | PAYLOAD(N) | CRC16(2, CRC16-Modbus, 覆盖 SOF~PAYLOAD)
// 设备应答统一为 CMD=0x7F 的 ACK 帧，其 PAYLOAD = ACK_CMD(1) + RESULT(1) + 数据（6.6.1）。

const SOF = 0xAA
const ACK = 0x7F

// GATT UUID（6.3）。微信返回的是 128 位全 UUID，匹配时只取其中的 16 位短码（见 device-ble.js）。
const SERVICE_UUID = 'FF00' // 主服务
const CHAR_WRITE_UUID = 'FF01' // APP → 设备：写指令
const CHAR_NOTIFY_UUID = 'FF02' // 设备 → APP：通知应答
const OTA_SERVICE_UUID = 'FF10'
const OTA_CHAR_CONTROL_UUID = 'FF11'
const OTA_CHAR_DATA_UUID = 'FF12'

// 命令字（6.5 / 6.7）
const CMD = {
  GET_INFO: 0x01, // 获取设备信息（电量/播放/屏幕/图位等一次性返回）
  GET_PLAY: 0x02, // 获取播放参数
  GET_SW_VER: 0x03, // 获取软件版本（固件号字符串）
  GET_BATTERY: 0x04, // 获取电量
  GET_CONN_INTERVAL: 0x05, // 获取 BLE 连接间隔（v1.4）
  SET_PLAY: 0x10, // 设置播放模式/间隔
  SET_TIME: 0x11, // 校时（同步手机时间到设备 RTC）
  DELETE_IMG: 0x12, // 按位掩码删除图片
  SET_CONN_INTERVAL: 0x13, // 设置 BLE 连接间隔（v1.4）
  IMG_START: 0x20, // 图传-开始
  IMG_DATA: 0x21, // 图传-数据
  IMG_END: 0x22, // 图传-结束
  IMG_ACK: 0x23, // 图传-批量 ACK
  SET_CUR_IMG: 0x24, // 切换当前显示图片
  ACK: 0x7f // 通用应答
}

// BLE 连接间隔（v1.4）：CONN_INTERVAL 为 2 字节小端，单位 1.25ms，范围 6~3200。
const CONN_INTERVAL_UNIT_MS = 1.25
const CONN_INTERVAL_MIN_UNITS = 6
const CONN_INTERVAL_MAX_UNITS = 3200

// 屏幕类型（6.7.3 / 6.10.7）。capacity = 该尺寸最多可存图片张数（5.2）。
const SCREEN_TYPES = {
  0x01: { label: '3.7寸', model: 'EF6-370', width: 480, height: 720, capacity: 95 },
  0x02: { label: '5.89寸', model: 'EF6-589', width: 680, height: 960, capacity: 51 },
  0x03: { label: '7.3寸', model: 'EF6-730', width: 0, height: 0, capacity: 0 }
}

// 播放模式（6.7.3）：0x00 顺序 / 0x01 随机 / 0x02 手动。
const PLAY_MODES = { 0x00: 'order', 0x01: 'random', 0x02: 'manual' }
const PLAY_MODE_BYTES = { order: 0x00, random: 0x01, manual: 0x02 }

function playModeToString(value) {
  return PLAY_MODES[value] || 'order'
}

function playModeToByte(mode) {
  return PLAY_MODE_BYTES[mode] !== undefined ? PLAY_MODE_BYTES[mode] : 0x00
}

// ── 基础工具 ──────────────────────────────────────────────

// 把 ArrayBuffer / 类数组统一成普通数字数组，便于处理
function toBytes(input) {
  if (!input) {
    return []
  }
  if (input instanceof ArrayBuffer) {
    return Array.from(new Uint8Array(input))
  }
  return Array.from(input)
}

function toArrayBuffer(bytes) {
  return new Uint8Array(bytes).buffer
}

function bytesToHex(input) {
  return toBytes(input)
    .map(b => b.toString(16).padStart(2, '0').toUpperCase())
    .join(' ')
}

function readUint16LE(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8)) >>> 0
}

function readUint32LE(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0
}

// 6 字节 Device_ID 转成大写十六进制串（如 12:34:56:78:9A:BC）
function bytesToId(bytes, start, length) {
  const parts = []
  for (let i = 0; i < length; i++) {
    parts.push((bytes[start + i] || 0).toString(16).padStart(2, '0').toUpperCase())
  }
  return parts.join(':')
}

// 统计 IMG_MASK 中置位的比特数 = 设备上已有图片张数
function popcount(bytes, start, length) {
  let count = 0
  for (let i = 0; i < length; i++) {
    let v = bytes[start + i] || 0
    while (v) {
      count += v & 1
      v >>= 1
    }
  }
  return count
}

// CRC16-Modbus：初值 0xFFFF，多项式 0xA001（反转），覆盖 SOF~PAYLOAD（6.4.1）。
// 注意：帧内按低字节在前（LSB first）写入，与 Modbus 惯例一致；若真机校验不过，优先怀疑此字节序。
// 查表实现（性能优化 D1）：图传一张要对上千个 0x21 帧算 CRC16，逐位版在发送热路径上；
// 表按同一多项式生成，结果与逐位版完全一致。入参数组 / Uint8Array 均可。
const CRC16_MODBUS_TABLE = (() => {
  const table = new Uint16Array(256)
  for (let n = 0; n < 256; n++) {
    let crc = n
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? (crc >> 1) ^ 0xa001 : crc >> 1
    }
    table[n] = crc
  }
  return table
})()

function crc16Modbus(bytes) {
  let crc = 0xffff
  for (let i = 0; i < bytes.length; i++) {
    crc = (crc >> 8) ^ CRC16_MODBUS_TABLE[(crc ^ bytes[i]) & 0xff]
  }
  return crc & 0xffff
}

// ── 组帧 / 解帧 ───────────────────────────────────────────

// 组一帧待发送数据，返回 ArrayBuffer（可直接喂给 wx.writeBLECharacteristicValue）
function buildFrame(cmd, payload) {
  const body = [SOF, cmd & 0xff, 0, 0]
  const data = toBytes(payload)
  body[2] = data.length & 0xff
  body[3] = (data.length >> 8) & 0xff
  for (let i = 0; i < data.length; i++) {
    body.push(data[i] & 0xff)
  }
  const crc = crc16Modbus(body)
  body.push(crc & 0xff, (crc >> 8) & 0xff)
  return toArrayBuffer(body)
}

// 从字节流头部尝试解出一帧。返回 { frame, consumed } 或 null（数据不足/帧头不对）。
// frame = { cmd, payload(数组), crcOk }；用于通知数据可能分包/粘包时的流式解析。
function tryParseFrame(input) {
  const bytes = toBytes(input)
  if (bytes.length < 6) {
    return null // 至少 SOF+CMD+LEN(2)+CRC(2)
  }
  if (bytes[0] !== SOF) {
    return null
  }
  const len = readUint16LE(bytes, 2)
  const total = 4 + len + 2
  if (bytes.length < total) {
    return null // 整帧还没收齐
  }
  const cmd = bytes[1]
  const payload = bytes.slice(4, 4 + len)
  const crcGot = readUint16LE(bytes, 4 + len)
  const crcCalc = crc16Modbus(bytes.slice(0, 4 + len))
  return {
    frame: { cmd, payload, crcOk: crcGot === crcCalc },
    consumed: total
  }
}

// 把一帧 ACK 的 PAYLOAD 拆成 { ackCmd, result, data }（6.6.1）
function parseAck(payload) {
  const bytes = toBytes(payload)
  return {
    ackCmd: bytes[0],
    result: bytes[1],
    data: bytes.slice(2)
  }
}

// ── 业务字段解析 ──────────────────────────────────────────

// 解析 CMD=0x01 设备信息的 data 段（ACK 去掉 ackCmd/result 后的 28 字节，6.7.3）
function parseDeviceInfo(data) {
  const b = toBytes(data)
  if (b.length < 28) {
    throw new Error(`设备信息长度不足：期望28字节，实际${b.length}字节`)
  }
  const screenType = b[26]
  const screen = SCREEN_TYPES[screenType] || {}
  const imgCount = popcount(b, 8, 12)
  return {
    deviceId: bytesToId(b, 0, 6),
    hwVersion: readUint16LE(b, 6),
    imgMask: b.slice(8, 20),
    imgCount,
    battery: b[20],
    playMode: playModeToString(b[21]),
    intervalSeconds: readUint32LE(b, 22),
    screenType,
    screen: screen.label || '',
    model: screen.model || '',
    capacity: screen.capacity || 0,
    width: screen.width || 0,
    height: screen.height || 0,
    curImgIndex: b[27]
  }
}

// 解析 CMD=0x03 软件版本：64 字节 ASCII，遇 \0 截断（6.7.5）
function parseSwVer(data) {
  const b = toBytes(data)
  let str = ''
  for (let i = 0; i < b.length; i++) {
    if (b[i] === 0) {
      break
    }
    str += String.fromCharCode(b[i])
  }
  return str.trim()
}

// 解析 CMD=0x04 电量：1 字节 0~100（6.7.6）
function parseBattery(data) {
  return toBytes(data)[0]
}

function connectionIntervalUnitsToMs(units) {
  const value = Number(units) || 0
  return Number((value * CONN_INTERVAL_UNIT_MS).toFixed(2))
}

function connectionIntervalMsToUnits(ms) {
  const value = Number(ms)
  if (!Number.isFinite(value)) {
    return 0
  }
  return Math.round(value / CONN_INTERVAL_UNIT_MS)
}

function parseConnectionInterval(data) {
  const b = toBytes(data)
  const units = b.length >= 2 ? readUint16LE(b, 0) : 0
  return {
    units,
    ms: connectionIntervalUnitsToMs(units)
  }
}

// 组 CMD=0x10 设置播放参数的 PAYLOAD：PLAY_MODE(1) + INTERVAL(4, 小端)（6.7.7）
function buildSetPlaybackPayload(mode, intervalSeconds) {
  const interval = Number(intervalSeconds) || 0
  return [
    playModeToByte(mode),
    interval & 0xff,
    (interval >> 8) & 0xff,
    (interval >> 16) & 0xff,
    (interval >> 24) & 0xff
  ]
}

// 组 CMD=0x13 设置 BLE 连接间隔的 PAYLOAD：CONN_INTERVAL(2, 小端)，单位 1.25ms。
function buildSetConnectionIntervalPayload(units) {
  const value = Number(units) || 0
  return [
    value & 0xff,
    (value >> 8) & 0xff
  ]
}

// ── 结果码（6.6.1）──────────────────────────────────────────
// 设备 ACK 里的 RESULT 字节含义。联调时把数字翻译成人话，方便排查。
const RESULT_TEXT = {
  0x00: '成功',
  0x01: '参数错误',
  0x02: '长度错误',
  0x03: 'CRC 错误',
  0x04: 'Flash 写入失败',
  0x05: '图片不存在',
  0x06: '存储空间不足',
  0x07: '掩码不一致(该位置已有图/索引越界)',
  0x08: '不支持的命令',
  0x09: '传输中断',
  0x0a: '校验失败(整图CRC32不符)',
  0x0b: '设备忙(Busy)'
}

function resultText(code) {
  const text = RESULT_TEXT[code]
  return text ? text : `未知结果码 0x${(code || 0).toString(16).padStart(2, '0')}`
}

// 设备忙（v1.5 §6.6.1）：设备正忙于处理其它指令时，对新指令回 RESULT=0x0B。
// BUSY_MESSAGE 是面向用户的统一提示；所有和设备交互的判断（device-ble.js 的 request() 集中拦截）
// 一旦收到任意指令的 0x0B 应答，都用它提示，避免各处各写一套文案。
const RESULT_BUSY = 0x0b
const BUSY_MESSAGE = '当前设备繁忙，请稍后重试'

// 判断一个 RESULT 结果码是否为「设备忙」。
function isBusyResult(code) {
  return (code & 0xff) === RESULT_BUSY
}

// ── 小端写入工具（组帧时把多字节数字按低字节在前压入数组）──
function pushUint16LE(arr, value) {
  arr.push(value & 0xff, (value >> 8) & 0xff)
}

function pushUint32LE(arr, value) {
  arr.push(value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff)
}

// ── 图片掩码 ⇄ 索引互转（6.7.2 / 6.9.1）────────────────────
// IMG_MASK 是 12 字节(96 位)，低字节在前；第 n 张图占第 n 位（bit0 在第 0 字节最低位）。
// 把图片索引数组转成 12 字节掩码，用于 0x12 删除图片的 IMG_INDEX_MASK。
function indexesToMask(indexes) {
  const mask = new Array(12).fill(0)
  ;(indexes || []).forEach(index => {
    const i = Number(index)
    if (i >= 0 && i < 96) {
      mask[i >> 3] |= 1 << (i & 7) // i>>3 定位字节，i&7 定位字节内的位
    }
  })
  return mask
}

// 把 12 字节掩码展开成已存在图片的索引数组（升序）
function maskToIndexes(maskBytes) {
  const b = toBytes(maskBytes)
  const list = []
  for (let i = 0; i < 96; i++) {
    if ((b[i >> 3] || 0) & (1 << (i & 7))) {
      list.push(i)
    }
  }
  return list
}

// 在容量范围内找到第一个空闲（未被占用）的图片索引；找不到返回 -1。上传新图时用它选槽位。
function firstFreeIndex(maskBytes, capacity) {
  const b = toBytes(maskBytes)
  const max = capacity || 96
  for (let i = 0; i < max; i++) {
    if (!((b[i >> 3] || 0) & (1 << (i & 7)))) {
      return i
    }
  }
  return -1
}

// ── 各命令的 PAYLOAD 组装 / 解析 ──────────────────────────

// 解析 CMD=0x02 播放配置应答的 data 段：PLAY_MODE(1) + INTERVAL(4, 小端)（6.7.4）
function parsePlayConfig(data) {
  const b = toBytes(data)
  return {
    playMode: playModeToString(b[0]),
    playModeByte: b[0],
    intervalSeconds: readUint32LE(b, 1)
  }
}

// 组 CMD=0x11 设置系统时间的 PAYLOAD：YEAR(2,小端) MONTH DAY HOUR MIN SEC（6.7.8）
// 入参可传 JS Date；默认用手机当前时间给设备校时。
function buildSetTimePayload(date) {
  const d = date instanceof Date ? date : new Date()
  const payload = []
  pushUint16LE(payload, d.getFullYear())
  payload.push(d.getMonth() + 1) // JS 月份从 0 开始，协议要 1~12
  payload.push(d.getDate())
  payload.push(d.getHours())
  payload.push(d.getMinutes())
  payload.push(d.getSeconds())
  return payload
}

// 解析「带掩码」类应答的 data 段（0x10 设置播放 / 0x12 删除图片）：返回更新后的 12 字节 IMG_MASK
function parseMaskResult(data) {
  const b = toBytes(data)
  return { imgMask: b.slice(0, 12) }
}

// 解析 CMD=0x24 屏幕刷新应答的 data 段：CUR_IMG_INDEX(1)（6.7.10）
function parseRefreshResult(data) {
  return { curImgIndex: toBytes(data)[0] }
}

// 组 CMD=0x20 图片帧头 PAYLOAD（6.8.1）：
// SCREEN_TYPE(1) IMG_INDEX(1) WIDTH(2,小端) HEIGHT(2,小端) FORMAT(1) IMG_DATA_SIZE(4,小端) IMG_CRC32(4,小端)
// 共 15 字节。format 固件目前只支持 0x01（六色 4bpp 原始帧缓存）。
function buildImgStartPayload(options) {
  const payload = []
  payload.push(options.screenType & 0xff)
  payload.push(options.index & 0xff)
  pushUint16LE(payload, options.width)
  pushUint16LE(payload, options.height)
  payload.push((options.format || 0x01) & 0xff)
  pushUint32LE(payload, options.dataSize)
  pushUint32LE(payload, options.crc32) // 整图 CRC32-MPEG2，低字节在前
  return payload
}

// 组 CMD=0x21 图片数据包 PAYLOAD（6.8.2）：PKT_SEQ(2,小端) + DATA(本片最多 236 字节)
function buildImgDataPayload(seq, chunk) {
  const payload = []
  pushUint16LE(payload, seq)
  const bytes = toBytes(chunk)
  for (let i = 0; i < bytes.length; i++) {
    payload.push(bytes[i] & 0xff)
  }
  return payload
}

// 组一帧完整的 CMD=0x21 图片数据帧（性能优化 D1，含 SOF/LEN/CRC16，返回 ArrayBuffer 可直接写特征）。
// 字节与 buildFrame(CMD.IMG_DATA, buildImgDataPayload(seq, chunk)) 完全一致，但用 Uint8Array 整块
// set + 查表 CRC16，免去逐字节 push 的多次数组复制——一张图要组上千帧，这条路径在图传热路径/预组包上。
// data: 整图 Uint8Array；seq: 包号（0 起）；chunkSize: 每包数据字节数（末包自动截短）。
function buildImgDataFrame(data, seq, chunkSize) {
  const start = seq * chunkSize
  const end = Math.min(start + chunkSize, data.length)
  const payloadLen = end - start + 2 // PKT_SEQ(2) + DATA
  const frame = new Uint8Array(4 + payloadLen + 2) // SOF+CMD+LEN(2) + PAYLOAD + CRC16(2)
  frame[0] = SOF
  frame[1] = CMD.IMG_DATA
  frame[2] = payloadLen & 0xff
  frame[3] = (payloadLen >> 8) & 0xff
  frame[4] = seq & 0xff
  frame[5] = (seq >> 8) & 0xff
  frame.set(data.subarray(start, end), 6)
  const crc = crc16Modbus(frame.subarray(0, frame.length - 2))
  frame[frame.length - 2] = crc & 0xff
  frame[frame.length - 1] = (crc >> 8) & 0xff
  return frame.buffer
}

// 解析 CMD=0x23 图传应答（6.6.2）：ACK_SEQ(2,小端) = 已连续收到的最后一个包号
function parseImgAck(payload) {
  return { ackSeq: readUint16LE(toBytes(payload), 0) }
}

// 解析 CMD=0x22 结束传输应答的 data 段（6.8.4）：IMG_MASK(12) + IMG_COUNT(2,小端) + STORAGE_FREE(4,小端)
function parseImgEndResult(data) {
  const b = toBytes(data)
  return {
    imgMask: b.slice(0, 12),
    imgCount: readUint16LE(b, 12),
    storageFree: readUint32LE(b, 14)
  }
}

// 解析广播包里的厂商自定义数据（6.10.7）：Company_ID(2=0xFFFF) + Screen_Type(1) + Device_ID(4) + Battery(1)。
// 微信的 advertisData 是否含 2 字节 Company_ID 各平台略有差异，这里两种偏移都试，命中合法值即采用。
function parseAdvertising(advertisData) {
  const b = toBytes(advertisData)

  const attempt = offset => {
    const screenType = b[offset]
    const battery = b[offset + 5]
    if (!SCREEN_TYPES[screenType] || battery === undefined || battery > 100) {
      return null
    }
    const screen = SCREEN_TYPES[screenType]
    return {
      screenType,
      screen: screen.label,
      model: screen.model,
      deviceId: bytesToId(b, offset + 1, 4),
      battery
    }
  }

  // 含 Company_ID：前两字节为 0xFF 0xFF，则从第 2 字节起为 Screen_Type
  if (b[0] === 0xff && b[1] === 0xff) {
    const withId = attempt(2)
    if (withId) {
      return withId
    }
  }
  return attempt(0)
}

module.exports = {
  SOF,
  ACK,
  CMD,
  CONN_INTERVAL_UNIT_MS,
  CONN_INTERVAL_MIN_UNITS,
  CONN_INTERVAL_MAX_UNITS,
  SERVICE_UUID,
  CHAR_WRITE_UUID,
  CHAR_NOTIFY_UUID,
  OTA_SERVICE_UUID,
  OTA_CHAR_CONTROL_UUID,
  OTA_CHAR_DATA_UUID,
  SCREEN_TYPES,
  playModeToString,
  playModeToByte,
  crc16Modbus,
  buildFrame,
  tryParseFrame,
  parseAck,
  parseDeviceInfo,
  parseSwVer,
  parseBattery,
  connectionIntervalUnitsToMs,
  connectionIntervalMsToUnits,
  parseConnectionInterval,
  buildSetPlaybackPayload,
  buildSetConnectionIntervalPayload,
  parseAdvertising,
  RESULT_TEXT,
  resultText,
  RESULT_BUSY,
  BUSY_MESSAGE,
  isBusyResult,
  indexesToMask,
  maskToIndexes,
  firstFreeIndex,
  parsePlayConfig,
  buildSetTimePayload,
  parseMaskResult,
  parseRefreshResult,
  buildImgStartPayload,
  buildImgDataPayload,
  buildImgDataFrame,
  parseImgAck,
  parseImgEndResult,
  bytesToHex,
  toBytes,
  toArrayBuffer
}
