const api = require('../../../utils/api')
const toast = require('../../../utils/toast')
const system = require('../../../utils/system')
const fold = require('../../../utils/fold-adapt')
const wifiShare = require('../../../utils/wifi-share')

const app = getApp()

// 接受设备分享（2026-10-29，简化版：微信卡片打开，见 utils/wifi-share.js）。
//   · 卡片参数缺失 / 格式不对：显示「分享链接无效」；
//   · 未登录：点「登录并接受」先记下本次卡片（10 分钟内有效），登录成功后回到本页（login 页处理）；
//   · 已登录点「接受」：是自己分享的 → 提示；已在自己列表 → 直接进详情；否则 addUserProduct（isToHave=0、
//     shareUserId=所有者 userId），成功后回查列表拿到记录、进 WiFi 详情。服务端拒绝时提示由接口层统一给出。
Page(fold.adapt({
  data: {
    statusBarHeight: 20,
    safeBottom: 0,
    invalid: false,
    info: null,
    loggedIn: false,
    accepting: false
  },

  onLoad(options) {
    const info = wifiShare.parseAcceptQuery(options)
    this.setData(Object.assign(system.getLayoutMetrics(), { info, invalid: !info }))
  },

  onShow() {
    const token = app.globalData.token || wx.getStorageSync('token')
    const jwtToken = app.globalData.jwtToken || wx.getStorageSync('jwtToken')
    this.setData({ loggedIn: !!(token && jwtToken) })
  },

  async accept() {
    const info = this.data.info
    if (!info || this.data.accepting) {
      return
    }
    if (!this.data.loggedIn) {
      try {
        wx.setStorageSync(wifiShare.PENDING_KEY, { path: wifiShare.buildAcceptPath(info), at: Date.now() })
      } catch (error) {
        // 存不下就登录后回首页，用户再点一次卡片即可
      }
      app.requireLogin()
      return
    }
    this.setData({ accepting: true })
    try {
      await this.doAccept(info)
    } finally {
      if (!this.unloaded) {
        this.setData({ accepting: false })
      }
    }
  },

  async doAccept(info) {
    let user = null
    try {
      user = await api.getUserProfile()
    } catch (error) {
      user = null
    }
    if (user && String(user.userId) === String(info.ownerUserId)) {
      toast.show({ title: '这是你分享出去的设备', icon: 'none' })
      return
    }
    let devices = []
    try {
      devices = await api.getDevices()
    } catch (error) {
      devices = []
    }
    const existed = wifiShare.findBound(devices, info.deviceId)
    if (existed) {
      toast.show({ title: '设备已在你的设备列表中', icon: 'none' })
      this.openDetail(existed)
      return
    }
    try {
      await api.acceptSharedDevice({
        productId: Number(info.productId),
        productName: info.deviceName,
        deviceId: info.deviceId,
        shareUserId: Number(info.ownerUserId)
      })
    } catch (error) {
      return // 失败（含服务端拒绝）已由接口层提示
    }
    let saved = null
    try {
      saved = wifiShare.findBound(await api.getDevices(), info.deviceId)
    } catch (error) {
      saved = null
    }
    toast.show({ title: '已加入，可以使用这台设备了', icon: 'none' })
    if (saved) {
      this.openDetail(saved)
    } else {
      setTimeout(() => wx.switchTab({ url: '/pages/home/home' }), 800)
    }
  },

  openDetail(device) {
    setTimeout(() => {
      wx.redirectTo({ url: `/subpackages/device/wifi-detail/wifi-detail?id=${device.id}` })
    }, 600)
  },

  goHome() {
    wx.switchTab({ url: '/pages/home/home' })
  },

  onUnload() {
    this.unloaded = true
  }
}))
