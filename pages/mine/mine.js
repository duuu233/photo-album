const api = require('../../utils/api')

const app = getApp()
const defaultAvatarUrl = 'https://mmbiz.qpic.cn/mmbiz/icTdbqWNOwNRna42FI242Lcia07jQodd2FJGIYQfG0LAJGFxM4FbnQP6yfMxBgJ0F3YRqJCJ1aPAK2dQagdusBZg/0'

Page({
  data: {
    userInfo: null,
    defaultAvatarUrl,
    stats: {
      photoCount: 0,
      deviceCount: 0,
      recordCount: 0
    }
  },

  onShow() {
    this.loadMine()
  },

  async loadMine() {
    await app.ensureLogin()
    const [userInfo, photos, devices, records] = await Promise.all([
      api.getUserProfile(),
      api.getAlbumPhotos(),
      api.getDevices(),
      api.getProjectionRecords()
    ])

    app.globalData.userInfo = userInfo
    wx.setStorageSync('userInfo', userInfo)
    this.setData({
      userInfo,
      stats: {
        photoCount: photos.length,
        deviceCount: devices.length,
        recordCount: records.length
      }
    })
  },

  async onChooseAvatar(e) {
    const avatarUrl = e.detail.avatarUrl
    const userInfo = await api.updateUserProfile({
      avatarUrl
    })
    app.globalData.userInfo = userInfo
    wx.setStorageSync('userInfo', userInfo)
    this.setData({
      userInfo
    })
  },

  async onNicknameBlur(e) {
    const nickName = e.detail.value.trim()

    if (!nickName || !this.data.userInfo || nickName === this.data.userInfo.nickName) {
      return
    }

    const userInfo = await api.updateUserProfile({
      nickName
    })
    app.globalData.userInfo = userInfo
    wx.setStorageSync('userInfo', userInfo)
    this.setData({
      userInfo
    })
  },

  async bindPhone(e) {
    if (!e.detail || !e.detail.code) {
      wx.showToast({
        title: '未授权手机号',
        icon: 'none'
      })
      return
    }

    const userInfo = await api.bindPhone({
      code: e.detail.code
    })
    app.globalData.userInfo = userInfo
    wx.setStorageSync('userInfo', userInfo)
    this.setData({
      userInfo
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
      url: '/subpackages/projection/guide/guide'
    })
  },

  goSettings() {
    wx.navigateTo({
      url: '/subpackages/settings/index/index'
    })
  },

  goProfile() {
    wx.navigateTo({
      url: '/subpackages/settings/profile/profile'
    })
  },

  goModifyPassword() {
    wx.navigateTo({
      url: '/subpackages/settings/modify-password/modify-password'
    })
  }
})
