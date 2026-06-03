// 电子相框 BLE 协议编解码层（依据《电子相框产品需求规格书 v1.2》第 6 章实现）。
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
  SET_PLAY: 0x10, // 设置播放模式/间隔
  SET_TIME: 0x11, // 校时（同步手机时间到设备 RTC）
  DELETE_IMG: 0x12, // 按位掩码删除图片
  IMG_START: 0x20, // 图传-开始
  IMG_DATA: 0x21, // 图传-数据
  IMG_END: 0x22, // 图传-结束
  IMG_ACK: 0x23, // 图传-批量 ACK
  SET_CUR_IMG: 0x24, // 切换当前显示图片
  ACK: 0x7f // 通用应答
}

// 屏幕类型（6.7.3 / 6.10.7）。capacity = 该尺寸最多可存图片张数（5.2）。
const SCREEN_TYPES = {
  0x01: { label: '3.7寸', model: 'EF6-370', width: 480, height: 720, capacity: 95 },
  0x02: { label: '5.89寸', model: 'EF6-589', width: 680, height: 960, capacity: 51 },
  0x03: { label: '7.3寸', model: 'EF6-730', width: 0, height: 0, capacity: 0 }
}

// 播放模式（6.7.3）：0x00 顺序 / 0x01 随机。其余值保留，按顺序处理。
function playModeToString(value) {
  return value === 0x01 ? 'random' : 'order'
}

function playModeToByte(mode) {
  return mode === 'random' ? 0x01 : 0x00
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
function crc16Modbus(bytes) {
  let crc = 0xffff
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i] & 0xff
    for (let bit = 0; bit < 8; bit++) {
      if (crc & 1) {
        crc = (crc >> 1) ^ 0xa001
      } else {
        crc >>= 1
      }
    }
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
  buildSetPlaybackPayload,
  parseAdvertising,
  bytesToHex,
  toBytes,
  toArrayBuffer
}
