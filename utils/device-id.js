// 固件 Device_ID 的统一口径：
// - 稳定设备身份必须来自连接后 0x01 返回的 6 字节 Device_ID；
// - 广播里的 4 字节短 ID、微信 BLE deviceId 均不是完整设备身份；
// - 对外统一使用 AA:BB:CC:DD:EE:FF 格式。
const COMPLETE_HEX_LENGTH = 12

function normalize(value) {
  return String(value == null ? '' : value)
    .replace(/[:\-\s]/g, '')
    .toUpperCase()
}

function isComplete(value) {
  const normalized = normalize(value)
  return (
    /^[0-9A-F]{12}$/.test(normalized) &&
    normalized !== '000000000000' &&
    normalized !== 'FFFFFFFFFFFF'
  )
}

function canonical(value) {
  const normalized = normalize(value)
  if (!isComplete(normalized)) {
    return ''
  }
  return normalized.match(/.{2}/g).join(':')
}

function requireComplete(value, message) {
  const result = canonical(value)
  if (result) {
    return result
  }
  const error = new Error(message || '设备-未读取到完整的6字节设备ID，请重新连接后再试')
  error.code = 'INCOMPLETE_DEVICE_ID'
  throw error
}

module.exports = {
  COMPLETE_HEX_LENGTH,
  normalize,
  isComplete,
  canonical,
  requireComplete
}
