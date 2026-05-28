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

    // 状态由 URL 参数决定，结果详情（设备名/张数）从预览页写入的 Storage 读取
    const status = options.status || 'progress'
    const result = wx.getStorageSync('lastProjectionResult') || {}
    this.applyStatus(status, result)

    // 进度态会模拟一个上传进度，结束后自动切到成功
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

  // 模拟投屏进度：每 280ms 上传一张，到达总数后置 100% 并稍后切换到成功态
  startProgress(result) {
    const total = result.imageCount || 12
    this.setData({
      progressTotal: total,
      progressCurrent: 0,
      progressPercent: 0
    })

    this.progressTimer = setInterval(() => {
      const next = this.data.progressCurrent + 1

      // 到达最后一张：停定时器、补满进度条，短暂停顿后展示成功页
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
