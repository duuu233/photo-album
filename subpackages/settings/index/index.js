const api = require('../../../utils/api')

const app = getApp()

Page({
  data: {
    statusBarHeight: 20,
    safeBottom: 0,
    contact: '99999@qq.com',
    dialogType: '',
    dialogTitle: '',
    dialogDesc: '',
    dialogClosing: false // 确认弹窗是否正在播放退场动画
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

  // 退出登录与注销共用一个确认弹窗，靠 dialogType 区分（'logout' / 'delete'）
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

  // 先播放退场动画再卸载，避免弹窗瞬间消失
  closeDialog() {
    if (this.data.dialogClosing) {
      return
    }
    this.setData({ dialogClosing: true })
    setTimeout(() => {
      this.setData({
        dialogType: '',
        dialogTitle: '',
        dialogDesc: '',
        dialogClosing: false
      })
    }, 220)
  },

  // 弹窗确认：按 dialogType 执行退出或注销，两者都清本地会话并重启到登录页
  async confirmDialog() {
    const dialogType = this.data.dialogType
    this.closeDialog()

    if (dialogType === 'logout') {
      try {
        await api.logout()
      } catch (error) {
        // 即使后端/网络登出失败，本地会话仍需清除，故忽略此异常
      }
      app.clearSession()
      wx.reLaunch({
        url: '/pages/login/login'
      })
      return
    }

    if (dialogType === 'delete') {
      await api.deleteAccount()
      app.clearSession()
      wx.reLaunch({
        url: '/pages/login/login'
      })
    }
  },

  noop() {}
})
