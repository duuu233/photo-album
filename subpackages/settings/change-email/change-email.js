const api = require('../../../utils/api')
const system = require('../../../utils/system')

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

Page({
  data: {
    statusBarHeight: 20,
    safeBottom: 0,
    currentEmail: '123456789@qq.com',
    email: '',
    code: '',
    password: '',
    confirmPassword: '',
    codeCountdown: 0,
    codeButtonText: '获取验证码',
    canSubmit: false
  },

  onLoad() {
    this.setSystemMetrics()
    this.loadCurrentEmail()
  },

  onUnload() {
    this.clearCodeTimer()
  },

  setSystemMetrics() {
    this.setData(system.getLayoutMetrics())
  },

  loadCurrentEmail() {
    const userInfo = getApp().globalData.userInfo || wx.getStorageSync('userInfo') || {}
    this.setData({
      currentEmail: userInfo.email || '123456789@qq.com'
    })
  },

  onInput(event) {
    this.setData({
      [event.currentTarget.dataset.field]: event.detail.value
    }, this.updateSubmitState)
  },

  updateSubmitState() {
    const { email, code, password, confirmPassword } = this.data
    this.setData({
      canSubmit: Boolean(email && code && password && confirmPassword && password === confirmPassword)
    })
  },

  sendCode() {
    if (!isEmail(this.data.email)) {
      wx.showToast({
        title: '请输入正确邮箱',
        icon: 'none'
      })
      return
    }

    this.startCodeCountdown()
    wx.showToast({
      title: '验证码已发送',
      icon: 'success'
    })
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

  async submit() {
    if (!this.data.canSubmit) {
      wx.showToast({
        title: '请补全信息并确认密码',
        icon: 'none'
      })
      return
    }

    if (!isEmail(this.data.email)) {
      wx.showToast({
        title: '请输入正确邮箱',
        icon: 'none'
      })
      return
    }

    await api.changeEmail(this.data.email)
    const app = getApp()
    const userInfo = Object.assign({}, app.globalData.userInfo || wx.getStorageSync('userInfo') || {}, {
      email: this.data.email
    })
    app.globalData.userInfo = userInfo
    wx.setStorageSync('userInfo', userInfo)
    wx.showToast({
      title: '修改成功',
      icon: 'success'
    })
    setTimeout(() => wx.navigateBack(), 500)
  },

  goBack() {
    wx.navigateBack()
  }
})
