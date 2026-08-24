const api = require('../../utils/api')
const tokenApi = require('../../utils/token-api')

const app = getApp()

// 后端历史数据可能把 emoji 存成 Unicode/HTML 转义串；统一解码为真实码点后交给文本节点展示。
function displayNickname(value) {
  return String(value || '')
    .replace(/\\u\{([0-9a-fA-F]+)\}/g, (_, hex) =>
      String.fromCodePoint(parseInt(hex, 16))
    )
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16))
    )
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
      String.fromCodePoint(parseInt(hex, 16))
    )
    .replace(/&#([0-9]+);/g, (_, num) =>
      String.fromCodePoint(parseInt(num, 10))
    )
}

Page({
  data: {
    statusBarHeight: 20,
    safeBottom: 0,
    avatarUrl: '',
    nickName: '微信用户',
    userId: '--',
    photoCount: 0,
    deviceCount: 0,
    // 2026-08-06 新增（设计稿 assets/ai/UI页面/我的.png）。
    // ⚠️ 同批的「我的收藏」入口已于 2026-08-12 移到官方图库页分类条右侧，
    // 本页不再展示收藏数，也不再打 galleryApi.getFavoriteCount()（少一个请求）。
    tokenBalance: 0,
    bgReady: false
  },

  onLoad() {
    this.setSystemMetrics()
  },

  onShow() {
    if (wx.hideTabBar) {
      wx.hideTabBar({
        animation: false
      })
    }
    this.loadUserInfo()
  },

  onMineBgLoaded() {
    if (!this.data.bgReady) {
      this.setData({ bgReady: true })
    }
  },

  setSystemMetrics() {
    try {
      const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
      const safeBottom = Math.max(0, (info.screenHeight || 0) - (info.safeArea ? info.safeArea.bottom : info.windowHeight || 0))
      this.setData({
        statusBarHeight: info.statusBarHeight || 20,
        safeBottom
        // ⚠️ 页面高度不在这里存：交给 wxss 的 100vh（见 mine.wxss .mine-root 注释）
      })
    } catch (error) {
      this.setData({
        statusBarHeight: 20,
        safeBottom: 0
      })
    }
  },

  // 折叠屏展开/折叠、旋转、分屏、三折叠切形态都会触发：
  // 页面高度由 100vh 自动跟随，这里只重测状态栏高度与底部安全区（内外屏刘海/Home Indicator 不同）
  onResize() {
    this.setSystemMetrics()
  },

  // 拉一次用户信息，组装“我的”页头部与两张功能卡的展示数据。
  // 2026-08-24 起两张卡的数字都由用户信息接口直接下发（见下方 setData 处注释），
  // 不再另外打设备列表与投屏记录接口——进页面只剩这一个请求。
  async loadUserInfo() {
    // 游客模式：未登录展示默认头部，不强制跳登录（登录留到具体操作时再触发）
    const token = app.globalData.token || wx.getStorageSync('token')
    const jwtToken =
      app.globalData.jwtToken || wx.getStorageSync('jwtToken')
    if (!token || !jwtToken) {
      this._mineLoaded = false // 登出后回默认态，此前的成功数据不再保留
      this.setData({
        avatarUrl: '',
        nickName: '微信用户',
        userId: '--',
        photoCount: 0,
        deviceCount: 0,
        tokenBalance: 0
      })
      return
    }

    try {
      const userInfo = await api.getUserProfile()

      // Token 余额（2026-08-11 接口对账）：`getUserInfo` 的出参已带 `availableToken`，
      // 本页不再固定多打一次 `/Client/Order/getUserAccount`。
      // 只有该字段缺失（null = 老后端灰度期没下发）才回退查账户；余额真的是 0 时照常显示 0。
      let tokenBalance = userInfo.availableToken
      if (tokenBalance === null || tokenBalance === undefined) {
        tokenBalance = await tokenApi
          .getAccount({ showError: false })
          .then(account => (account && account.balance) || 0)
          .catch(() => 0)
      }
      const displayUserId = userInfo.id || userInfo.userNo || '--'
      const displayName = displayNickname(userInfo.nickName) || '微信用户'
      this._mineLoaded = true
      this.setData({
        avatarUrl: userInfo.avatarUrl || '',
        nickName: displayName,
        userId: displayUserId,
        // 2026-08-24 按接口文档统一口径：两张卡的数字都取用户信息接口
        // （登录 setWechatAppLogin / getUserInfo 同一份 UserInfoDetailApiOut）下发的字段——
        // 「我的上传」= imgCount，「我的设备」= productCount，后端算什么就显示什么。
        // ⚠️ 这是对 2026-08-05「张数改用投屏成功记录条数」的有意回退：卡片文案已从
        //    「我的相册」改成「我的上传」，口径就是用户上传过的张数（含投屏失败/已从设备删掉的），
        //    与点进去的成功记录列表本来就不是同一个数，别再为了对齐列表把它改回去。
        photoCount: Number(userInfo.imgCount) || 0,
        deviceCount: Number(userInfo.productCount) || 0,
        tokenBalance
      })
    } catch (error) {
      // 失败保留上次成功值：弱网切到「我的」页把照片/设备数清零，用户会误以为数据没了。
      // 只有从未成功加载过（首次进入即失败）才落占位（接口层已 toast，此处不再提示）
      if (!this._mineLoaded) {
        this.setData({
          nickName: '微信用户',
          userId: '--',
          photoCount: 0,
          deviceCount: 0,
          tokenBalance: 0
        })
      }
    }
  },

  goHome() {
    wx.switchTab({
      url: '/pages/home/home'
    })
  },

  goProfile() {
    if (!app.requireLogin()) {
      return
    }
    wx.navigateTo({
      url: '/subpackages/settings/profile/profile'
    })
  },

  // 「我的相册」：2026-08-04 由原「设备照片」+「投屏管理」两个模块合并而成，
  // 页面仍是 subpackages/album/list（沿用其 UI），数据改用「投屏成功记录」（见该页注释）。
  goAlbum() {
    if (!app.requireLogin()) {
      return
    }
    wx.navigateTo({
      url: '/subpackages/album/list/list'
    })
  },

  goDevices() {
    if (!app.requireLogin()) {
      return
    }
    wx.navigateTo({
      url: '/subpackages/device/list/list'
    })
  },

  // goRecords（投屏管理入口）已于 2026-08-04 随模块合并移除：投屏成功的照片进「我的相册」。
  // 2026-08-06 的「我的」设计稿里又画了这一行，未恢复，原因见 mine.wxml 里的注释。
  // ⚠️ 投屏记录页（含失败记录/重新投屏）代码仍在（subpackages/projection/records），
  // 但 2026-08-12 起**全项目已没有入口**：投屏结果页那一行「投屏明细」原本进的是它，
  // 现改进「我的相册」。要恢复入口就在这里加回一行，页面本身不用动。

  // 「我的收藏」入口 2026-08-12 按产品要求移到官方图库页（分类条右侧常驻），本页不再提供，
  // 跳转逻辑随之搬到 subpackages/gallery/list/list.js 的 goFavorites。

  // 2026-08-06 新增：Token 管理（余额 / 套餐 / 购买与消费记录）
  goToken() {
    if (!app.requireLogin()) {
      return
    }
    wx.navigateTo({
      url: '/subpackages/token/index/index'
    })
  },

  goGuide() {
    if (!app.requireLogin()) {
      return
    }
    wx.navigateTo({
      url: '/subpackages/settings/guide/guide'
    })
  },

  goSettings() {
    if (!app.requireLogin()) {
      return
    }
    wx.navigateTo({
      url: '/subpackages/settings/index/index'
    })
  },

  noop() {}
})
