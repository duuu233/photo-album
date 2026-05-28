const system = require('../../../utils/system')

const STATUS_TEXT = {
  progress: {
    title: '投屏中',
    desc: '投屏过程中请不要关闭手机'
  },
  success: {
    title: '投屏成功',
    desc: '照片已成功投屏到设备，可前往相册查看'
  },
  fail: {
    title: '投屏失败',
    desc: '设备连接中断，请检查设备状态后重试'
  }
}

Page({
  data: {
    statusBarHeight: 20,
    safeBottom: 0,
    status: 'progress',
    title: '投屏中',
    desc: STATUS_TEXT.progress.desc,
    deviceName: '房间相册',
    recordCount: 12,
    progressCurrent: 0,
    progressTotal: 12,
    progressPercent: 0
  },

  onLoad(options) {
    this.setData(system.getLayoutMetrics())

    const status = options.status || 'progress'
    const result = wx.getStorageSync('lastProjectionResult') || {}
    this.applyStatus(status, result)

    if (status === 'progress') {
      this.startProgress(result)
    }
  },

  onUnload() {
    this.clearProgress()
  },

  applyStatus(status, result) {
    const text = STATUS_TEXT[status] || STATUS_TEXT.progress
    this.setData({
      status,
      title: text.title,
      desc: text.desc,
      deviceName: result.deviceName || '房间相册',
      recordCount: result.recordCount || result.imageCount || 12
    })
  },

  startProgress(result) {
    const total = result.imageCount || 12
    this.setData({
      progressTotal: total,
      progressCurrent: 0,
      progressPercent: 0
    })

    this.progressTimer = setInterval(() => {
      const next = this.data.progressCurrent + 1

      if (next >= total) {
        this.clearProgress()
        this.setData({
          progressCurrent: total,
          progressPercent: 100
        })
        setTimeout(() => this.applyStatus('success', result), 400)
        return
      }

      this.setData({
        progressCurrent: next,
        progressPercent: Math.round((next / total) * 100)
      })
    }, 280)
  },

  clearProgress() {
    if (this.progressTimer) {
      clearInterval(this.progressTimer)
      this.progressTimer = null
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
  },

  backHome() {
    wx.switchTab({
      url: '/pages/home/home'
    })
  },

  goRecords() {
    wx.redirectTo({
      url: '/subpackages/projection/records/records'
    })
  },

  retry() {
    wx.redirectTo({
      url: '/subpackages/projection/preview/preview'
    })
  },

  continueProjection() {
    wx.switchTab({
      url: '/pages/home/home'
    })
  }
})
