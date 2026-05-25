const app = getApp()

Page({
  data: {
    agreed: true,
    loading: false
  },

  toggleAgreement() {
    this.setData({
      agreed: !this.data.agreed
    })
  },

  async loginByWechat() {
    if (!this.data.agreed) {
      wx.showToast({
        title: '请先同意用户协议',
        icon: 'none'
      })
      return
    }

    this.setData({
      loading: true
    })

    try {
      await app.loginWithWechat()
      wx.showToast({
        title: '登录成功',
        icon: 'success'
      })
      wx.switchTab({
        url: '/pages/home/home'
      })
    } catch (error) {
      wx.showToast({
        title: error && error.message ? error.message : '登录失败',
        icon: 'none'
      })
    } finally {
      this.setData({
        loading: false
      })
    }
  },

  skipLogin() {
    wx.switchTab({
      url: '/pages/home/home'
    })
  },

  goForgotPassword() {
    wx.navigateTo({
      url: '/subpackages/auth/forgot-password/forgot-password'
    })
  }
})
