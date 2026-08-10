const api = require('../../utils/api')
const galleryApi = require('../../utils/gallery-api')
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
    // 2026-08-06 新增两行入口（设计稿 assets/ai/UI页面/我的.png）
    favoriteCount: 0,
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

  // 并行拉取用户信息、设备列表、投屏成功记录数，组装“我的”页头部与两张功能卡的展示数据
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
        favoriteCount: 0,
        tokenBalance: 0
      })
      return
    }

    try {
      const [userInfo, devices, castSuccessCount, favoriteCount, tokenAccount] = await Promise.all([
        api.getUserProfile(),
        api.getDevices(),
        api.getProjectionSuccessCount(),
        // ⚠️ 收藏数仍来自本地 mock（gallery-api），后端接口尚未提供；Token 余额已走真实接口
        // （/Client/Order/getUserAccount）。两者都做了自身的失败兜底，不让它们把整个
        // Promise.all 拖挂——用户信息才是这页的主数据。
        galleryApi.getFavoriteCount().catch(() => 0),
        tokenApi.getAccount().catch(() => ({ balance: 0 }))
      ])
      const displayUserId = userInfo.id || userInfo.userNo || '--'
      const displayName = displayNickname(userInfo.nickName) || '微信用户'
      this._mineLoaded = true
      this.setData({
        avatarUrl: userInfo.avatarUrl || '',
        nickName: displayName,
        userId: displayUserId,
        // 2026-08-05：「我的相册」卡片的张数改成**全部设备的投屏成功记录条数**，与点进去
        // 看到的列表同一个口径。不再用用户信息里的 imgCount（相册口径：投屏失败的、已从设备
        // 删掉的都算在内），那个数和列表对不上。
        photoCount: castSuccessCount,
        deviceCount: Number(userInfo.productCount) || devices.length,
        favoriteCount,
        tokenBalance: (tokenAccount && tokenAccount.balance) || 0
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
          favoriteCount: 0,
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

  // goRecords（投屏管理入口）已于 2026-08-04 随模块合并移除：投屏成功的照片进「我的相册」，
  // 投屏记录页（含失败记录/重新投屏）仍保留，由投屏结果页的「投屏明细」进入。
  // 2026-08-06 的「我的」设计稿里又画了这一行，未恢复，原因见 mine.wxml 里的注释。

  // 2026-08-06 新增：官方图库的收藏列表
  goFavorites() {
    if (!app.requireLogin()) {
      return
    }
    wx.navigateTo({
      url: '/subpackages/gallery/favorites/favorites'
    })
  },

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
