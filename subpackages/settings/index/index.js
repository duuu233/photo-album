const api = require('../../../utils/api')
const toast = require('../../../utils/toast')

const app = getApp()

Page({
  data: {
    statusBarHeight: 20,
    safeBottom: 0,
    contact: 'boltstarservice@boltstar.net',
    dialogType: '',
    dialogTitle: '',
    dialogDesc: '',
    dialogConfirmText: '确定',
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
        toast.show({
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

  // 退出登录与注销共用一个确认弹窗，靠 dialogType 区分（'logout' / 'delete-warn' / 'delete'）
  showLogout() {
    this.setData({
      dialogType: 'logout',
      dialogTitle: '退出登录',
      dialogDesc: '退出后将返回登录页，是否继续?',
      dialogConfirmText: '确定'
    })
  },

  // 注销需两步确认：第一步提示设备照片需自行清空，第二步让用户确认已了解
  showDelete() {
    this.setData({
      dialogType: 'delete-warn',
      dialogTitle: '用户注销',
      dialogDesc: '注销将永久删除您的所有账号数据，请确认设备照片已自行清空，否则注销后将无法删除设备照片',
      dialogConfirmText: '继续'
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
        dialogConfirmText: '确定',
        dialogClosing: false
      })
    }, 220)
  },

  // 弹窗确认：按 dialogType 执行退出或注销，两者都清本地会话并重启到登录页
  async confirmDialog() {
    const dialogType = this.data.dialogType

    // 注销第一步点「继续」：原弹窗内切换到第二步确认文案，不关闭遮罩
    if (dialogType === 'delete-warn') {
      this.setData({
        dialogType: 'delete',
        dialogTitle: '用户注销',
        dialogDesc: '我已了解设备照片需自行处理的说明，并确认继续注销。',
        dialogConfirmText: '确认'
      })
      return
    }

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
