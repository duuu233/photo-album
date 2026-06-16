const api = require('../../../utils/api')
const system = require('../../../utils/system')
const batteryUtil = require('../../../utils/battery')
const deviceBle = require('../../../utils/device-ble')

const app = getApp()

// 计算设备存储使用百分比，用于列表项进度条
function memoryPercent(device) {
  if (!device.totalMemory) {
    return 0
  }
  return Math.min(100, Math.round((device.usedMemory / device.totalMemory) * 100))
}

Page({
  data: {
    statusBarHeight: 20,
    safeBottom: 0,
    devices: [],
    selectedId: '',
    selectMode: false,
    loading: true
  },

  onLoad(options) {
    this.setSystemMetrics()
    // select=1 表示“选择设备”模式（从投屏等场景进入，点选即切换并返回）；否则为普通管理列表
    const selectMode = options.select === '1'
    this.setData({
      selectMode
    })

  },

  onShow() {
    this.loadDevices()
  },

  // 加载设备列表，并为每项附加展示用字段（内存百分比、删除提示）
  async loadDevices() {
    this.setData({
      loading: true
    })
    const sourceDevices = await api.getDevices()
    const selected = app.globalData.selectedDevice
    const devices = sourceDevices.map(item => {
      if (!selected || String(selected.id) !== String(item.id)) {
        return item
      }
      return Object.assign({}, item, {
        deviceId: item.deviceId || selected.deviceId,
        bleDeviceId: item.bleDeviceId || selected.bleDeviceId || selected.deviceId,
        battery: typeof item.battery === 'number' ? item.battery : selected.battery
      })
    })

    this.setData({
      // 先算内存百分比，再标记“可删除提示”仅显示在最后一个离线设备上（引导用户清理）
      devices: devices.map(item => Object.assign({}, item, {
        memoryPercent: memoryPercent(item),
        batteryIcon: batteryUtil.getBatteryIcon(item.battery),
        // 电量未知（蓝牙未读到）时不展示百分比，避免出现 null%
        batteryText: typeof item.battery === 'number' ? `${item.battery}%` : ''
      })).map((item, index, list) => Object.assign({}, item, {
        canDeleteHint: !item.connected && index === list.length - 1
      })),
      selectedId: selected ? selected.id : '',
      loading: false
    })
  },

  setSystemMetrics() {
    this.setData(system.getLayoutMetrics())
  },

  goBack() {
    const pages = getCurrentPages()

    if (pages.length > 1) {
      wx.navigateBack()
      return
    }

    wx.switchTab({
      url: '/pages/mine/mine'
    })
  },

  // 点击设备：选择模式下设为当前设备并返回；普通模式下进入设备详情
  selectDevice(e) {
    const id = e.currentTarget.dataset.id
    const device = this.data.devices.find(item => item.id === id)

    if (!device) {
      return
    }

    if (this.data.selectMode) {
      app.setSelectedDevice(device)
      wx.showToast({
        title: '已切换设备',
        icon: 'success'
      })
      setTimeout(() => wx.navigateBack(), 350)
      return
    }

    wx.navigateTo({
      url: `/subpackages/device/detail/detail?id=${id}`
    })
  },

  goBind() {
    wx.navigateTo({
      url: '/subpackages/device/bind/bind'
    })
  },

  goSlideshow(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({
      url: `/subpackages/device/slideshow/slideshow?id=${id}`
    })
  },

  async toggleConnection(e) {
    const id = e.currentTarget.dataset.id
    const device = this.data.devices.find(item => item.id === id)

    if (!device) {
      return
    }

    if (device.connected) {
      if (device.deviceId) {
        deviceBle.disconnect(device.deviceId)
      }
      this.setData({
        devices: this.data.devices.map(item => item.id === id ? Object.assign({}, item, {
          connected: false
        }) : item)
      })
      wx.showToast({ title: '已断开', icon: 'none' })
      return
    }

    if (!device.deviceId) {
      wx.showToast({
        title: '请重新搜索绑定后连接',
        icon: 'none'
      })
      return
    }

    wx.showLoading({ title: '连接设备中', mask: true })
    try {
      await deviceBle.ensureConnection(device.deviceId)
      const info = await deviceBle.readDeviceInfo(device.deviceId)
      const updated = Object.assign({}, device, {
        connected: true,
        battery: info.battery,
        usedMemory: info.imgCount,
        totalMemory: info.capacity,
        playbackMode: info.playMode,
        intervalSeconds: info.intervalSeconds,
        intervalHours: info.intervalSeconds ? Math.max(1, Math.round(info.intervalSeconds / 3600)) : device.intervalHours,
        firmwareVersion: info.firmwareVersion || device.firmwareVersion
      })

      if (app.globalData.selectedDevice && app.globalData.selectedDevice.id === id) {
        app.setSelectedDevice(updated)
      }

      this.setData({
        devices: this.data.devices.map(item => item.id === id ? Object.assign({}, updated, {
          memoryPercent: memoryPercent(updated),
          batteryIcon: batteryUtil.getBatteryIcon(updated.battery),
          batteryText: typeof updated.battery === 'number' ? `${updated.battery}%` : ''
        }) : item)
      })
      wx.showToast({ title: '已连接', icon: 'success' })
    } catch (error) {
      wx.showToast({
        title: error.message || '连接失败',
        icon: 'none'
      })
    } finally {
      wx.hideLoading()
    }
  },

  renameDevice(e) {
    const id = e.currentTarget.dataset.id
    const device = this.data.devices.find(item => item.id === id)

    if (!device) {
      return
    }

    wx.showModal({
      title: '编辑设备名称',
      editable: true,
      placeholderText: '请输入设备名称',
      content: device.name,
      success: async res => {
        if (!res.confirm || !res.content.trim()) {
          return
        }

        const updated = await api.renameDevice(id, res.content.trim())
        if (app.globalData.selectedDevice && app.globalData.selectedDevice.id === updated.id) {
          app.setSelectedDevice(updated)
        }
        this.loadDevices()
      }
    })
  },

  deleteDevice(e) {
    const id = e.currentTarget.dataset.id

    wx.showModal({
      title: '删除设备',
      content: '删除后将解除与该相框设备的绑定。',
      confirmText: '删除',
      confirmColor: '#ff4d4f',
      success: async res => {
        if (!res.confirm) {
          return
        }

        await api.deleteDevice(id)
        if (app.globalData.selectedDevice && app.globalData.selectedDevice.id === id) {
          app.setSelectedDevice(null)
        }
        this.loadDevices()
      }
    })
  }
})
