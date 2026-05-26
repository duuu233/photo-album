const api = require('../../../utils/api')

const app = getApp()

Page({
  data: {
    statusBarHeight: 20,
    safeBottom: 0,
    userInfo: {
      nickName: '江江江',
      avatarUrl: '',
      email: '123456789@qq.com',
      phone: '123456789'
    }
  },

  onLoad() {
    this.setSystemMetrics()
  },

  onShow() {
    this.loadUser()
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

  async loadUser() {
    try {
      const userInfo = await api.getUserProfile()
      this.syncUser({
        nickName: userInfo.nickName || '江江江',
        avatarUrl: userInfo.avatarUrl || '',
        email: userInfo.email || '123456789@qq.com',
        phone: userInfo.phone || '123456789'
      })
    } catch (error) {
      this.syncUser(this.data.userInfo)
    }
  },

  onChooseAvatar(event) {
    this.setData({
      'userInfo.avatarUrl': event.detail.avatarUrl
    })
  },

  onNicknameInput(event) {
    this.setData({
      'userInfo.nickName': event.detail.value
    })
  },

  saveProfile() {
    app.globalData.userInfo = this.data.userInfo
    wx.setStorageSync('userInfo', this.data.userInfo)
    wx.showToast({
      title: '已保存',
      icon: 'success'
    })
  },

  goChangeEmail() {
    wx.navigateTo({
      url: '/subpackages/settings/change-email/change-email'
    })
  },

  goBack() {
    wx.navigateBack()
  },

  syncUser(userInfo) {
    app.globalData.userInfo = userInfo
    wx.setStorageSync('userInfo', userInfo)
    this.setData({
      userInfo
    })
  }
})
