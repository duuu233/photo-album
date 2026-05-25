const api = require('../../../utils/api')

Page({
  data: {
    oldPassword: '',
    newPassword: '',
    confirmPassword: '',
    loading: false
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

  async savePassword() {
    const { oldPassword, newPassword, confirmPassword } = this.data

    if (!oldPassword) {
      wx.showToast({
        title: '请输入当前密码',
        icon: 'none'
      })
      return
    }

    if (newPassword.length < 8) {
      wx.showToast({
        title: '新密码至少 8 位',
        icon: 'none'
      })
      return
    }

    if (newPassword !== confirmPassword) {
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
      await api.modifyPassword({
        oldPassword,
        newPassword
      })
      wx.showToast({
        title: '密码已修改',
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
