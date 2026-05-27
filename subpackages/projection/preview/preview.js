const api = require('../../../utils/api')
const system = require('../../../utils/system')

function calcTotalSize(images) {
  return Number(images.reduce((sum, image) => sum + Number(image.sizeMb || image.size || 0), 0).toFixed(2))
}

Page({
  data: {
    statusBarHeight: 20,
    safeBottom: 0,
    device: null,
    images: [],
    activeImage: null,
    activeIndex: 0,
    imageCount: 0,
    totalSize: 0,
    enoughMemory: true,
    activeTool: 'crop',
    rotation: 0,
    projecting: false
  },

  onLoad() {
    this.setData(system.getLayoutMetrics())
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
      imageCount: images.length,
      totalSize,
      enoughMemory: device ? device.usedMemory + totalSize <= device.totalMemory : false
    })
  },

  onSwiperChange(e) {
    const index = e.detail.current
    this.setData({
      activeIndex: index,
      activeImage: this.data.images[index] || null,
      rotation: 0
    })
  },

  selectTool(e) {
    const tool = e.currentTarget.dataset.tool

    if (tool === 'rotate') {
      this.setData({
        activeTool: 'rotate',
        rotation: (this.data.rotation + 90) % 360
      })
      return
    }

    if (tool === 'origin') {
      this.setData({
        activeTool: 'origin',
        rotation: 0
      })
      return
    }

    this.setData({
      activeTool: 'crop'
    })
  },

  savePhoto() {
    wx.showToast({
      title: '已保存',
      icon: 'success'
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
        url: '/subpackages/projection/result/result?status=progress'
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

  goBack() {
    const pages = getCurrentPages()

    if (pages.length > 1) {
      wx.navigateBack()
      return
    }

    wx.switchTab({
      url: '/pages/home/home'
    })
  }
})
