// 相框设备的 BLE 会话层：在 utils/bluetooth.js（底层扫描/适配器）与 frame-protocol.js（编解码）之上，
// 提供「连接 → 发指令 → 收应答」的请求-应答能力，并封装出读设备信息、设电量等业务方法。
//
// 用法（绑定/详情页）：
//   const info = await deviceBle.readDeviceInfo(deviceId)   // 一次拿到电量/播放/屏幕/张数/固件
//   await deviceBle.setPlayback(deviceId, 'random', 60)
//   await deviceBle.disconnect(deviceId)

const protocol = require('./frame-protocol')

// 每台设备一个会话：缓存已发现的服务/特征、接收缓冲区与未完成的请求
const sessions = {}
let globalListenerBound = false

// 微信返回的 UUID 是 128 位全大写串（如 0000FF01-0000-...），只取其中的 16 位短码做匹配
function short16(uuid) {
  return String(uuid || '').toUpperCase().replace(/-/g, '').slice(4, 8)
}

function matchUuid(uuid, shortCode) {
  return short16(uuid) === shortCode
}

function wxp(fn, options) {
  return new Promise((resolve, reject) => {
    fn(Object.assign({}, options, {
      success: resolve,
      fail: error => reject(new Error((error && error.errMsg) || '蓝牙操作失败'))
    }))
  })
}

// 全局只注册一次特征值变化监听，按 deviceId 分发到对应会话
function ensureGlobalListener() {
  if (globalListenerBound || !wx.onBLECharacteristicValueChange) {
    return
  }
  globalListenerBound = true
  wx.onBLECharacteristicValueChange(res => {
    const session = sessions[res.deviceId]
    if (!session) {
      return
    }
    handleNotify(session, res.value)
  })
}

// 处理一次通知数据：追加到接收缓冲，循环解出完整帧并派发给等待中的请求
function handleNotify(session, value) {
  session.rxBuffer = session.rxBuffer.concat(protocol.toBytes(value))

  // 可能粘包/分包：从头不断尝试解帧，解出一帧就消费掉对应字节
  while (session.rxBuffer.length) {
    const parsed = protocol.tryParseFrame(session.rxBuffer)
    if (!parsed) {
      break
    }
    session.rxBuffer = session.rxBuffer.slice(parsed.consumed)

    const frame = parsed.frame
    if (frame.cmd !== protocol.ACK) {
      continue // 目前只关心设备的 ACK 应答
    }
    const ack = protocol.parseAck(frame.payload)
    const pending = session.pending[ack.ackCmd]
    if (!pending) {
      continue // 没有对应的等待者（可能是主动上报），忽略
    }
    delete session.pending[ack.ackCmd]
    clearTimeout(pending.timer)
    if (!frame.crcOk) {
      pending.reject(new Error('应答 CRC 校验失败'))
    } else {
      pending.resolve(ack)
    }
  }
}

// 建立连接并发现 FF00 主服务下的写(FF01)/通知(FF02)特征，开启通知。结果缓存到会话。
async function ensureConnection(deviceId) {
  if (sessions[deviceId] && sessions[deviceId].ready) {
    return sessions[deviceId]
  }

  ensureGlobalListener()
  await wxp(wx.createBLEConnection, { deviceId, timeout: 10000 })

  const servicesRes = await wxp(wx.getBLEDeviceServices, { deviceId })
  const service = (servicesRes.services || []).find(s => matchUuid(s.uuid, protocol.SERVICE_UUID))
  if (!service) {
    throw new Error('未找到相框主服务(FF00)，请确认是相框设备')
  }

  const charsRes = await wxp(wx.getBLEDeviceCharacteristics, { deviceId, serviceId: service.uuid })
  const chars = charsRes.characteristics || []
  const writeChar = chars.find(c => matchUuid(c.uuid, protocol.CHAR_WRITE_UUID))
  const notifyChar = chars.find(c => matchUuid(c.uuid, protocol.CHAR_NOTIFY_UUID))
  if (!writeChar || !notifyChar) {
    throw new Error('未找到读写特征(FF01/FF02)')
  }

  await wxp(wx.notifyBLECharacteristicValueChange, {
    deviceId,
    serviceId: service.uuid,
    characteristicId: notifyChar.uuid,
    state: true
  })

  const session = {
    deviceId,
    serviceId: service.uuid,
    writeCharId: writeChar.uuid,
    notifyCharId: notifyChar.uuid,
    rxBuffer: [],
    pending: {},
    ready: true
  }
  sessions[deviceId] = session
  return session
}

// 发送一条指令并等待设备对应的 ACK；返回 { ackCmd, result, data }
async function request(deviceId, cmd, payload, timeout = 6000) {
  const session = await ensureConnection(deviceId)

  if (session.pending[cmd]) {
    throw new Error(`指令 0x${cmd.toString(16)} 正在等待应答`)
  }

  const ackPromise = new Promise((resolve, reject) => {
    session.pending[cmd] = {
      resolve,
      reject,
      timer: setTimeout(() => {
        delete session.pending[cmd]
        reject(new Error(`指令 0x${cmd.toString(16)} 应答超时`))
      }, timeout)
    }
  })

  await wxp(wx.writeBLECharacteristicValue, {
    deviceId,
    serviceId: session.serviceId,
    characteristicId: session.writeCharId,
    value: protocol.buildFrame(cmd, payload)
  })

  return ackPromise
}

// 读设备信息：CMD=0x01 拿核心信息，再用 CMD=0x03 补固件号（固件失败不阻断主流程）
async function readDeviceInfo(deviceId) {
  const infoAck = await request(deviceId, protocol.CMD.GET_INFO)
  const info = protocol.parseDeviceInfo(infoAck.data)

  try {
    const swAck = await request(deviceId, protocol.CMD.GET_SW_VER)
    info.firmwareVersion = protocol.parseSwVer(swAck.data)
  } catch (error) {
    info.firmwareVersion = ''
  }

  return info
}

// 单独读电量（CMD=0x04），用于详情页刷新
async function readBattery(deviceId) {
  const ack = await request(deviceId, protocol.CMD.GET_BATTERY)
  return protocol.parseBattery(ack.data)
}

// 设置播放模式/间隔（CMD=0x10）
async function setPlayback(deviceId, mode, intervalSeconds) {
  return request(deviceId, protocol.CMD.SET_PLAY, protocol.buildSetPlaybackPayload(mode, intervalSeconds))
}

// 断开连接并清理会话（离开详情/绑定页时调用）
function disconnect(deviceId) {
  const session = sessions[deviceId]
  if (session) {
    Object.keys(session.pending).forEach(key => {
      clearTimeout(session.pending[key].timer)
    })
    delete sessions[deviceId]
  }
  if (wx.closeBLEConnection && deviceId) {
    wx.closeBLEConnection({ deviceId })
  }
}

module.exports = {
  ensureConnection,
  request,
  readDeviceInfo,
  readBattery,
  setPlayback,
  disconnect
}
