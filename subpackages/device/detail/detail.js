const api = require('../../../utils/api')
const system = require('../../../utils/system')

const app = getApp()

function memoryPercent(device) {
  if (!device || !device.totalMemory) {
    return 0
  }
  return Math.min(100, Math.round((device.usedMemory / device.totalMemory) * 100))
}

Page({
  data: {
    statusBarHeight: 20,
    safeBottom: 0,
    id: '',
    device: null,
    memoryPercent: 0,
    deviceCode: '',
    memoryText: '',
    macAddress: '',
    firmwareVersion: '1.2.0',
    playbackLabel: '',
    intervalOptions: [1, 2, 4, 8, 24],
    intervalIndex: 1,
    showClearConfirm: false,
    showDeleteConfirm: false
  },

  onLoad(options) {
    this.setSystemMetrics()
    this.setData({
      id: options.id || ''
    })
  },

  onShow() {
    this.loadDetail()
  },

  noop() {},

  setSystemMetrics() {
    this.setData(system.getLayoutMetrics())
  },

  goBack() {
    const pages = getCurrentPages()

    if (pages.length > 1) {
      wx.navigateBack()
      return
    }

    wx.navigateTo({
      url: '/subpackages/device/list/list'
    })
  },

  async loadDetail() {
    const device = await api.getDeviceDetail(this.data.id)
    const intervalIndex = this.data.intervalOptions.indexOf(device ? device.intervalHours : 2)
    const digitId = device && device.deviceNo ? String(device.deviceNo).replace(/\D/g, '').slice(-6) : ''

    this.setData({
      device,
      memoryPercent: memoryPercent(device),
      deviceCode: digitId || '123456',
      memoryText: device ? `${device.usedMemory}/${device.totalMemory}` : '',
      macAddress: device && device.macAddress ? device.macAddress : '123456',
      firmwareVersion: device && device.firmwareVersion ? device.firmwareVersion : '1.2.0',
      playbackLabel: device && device.playbackMode === 'random' ? '随机轮播' : '顺序轮播',
      intervalIndex: intervalIndex > -1 ? intervalIndex : 1
    })
  },

  async renameDevice() {
    if (!this.data.device) {
      return
    }

    wx.showModal({
      title: '编辑设备名称',
      editable: true,
      placeholderText: '请输入设备名称',
      content: this.data.device.name,
      success: async res => {
        if (!res.confirm || !res.content.trim()) {
          return
        }

        const device = await api.renameDevice(this.data.id, res.content.trim())
        if (app.globalData.selectedDevice && app.globalData.selectedDevice.id === device.id) {
          app.setSelectedDevice(device)
        }
        this.setData({
          device,
          memoryPercent: memoryPercent(device)
        })
      }
    })
  },

  async toggleCarousel(e) {
    if (!this.data.device) {
      return
    }

    const device = await api.updateDevicePlayback(this.data.id, {
      carouselEnabled: e.detail.value
    })
    this.setData({
      device
    })
  },

  async changePlayback(e) {
    if (!this.data.device) {
      return
    }

    const mode = e.detail.value === '0' ? 'order' : 'random'
    const device = await api.updateDevicePlayback(this.data.id, {
      playbackMode: mode
    })
    this.setData({
      device
    })
  },

  async changeInterval(e) {
    if (!this.data.device) {
      return
    }

    const intervalHours = this.data.intervalOptions[Number(e.detail.value)]
    const device = await api.updateDevicePlayback(this.data.id, {
      intervalHours
    })
    this.setData({
      device,
      intervalIndex: Number(e.detail.value)
    })
  },

  goSlideshow() {
    wx.navigateTo({
      url: `/subpackages/device/slideshow/slideshow?id=${this.data.id}`
    })
  },

  showClearConfirm() {
    this.setData({
      showClearConfirm: true
    })
  },

  hideClearConfirm() {
    this.setData({
      showClearConfirm: false
    })
  },

  clearCopies() {
    this.showClearConfirm()
  },

  async confirmClearCopies() {
    if (!this.data.device) {
      return
    }

    await api.clearDevicePhotoCopies(this.data.id)
    this.setData({
      showClearConfirm: false
    })
    wx.showToast({
      title: '已清空',
      icon: 'success'
    })
    this.loadDetail()
  },

  showDeleteConfirm() {
    this.setData({
      showDeleteConfirm: true
    })
  },

  hideDeleteConfirm() {
    this.setData({
      showDeleteConfirm: false
    })
  },

  async confirmDeleteDevice() {
    if (!this.data.device) {
      return
    }

    await api.deleteDevice(this.data.id)
    if (app.globalData.selectedDevice && app.globalData.selectedDevice.id === this.data.id) {
      app.setSelectedDevice(null)
    }
    wx.showToast({
      title: '已删除',
      icon: 'success'
    })
    setTimeout(() => wx.navigateBack(), 500)
  },

  formatDevice() {
    if (!this.data.device) {
      return
    }

    wx.showModal({
      title: '格式化设备',
      content: '格式化会删除设备上的照片数据，请确认是否继续。',
      confirmText: '格式化',
      confirmColor: '#c7372f',
      success: async res => {
        if (!res.confirm) {
          return
        }

        await api.formatDevice(this.data.id)
        wx.showToast({
          title: '格式化完成',
          icon: 'success'
        })
        this.loadDetail()
      }
    })
  }
})
