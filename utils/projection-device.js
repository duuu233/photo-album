// 投屏尺寸取设备列表记录；0x01 只提供固件型号/身份/图片掩码，不直接携带宽高。
const protocol = require('./frame-protocol')
const deviceId = require('./device-id')

function validDimension(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return false
  const n = Number(value)
  return Number.isInteger(n) && n > 0 && n <= 0xffff
}

function sameSize(left, right) {
  return (Number(left.width) === Number(right.width) && Number(left.height) === Number(right.height)) ||
    (Number(left.width) === Number(right.height) && Number(left.height) === Number(right.width))
}

function legacyScreenForSize(device) {
  return Object.keys(protocol.SCREEN_TYPES)
    .map(key => protocol.SCREEN_TYPES[key])
    .find(screen => screen.width > 0 && screen.height > 0 && sameSize(device, screen)) || null
}

function configurationError(message) {
  const error = new Error(message)
  error.code = 'DEVICE_TRANSFER_CONFIG'
  return error
}

function resolveTransferInfo(device, info) {
  // 尺寸来自哪条后台记录，必须由刚读回的完整硬件 ID 确认；临时 BLE 句柄和广播名不能证明身份。
  const expected = [device.productDeviceId, device.deviceNo, device.firmwareDeviceId, device.backendDeviceId]
    .map(deviceId.canonical).filter(Boolean)
  const actual = deviceId.canonical(info.deviceId)
  if (!actual || expected.indexOf(actual) === -1) {
    const error = new Error('所选电子纸设备与连接电子纸设备ID不一致，请重新连接后重试')
    error.code = 'DEVICE_ID_MISMATCH'
    throw error
  }
  if (!Number.isInteger(info.screenType) || info.screenType < 0 || info.screenType > 0xff) {
    throw configurationError('电子纸设备返回的屏幕型号无效，请检查设备协议')
  }
  const supplied = value => value !== undefined && value !== null && value !== ''
  const hasDeviceSize = supplied(device.width) || supplied(device.height)
  const size = hasDeviceSize ? device : info
  if (!validDimension(size.width) || !validDimension(size.height)) {
    throw configurationError('电子纸设备分辨率未配置或无效，请检查设备信息后重试')
  }
  const width = Number(size.width)
  const height = Number(size.height)
  if (device.shapeType === 1 && width !== height) {
    throw configurationError('圆形电子纸设备分辨率须为正方形，请检查设备配置')
  }
  const mask = info.imgMask instanceof ArrayBuffer ? new Uint8Array(info.imgMask) : info.imgMask
  // 12 字节 IMG_MASK 最多表达 96 个槽位，不把这个上限宣称为设备实际存储容量。
  const maskSlotLimit = Math.min(96, (mask && mask.length || 0) * 8)
  if (!maskSlotLimit) {
    throw configurationError('电子纸设备图片槽位信息无效，请重新读取设备信息')
  }
  const legacy = legacyScreenForSize({ width, height })
  const capacity = sameSize(info, { width, height }) && Number.isInteger(info.capacity) && info.capacity > 0
    ? Math.min(info.capacity, maskSlotLimit)
    : Math.min(legacy && legacy.capacity || 0, maskSlotLimit)
  return Object.assign({}, info, {
    width,
    height,
    capacity,
    slotLimit: capacity || maskSlotLimit,
    resolutionSource: hasDeviceSize ? 'device-list' : 'legacy-protocol'
  })
}

module.exports = { resolveTransferInfo, legacyScreenForSize }
