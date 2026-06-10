const api = require('../../../utils/api')
const system = require('../../../utils/system')

// 简单邮箱格式校验：xxx@xxx.xxx
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

  // 通用输入：data-field 指定字段，更新后回调重算提交按钮可用性
  onInput(event) {
    this.setData({
      [event.currentTarget.dataset.field]: event.detail.value
    }, this.updateSubmitState)
  },

  // 四项均填写且两次密码一致才允许提交
  updateSubmitState() {
    const { email, code, password, confirmPassword } = this.data
    this.setData({
      canSubmit: Boolean(email && code && password && confirmPassword && password === confirmPassword)
    })
  },

  async sendCode() {
    if (this.data.codeCountdown > 0) {
      return
    }

    if (!isEmail(this.data.email)) {
      wx.showToast({
        title: '请输入正确邮箱',
        icon: 'none'
      })
      return
    }

    try {
      await api.sendEmail({
        userEmail: this.data.email,
        sendType: 3
      })
      this.startCodeCountdown()
      wx.showToast({
        title: '验证码已发送',
        icon: 'success'
      })
    } catch (error) {
      // request.js already shows the backend error message.
    }
  },

  // 发送验证码后启动 30 秒倒计时，期间禁用按钮防止重复发送
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
    // 成功后把新邮箱合并回用户信息并同步到内存与缓存
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
