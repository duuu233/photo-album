const api = require('../../../utils/api')

const app = getApp()
const defaultAvatarUrl = 'https://mmbiz.qpic.cn/mmbiz/icTdbqWNOwNRna42FI242Lcia07jQodd2FJGIYQfG0LAJGFxM4FbnQP6yfMxBgJ0F3YRqJCJ1aPAK2dQagdusBZg/0'

Page({
  data: {
    userInfo: null,
    defaultAvatarUrl
  },

  onShow() {
    this.loadUser()
  },

  async loadUser() {
    const userInfo = await api.getUserProfile()
    this.syncUser(userInfo)
  },

  async onChooseAvatar(e) {
    await this.updateProfile({
      avatarUrl: e.detail.avatarUrl
    })
  },

  onNicknameInput(e) {
    this.setData({
      'userInfo.nickName': e.detail.value
    })
  },

  async saveProfile() {
    if (!this.data.userInfo) {
      return
    }

    const nickName = this.data.userInfo.nickName.trim()

    if (!nickName) {
      wx.showToast({
        title: '请输入昵称',
        icon: 'none'
      })
      return
    }

    await this.updateProfile({
      nickName
    })

    wx.showToast({
      title: '已保存',
      icon: 'success'
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
    this.syncUser(userInfo)
  },

  goBindEmail() {
    wx.navigateTo({
      url: '/subpackages/settings/bind-email/bind-email'
    })
  },

  goChangeEmail() {
    wx.navigateTo({
      url: '/subpackages/settings/change-email/change-email'
    })
  },

  goEmail() {
    if (this.data.userInfo && this.data.userInfo.email) {
      this.goChangeEmail()
      return
    }
    this.goBindEmail()
  },

  async updateProfile(payload) {
    const userInfo = await api.updateUserProfile(payload)
    this.syncUser(userInfo)
  },

  syncUser(userInfo) {
    app.globalData.userInfo = userInfo
    wx.setStorageSync('userInfo', userInfo)
    this.setData({
      userInfo
    })
  }
})
