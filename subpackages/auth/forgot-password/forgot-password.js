const api = require('../../../utils/api')

function isPhone(value) {
  return /^1\d{10}$/.test(value)
}

Page({
  timer: null,

  data: {
    phone: '',
    code: '',
    password: '',
    confirmPassword: '',
    countdown: 0,
    loading: false
  },

  onUnload() {
    if (this.timer) {
      clearInterval(this.timer)
    }
  },

  updateField(e) {
    const { name, value } = e.detail

    if (!name) {
      return
    }

    this.setData({
      [name]: value
    })
  },

  sendCode() {
    if (this.data.countdown > 0) {
      return
    }

    if (!isPhone(this.data.phone)) {
      wx.showToast({
        title: '请输入有效手机号',
        icon: 'none'
      })
      return
    }

    this.setData({
      countdown: 60
    })
    wx.showToast({
      title: '验证码已发送',
      icon: 'success'
    })

    this.timer = setInterval(() => {
      const next = this.data.countdown - 1
      this.setData({
        countdown: Math.max(next, 0)
      })

      if (next <= 0 && this.timer) {
        clearInterval(this.timer)
        this.timer = null
      }
    }, 1000)
  },

  async submitReset() {
    const { phone, code, password, confirmPassword } = this.data

    if (!isPhone(phone)) {
      wx.showToast({
        title: '请输入有效手机号',
        icon: 'none'
      })
      return
    }

    if (!code) {
      wx.showToast({
        title: '请输入验证码',
        icon: 'none'
      })
      return
    }

    if (password.length < 8) {
      wx.showToast({
        title: '密码至少 8 位',
        icon: 'none'
      })
      return
    }

    if (password !== confirmPassword) {
      wx.showToast({
        title: '两次密码不一致',
        icon: 'none'
      })
      return
    }

    this.setData({
      loading: true
    })

    try {
      await api.resetPassword({
        phone,
        code,
        password
      })
      wx.showToast({
        title: '密码已重设',
        icon: 'success'
      })
      setTimeout(() => {
        wx.navigateBack()
      }, 500)
    } finally {
      this.setData({
        loading: false
      })
    }
  }
})
