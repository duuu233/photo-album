const api = require('../../../utils/api')

const app = getApp()

function memoryPercent(device) {
  if (!device || !device.totalMemory) {
    return 0
  }
  return Math.min(100, Math.round((device.usedMemory / device.totalMemory) * 100))
}

Page({
  data: {
    id: '',
    device: null,
    memoryPercent: 0,
    intervalOptions: [1, 2, 4, 8, 24],
    intervalIndex: 1
  },

  onLoad(options) {
    this.setData({
      id: options.id || ''
    })
  },

  onShow() {
    this.loadDetail()
  },

  async loadDetail() {
    const device = await api.getDeviceDetail(this.data.id)
    const intervalIndex = this.data.intervalOptions.indexOf(device ? device.intervalHours : 2)

    this.setData({
      device,
      memoryPercent: memoryPercent(device),
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

  clearCopies() {
    if (!this.data.device) {
      return
    }

    wx.showModal({
      title: '一键清空',
      content: '仅删除设备中的照片副本，保留我的相册数据。',
      confirmText: '清空',
      success: async res => {
        if (!res.confirm) {
          return
        }

        await api.clearDevicePhotoCopies(this.data.id)
        wx.showToast({
          title: '已清空',
          icon: 'success'
        })
        this.loadDetail()
      }
    })
  },

  formatDevice() {
    if (!this.data.device) {
      return
    }

    wx.showModal({
      title: '格式化设备',
      content: '格式化会删除设备详细信息与设备上的照片，请确认是否继续。',
      confirmText: '格式化',
      confirmColor: '#c72e2e',
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
