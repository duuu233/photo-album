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

  // 并行拉取用户信息、相册照片、设备列表，组装“我的”页头部展示数据
  async loadUserInfo() {
    try {
      await app.ensureLogin()
      const [userInfo, photos, devices] = await Promise.all([
        api.getUserProfile(),
        api.getAlbumPhotos(),
        api.getDevices()
      ])
      // 仅当 id 为纯数字时展示，否则用占位号（demo 数据兜底）
      const displayUserId = userInfo.id && /^\d+$/.test(String(userInfo.id)) ? userInfo.id : '123456'
      // 默认昵称“微信用户”视为未设置，回退到占位昵称
      const displayName = userInfo.nickName && userInfo.nickName !== '微信用户' ? userInfo.nickName : '江江江'
      this.setData({
        avatarUrl: userInfo.avatarUrl || '',
        nickName: displayName,
        userId: displayUserId,
        photoCount: Math.max(photos.length, 102),
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
  },

  noop() {}
})
