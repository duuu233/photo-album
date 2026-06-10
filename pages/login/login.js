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

  // 未勾选协议时按钮无 getPhoneNumber 能力，仅触发 bindtap：提示先同意协议（避免提前弹授权框）
  onLoginTap() {
    if (!this.data.agreed) {
      this.showToast('请先同意用户协议和隐私政策')
    }
  },

  // open-type="getPhoneNumber" 的回调：detail 含手机号授权结果（code 或 encryptedData+iv）
  async onWechatLogin(event) {
    if (this.data.submitting) {
      return // 防重复点击
    }

    // 双重保险：勾选协议后才会触发该回调，这里再校验一次
    if (!this.data.agreed) {
      this.showToast('请先同意用户协议和隐私政策')
      return
    }

    const detail = (event && event.detail) || {}

    // 用户拒绝/取消授权：静默返回，不弹错误；其余失败给出提示
    if (!detail.code && !detail.encryptedData) {
      const errMsg = detail.errMsg || ''
      if (errMsg && errMsg.indexOf('deny') === -1 && errMsg.indexOf('cancel') === -1) {
        this.showToast('获取手机号失败，请重试')
      }
      return
    }

    this.setData({
      submitting: true
    })

    try {
      await app.loginWithWechatPhone(detail)
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
