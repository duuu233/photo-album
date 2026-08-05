const api = require('../../../utils/api')
const system = require('../../../utils/system')
const fold = require('../../../utils/fold-adapt')

const app = getApp()

// 折叠屏/分屏适配：Page 配置外面包一层 fold.adapt（方案见 utils/fold-adapt.js 与
// styles/fold-adapt.wxss）。只叠加「形态变化后重测状态栏/安全区」等钩子，页面原有配置一字不改。
Page(fold.adapt({
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
    // 更换头像/昵称保存成功不再弹提示（界面已更新即为反馈）；保存失败由接口层统一提示。
  },

  // 邮箱已隐藏（2026-07-18）：页面不展示邮箱行，小程序不操作邮箱，绑定/修改均在 App 内完成
  // data.userInfo.email 仍保留：loadUser 取回后随 saveProfile 原样回传，避免保存时把后端邮箱清空

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
}))
