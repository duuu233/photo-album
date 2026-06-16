const api = require('../../utils/api')

const app = getApp()

Page({
  data: {
    statusBarHeight: 20,
    safeBottom: 0,
    avatarUrl: '',
    nickName: '微信用户',
    userId: '--',
    photoCount: 0,
    deviceCount: 0
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
    // 游客模式：未登录展示默认头部，不强制跳登录（登录留到具体操作时再触发）
    if (!app.globalData.token && !wx.getStorageSync('token')) {
      this.setData({
        avatarUrl: '',
        nickName: '微信用户',
        userId: '--',
        photoCount: 0,
        deviceCount: 0
      })
      return
    }

    try {
      const [userInfo, photos, devices] = await Promise.all([
        api.getUserProfile(),
        api.getAlbumPhotos(),
        api.getDevices()
      ])
      const displayUserId = userInfo.id || userInfo.userNo || '--'
      const displayName = userInfo.nickName || '微信用户'
      this.setData({
        avatarUrl: userInfo.avatarUrl || '',
        nickName: displayName,
        userId: displayUserId,
        photoCount: Number(userInfo.imgCount) || photos.length,
        deviceCount: Number(userInfo.productCount) || devices.length
      })
    } catch (error) {
      this.setData({
        nickName: '微信用户',
        userId: '--',
        photoCount: 0,
        deviceCount: 0
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
