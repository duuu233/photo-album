// 设备名称校验（编辑设备名称 editUserProduct 的前端限制）。
// 规则：去掉首尾空格后长度必须为 1-20 个字符。
// 用 Array.from 按码点计数，避免 emoji、生僻字这类代理对被算成 2 个字符。
// 统一弹窗组件会在输入阶段限制 maxlength，这里仍作为接口提交前的最终校验。

const DEVICE_NAME_MAX_LEN = 20

// 返回 { ok, name, message }：name 是去掉首尾空格的名称，message 是不合法时的提示文案
function validateDeviceName(input) {
  const name = String(input == null ? '' : input).trim()
  const length = Array.from(name).length

  if (length === 0) {
    return { ok: false, name, message: '请输入电子纸设备名称' }
  }
  if (length > DEVICE_NAME_MAX_LEN) {
    return { ok: false, name, message: `电子纸设备名称最多${DEVICE_NAME_MAX_LEN}个字符` }
  }
  return { ok: true, name, message: '' }
}

module.exports = {
  DEVICE_NAME_MAX_LEN,
  validateDeviceName
}
