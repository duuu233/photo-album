const api = require('../../../utils/api')

function calcTotalSize(images) {
  return Number(images.reduce((sum, image) => sum + Number(image.sizeMb || image.size || 0), 0).toFixed(2))
}

Page({
  data: {
    device: null,
    images: [],
    activeImage: null,
    activeIndex: 0,
    totalSize: 0,
    enoughMemory: true,
    fitMode: 'cover',
    projecting: false
  },

  onLoad() {
    const pending = wx.getStorageSync('pendingProjection') || {}
    const images = pending.images || []
    const device = pending.device || null
    this.updateImageState(images, device, 0)
  },

  updateImageState(images, device, activeIndex) {
    const safeIndex = Math.max(0, Math.min(activeIndex, images.length - 1))
    const totalSize = calcTotalSize(images)

    this.setData({
      device,
      images,
      activeIndex: safeIndex,
      activeImage: images[safeIndex] || null,
      totalSize,
      enoughMemory: device ? device.usedMemory + totalSize <= device.totalMemory : false
    })
  },

  selectImage(e) {
    const index = Number(e.currentTarget.dataset.index)
    this.updateImageState(this.data.images, this.data.device, index)
  },

  removeImage(e) {
    const index = Number(e.currentTarget.dataset.index)
    const images = this.data.images.filter((_, itemIndex) => itemIndex !== index)
    const nextIndex = index >= images.length ? images.length - 1 : index
    this.updateImageState(images, this.data.device, nextIndex)
  },

  setFitMode(e) {
    this.setData({
      fitMode: e.currentTarget.dataset.mode
    })
  },

  rotateLeft() {
    wx.showToast({
      title: '已预留旋转事件',
      icon: 'none'
    })
  },

  rotateRight() {
    wx.showToast({
      title: '已预留旋转事件',
      icon: 'none'
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

    this.setData({
      projecting: true
    })

    try {
      await api.uploadProjection({
        deviceId: this.data.device.id,
        images: this.data.images
      })
      wx.removeStorageSync('pendingProjection')
      wx.setStorageSync('lastProjectionResult', {
        status: 'success',
        deviceName: this.data.device.name,
        imageCount: this.data.images.length
      })
      wx.redirectTo({
        url: '/subpackages/projection/result/result?status=success'
      })
    } catch (error) {
      wx.setStorageSync('lastProjectionResult', {
        status: 'fail',
        deviceName: this.data.device ? this.data.device.name : '',
        imageCount: this.data.images.length,
        message: error.message || '投屏失败'
      })
      wx.redirectTo({
        url: '/subpackages/projection/result/result?status=fail'
      })
    } finally {
      this.setData({
        projecting: false
      })
    }
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

    this.updateImageState(this.data.images, selectedDevice, this.data.activeIndex)
  }
})
