const app = getApp()

Page({
  data: {
    agreed: false,
    submitting: false
  },

  onShow() {
    if (app.globalData.token || wx.getStorageSync('token')) {
      wx.switchTab({
        url: '/pages/home/home'
      })
    }
  },

  toggleAgreement() {
    this.setData({
      agreed: !this.data.agreed
    })
  },

  async onWechatLogin() {
    if (this.data.submitting) {
      return
    }

    if (!this.data.agreed) {
      this.showToast('请先同意用户协议和隐私政策')
      return
    }

    this.setData({
      submitting: true
    })

    try {
      await app.loginWithWechat()
      wx.switchTab({
        url: '/pages/home/home'
      })
    } finally {
      this.setData({
        submitting: false
      })
    }
  },

  goBack() {
    const pages = getCurrentPages()

    if (pages.length > 1) {
      wx.navigateBack()
      return
    }

    wx.switchTab({
      url: '/pages/home/home'
    })
  },

  openUserAgreement() {
    wx.showToast({
      title: '用户协议待接入',
      icon: 'none'
    })
  },

  openPrivacyPolicy() {
    wx.showToast({
      title: '隐私政策待接入',
      icon: 'none'
    })
  },

  showToast(title) {
    wx.showToast({
      title,
      icon: 'none'
    })
  }
})
