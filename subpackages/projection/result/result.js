Page({
  data: {
    status: 'progress',
    result: {},
    title: '投屏中',
    desc: '正在把照片发送到智能相框，请保持设备在线。'
  },

  onLoad(options) {
    const status = options.status || 'progress'
    const result = wx.getStorageSync('lastProjectionResult') || {}
    this.applyStatus(status, result)

    if (status === 'progress') {
      setTimeout(() => {
        this.applyStatus('success', result)
      }, 1200)
    }
  },

  applyStatus(status, result) {
    const statusText = {
      progress: {
        title: '投屏中',
        desc: '正在把照片发送到智能相框，请保持设备在线。'
      },
      success: {
        title: '投屏成功',
        desc: `${result.deviceName || '智能相框'} 已收到 ${result.imageCount || 0} 张照片。`
      },
      fail: {
        title: '投屏失败',
        desc: result.message || '请检查设备连接、蓝牙和剩余内存后重试。'
      }
    }

    this.setData(Object.assign({
      status,
      result
    }, statusText[status] || statusText.progress))
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
  }
})
