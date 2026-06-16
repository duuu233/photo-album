const api = require('../../../utils/api')
const system = require('../../../utils/system')

const app = getApp()

Page({
  data: {
    statusBarHeight: 20,
    safeBottom: 0,
    userInfo: {
      id: '--',
      nickName: '微信用户',
      avatarUrl: '',
      email: '',
      phone: ''
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

  // 加载用户资料，对缺失字段做占位兜底
  async loadUser() {
    try {
      const userInfo = await api.getUserProfile()
      this.syncUser({
        id: userInfo.id || userInfo.userNo || '--',
        nickName: userInfo.nickName || '微信用户',
        avatarUrl: userInfo.avatarUrl || '',
        email: userInfo.email || '',
        phone: userInfo.phone || ''
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

  // 已绑邮箱去“更换邮箱”，未绑去“绑定邮箱”
  goEmail() {
    wx.navigateTo({
      url: this.data.userInfo.email ? '/subpackages/settings/change-email/change-email' : '/subpackages/settings/bind-email/bind-email'
    })
  },

  goBack() {
    wx.navigateBack()
  },

  // 统一同步用户信息：内存、本地缓存、页面 data 三处一起更新
  syncUser(userInfo) {
    app.globalData.userInfo = userInfo
    wx.setStorageSync('userInfo', userInfo)
    this.setData({
      userInfo
    })
  }
})
