const api = require('./utils/api')
const system = require('./utils/system')

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
    const logs = wx.getStorageSync('logs') || []
    logs.unshift(Date.now())
    wx.setStorageSync('logs', logs)

    this.restoreSession()
  },

  restoreSession() {
    this.globalData.token = wx.getStorageSync('token') || ''
    this.globalData.userInfo = wx.getStorageSync('userInfo') || null
    this.globalData.selectedDevice = wx.getStorageSync('selectedDevice') || null
  },

  async loginWithWechat() {
    const loginRes = await wxLogin()

    const session = await api.loginByWechat({
      code: loginRes.code,
      language: system.getSystemLanguageInfo().value
    })

    this.globalData.token = session.token
    this.globalData.userInfo = session.user
    wx.setStorageSync('token', session.token)
    wx.setStorageSync('userInfo', session.user)
    return session
  },

  ensureLogin() {
    if (this.globalData.token) {
      return Promise.resolve({
        token: this.globalData.token,
        user: this.globalData.userInfo
      })
    }
    return this.loginWithWechat()
  },

  setSelectedDevice(device) {
    this.globalData.selectedDevice = device || null

    if (device) {
      wx.setStorageSync('selectedDevice', device)
      return
    }

    wx.removeStorageSync('selectedDevice')
  },

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
