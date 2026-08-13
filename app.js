const api = require('./utils/api')
const system = require('./utils/system')
const deviceBle = require('./utils/device-ble')
const aiServiceConsent = require('./utils/ai-service-consent')
const deviceIdentity = require('./utils/device-identity')

// 将回调式的 wx.login 封装为 Promise，便于在 async 流程中 await
function wxLogin() {
  return new Promise((resolve, reject) => {
    wx.login({
      success: resolve,
      fail: reject
    })
  })
}

// 预取的登录 code 按 4 分钟判超龄：官方有效期 5 分钟，留 1 分钟余量——
// 拿一个临期 code 去提交，网络慢一点就变成「code 已过期」的新失败。
const LOGIN_CODE_MAX_AGE_MS = 4 * 60 * 1000

App({
  onLaunch() {
    // 记录每次启动时间，用于调试/排查问题（最新的排在最前）。
    // 截断到 50 条：此前只增不减，长期用户启动路径上的同步读写 Storage 会越来越慢
    const logs = wx.getStorageSync('logs') || []
    logs.unshift(Date.now())
    wx.setStorageSync('logs', logs.slice(0, 50))

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
      const jwtToken =
        this.globalData.jwtToken || wx.getStorageSync('jwtToken')
      const selected = this.globalData.selectedDevice
      if (!token || !jwtToken || !selected || !selected.id) {
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
    const token = wx.getStorageSync('token') || ''
    const jwtToken = wx.getStorageSync('jwtToken') || ''

    // 新鉴权契约要求 userToken 与 jwtToken 同时存在。旧版本只缓存 userToken，
    // 这类半会话无法为后续请求生成 Authentication 头，冷启动时直接按未登录处理。
    if (token && jwtToken) {
      this.globalData.token = token
      this.globalData.jwtToken = jwtToken
      this.globalData.userInfo = wx.getStorageSync('userInfo') || null
    } else {
      this.globalData.token = ''
      this.globalData.jwtToken = ''
      this.globalData.userInfo = null
      wx.removeStorageSync('token')
      wx.removeStorageSync('jwtToken')
      wx.removeStorageSync('userInfo')
      wx.removeStorageSync('selectedDevice')
    }
    // 选中设备连同最近一次有效电量恢复；页面先展示缓存，15 秒窗口外再后台刷新，
    // 避免启动/切页时出现「-- → 真值」闪烁。
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

    const profile = session.user
      ? Object.assign({}, session.user, {
          userToken: session.userToken || session.token,
          jwtToken: session.jwtToken
        })
      : session
    return this.applyWechatSession(profile)
  },

  // ── 登录 code 预取（2026-08-13，修「隔日首次登录必失败、重试即成功」）─────────────
  //
  // 根因：旧版手机号授权的 encryptedData 用「用户点授权那一刻」端上的 session_key 加密，而此前的
  // 写法是**授权回调之后**才 wx.login —— login 可能刷新 session_key（隔日必刷新；同日落在官方说的
  // 「最短刷新周期」内不刷新，所以同日不复现），后端拿新 code 换到新 key，解不开旧密文，报解密失败；
  // 紧接着重试时 key 刚刷新过不再变，于是又能成功——正是现场「隔日第一次必报错、再点一次就好」。
  //
  // 修法（getPhoneNumber 官方文档明写的「建议提前 login」）：登录页 onShow 先 wx.login 预取 code，
  // 顺带把 session_key 刷新到位；授权发生在它之后，密文用的就是新 key；提交时用**预取的** code，
  // 两边必然配对。code 单次使用、5 分钟过期：消费即作废（无论提交成败），登录页在失败后再预取一个。
  prefetchLoginCode() {
    return wxLogin()
      .then(res => {
        if (res && res.code) {
          this._prefetchedLoginCode = { code: res.code, fetchedAt: Date.now() }
        }
      })
      .catch(() => {
        // 预取失败不打扰用户：提交时会现取兜底（见 loginWithWechatPhone）
        this._prefetchedLoginCode = null
      })
  },

  // 取出并作废预取的 code（单次使用）。缺失或超龄返回 ''，调用方现取兜底。
  consumePrefetchedLoginCode() {
    const stash = this._prefetchedLoginCode
    this._prefetchedLoginCode = null
    if (!stash || Date.now() - stash.fetchedAt > LOGIN_CODE_MAX_AGE_MS) {
      return ''
    }
    return stash.code
  },

  // 真实 BoltFox 一键登录：detail 来自 button open-type="getPhoneNumber" 的回调，
  // 仅携带手机号授权（旧版 encryptedData + iv）。换取 openid 必须用 wx.login 的登录 code 走
  // jscode2session —— getPhoneNumber 回调里的 code 是手机号专用 code，不能用于 jscode2session
  // （误用即报 40029 invalid code）。
  async loginWithWechatPhone(detail = {}) {
    // 优先用登录页 onShow 预取的 code（与 encryptedData 的加密 key 必然配对，见 prefetchLoginCode）。
    // 预取缺失/超龄/已被上次提交消费时回退为现取 —— 本页刚 login 过，session_key 处于最短刷新
    // 周期内不会再变，现取的 code 与密文仍是同一个 key（「重试即成功」的机理，兜底沿用它）。
    // ⚠️ 用了预取 code 就**不要**再补一次 wx.login：预取 code 对应的 key 才是密文用的那个，
    // 提交前再 login 一次没有任何收益，反而可能提前刷新掉下一次授权要用的 key。
    let code = this.consumePrefetchedLoginCode()
    if (!code) {
      const loginRes = await wxLogin()
      code = loginRes.code
    }

    const profile = await api.setWechatAppLogin({
      code,
      wxEncrypData: detail.encryptedData,
      wxIvData: detail.iv
    })

    return this.applyWechatSession(profile)
  },

  // 把后端返回的 UserInfoDetailApiOut 落地为会话：
  // userToken 继续用于业务公共参数，jwtToken 专用于 Authentication 请求头。
  applyWechatSession(profile = {}) {
    const token = profile.userToken || ''
    const jwtToken = profile.jwtToken || ''
    const userInfo = this.normalizeUserInfo(profile)

    if (!token || !jwtToken) {
      wx.showToast({
        title: '登录响应缺少登录凭证，请稍后重试',
        icon: 'none',
        duration: 3000
      })
      throw {
        code: 'LOGIN_CREDENTIALS_MISSING',
        message: '登录响应缺少 userToken 或 jwtToken'
      }
    }

    this.globalData.token = token
    this.globalData.jwtToken = jwtToken
    this.globalData.userInfo = userInfo
    wx.setStorageSync('token', token)
    wx.setStorageSync('jwtToken', jwtToken)
    wx.setStorageSync('userInfo', userInfo)

    return {
      token,
      jwtToken,
      user: userInfo
    }
  },

  // 兼容旧页面字段：BoltFox 用 avatar/userEmail，旧页面读 avatarUrl/email，这里两套都给。
  //
  // availableToken（2026-08-11）：登录响应 UserInfoDetailApiOut 里就带着可用 Token 余额，
  // 落到会话里，「我的」页与 AI 模块进页面即可直接显示，不必先打一次 getUserAccount。
  // ⚠️ 用 null 表示「这次响应没带该字段」（老后端灰度期），与「余额真的是 0」区分开——
  //    调用方据此决定要不要回退去调 /Client/Order/getUserAccount。
  normalizeUserInfo(profile = {}) {
    const available =
      profile.availableToken === undefined ||
      profile.availableToken === null ||
      profile.availableToken === ''
        ? null
        : Number(profile.availableToken)
    return {
      nickName: profile.nickName || '',
      avatar: profile.avatar || '',
      avatarUrl: profile.avatar || '',
      userEmail: profile.userEmail || '',
      email: profile.userEmail || '',
      userNo: profile.userNo || '',
      imgCount: profile.imgCount || 0,
      productCount: profile.productCount || 0,
      availableToken: Number.isFinite(available) ? Math.max(0, available) : null
    }
  },

  // 点击事件的同步登录拦截：已登录返回 true；未登录跳转登录页并返回 false。
  // 与异步的 ensureLogin 区分——这里不返回 Promise，便于在 tap 处理函数里直接 if 判断后 return。
  requireLogin() {
    const token = this.globalData.token || wx.getStorageSync('token')
    const jwtToken =
      this.globalData.jwtToken || wx.getStorageSync('jwtToken')
    if (token && jwtToken) {
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
    if (this.globalData.token && this.globalData.jwtToken) {
      return Promise.resolve({
        token: this.globalData.token,
        jwtToken: this.globalData.jwtToken,
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
    const selected = device || null
    this.globalData.selectedDevice = selected

    if (selected) {
      wx.setStorageSync('selectedDevice', selected)
      return
    }

    wx.removeStorageSync('selectedDevice')
  },

  // 退出登录：清空内存与缓存中的所有会话相关数据
  clearSession() {
    // 必须在 userInfo 置空前按当前用户 ID 清掉 AI 协议同意记录：
    // 换账号、退出、注销和 401/406 登录态失效后都需要重新确认。
    aiServiceConsent.clearCurrentUserConsent()
    this.globalData.token = ''
    this.globalData.jwtToken = ''
    this.globalData.userInfo = null
    this.setSelectedDevice(null)
    // 设备身份登记表按 userProductId 存完整设备 ID，换账号后这批主键与新用户无关，一并清空
    deviceIdentity.clear()
    wx.removeStorageSync('token')
    wx.removeStorageSync('jwtToken')
    wx.removeStorageSync('userInfo')
  },

  // 登录页 onShow 预取的登录 code（{ code, fetchedAt }，见 prefetchLoginCode）。
  // 不放 globalData：它是登录流程的内部状态，单次使用，页面不应直接读它。
  _prefetchedLoginCode: null,

  globalData: {
    token: '',
    jwtToken: '',
    userInfo: null,
    selectedDevice: null,
    // 登录页在过渡 loading 期间预取的设备列表，首页 loadHomeState 一次性消费后置回 null
    prefetchedDevices: null
  }
})
