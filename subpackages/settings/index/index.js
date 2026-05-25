const api = require('../../../utils/api')
const system = require('../../../utils/system')

const app = getApp()

Page({
  data: {
    userInfo: null,
    languageInfo: null
  },

  onShow() {
    this.loadUser()
  },

  async loadUser() {
    const userInfo = await api.getUserProfile()
    this.setData({
      userInfo,
      languageInfo: system.getSystemLanguageInfo()
    })
  },

  goProfile() {
    wx.navigateTo({
      url: '/subpackages/settings/profile/profile'
    })
  },

  goLanguage() {
    wx.navigateTo({
      url: '/subpackages/settings/language/language'
    })
  },

  goAbout() {
    wx.navigateTo({
      url: '/subpackages/settings/about/about'
    })
  },

  goAccount() {
    wx.navigateTo({
      url: '/subpackages/settings/account/account'
    })
  },

  goModifyPassword() {
    wx.navigateTo({
      url: '/subpackages/settings/modify-password/modify-password'
    })
  },

  logout() {
    wx.showModal({
      title: '退出登录',
      content: '退出后再次进入会重新走微信快捷登录。',
      confirmText: '退出',
      success: async res => {
        if (!res.confirm) {
          return
        }

        await api.logout()
        app.clearSession()
        await app.ensureLogin()
        wx.showToast({
          title: '已重新登录',
          icon: 'success'
        })
        this.loadUser()
      }
    })
  }
})
