const protocol = require('./frame-protocol')

// 保存当前的“发现设备”监听回调引用，停止搜索时用它来精确解绑（off 需要传入同一函数引用）
let foundHandler = null

// 仅保留目标相框：按广播名（name / localName）做白名单筛选，其余蓝牙设备一律不进搜索结果。
//   3.7 寸：EF6-370    5.89 寸：EF6-589
// 屏幕类型/电量若广播包带了厂商数据就顺带解析出来（frame-protocol.parseAdvertising）。
const ALLOWED_BROADCAST_NAMES = ['EF6-370', 'EF6-589']

// 广播名是否命中白名单：大小写不敏感，允许带前后缀，故用包含匹配。
// name 与 localName 都查，因为真机有时只在后续广播包里带上 localName。
function isAllowedFrame(device) {
  const name = `${device.name || ''} ${device.localName || ''}`.toUpperCase()
  return ALLOWED_BROADCAST_NAMES.some(allowed => name.indexOf(allowed) > -1)
}

// 检测当前微信运行环境是否具备完整的蓝牙搜索能力
function canUseBluetooth() {
  return Boolean(wx.openBluetoothAdapter && wx.startBluetoothDevicesDiscovery && wx.onBluetoothDeviceFound)
}

// 是否运行在鸿蒙系统(含纯血鸿蒙 HarmonyOS NEXT，如 Mate 系列)。
// 鸿蒙把蓝牙扫描的「附近设备」权限独立管控，且存在「权限全开仍打不开/搜不到」的兼容问题，
// 需要给用户单独的引导文案(关开权限 + 彻底重启微信)。
function isHarmonyOS() {
  try {
    // getDeviceInfo 为新接口，旧基础库降级到 getSystemInfoSync
    const info = (wx.getDeviceInfo ? wx.getDeviceInfo() : wx.getSystemInfoSync()) || {}
    const flag = `${info.system || ''} ${info.platform || ''}`.toLowerCase()
    return flag.indexOf('harmony') > -1 || flag.indexOf('ohos') > -1
  } catch (e) {
    return false
  }
}

// 微信本体的系统级蓝牙权限入口路径(用于引导文案)。鸿蒙与安卓的设置层级不同。
function systemSettingsPath() {
  return isHarmonyOS()
    ? '设置 → 应用和元服务 → 应用管理 → 微信 → 权限'
    : '设置 → 应用 → 微信 → 权限'
}

// openBluetoothAdapter 失败原因归一化：区分「蓝牙没开」「系统权限没给」「其它」，
// 给「系统权限没给」打上 PERMISSION_DENIED 标记，让页面层弹出系统设置引导。
// 注意：permission not grant / system permission denied(errno:3) 指的是「微信本体」缺少
// 系统级「附近设备」权限(安卓12+/鸿蒙把蓝牙扫描权限独立出来)，小程序没有蓝牙 scope，
// 无法弹窗申请，只能引导用户去系统设置手动开。
function describeAdapterError(error) {
  const errMsg = ((error && error.errMsg) || '').toLowerCase()
  const errCode = error && error.errCode

  // 10001：系统蓝牙不可用，绝大多数是没开手机蓝牙开关
  if (errCode === 10001 || errMsg.indexOf('not available') > -1) {
    return { code: 'UNAVAILABLE', message: '请先打开手机蓝牙开关' }
  }

  // 系统级权限被拒：permission not grant / system permission denied / errno:3
  if (
    errMsg.indexOf('permission not grant') > -1 ||
    errMsg.indexOf('permission denied') > -1 ||
    (error && error.errno === 3)
  ) {
    return { code: 'PERMISSION_DENIED', message: '微信缺少「附近设备」权限，请在系统设置中开启' }
  }

  return { code: 'UNKNOWN', message: (error && error.errMsg) || '蓝牙初始化失败' }
}

function openAdapter() {
  return new Promise((resolve, reject) => {
    if (!wx.openBluetoothAdapter) {
      reject(new Error('当前微信版本不支持蓝牙能力'))
      return
    }

    wx.openBluetoothAdapter({
      success: resolve,
      fail(error) {
        const detail = describeAdapterError(error)
        const err = new Error(detail.message)
        err.code = detail.code // 供页面层判断是否要弹「去系统设置」引导
        reject(err)
      }
    })
  })
}

// 系统级蓝牙权限引导：小程序无法直接申请微信本体的「附近设备」权限(openSetting 也管不到)，
// 只能弹窗告诉用户去系统设置手动开启；鸿蒙额外提示「关开重启」兜底。
function showPermissionGuide() {
  const harmonyTip = isHarmonyOS()
    ? '\n\n若开关已是开启状态仍报错：请把「附近设备」关闭再打开，并彻底退出微信后重进。'
    : ''
  wx.showModal({
    title: '需要「附近设备」权限',
    content: `请前往：\n${systemSettingsPath()}\n开启「附近设备」与「位置信息」后重试。${harmonyTip}`,
    confirmText: '我知道了',
    showCancel: false
  })
}

// 鸿蒙兼容兜底：适配器已打开但一台设备都没搜到时，鸿蒙存在「权限全开仍搜不到」的已知问题，
// 给鸿蒙用户单独的排查引导(关开附近设备 + 重启微信)。非鸿蒙环境返回 false，保留页面原有空态 UI。
function showEmptyResultGuide() {
  if (!isHarmonyOS()) {
    return false
  }
  wx.showModal({
    title: '没有搜索到设备',
    content: `请确认相框已开机并贴近手机。鸿蒙系统如反复搜不到，可在：\n${systemSettingsPath()}\n把「附近设备」关闭再打开，并彻底退出微信后重试。`,
    confirmText: '我知道了',
    showCancel: false
  })
  return true
}

// 停止搜索并清理监听，避免后台持续扫描耗电与回调泄漏
function stopDiscovery() {
  if (wx.stopBluetoothDevicesDiscovery) {
    wx.stopBluetoothDevicesDiscovery({})
  }

  if (foundHandler && wx.offBluetoothDeviceFound) {
    wx.offBluetoothDeviceFound(foundHandler)
  }

  foundHandler = null
}

// 将系统返回的原始蓝牙设备结构裁剪为业务统一字段（取广播服务 UUID 作为设备编号兜底）
function normalizeDevice(device) {
  // 无名设备用 deviceId 末段兜底展示，方便靠信号强度认出自己的设备
  const shortId = String(device.deviceId || '').replace(/[:-]/g, '').slice(-4)
  const name = device.name || device.localName || (shortId ? `设备 ${shortId}` : '未命名设备')
  // 优先用广播包里的厂商数据拿到权威的屏幕类型/电量/设备ID（6.10.7），解析不到再留空
  const ad = protocol.parseAdvertising(device.advertisData) || {}

  return {
    id: device.deviceId,
    deviceId: device.deviceId,
    name,
    // 设备编号优先用广播里的 Device_ID，兜底用蓝牙 deviceId
    deviceNo: ad.deviceId || device.deviceId,
    model: ad.model || '',
    screen: ad.screen || '',
    screenType: ad.screenType || 0,
    battery: ad.battery,
    RSSI: device.RSSI || 0,
    localName: device.localName || '',
    advertisServiceUUIDs: device.advertisServiceUUIDs || [],
    realBluetooth: true
  }
}

// 在 timeout 时间内持续收集附近的蓝牙相框，到点后返回去重后的设备列表
function discoverDevices(options) {
  const timeout = options && options.timeout ? options.timeout : 8000

  return new Promise((resolve, reject) => {
    if (!canUseBluetooth()) {
      reject(new Error('当前环境不支持蓝牙搜索'))
      return
    }

    const foundMap = {} // 以 deviceId 为键去重，同一设备多次广播只保留最新一条
    let settled = false // 保证只 resolve/reject 一次
    let timer = null

    const finish = devices => {
      if (settled) {
        return
      }

      settled = true
      clearTimeout(timer)
      stopDiscovery()
      resolve(devices)
    }

    // 每次发现设备的回调：累积到 foundMap，搜索期间不立即返回。
    // 新设备必须广播名命中白名单（EF6-370 / EF6-589）才收录；已收录的目标设备后续广播包继续刷新
    // （电量/名称/信号常在后续包才带全），避免因某个包暂时缺 localName 而漏更新。
    foundHandler = res => {
      const devices = res.devices || []
      devices.forEach(device => {
        if (!device.deviceId) {
          return
        }
        if (!foundMap[device.deviceId] && !isAllowedFrame(device)) {
          return
        }
        foundMap[device.deviceId] = normalizeDevice(device)
      })
    }

    // 注意：必须先注册监听再开始搜索，否则可能漏掉最早广播的设备
    wx.onBluetoothDeviceFound(foundHandler)
    wx.startBluetoothDevicesDiscovery({
      // 允许重复上报：设备名/电量常在后续广播包才带上，开重复上报可持续刷新展示信息
      allowDuplicatesKey: true,
      interval: 0,
      success() {
        // 搜索成功开启后，等待 timeout 再统一汇总结果；按信号强度排序，离得近的设备排在前面
        timer = setTimeout(() => {
          const list = Object.keys(foundMap).map(id => foundMap[id]).sort((a, b) => b.RSSI - a.RSSI)
          finish(list)
        }, timeout)
      },
      fail(error) {
        clearTimeout(timer)
        stopDiscovery()
        reject(new Error(error.errMsg || '蓝牙搜索失败'))
      }
    })
  })
}

function connectDevice(deviceId) {
  return new Promise((resolve, reject) => {
    if (!deviceId || !wx.createBLEConnection) {
      resolve(false)
      return
    }

    wx.createBLEConnection({
      deviceId,
      timeout: 8000,
      success() {
        resolve(true)
      },
      fail(error) {
        reject(new Error(error.errMsg || '设备连接失败'))
      }
    })
  })
}

module.exports = {
  canUseBluetooth,
  isHarmonyOS,
  openAdapter,
  discoverDevices,
  connectDevice,
  stopDiscovery,
  showPermissionGuide,
  showEmptyResultGuide
}
