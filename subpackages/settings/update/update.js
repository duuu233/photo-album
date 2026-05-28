Page({
  data: {
    statusBarHeight: 20,
    safeBottom: 0,
    state: 'latest'
  },

  onLoad(options = {}) {
    this.setSystemMetrics()
    // 页面状态由 query 决定：latest 已是最新 / available 有新版本 / updating 升级中
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
