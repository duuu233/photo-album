const api = require('../../utils/api')

const app = getApp()

Page({
  data: {
    statusBarHeight: 20,
    safeBottom: 0,
    avatarUrl: '',
    nickName: '江江江',
    userId: '123456',
    photoCount: 102,
    deviceCount: 3
  },

  onLoad() {
    this.setSystemMetrics()
  },

  onShow() {
    if (wx.hideTabBar) {
      wx.hideTabBar({
        animation: false
      })
    }
    this.loadUserInfo()
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

  async loadUserInfo() {
    try {
      await app.ensureLogin()
      const [userInfo, photos, devices] = await Promise.all([
        api.getUserProfile(),
        api.getAlbumPhotos(),
        api.getDevices()
      ])
      this.setData({
        avatarUrl: userInfo.avatarUrl || '',
        nickName: userInfo.nickName || '江江江',
        userId: userInfo.id || '123456',
        photoCount: photos.length || 102,
        deviceCount: devices.length || 3
      })
    } catch (error) {
      this.setData({
        nickName: '江江江',
        userId: '123456',
        photoCount: 102,
        deviceCount: 3
      })
    }
  },

  goHome() {
    wx.switchTab({
      url: '/pages/home/home'
    })
  },

  goProfile() {
    wx.navigateTo({
      url: '/subpackages/settings/profile/profile'
    })
  },

  goAlbum() {
    wx.navigateTo({
      url: '/subpackages/album/list/list'
    })
  },

  goDevices() {
    wx.navigateTo({
      url: '/subpackages/device/list/list'
    })
  },

  goRecords() {
    wx.navigateTo({
      url: '/subpackages/projection/records/records'
    })
  },

  goGuide() {
    wx.navigateTo({
      url: '/subpackages/settings/guide/guide'
    })
  },

  goSettings() {
    wx.navigateTo({
      url: '/subpackages/settings/index/index'
    })
  }
})
