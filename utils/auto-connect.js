// 自动重连 / 保活管理器。
// 目标：除「用户手动断开」和「物理断开（关蓝牙 / 设备关机 / 走太远）」外，尽量保持与相框的连接，
// 切到别的页面或退后台再回来都能自动接上，无需用户再手动点「连接」。
//
// 触发条件（全部满足才会尝试，否则静默放弃，绝不弹任何授权/失败弹窗）：
//   1) 当前没有任何活动的 BLE 连接；
//   2) 已登录（否则拿不到用户的绑定设备列表）；
//   3) 手机蓝牙已打开（openAdapter 成功）；
//   4) 定位权限「已授权」（用 getSetting 静默判断，未授权就放弃——不打扰，留待用户手动操作时再引导）；
//   5) 没有正在进行的手动扫描（避免两路扫描并发互相干扰）。
//
// 动作：扫描附近相框 → 用 Device_ID(deviceNo) 与绑定设备列表匹配 → 命中即连接、读一次信息、设为当前设备，
// 并通过 onChange 通知页面刷新「已连接」显示。
// 反馈：仅在「匹配命中、真正建立连接」这一小段显示一个 loading；前面的扫描阶段保持静默
//（避免每次进页面都长时间转圈），连上/失败都会关闭。

const api = require('./api')
const bluetooth = require('./bluetooth')
const deviceBle = require('./device-ble')

let running = false // 同一时刻只允许一个自动连接流程
let lastAttemptAt = 0 // 上次尝试时间，做节流避免频繁扫描耗电
const MIN_INTERVAL_MS = 20000 // 两次自动连接尝试的最小间隔

const listeners = [] // 连接结果订阅者（页面据此刷新连接显示）

// 订阅自动连接结果。返回一个取消订阅的函数。重复订阅同一个函数引用会被忽略，不会重复回调。
function onChange(fn) {
  if (typeof fn === 'function' && listeners.indexOf(fn) < 0) {
    listeners.push(fn)
  }
  return () => offChange(fn)
}

function offChange(fn) {
  const index = listeners.indexOf(fn)
  if (index >= 0) {
    listeners.splice(index, 1)
  }
}

function notify(payload) {
  listeners.slice().forEach(fn => {
    try {
      fn(payload)
    } catch (error) {
      // 单个订阅者异常不影响其它订阅者
    }
  })
}

function getToken() {
  try {
    const app = getApp()
    return (app && app.globalData && app.globalData.token) || wx.getStorageSync('token') || ''
  } catch (error) {
    return wx.getStorageSync('token') || ''
  }
}

// 仅当定位权限「已授权」时返回 true。自动连接不主动弹授权，避免打扰；未授权就放弃。
function hasLocationAuth() {
  return new Promise(resolve => {
    if (!wx.getSetting) {
      resolve(false)
      return
    }
    wx.getSetting({
      success: res => resolve(!!(res.authSetting && res.authSetting['scope.userLocation'])),
      fail: () => resolve(false)
    })
  })
}

// 归一化 Device_ID 后比较：去掉冒号/连字符/空格并大写，兼容两侧（后端 vs 蓝牙广播）格式差异。
function normId(value) {
  return String(value == null ? '' : value).replace(/[:\-\s]/g, '').toUpperCase()
}

// 用 Device_ID(deviceNo) 把绑定设备和扫描结果配对，返回 { device, scan }。
// Device_ID 精确匹配优先；都匹配不到再按设备名兜底（扫描结果已按信号排序，同名取最强那台）。
function matchByDeviceId(devices, found) {
  for (let i = 0; i < devices.length; i++) {
    const device = devices[i]
    const serial = normId(device.deviceNo || device.productDeviceId)
    if (!serial) {
      continue
    }
    const scan = found.find(item => normId(item.deviceNo) === serial)
    if (scan) {
      return { device, scan }
    }
  }
  for (let i = 0; i < devices.length; i++) {
    const device = devices[i]
    const name = String(device.name || '').trim()
    if (!name) {
      continue
    }
    const scan = found.find(item => String(item.name || '').trim() === name)
    if (scan) {
      return { device, scan }
    }
  }
  return null
}

// 尝试一次自动连接。options.force=true 时忽略节流（用于「刚物理断开后立即重连」）。
// 返回是否成功连上。全程静默，任何条件不满足/出错都安静返回 false。
async function run(options) {
  const force = !!(options && options.force)

  if (running) {
    return false
  }
  if (!force && Date.now() - lastAttemptAt < MIN_INTERVAL_MS) {
    return false
  }
  if (deviceBle.hasAnyActiveConnection()) {
    return false // 已经连着设备，无需再连
  }
  if (!getToken()) {
    return false // 未登录，拿不到绑定设备列表
  }
  if (bluetooth.isDiscovering()) {
    return false // 有手动扫描在进行，避让，避免两路扫描互相干扰
  }

  running = true
  lastAttemptAt = Date.now()
  let connectedDeviceId = ''

  try {
    // 蓝牙必须已打开：openAdapter 成功即视为已开；失败 = 没开 / 缺系统权限 → 静默放弃
    try {
      await bluetooth.openAdapter()
    } catch (error) {
      return false
    }

    // 定位未授权就放弃（扫描多半也搜不到，且不想弹授权打扰）
    if (!(await hasLocationAuth())) {
      return false
    }

    let devices = []
    try {
      devices = await api.getDevices()
    } catch (error) {
      return false
    }
    if (!devices || !devices.length) {
      return false
    }

    let found = []
    try {
      found = await bluetooth.discoverDevices({ timeout: 6000 })
    } catch (error) {
      return false
    }
    if (!found.length) {
      return false
    }

    // 扫描这几秒里用户可能已手动连上：再判一次，避免重复连接
    if (deviceBle.hasAnyActiveConnection()) {
      return false
    }

    const matched = matchByDeviceId(devices, found)
    if (!matched) {
      return false
    }

    const deviceId = matched.scan.deviceId
    // 已匹配到附近的已绑定设备、开始真正建立连接：给个 loading 作为反馈。
    // 用非遮罩(mask:false)：后台自动动作，给提示但不冻结界面，连接慢/失败也不至于卡住用户操作。
    if (wx.showLoading) {
      wx.showLoading({ title: '正在连接设备…', mask: false })
    }
    try {
      await deviceBle.ensureConnection(deviceId)
      const info = await deviceBle.readDeviceInfo(deviceId)
      connectedDeviceId = deviceId

      // 设为当前选中设备，并带上本次会话的活动 deviceId，供各页面据此显示「已连接」/后续图传复用
      const app = getApp()
      const merged = Object.assign({}, matched.device, {
        deviceId,
        bleDeviceId: deviceId,
        battery: typeof info.battery === 'number' ? info.battery : matched.device.battery
      })
      if (app && app.setSelectedDevice) {
        app.setSelectedDevice(merged)
      }
    } catch (error) {
      deviceBle.disconnect(deviceId) // 连接/读信息失败：释放可能的半连接，放弃，等下次再试
      return false
    } finally {
      if (wx.hideLoading) {
        wx.hideLoading()
      }
    }
  } finally {
    running = false
  }

  if (connectedDeviceId) {
    notify({ connected: true, deviceId: connectedDeviceId })
    return true
  }
  return false
}

module.exports = {
  run,
  onChange,
  offChange
}
