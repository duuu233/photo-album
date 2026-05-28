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
    deviceCount: 3,
    showDevPanel: false,
    devPages: [
      { name: '我的设备', url: '/subpackages/device/list/list' },
      { name: '设备详情', url: '/subpackages/device/detail/detail?id=frame_room' },
      { name: '轮播设置', url: '/subpackages/device/slideshow/slideshow?id=frame_room' },
      { name: '绑定设备', url: '/subpackages/device/bind/bind' },
      { name: '我的图库', url: '/subpackages/album/list/list' },
      { name: '照片预览-调整图片', url: '/subpackages/projection/preview/preview' },
      { name: '投屏管理', url: '/subpackages/projection/records/records' },
      { name: '投屏中', url: '/subpackages/projection/result/result?status=progress' },
      { name: '投屏成功', url: '/subpackages/projection/result/result?status=success' },
      { name: '投屏失败', url: '/subpackages/projection/result/result?status=fail' },
      { name: '设置', url: '/subpackages/settings/index/index' },
      { name: '个人信息', url: '/subpackages/settings/profile/profile' },
      { name: '绑定邮箱', url: '/subpackages/settings/bind-email/bind-email' },
      { name: '修改邮箱', url: '/subpackages/settings/change-email/change-email' },
      { name: '忘记密码', url: '/subpackages/settings/forgot-password/forgot-password' },
      { name: '语种设置', url: '/subpackages/settings/language/language' },
      { name: '操作指南', url: '/subpackages/settings/guide/guide' },
      { name: '更新BoltStar', url: '/subpackages/settings/update/update' },
      { name: '隐私政策', url: '/subpackages/settings/privacy/privacy' },
      { name: '用户协议', url: '/subpackages/settings/agreement/agreement' }
    ]
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
      const displayUserId = userInfo.id && /^\d+$/.test(String(userInfo.id)) ? userInfo.id : '123456'
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

  toggleDevPanel() {
    this.setData({
      showDevPanel: !this.data.showDevPanel
    })
  },

  goDev(event) {
    const url = event.currentTarget.dataset.url
    this.setData({
      showDevPanel: false
    })
    wx.navigateTo({ url })
  },

  noop() {}
})
