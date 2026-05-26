Page({
  data: {
    statusBarHeight: 20,
    safeBottom: 0,
    state: 'latest'
  },

  onLoad(options = {}) {
    this.setSystemMetrics()
    this.setData({
      state: options.state || 'latest'
    })
  },

  setSystemMetrics() {
    try {
      const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
      const safeBottom = Math.max(0, (info.screenHeight || 0) - (info.safeArea ? info.safeArea.bottom : info.windowHeight || 0))
      this.setData({
        statusBarHeight: info.statusBarHeight || 20,
        safeBottom
      })
    } catch (error) {
      this.setData({
        statusBarHeight: 20,
        safeBottom: 0
      })
    }
  },

  startUpdate() {
    this.setData({
      state: 'updating'
    })
  },

  goBack() {
    wx.navigateBack()
  }
})
