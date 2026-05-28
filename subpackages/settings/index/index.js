Page({
  data: {
    statusBarHeight: 20,
    safeBottom: 0,
    contact: '99999@qq.com',
    dialogType: '',
    dialogTitle: '',
    dialogDesc: ''
  },

  onLoad() {
    this.setSystemMetrics()
  },

  setSystemMetrics() {
    try {
      const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
      const safeBottom = Math.max(0, (info.screenHeight || 0) - (info.safeArea ? info.safeArea.bottom : info.windowHeight || 0))
      this.setData({
        statusBarHeight: info.statusBarHeight || 20,
        safeBottom
      })
    } catch (error) {
      this.setData({
        statusBarHeight: 20,
        safeBottom: 0
      })
    }
  },

  goBack() {
    wx.navigateBack()
  },

  goLanguage() {
    wx.navigateTo({
      url: '/subpackages/settings/language/language'
    })
  },

  copyContact() {
    wx.setClipboardData({
      data: this.data.contact,
      success() {
        wx.showToast({
          title: '已复制联系方式',
          icon: 'none'
        })
      }
    })
  },

  goPrivacy() {
    wx.navigateTo({
      url: '/subpackages/settings/privacy/privacy'
    })
  },

  goAgreement() {
    wx.navigateTo({
      url: '/subpackages/settings/agreement/agreement'
    })
  },

  goUpdate() {
    wx.navigateTo({
      url: '/subpackages/settings/update/update?state=available'
    })
  },

  showLogout() {
    this.setData({
      dialogType: 'logout',
      dialogTitle: '退出登录',
      dialogDesc: '退出后将返回登录页，是否继续?'
    })
  },

  showDelete() {
    this.setData({
      dialogType: 'delete',
      dialogTitle: '用户注销',
      dialogDesc: '注销后您的所有数据将会彻底删除且无法恢复，确定要注销账号?'
    })
  },

  closeDialog() {
    this.setData({
      dialogType: '',
      dialogTitle: '',
      dialogDesc: ''
    })
  },

  confirmDialog() {
    this.closeDialog()
    wx.showToast({
      title: '静态页面占位',
      icon: 'none'
    })
  },

  noop() {}
})
