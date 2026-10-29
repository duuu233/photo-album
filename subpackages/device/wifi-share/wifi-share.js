const api = require('../../../utils/api')
const toast = require('../../../utils/toast')
const system = require('../../../utils/system')
const fold = require('../../../utils/fold-adapt')
const wifiShare = require('../../../utils/wifi-share')

// WiFi 版分享列表（2026-10-29）。入口：WiFi 详情「分享设备」（仅所有者）。
//   · 第一栏固定所有者（头像 + 昵称 + 身份），与接收者用不同底色区分；
//   · 下面是接收者（头像 + 昵称 + 加入时间 + 移除）；底部按钮「分享设备」。
// 数据：老服务 getShareUserProductList（按后端设备号）；列表里没有所有者时用当前用户资料兜底。
// 分享邀请、移除成员的服务端接口尚未提供（docs/wifi/设备分享方案.md），两个按钮先提示「即将上线」。
const PENDING_TIP = '该功能即将上线，敬请期待'

Page(fold.adapt({
  data: {
    statusBarHeight: 20,
    safeBottom: 0,
    id: '',
    loading: true,
    loadError: false,
    owner: null,
    members: []
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
    const deviceId = device.rawProductDeviceId || device.productDeviceId || device.deviceNo
    let list
    try {
      list = await api.getShareUsers({ deviceId })
    } catch (error) {
      list = null
    }
    let profile = null
    if (!list || !list.some(item => item && Number(item.isToHave) === 1)) {
      try {
        const user = await api.getUserProfile()
        profile = { userProductId: device.userProductId, userName: user && user.nickName, avatar: user && user.avatarUrl }
      } catch (error) {
        profile = { userProductId: device.userProductId }
      }
    }
    if (this.unloaded) {
      return
    }
    if (!list) {
      this.setData({ loading: false, loadError: true })
      return
    }
    const split = wifiShare.splitMembers(list, profile)
    this.setData({ loading: false, loadError: false, owner: split.owner, members: split.members })
  },

  retryLoad() {
    this.setData({ loading: true, loadError: false })
    this.load()
  },

  removeMember() {
    toast.show({ title: PENDING_TIP, icon: 'none' })
  },

  shareDevice() {
    toast.show({ title: PENDING_TIP, icon: 'none' })
  }
}))
