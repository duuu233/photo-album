const api = require('../../../utils/api')
const permission = require('../../../utils/permission')
const bluetooth = require('../../../utils/bluetooth')
const system = require('../../../utils/system')

const app = getApp()

// 合并真实蓝牙搜索结果与模拟设备并去重（同一设备编号只保留先出现的一条，真机结果优先）
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
    bluetooth.stopDiscovery() // 离开页面务必停止扫描，释放蓝牙资源
  },

  noop() {},

  // 搜索附近设备：定位授权 → 开蓝牙 → 扫描；开发者工具无真机蓝牙时降级到模拟数据
  async scan() {
    if (this.data.scanning) {
      return // 防止重复触发扫描
    }

    this.setData({
      scanning: true,
      usedMockFallback: false,
      devices: [],
      showHelp: false
    })

    try {
      // 微信要求搜索蓝牙前需有定位权限
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

      // 真机扫不到且在开发者工具中：补充模拟设备，方便无硬件时调试 UI
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
      // 蓝牙不可用时：开发者工具下用模拟数据兜底，真机则提示错误
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

  // 绑定所选设备：真机设备先建立蓝牙连接，再调用后端绑定并设为当前选中设备
  async bindDevice(e) {
    const id = e.currentTarget.dataset.id
    const scanDevice = this.data.devices.find(item => item.id === id || item.deviceId === id)

    if (!scanDevice) {
      return
    }

    // 仅真实蓝牙设备需要先连接；模拟设备跳过这一步
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
