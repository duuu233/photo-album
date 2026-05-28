const api = require('../../../utils/api')
const system = require('../../../utils/system')

const app = getApp()

Page({
  data: {
    statusBarHeight: 20,
    safeBottom: 0,
    userInfo: {
      id: '123456',
      nickName: '江江江',
      avatarUrl: '',
      email: '',
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
    this.setData(system.getLayoutMetrics())
  },

  async loadUser() {
    try {
      const userInfo = await api.getUserProfile()
      const displayId = userInfo.id && /^\d+$/.test(String(userInfo.id)) ? userInfo.id : '123456'
      this.syncUser({
        id: displayId,
        nickName: userInfo.nickName || '江江江',
        avatarUrl: userInfo.avatarUrl || '',
        email: userInfo.email || '',
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

  async saveProfile() {
    const userInfo = await api.updateUserProfile(this.data.userInfo)
    this.syncUser(Object.assign({}, this.data.userInfo, userInfo))
    wx.showToast({
      title: '已保存',
      icon: 'success'
    })
  },

  goEmail() {
    wx.navigateTo({
      url: this.data.userInfo.email ? '/subpackages/settings/change-email/change-email' : '/subpackages/settings/bind-email/bind-email'
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
