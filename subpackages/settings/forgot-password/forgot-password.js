const api = require('../../../utils/api')
const toast = require('../../../utils/toast')

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

Page({
  data: {
    statusBarHeight: 20,
    safeBottom: 0,
    email: '123456789@qq.com',
    code: '',
    password: '',
    confirmPassword: '',
    codeCountdown: 0,
    codeButtonText: '获取验证码'
  },

  onLoad() {
    this.setSystemMetrics()
  },

  onUnload() {
    this.clearCodeTimer()
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

  async sendCode() {
    if (this.data.codeCountdown > 0) {
      return
    }

    if (!isEmail(this.data.email)) {
      toast.warn({
        title: '请输入正确邮箱',
        icon: 'none'
      })
      return
    }

    try {
      await api.sendEmail({
        userEmail: this.data.email,
        sendType: 2
      })
      this.startCodeCountdown()
      toast.show({
        title: '验证码已发送',
        icon: 'none'
      })
    } catch (error) {
      // request.js already shows the backend error message.
    }
  },

  startCodeCountdown() {
    this.clearCodeTimer()
    this.setData({
      codeCountdown: 30,
      codeButtonText: '30秒后重新获取'
    })
    this.codeTimer = setInterval(() => {
      const next = this.data.codeCountdown - 1

      if (next <= 0) {
        this.clearCodeTimer()
        this.setData({
          codeCountdown: 0,
          codeButtonText: '获取验证码'
        })
        return
      }

      this.setData({
        codeCountdown: next,
        codeButtonText: `${next}秒后重新获取`
      })
    }, 1000)
  },

  clearCodeTimer() {
    if (this.codeTimer) {
      clearInterval(this.codeTimer)
      this.codeTimer = null
    }
  },

  submit() {
    toast.show({
      title: '静态页面占位',
      icon: 'none'
    })
  },

  goBack() {
    wx.navigateBack()
  }
})
