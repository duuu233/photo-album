// 「当前选中设备」统一入口。
// 首页 device-swiper 当前展示/选中的那台设备即全局当前设备（app.globalData.selectedDevice，
// 由 home.js 的 onDeviceChange/loadHomeState 维护）。所有需要与固件交互的流程都应先经此
// 确保与该设备建立蓝牙连接，再处理后续逻辑；若确实连不上，则弹窗引导用户去首页切换设备或绑定新设备。
const deviceBle = require('./device-ble')

// 弹窗引导去首页切换设备 / 绑定新设备
function promptSwitchDevice(content) {
  wx.showModal({
    title: '设备未连接',
    content: content || '无法连接当前设备，请前往首页切换设备或绑定新设备',
    confirmText: '去首页',
    cancelText: '取消',
    success(res) {
      if (res.confirm) {
        wx.switchTab({ url: '/pages/home/home' })
      }
    }
  })
}

// 当前选中设备（可能为 null）
function getActiveDevice() {
  const app = getApp()
  return (app && app.globalData && app.globalData.selectedDevice) || null
}

// 确保与「当前选中设备」建立蓝牙连接：
//   成功 -> 返回 device 对象；
//   无选中设备 / 连接失败 -> 弹窗引导去首页，并抛出错误（调用方 catch 到后直接 return 即可）。
// 已在连接中的设备会直接复用，不再重复连接，也不弹「连接设备中」的 loading。
async function ensureActiveDeviceConnection() {
  const device = getActiveDevice()

  if (!device || !device.deviceId) {
    promptSwitchDevice('当前没有可用设备，请前往首页选择或绑定相框设备')
    throw new Error('NO_ACTIVE_DEVICE')
  }

  if (deviceBle.isConnected(device.deviceId)) {
    return device
  }

  wx.showLoading({ title: '连接设备中', mask: true })
  try {
    await deviceBle.ensureConnection(device.deviceId)
    wx.hideLoading()
    return device
  } catch (error) {
    wx.hideLoading()
    promptSwitchDevice('无法连接当前设备，请前往首页切换设备或绑定新设备')
    throw error
  }
}

module.exports = {
  getActiveDevice,
  ensureActiveDeviceConnection,
  promptSwitchDevice
}
