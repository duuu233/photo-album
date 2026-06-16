const api = require('./utils/api')
const system = require('./utils/system')

// 将回调式的 wx.login 封装为 Promise，便于在 async 流程中 await
function wxLogin() {
  return new Promise((resolve, reject) => {
    wx.login({
      success: resolve,
      fail: reject
    })
  })
}

App({
  onLaunch() {
    // 记录每次启动时间，用于调试/排查问题（最新的排在最前）
    const logs = wx.getStorageSync('logs') || []
    logs.unshift(Date.now())
    wx.setStorageSync('logs', logs)

    // 启动即从本地缓存恢复上次的登录态与选中设备，避免每次都重新登录
    this.restoreSession()
  },

  // 把本地缓存里的会话信息读回内存（globalData），作为全局单一数据源
  restoreSession() {
    this.globalData.token = wx.getStorageSync('token') || ''
    this.globalData.userInfo = wx.getStorageSync('userInfo') || null
    this.globalData.selectedDevice = wx.getStorageSync('selectedDevice') || null
  },

  // 走微信登录换取后端 token：wx.login 拿 code → 后端校验返回 token/用户信息
  async loginWithWechat() {
    const loginRes = await wxLogin()

    const session = await api.loginByWechat({
      code: loginRes.code,
      // 把系统语言一并上报，便于后端按语言返回内容
      language: system.getSystemLanguageInfo().value
    })

    // 内存与本地缓存双写，保证下次启动能恢复
    this.globalData.token = session.token
    this.globalData.userInfo = session.user
    wx.setStorageSync('token', session.token)
    wx.setStorageSync('userInfo', session.user)
    return session
  },

  // 真实 BoltFox 一键登录：detail 来自 button open-type="getPhoneNumber" 的回调，
  // 新版微信返回 code，旧版返回 encryptedData + iv，后端据此换取手机号并下发 userToken。
  async loginWithWechatPhone(detail = {}) {
    const profile = await api.setWechatAppLogin({
      code: detail.code,
      wxEncrypData: detail.encryptedData,
      wxIvData: detail.iv
    })

    return this.applyWechatSession(profile)
  },

  // 把后端返回的 UserInfoDetailApiOut 落地为会话：写 token + 规范化用户信息，内存与缓存双写。
  applyWechatSession(profile = {}) {
    const token = profile.userToken || ''
    const userInfo = this.normalizeUserInfo(profile)

    this.globalData.token = token
    this.globalData.userInfo = userInfo
    wx.setStorageSync('token', token)
    wx.setStorageSync('userInfo', userInfo)

    return {
      token,
      user: userInfo
    }
  },

  // 兼容旧页面字段：BoltFox 用 avatar/userEmail，旧页面读 avatarUrl/email，这里两套都给。
  normalizeUserInfo(profile = {}) {
    return {
      nickName: profile.nickName || '',
      avatar: profile.avatar || '',
      avatarUrl: profile.avatar || '',
      userEmail: profile.userEmail || '',
      email: profile.userEmail || '',
      userNo: profile.userNo || '',
      imgCount: profile.imgCount || 0,
      productCount: profile.productCount || 0
    }
  },

  // 需要登录态的入口统一调用：已登录直接复用，未登录才触发微信登录
  ensureLogin() {
    if (this.globalData.token) {
      return Promise.resolve({
        token: this.globalData.token,
        user: this.globalData.userInfo
      })
    }

    const pages = getCurrentPages ? getCurrentPages() : []
    const current = pages[pages.length - 1]
    if (!current || current.route !== 'pages/login/login') {
      wx.reLaunch({
        url: '/pages/login/login'
      })
    }

    return Promise.reject({
      code: 'NO_TOKEN',
      message: '请先登录'
    })
  },

  // 设置/清除当前选中的相框设备，同步写入缓存以便跨页面、跨启动保持选中
  setSelectedDevice(device) {
    this.globalData.selectedDevice = device || null

    if (device) {
      wx.setStorageSync('selectedDevice', device)
      return
    }

    wx.removeStorageSync('selectedDevice')
  },

  // 退出登录：清空内存与缓存中的所有会话相关数据
  clearSession() {
    this.globalData.token = ''
    this.globalData.userInfo = null
    this.setSelectedDevice(null)
    wx.removeStorageSync('token')
    wx.removeStorageSync('userInfo')
  },

  globalData: {
    token: '',
    userInfo: null,
    selectedDevice: null
  }
})
