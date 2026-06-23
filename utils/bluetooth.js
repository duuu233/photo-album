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

function openAdapter() {
  return new Promise((resolve, reject) => {
    if (!wx.openBluetoothAdapter) {
      reject(new Error('当前微信版本不支持蓝牙能力'))
      return
    }

    wx.openBluetoothAdapter({
      success: resolve,
      fail(error) {
        const message = error.errCode === 10001 ? '请先开启手机蓝牙' : (error.errMsg || '蓝牙初始化失败')
        reject(new Error(message))
      }
    })
  })
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
  openAdapter,
  discoverDevices,
  connectDevice,
  stopDiscovery
}
