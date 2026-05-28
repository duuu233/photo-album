const app = getApp()

Page({
  data: {
    agreed: false,
    submitting: false
  },

  onShow() {
    // 已登录则无需停留在登录页，直接进入首页
    if (app.globalData.token || wx.getStorageSync('token')) {
      wx.switchTab({
        url: '/pages/home/home'
      })
    }
  },

  // 协议勾选框为 checkbox-group，值数组含 'agreed' 即视为已同意
  onAgreementChange(event) {
    const values = event.detail.value || []

    this.setData({
      agreed: values.indexOf('agreed') !== -1
    })
  },

  async onWechatLogin() {
    if (this.data.submitting) {
      return // 防重复点击
    }

    // 未勾选协议禁止登录（合规要求）
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
      // 无论成功失败都恢复按钮可点击状态
      this.setData({
        submitting: false
      })
    }
  },

  // 返回：有上级页面则正常返回，否则兜底回首页（防止无处可返回）
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
    wx.navigateTo({
      url: '/subpackages/settings/agreement/agreement'
    })
  },

  openPrivacyPolicy() {
    wx.navigateTo({
      url: '/subpackages/settings/privacy/privacy'
    })
  },

  showToast(title) {
    wx.showToast({
      title,
      icon: 'none'
    })
  }
})
