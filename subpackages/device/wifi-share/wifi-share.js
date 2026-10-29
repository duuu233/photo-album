const api = require('../../../utils/api')
const toast = require('../../../utils/toast')
const system = require('../../../utils/system')
const fold = require('../../../utils/fold-adapt')
const wifiShare = require('../../../utils/wifi-share')

// WiFi 版分享列表（2026-10-29）。入口：WiFi 详情「分享设备」（仅所有者）。
//   · 第一栏固定所有者（头像 + 昵称 + 身份），与接收者用不同底色区分；
//   · 下面是接收者（头像 + 昵称 + 加入时间 + 移除）；底部按钮「分享设备」。
// 数据：老服务 getShareUserProductList（按后端设备号）；列表里没有所有者时用当前用户资料兜底。
// 分享（简化版，无邀请码）：底部按钮 open-type="share" 发微信卡片，卡片路径带设备号 / 产品 / 所有者 userId，
//   对方在接受页确认后以非所有者身份绑定（见 utils/wifi-share.js）。拿不到自己的 userId 或产品 ID 时不让分享。
// 移除：确认后 delUserProduct 删成员那条记录，再刷新列表。服务端暂无加入时间字段，显示「--」。
Page(fold.adapt({
  data: {
    statusBarHeight: 20,
    safeBottom: 0,
    id: '',
    loading: true,
    loadError: false,
    owner: null,
    members: [],
    canShare: false
  },

  onLoad(options) {
    this.setData(Object.assign(system.getLayoutMetrics(), { id: (options && options.id) || '' }))
    this.load()
  },

  onUnload() {
    this.unloaded = true
  },

  async load() {
    let device
    try {
      device = await api.getDeviceDetail(this.data.id)
    } catch (error) {
      this.setData({ loading: false, loadError: true })
      return
    }
    this.device = device
    const deviceId = device.rawProductDeviceId || device.productDeviceId || device.deviceNo
    let list
    try {
      list = await api.getShareUsers({ deviceId })
    } catch (error) {
      list = null
    }
    let user = null
    try {
      user = await api.getUserProfile()
    } catch (error) {
      user = null
    }
    this.user = user
    if (this.unloaded) {
      return
    }
    if (!list) {
      this.setData({ loading: false, loadError: true })
      return
    }
    const profile = { userProductId: device.userProductId, userName: user && user.nickName, avatar: user && user.avatarUrl }
    const split = wifiShare.splitMembers(list, profile)
    this.setData({
      loading: false,
      loadError: false,
      owner: split.owner,
      members: split.members,
      canShare: !!(user && user.userId && device.productId && device.productDeviceId)
    })
  },

  retryLoad() {
    this.setData({ loading: true, loadError: false })
    this.load()
  },

  removeMember(e) {
    const id = String(e.currentTarget.dataset.id || '')
    const member = this.data.members.filter(item => item.id === id)[0]
    if (!member || this._removing) {
      return
    }
    wx.showModal({
      title: '移除成员',
      content: `移除后「${member.name}」将不能再使用这台设备，确认移除？`,
      confirmText: '移除',
      confirmColor: '#ff3045',
      success: res => {
        if (res.confirm) {
          this.confirmRemove(member)
        }
      }
    })
  },

  async confirmRemove(member) {
    if (this._removing) {
      return
    }
    this._removing = true
    try {
      await api.removeShareUser(member.id)
    } catch (error) {
      this._removing = false
      return // 失败已由接口层提示
    }
    this._removing = false
    toast.show({ title: '已移除', icon: 'none' })
    this.load()
  },

  // 拿不到自己的 userId / 产品 ID 时底部是普通按钮，点了只提示
  shareUnavailable() {
    toast.show({ title: '暂时无法分享，请稍后重试', icon: 'none' })
  },

  // 底部「分享设备」（open-type="share"）与右上角菜单都走这里；不能分享时退回小程序首页卡片
  onShareAppMessage() {
    const device = this.device || {}
    const user = this.user || {}
    if (!this.data.canShare) {
      return { title: 'BoltStar 智能相框', path: '/pages/home/home' }
    }
    const ownerName = user.nickName || ''
    return {
      title: `${ownerName || '好友'}邀请你共用电子纸设备「${device.name || '智能相框'}」`,
      path: wifiShare.buildAcceptPath({
        deviceId: device.productDeviceId,
        productId: device.productId,
        ownerUserId: user.userId,
        deviceName: device.name,
        ownerName
      })
    }
  }
}))
