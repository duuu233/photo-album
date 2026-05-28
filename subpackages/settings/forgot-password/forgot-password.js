Page({
  data: {
    statusBarHeight: 20,
    safeBottom: 0,
    email: '123456789@qq.com',
    code: '',
    password: '',
    confirmPassword: ''
  },

  onLoad() {
    this.setSystemMetrics()
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

  // 通用输入处理：用 data-field 指定要更新的字段，多个输入框共用此方法
  onInput(event) {
    this.setData({
      [event.currentTarget.dataset.field]: event.detail.value
    })
  },

  sendCode() {
    wx.showToast({
      title: '验证码已发送',
      icon: 'success'
    })
  },

  submit() {
    wx.showToast({
      title: '静态页面占位',
      icon: 'none'
    })
  },

  goBack() {
    wx.navigateBack()
  }
})
