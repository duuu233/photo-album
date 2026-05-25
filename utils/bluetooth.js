let foundHandler = null

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

function stopDiscovery() {
  if (wx.stopBluetoothDevicesDiscovery) {
    wx.stopBluetoothDevicesDiscovery({})
  }

  if (foundHandler && wx.offBluetoothDeviceFound) {
    wx.offBluetoothDeviceFound(foundHandler)
  }

  foundHandler = null
}

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

function discoverDevices(options) {
  const timeout = options && options.timeout ? options.timeout : 8000

  return new Promise((resolve, reject) => {
    if (!canUseBluetooth()) {
      reject(new Error('当前环境不支持蓝牙搜索'))
      return
    }

    const foundMap = {}
    let settled = false
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

    foundHandler = res => {
      const devices = res.devices || []
      devices.forEach(device => {
        if (!device.deviceId) {
          return
        }
        foundMap[device.deviceId] = normalizeDevice(device)
      })
    }

    wx.onBluetoothDeviceFound(foundHandler)
    wx.startBluetoothDevicesDiscovery({
      allowDuplicatesKey: false,
      interval: 0,
      success() {
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
