const api = require('../../../utils/api')

const app = getApp()
const defaultAvatarUrl = 'https://mmbiz.qpic.cn/mmbiz/icTdbqWNOwNRna42FI242Lcia07jQodd2FJGIYQfG0LAJGFxM4FbnQP6yfMxBgJ0F3YRqJCJ1aPAK2dQagdusBZg/0'

Page({
  data: {
    userInfo: null,
    defaultAvatarUrl,
    emailInput: ''
  },

  onShow() {
    this.loadUser()
  },

  async loadUser() {
    const userInfo = await api.getUserProfile()
    this.setData({
      userInfo,
      emailInput: userInfo.email || ''
    })
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

  onEmailInput(e) {
    this.setData({
      emailInput: e.detail.value
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

    if (this.data.emailInput) {
      await api.bindEmail(this.data.emailInput)
    }

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

  async updateProfile(payload) {
    const userInfo = await api.updateUserProfile(payload)
    this.syncUser(userInfo)
  },

  syncUser(userInfo) {
    app.globalData.userInfo = userInfo
    wx.setStorageSync('userInfo', userInfo)
    this.setData({
      userInfo,
      emailInput: userInfo.email || this.data.emailInput
    })
  }
})
