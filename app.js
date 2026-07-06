const api = require('./utils/api')
const system = require('./utils/system')
const deviceBle = require('./utils/device-ble')

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

    // 启动全局固件检测：当前选中设备若为「强制升级」则弹窗阻断使用（提醒升级不处理）。静默失败，不打扰。
    this.checkForcedFirmwareUpgrade()
  },

  // 回前台做一次「连接体检」：微信在后台（尤其鸿蒙 HarmonyOS）会挂起蓝牙，可能已断开却没补发断开回调，
  // 内存会话会假报「已连接」，让下次操作复用死会话导致写失败/超时。这里对账真实连接、清掉已断会话，
  // 使各页「已连接」显示如实、下次操作会重新走一次真正的连接。不主动重连——连接保持「按需手动」
  //（用户点设备卡片的「连接蓝牙」按钮时才连，见 home.connectCurrentDevice）。冷启动/无连接时零开销。
  onShow() {
    deviceBle.reconcileConnections().catch(() => {})
  },

  // 启动时检测「当前选中设备」的固件升级方式：
  //   强制升级(upgradeMode==='force') -> 弹二次确认「请升级固件后继续使用」，稍后=关闭小程序 / 立刻更新=进升级页；
  //   无更新 / 提醒升级 -> 不处理。
  // 用 _fwChecked 去重，保证一次启动只弹一次；任何异常(未登录/无选中设备/网络失败)都静默返回。
  // 注：后续「App 版本升级」同理，可另接 /Client/Basic/getLastVersion 走同样的强制/提醒逻辑。
  async checkForcedFirmwareUpgrade() {
    if (this.globalData._fwChecked) {
      return
    }
    this.globalData._fwChecked = true

    try {
      const token = this.globalData.token || wx.getStorageSync('token')
      const selected = this.globalData.selectedDevice
      if (!token || !selected || !selected.id) {
        return
      }

      const device = await api.getDeviceDetail(selected.id)
      // 仅「强制升级」才弹窗阻断；无更新 / 提醒升级 → 不处理
      if (!device || device.upgradeMode !== 'force') {
        return
      }

      const version = String(device.newVersionNo || '').trim() || '新版本'
      wx.showModal({
        title: '固件升级',
        content: `检测到新版本：${version}，请升级固件后继续使用`,
        cancelText: '稍后',
        confirmText: '立刻更新',
        success: res => {
          if (res.confirm) {
            // 立刻更新：进入固件升级页
            wx.navigateTo({ url: `/subpackages/device/ota/ota?id=${device.id}` })
          } else if (wx.exitMiniProgram) {
            // 稍后：关闭小程序
            wx.exitMiniProgram()
          }
        }
      })
    } catch (error) {
      // 启动检测失败静默，不打扰用户
    }
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
  // 仅携带手机号授权（旧版 encryptedData + iv）。换取 openid 必须用 wx.login 的登录 code 走
  // jscode2session —— getPhoneNumber 回调里的 code 是手机号专用 code，不能用于 jscode2session
  // （误用即报 40029 invalid code），所以这里单独再调一次 wx.login 取新鲜登录 code。
  async loginWithWechatPhone(detail = {}) {
    // 登录 code 一次性、5 分钟有效，取到后立即提交，避免过期/复用导致 40029
    const loginRes = await wxLogin()

    const profile = await api.setWechatAppLogin({
      code: loginRes.code,
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

  // 点击事件的同步登录拦截：已登录返回 true；未登录跳转登录页并返回 false。
  // 与异步的 ensureLogin 区分——这里不返回 Promise，便于在 tap 处理函数里直接 if 判断后 return。
  requireLogin() {
    if (this.globalData.token || wx.getStorageSync('token')) {
      return true
    }

    const pages = getCurrentPages ? getCurrentPages() : []
    const current = pages[pages.length - 1]
    if (!current || current.route !== 'pages/login/login') {
      wx.navigateTo({
        url: '/pages/login/login'
      })
    }

    return false
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
      // 用 navigateTo 带左右滑动过渡进入登录页，避免 reLaunch 的瞬间闪切（与 requireLogin 一致）
      wx.navigateTo({
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
    selectedDevice: null,
    // 登录页在过渡 loading 期间预取的设备列表，首页 loadHomeState 一次性消费后置回 null
    prefetchedDevices: null
  }
})
