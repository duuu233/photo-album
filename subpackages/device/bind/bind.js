const api = require('../../../utils/api')
const permission = require('../../../utils/permission')
const bluetooth = require('../../../utils/bluetooth')
const system = require('../../../utils/system')

const app = getApp()

function mergeDevices(realDevices, mockDevices) {
  const map = {}
  realDevices.concat(mockDevices).forEach(device => {
    const key = device.deviceNo || device.deviceId || device.id
    if (!key || map[key]) {
      return
    }
    map[key] = device
  })
  return Object.keys(map).map(key => map[key])
}

Page({
  data: {
    statusBarHeight: 20,
    safeBottom: 0,
    scanning: false,
    devices: [],
    location: null,
    usedMockFallback: false,
    showHelp: false
  },

  onLoad() {
    this.setData(system.getLayoutMetrics())
    this.scan()
  },

  goBack() {
    const pages = getCurrentPages()

    if (pages.length > 1) {
      wx.navigateBack()
      return
    }

    wx.switchTab({
      url: '/pages/home/home'
    })
  },

  onUnload() {
    bluetooth.stopDiscovery()
  },

  noop() {},

  async scan() {
    if (this.data.scanning) {
      return
    }

    this.setData({
      scanning: true,
      usedMockFallback: false,
      devices: [],
      showHelp: false
    })

    try {
      const location = await permission.getCurrentLocation()
      if (!location) {
        wx.showToast({
          title: '请先授权定位',
          icon: 'none'
        })
        return
      }

      this.setData({
        location
      })

      await bluetooth.openAdapter()

      const realDevices = await bluetooth.discoverDevices({
        timeout: 8000
      })
      let devices = realDevices
      let usedMockFallback = false

      if (!devices.length && system.isDevTools()) {
        const mockDevices = await api.scanBluetoothDevices()
        devices = mergeDevices(realDevices, mockDevices)
        usedMockFallback = true
      }

      this.setData({
        devices,
        usedMockFallback
      })
    } catch (error) {
      if (system.isDevTools()) {
        const devices = await api.scanBluetoothDevices()
        this.setData({
          devices,
          usedMockFallback: true
        })
      } else {
        wx.showToast({
          title: error.message || '设备搜索失败',
          icon: 'none'
        })
      }
    } finally {
      this.setData({
        scanning: false
      })
    }
  },

  openHelp() {
    this.setData({
      showHelp: true
    })
  },

  closeHelp() {
    this.setData({
      showHelp: false
    })
  },

  async bindDevice(e) {
    const id = e.currentTarget.dataset.id
    const scanDevice = this.data.devices.find(item => item.id === id || item.deviceId === id)

    if (!scanDevice) {
      return
    }

    if (scanDevice.realBluetooth && scanDevice.deviceId) {
      try {
        await bluetooth.connectDevice(scanDevice.deviceId)
      } catch (error) {
        wx.showToast({
          title: error.message || '蓝牙连接失败',
          icon: 'none'
        })
        return
      }
    }

    const device = await api.bindDevice(scanDevice)
    app.setSelectedDevice(device)

    wx.showToast({
      title: '绑定成功',
      icon: 'success'
    })
    setTimeout(() => {
      wx.navigateBack()
    }, 500)
  }
})
