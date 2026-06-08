const protocol = require('./frame-protocol')
const imageCodec = require('./image-codec')

const sessions = {}
let globalListenerBound = false

const OTA_CMD = {
  START: 0x01,
  FINISH: 0x02,
  ABORT: 0x03
}

function wxp(fn, options) {
  return new Promise((resolve, reject) => {
    fn(Object.assign({}, options, {
      success: resolve,
      fail: error => reject(new Error((error && error.errMsg) || '蓝牙操作失败'))
    }))
  })
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function short16(uuid) {
  return String(uuid || '').toUpperCase().replace(/-/g, '').slice(4, 8)
}

function matchUuid(uuid, shortCode) {
  return short16(uuid) === shortCode
}

function toArrayBuffer(bytes) {
  return new Uint8Array(bytes).buffer
}

function pushUint32LE(payload, value) {
  payload.push(value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff)
}

function buildStartPayload(size, crc32) {
  const payload = [OTA_CMD.START]
  pushUint32LE(payload, size >>> 0)
  pushUint32LE(payload, crc32 >>> 0)
  return payload
}

function buildFinishPayload(crc32) {
  const payload = [OTA_CMD.FINISH]
  pushUint32LE(payload, crc32 >>> 0)
  return payload
}

function buildAbortPayload() {
  return [OTA_CMD.ABORT]
}

function pickWriteType(char) {
  const props = char && char.properties ? char.properties : {}

  if (props.writeNoResponse) {
    return 'writeNoResponse'
  }

  return props.write ? 'write' : ''
}

function chunkFromMtu(mtu) {
  const writable = Math.max(20, (mtu || 185) - 3)
  return Math.min(244, writable)
}

function emit(onProgress, patch) {
  if (typeof onProgress === 'function') {
    onProgress(patch)
  }
}

function ensureGlobalListener() {
  if (globalListenerBound || !wx.onBLECharacteristicValueChange) {
    return
  }

  globalListenerBound = true
  wx.onBLECharacteristicValueChange(res => {
    const session = sessions[res.deviceId]

    if (!session || res.characteristicId !== session.controlCharId) {
      return
    }

    const bytes = new Uint8Array(res.value || new ArrayBuffer(0))
    session.controlNotifications.push(bytes)
    session.waiters.splice(0).forEach(wake => wake(bytes))
  })
}

async function negotiateMtu(deviceId) {
  let mtu = 0

  if (wx.setBLEMTU) {
    try {
      const res = await wxp(wx.setBLEMTU, { deviceId, mtu: 247 })
      mtu = res && res.mtu ? res.mtu : mtu
    } catch (error) {
      // iOS often does not support manual MTU negotiation. Fall through.
    }
  }

  if (!mtu && wx.getBLEMTU) {
    try {
      const res = await wxp(wx.getBLEMTU, { deviceId, writeType: 'write' })
      mtu = res && res.mtu ? res.mtu : mtu
    } catch (error) {
      // Use the conservative default below.
    }
  }

  return mtu || 185
}

async function createConnection(deviceId) {
  try {
    await wxp(wx.createBLEConnection, { deviceId, timeout: 12000 })
  } catch (error) {
    if (!/already|connected|已连接/i.test(error.message || '')) {
      throw error
    }
  }
}

async function enableControlNotifyIfSupported(session, char) {
  const props = char && char.properties ? char.properties : {}

  if (!props.notify && !props.indicate) {
    return
  }

  await wxp(wx.notifyBLECharacteristicValueChange, {
    deviceId: session.deviceId,
    serviceId: session.serviceId,
    characteristicId: session.controlCharId,
    state: true
  })
}

async function ensureOtaConnection(deviceId) {
  if (sessions[deviceId] && sessions[deviceId].ready) {
    return sessions[deviceId]
  }

  if (!wx.createBLEConnection) {
    throw new Error('当前微信版本不支持蓝牙 OTA')
  }

  ensureGlobalListener()
  await createConnection(deviceId)

  const servicesRes = await wxp(wx.getBLEDeviceServices, { deviceId })
  const service = (servicesRes.services || []).find(item => matchUuid(item.uuid, protocol.OTA_SERVICE_UUID))

  if (!service) {
    throw new Error('未找到设备 OTA 服务(FF10)')
  }

  const charsRes = await wxp(wx.getBLEDeviceCharacteristics, {
    deviceId,
    serviceId: service.uuid
  })
  const chars = charsRes.characteristics || []
  const controlChar = chars.find(item => matchUuid(item.uuid, protocol.OTA_CHAR_CONTROL_UUID))
  const dataChar = chars.find(item => matchUuid(item.uuid, protocol.OTA_CHAR_DATA_UUID))

  if (!controlChar || !dataChar) {
    throw new Error('未找到 OTA 控制/数据特征(FF11/FF12)')
  }

  const mtu = await negotiateMtu(deviceId)
  const session = {
    deviceId,
    serviceId: service.uuid,
    controlCharId: controlChar.uuid,
    dataCharId: dataChar.uuid,
    controlWriteType: pickWriteType(controlChar),
    dataWriteType: pickWriteType(dataChar),
    controlNotifications: [],
    waiters: [],
    mtu,
    chunkSize: chunkFromMtu(mtu),
    ready: true
  }
  sessions[deviceId] = session
  await enableControlNotifyIfSupported(session, controlChar)
  return session
}

async function writeCharacteristic(session, characteristicId, value, writeType) {
  const params = {
    deviceId: session.deviceId,
    serviceId: session.serviceId,
    characteristicId,
    value
  }

  if (writeType) {
    params.writeType = writeType
  }

  await wxp(wx.writeBLECharacteristicValue, params)
}

async function writeControl(session, payload) {
  await writeCharacteristic(
    session,
    session.controlCharId,
    toArrayBuffer(payload),
    session.controlWriteType
  )
}

async function writeDataChunk(session, chunk) {
  let attempt = 0

  for (;;) {
    try {
      await writeCharacteristic(
        session,
        session.dataCharId,
        toArrayBuffer(chunk),
        session.dataWriteType
      )
      return
    } catch (error) {
      if (++attempt > 4) {
        throw error
      }
      await sleep(80)
    }
  }
}

function mockFirmwareBuffer(size, version) {
  const total = Math.max(1024, Number(size) || 65536)
  const seed = String(version || 'mock')
  const bytes = new Uint8Array(total)

  for (let i = 0; i < total; i++) {
    bytes[i] = (i * 31 + seed.charCodeAt(i % seed.length)) & 0xff
  }

  return bytes.buffer
}

function readDownloadedFile(filePath) {
  return new Promise((resolve, reject) => {
    const fs = wx.getFileSystemManager()
    fs.readFile({
      filePath,
      success: res => resolve(res.data),
      fail: error => reject(new Error((error && error.errMsg) || '读取固件包失败'))
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

async function prepareFirmwarePackage(packageInfo, options = {}) {
  const onProgress = options.onProgress
  emit(onProgress, { phase: 'preparing', percent: 0, message: '准备固件包' })

  let buffer

  if (packageInfo.inlineBase64 && wx.base64ToArrayBuffer) {
    buffer = wx.base64ToArrayBuffer(packageInfo.inlineBase64)
  } else if (packageInfo.mock || !packageInfo.packageUrl) {
    buffer = mockFirmwareBuffer(packageInfo.sizeBytes, packageInfo.version)
  } else {
    emit(onProgress, { phase: 'downloading', percent: 5, message: '下载固件包' })
    const filePath = await downloadFirmware(packageInfo.packageUrl)
    buffer = await readDownloadedFile(filePath)
  }

  const expectedSize = Number(packageInfo.sizeBytes) || 0

  if (expectedSize && buffer.byteLength !== expectedSize) {
    throw new Error(`固件包大小不一致：期望 ${expectedSize} 字节，实际 ${buffer.byteLength} 字节`)
  }

  const bytes = new Uint8Array(buffer)
  const crc32 = imageCodec.crc32Mpeg2(bytes)
  const expectedCrc = normalizeChecksum(packageInfo.checksum)

  if (expectedCrc !== null && expectedCrc !== crc32) {
    throw new Error('固件包校验失败')
  }

  emit(onProgress, {
    phase: 'prepared',
    percent: 10,
    message: '固件包已就绪',
    size: bytes.length,
    crc32
  })

  return {
    buffer,
    size: bytes.length,
    crc32
  }
}

async function simulateUpgrade(packageInfo, options = {}) {
  const onProgress = options.onProgress
  const prepared = await prepareFirmwarePackage(packageInfo, options)
  const total = prepared.size
  const steps = 20

  for (let i = 0; i <= steps; i++) {
    if (options.shouldAbort && options.shouldAbort()) {
      throw new Error('OTA_ABORTED')
    }

    const sent = Math.floor((total * i) / steps)
    emit(onProgress, {
      phase: i === steps ? 'done' : 'transferring',
      percent: Math.min(100, 10 + Math.floor((sent / total) * 90)),
      sent,
      total,
      message: i === steps ? '升级完成' : '模拟 OTA 传输中'
    })
    await sleep(90)
  }

  return {
    size: total,
    crc32: prepared.crc32,
    simulated: true
  }
}

async function upgradeFirmware(deviceId, packageInfo, options = {}) {
  if (options.simulate) {
    return simulateUpgrade(packageInfo, options)
  }

  const onProgress = options.onProgress
  const prepared = await prepareFirmwarePackage(packageInfo, options)
  const bytes = new Uint8Array(prepared.buffer)

  emit(onProgress, { phase: 'connecting', percent: 12, message: '连接 OTA 服务' })
  const session = await ensureOtaConnection(deviceId)

  emit(onProgress, {
    phase: 'starting',
    percent: 15,
    message: `开始 OTA，MTU ${session.mtu}，每包 ${session.chunkSize} 字节`
  })
  await writeControl(session, buildStartPayload(bytes.length, prepared.crc32))
  await sleep(options.startDelay || 180)

  const total = bytes.length
  const pace = Number.isFinite(options.pace) ? Math.max(0, options.pace) : 20
  let sent = 0

  while (sent < total) {
    if (options.shouldAbort && options.shouldAbort()) {
      await writeControl(session, buildAbortPayload())
      throw new Error('OTA_ABORTED')
    }

    const end = Math.min(sent + session.chunkSize, total)
    await writeDataChunk(session, bytes.subarray(sent, end))
    sent = end

    emit(onProgress, {
      phase: 'transferring',
      percent: Math.min(98, 15 + Math.floor((sent / total) * 83)),
      sent,
      total,
      message: `OTA传输中：${sent}/${total} 字节`
    })

    if (pace > 0) {
      await sleep(pace)
    }
  }

  emit(onProgress, { phase: 'finishing', percent: 99, sent, total, message: '写入完成，等待设备校验' })
  await writeControl(session, buildFinishPayload(prepared.crc32))
  await sleep(options.finishDelay || 800)
  emit(onProgress, { phase: 'done', percent: 100, sent, total, message: '升级完成' })

  return {
    size: total,
    crc32: prepared.crc32,
    mtu: session.mtu,
    chunkSize: session.chunkSize
  }
}

function disconnect(deviceId) {
  const session = sessions[deviceId]

  if (session) {
    session.waiters.splice(0)
    delete sessions[deviceId]
  }

  if (wx.closeBLEConnection && deviceId) {
    wx.closeBLEConnection({ deviceId })
  }
}

module.exports = {
  OTA_CMD,
  prepareFirmwarePackage,
  upgradeFirmware,
  disconnect
}
