const api = require('../../../utils/api')
const system = require('../../../utils/system')
const toast = require('../../../utils/toast')

// 简单邮箱格式校验：xxx@xxx.xxx
function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

// App 登录密码强度：至少 8 位且同时包含字母和数字。
// 该密码是真实登录凭证（后端 md5 存储），无强度要求时用户可设 "1" 这类秒破弱口令。
function isStrongPassword(value) {
  return typeof value === 'string' && value.length >= 8 && /[A-Za-z]/.test(value) && /\d/.test(value)
}

Page({
  data: {
    statusBarHeight: 20,
    safeBottom: 0,
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
    this.updateSubmitState()
  },

  onUnload() {
    this.clearCodeTimer()
  },

  setSystemMetrics() {
    this.setData(system.getLayoutMetrics())
  },

  // 通用输入：data-field 指定字段，更新后回调重算提交按钮可用性
  onInput(e) {
    const name = e.currentTarget.dataset.field
    this.setData({
      [name]: e.detail.value
    }, this.updateSubmitState)
  },

  // 邮箱、验证码、密码均填写且两次密码一致才允许提交（绑定邮箱同时设置 App 登录密码）
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
      toast.warn({
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
      toast.show({
        title: '验证码已发送',
        icon: 'none'
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

  // 提交前逐项校验，按序给出具体原因——原先只有灰按钮+「请补全信息并确认密码」的笼统提示，
  // 用户找不到到底哪一项错了（尤其两次密码不一致这种看不出来的）
  validateForm() {
    const { email, code, password, confirmPassword } = this.data
    if (!isEmail(email)) {
      return '请输入正确邮箱'
    }
    if (!code) {
      return '请输入验证码'
    }
    if (!isStrongPassword(password)) {
      return '密码需至少8位，且同时包含字母和数字'
    }
    if (password !== confirmPassword) {
      return '两次输入的密码不一致'
    }
    return ''
  },

  async submit() {
    const invalidMessage = this.validateForm()
    if (invalidMessage) {
      toast.warn({
        title: invalidMessage,
        icon: 'none'
      })
      return
    }

    try {
      await api.changeUserEmail({
        userEmail: this.data.email,
        verifyCode: this.data.code,
        password: this.data.password,
        confirmPassword: this.data.confirmPassword
      })
    } catch (error) {
      // request.js already shows the backend error message.
      return
    }

    // 成功后把新邮箱合并回用户信息并同步到内存与缓存
    const app = getApp()
    const userInfo = Object.assign({}, app.globalData.userInfo || wx.getStorageSync('userInfo') || {}, {
      email: this.data.email
    })
    app.globalData.userInfo = userInfo
    wx.setStorageSync('userInfo', userInfo)
    toast.show({
      title: '绑定成功',
      icon: 'none'
    })
    setTimeout(() => wx.navigateBack(), 500)
  },

  goBack() {
    wx.navigateBack()
  }
})
