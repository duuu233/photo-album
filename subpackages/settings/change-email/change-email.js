const api = require('../../../utils/api')

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

Page({
  data: {
    currentEmail: '',
    email: '',
    code: '',
    password: '',
    canSubmit: false
  },

  onShow() {
    const userInfo = getApp().globalData.userInfo || wx.getStorageSync('userInfo') || {}
    this.setData({
      currentEmail: userInfo.email || ''
    })
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

    const userInfo = await api.changeEmail(this.data.email)
    const app = getApp()
    app.globalData.userInfo = userInfo
    wx.setStorageSync('userInfo', userInfo)
    wx.showToast({
      title: '修改成功',
      icon: 'success'
    })
    setTimeout(() => wx.navigateBack(), 500)
  }
})
