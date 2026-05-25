const api = require('../../../utils/api')

Page({
  data: {
    device: null,
    images: [],
    totalSize: 0,
    enoughMemory: true
  },

  onLoad() {
    const pending = wx.getStorageSync('pendingProjection') || {}
    const images = pending.images || []
    const device = pending.device || null
    const totalSize = Number(images.reduce((sum, image) => sum + Number(image.sizeMb || 0), 0).toFixed(2))
    const enoughMemory = device ? device.usedMemory + totalSize <= device.totalMemory : false

    this.setData({
      device,
      images,
      totalSize,
      enoughMemory
    })
  },

  removeImage(e) {
    const index = Number(e.currentTarget.dataset.index)
    const images = this.data.images.filter((_, itemIndex) => itemIndex !== index)
    const totalSize = Number(images.reduce((sum, image) => sum + Number(image.sizeMb || 0), 0).toFixed(2))
    const device = this.data.device

    this.setData({
      images,
      totalSize,
      enoughMemory: device ? device.usedMemory + totalSize <= device.totalMemory : false
    })
  },

  async confirmProjection() {
    if (!this.data.device) {
      wx.showToast({
        title: '请选择设备',
        icon: 'none'
      })
      return
    }

    if (!this.data.images.length) {
      wx.showToast({
        title: '请至少保留一张照片',
        icon: 'none'
      })
      return
    }

    if (!this.data.device.connected) {
      wx.showToast({
        title: '设备未连接',
        icon: 'none'
      })
      return
    }

    if (!this.data.enoughMemory) {
      wx.showToast({
        title: '设备内存不足',
        icon: 'none'
      })
      return
    }

    // 真实接口一般先上传文件到对象存储，再把文件 key、设备 ID 和排序提交给后端。
    await api.uploadProjection({
      deviceId: this.data.device.id,
      images: this.data.images
    })
    wx.removeStorageSync('pendingProjection')
    wx.showToast({
      title: '投屏成功',
      icon: 'success'
    })
    setTimeout(() => {
      wx.navigateBack()
    }, 600)
  },

  chooseDevice() {
    wx.navigateTo({
      url: '/subpackages/device/list/list?select=1'
    })
  },

  onShow() {
    const app = getApp()
    const selectedDevice = app.globalData.selectedDevice

    if (!selectedDevice || !this.data.device || selectedDevice.id === this.data.device.id) {
      return
    }

    this.setData({
      device: selectedDevice,
      enoughMemory: selectedDevice.usedMemory + this.data.totalSize <= selectedDevice.totalMemory
    })
  }
})
