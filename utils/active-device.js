// 「当前选中设备」统一入口 + 「操作前确保设备已连接」。
// 首页 device-swiper 当前展示/选中的那台设备即全局当前设备(app.globalData.selectedDevice，由 home.js 维护)。
// 所有需要与固件交互的操作(设置轮播 / 一键删除 / 删除照片 / 刷新屏幕 / 进入固件升级等)都应先经此确保已连接：
//   已连接 -> 直接用；断联 -> 「自动重连」(扫描匹配→连接)，连不上再提示。
// 为何断联要重扫再连：微信 BLE deviceId 是「本次扫描会话」临时分配的，后端只存序列号，
//   直接拿旧 deviceId ensureConnection 多半失败，必须先重扫拿到当下有效 deviceId 再连。
const deviceBle = require('./device-ble')
const bluetooth = require('./bluetooth')
const permission = require('./permission')
const toast = require('./toast')

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

// 是否已有可用连接（有有效 bleDeviceId 且底层会话就绪）
function isDeviceConnected(device) {
  const id = device && (device.deviceId || device.bleDeviceId)
  return !!(id && deviceBle.isConnected(id))
}

// 序列号(deviceNo/productDeviceId)优先、名称兜底，从扫描结果里匹配出这台设备当下有效的 deviceId。
function matchScannedDevice(found, device) {
  const list = found || []
  const serial = String((device && (device.deviceNo || device.productDeviceId)) || '').trim()
  if (serial) {
    const bySerial = list.find(item => String(item.deviceNo || '').trim() === serial)
    if (bySerial) {
      return bySerial
    }
  }
  const name = String((device && device.name) || '').trim()
  if (name) {
    const byName = list.find(item => String(item.name || '').trim() === name)
    if (byName) {
      return byName
    }
  }
  return null
}

// 重连成功后，若这台正是全局选中设备，用当下有效 deviceId 刷新它（deviceId 每次扫描会变）。
function syncActiveDeviceId(device, deviceId) {
  try {
    const app = getApp()
    const selected = app && app.globalData && app.globalData.selectedDevice
    if (!selected || typeof app.setSelectedDevice !== 'function') {
      return
    }
    const sameById = device && device.id && selected.id && String(device.id) === String(selected.id)
    const sameBySerial =
      device && device.deviceNo && selected.deviceNo && String(device.deviceNo) === String(selected.deviceNo)
    if (sameById || sameBySerial) {
      app.setSelectedDevice(Object.assign({}, selected, { deviceId, bleDeviceId: deviceId, connected: true }))
    }
  } catch (error) {
    // 同步失败不影响连接结果
  }
}

// 确保这台设备已连接，未连接则自动重连(定位→openAdapter→扫描匹配→连接)。
// 返回连上的当下有效 deviceId；连不上抛错(error.code 保留，如 PERMISSION_DENIED)。
// 已连接：直接返回，不弹 loading。未连接：默认弹「连接设备中」loading（options.showLoading:false 可关）。
async function ensureDeviceConnected(device, options = {}) {
  const existingId = device && (device.deviceId || device.bleDeviceId)
  if (existingId && deviceBle.isConnected(existingId)) {
    return existingId
  }
  const showLoading = options.showLoading !== false
  if (showLoading) {
    wx.showLoading({ title: '连接设备中', mask: true })
  }
  try {
    const location = await permission.getCurrentLocation()
    if (!location) {
      throw new Error('请先授权定位后再连接')
    }
    await bluetooth.openAdapter()
    const found = await bluetooth.discoverDevices({ timeout: 6000 })
    const target = matchScannedDevice(found, device)
    if (!target) {
      throw new Error('未搜索到该设备，请确认设备已开机并在附近')
    }
    await deviceBle.ensureConnection(target.deviceId)
    syncActiveDeviceId(device, target.deviceId)
    return target.deviceId
  } finally {
    if (showLoading) {
      wx.hideLoading()
    }
  }
}

// 操作前确保已连接（未连接自动重连）。成功返回有效 deviceId；失败按标准 UI 提示并返回 ''（调用方据此 return）。
// 提示规则：系统级「附近设备」权限被拒 → 弹系统设置引导；其它失败 → toast「请先连接设备」。
async function ensureConnectedForAction(device) {
  if (!device || !(device.deviceId || device.bleDeviceId || device.deviceNo || device.name)) {
    toast.warn({ title: '请先连接设备', icon: 'none' })
    return ''
  }
  try {
    return await ensureDeviceConnected(device)
  } catch (error) {
    if (error && error.code === 'PERMISSION_DENIED') {
      bluetooth.showPermissionGuide()
    } else {
      toast.warn({ title: '请先连接设备', icon: 'none' })
    }
    return ''
  }
}

// 确保与「当前选中设备」建立连接（未连接自动重连）。
//   成功 -> 返回 device(带当下有效 deviceId)；
//   无选中设备 / 连接失败 -> 弹窗引导去首页，并抛出错误（调用方 catch 到后直接 return 即可）。
async function ensureActiveDeviceConnection() {
  const device = getActiveDevice()

  if (!device || !(device.deviceId || device.bleDeviceId || device.deviceNo || device.name)) {
    promptSwitchDevice('当前没有可用设备，请前往首页选择或绑定相框设备')
    throw new Error('NO_ACTIVE_DEVICE')
  }

  if (isDeviceConnected(device)) {
    return device
  }

  try {
    const deviceId = await ensureDeviceConnected(device)
    return Object.assign({}, device, { deviceId, bleDeviceId: deviceId, connected: true })
  } catch (error) {
    promptSwitchDevice('无法连接当前设备，请前往首页切换设备或绑定新设备')
    throw error
  }
}

module.exports = {
  getActiveDevice,
  isDeviceConnected,
  matchScannedDevice,
  ensureDeviceConnected,
  ensureConnectedForAction,
  ensureActiveDeviceConnection,
  promptSwitchDevice
}
