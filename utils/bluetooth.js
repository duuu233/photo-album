// 保存当前的“发现设备”监听回调引用，停止搜索时用它来精确解绑（off 需要传入同一函数引用）
let foundHandler = null

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
  const name = device.name || device.localName || '未知相框'
  const serviceId = device.advertisServiceUUIDs && device.advertisServiceUUIDs[0]

  return {
    id: device.deviceId,
    deviceId: device.deviceId,
    name,
    deviceNo: serviceId || device.deviceId,
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

    // 每次发现设备的回调：累积到 foundMap，搜索期间不立即返回
    foundHandler = res => {
      const devices = res.devices || []
      devices.forEach(device => {
        if (!device.deviceId) {
          return
        }
        foundMap[device.deviceId] = normalizeDevice(device)
      })
    }

    // 注意：必须先注册监听再开始搜索，否则可能漏掉最早广播的设备
    wx.onBluetoothDeviceFound(foundHandler)
    wx.startBluetoothDevicesDiscovery({
      allowDuplicatesKey: false,
      interval: 0,
      success() {
        // 搜索成功开启后，等待 timeout 再统一汇总结果（把 map 转成数组）
        timer = setTimeout(() => {
          finish(Object.keys(foundMap).map(id => foundMap[id]))
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
