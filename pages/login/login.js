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

  // 协议勾选改为图片单选按钮，点击切换勾选状态
  onAgreementChange() {
    this.setData({
      agreed: !this.data.agreed
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
      if (
        errMsg &&
        errMsg.indexOf('deny') === -1 &&
        errMsg.indexOf('cancel') === -1
      ) {
        this.showToast('获取手机号失败，请重试')
      }
      return
    }

    this.setData({
      submitting: true
    })

    try {
      await app.loginWithWechatPhone(detail)
      // 先提示登录成功，短暂停留后再进入首页，避免生硬的瞬间跳转。
      // 首页是 tabBar 页，只能用 switchTab（无滑动过渡），用 toast + 延时让切换更自然。
      wx.showToast({
        title: '登录成功',
        icon: 'none',
        duration: 1500
      })
      setTimeout(() => {
        wx.switchTab({
          url: '/pages/home/home'
        })
      }, 800)
    } finally {
      // 无论成功失败都恢复按钮可点击状态
      this.setData({
        submitting: false
      })
    }
  },

  // 登录页返回固定回首页：无论从哪个页面进入登录页，点返回都直达首页
  goBack() {
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
