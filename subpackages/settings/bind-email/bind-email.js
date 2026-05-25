const api = require('../../../utils/api')

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

Page({
  data: {
    email: '',
    code: '',
    password: '',
    canSubmit: false
  },

  updateField(e) {
    const name = e.currentTarget.dataset.name
    this.setData({
      [name]: e.detail.value
    }, this.updateSubmitState)
  },

  updateSubmitState() {
    const { email, code, password } = this.data
    this.setData({
      canSubmit: Boolean(email && code && password)
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

    wx.showToast({
      title: '验证码已发送',
      icon: 'success'
    })
  },

  async submit() {
    if (!this.data.canSubmit) {
      wx.showToast({
        title: '请补全信息',
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

    await api.bindEmail(this.data.email)
    wx.showToast({
      title: '绑定成功',
      icon: 'success'
    })
    setTimeout(() => wx.navigateBack(), 500)
  }
})
