const api = require('../../../utils/api')
const toast = require('../../../utils/toast')
const system = require('../../../utils/system')
const fold = require('../../../utils/fold-adapt')
const wifiShare = require('../../../utils/wifi-share')
const shareCard = require('../../../utils/share-card')

// WiFi 版共享设备列表（2026-10-29）。入口：WiFi 详情「共享设备」（2026-11-05 起所有者与接收者都能进）。
//   · 接收者（2026-11-05）：显示内容与所有者一致（所有者栏 + 已分享成员），没有底部「分享设备」；
//     身份按设备详情判断（wifiShare.isOwner），不看入口参数。接收者不画卡片封面、不取时间戳 / 个人资料，
//     列表里没有所有者那条时不拿自己兜底（所有者栏不显示），右上角转发退回首页卡片。
//     成员列表里接收者自己那行（按 userProductId 认）在原「移除」位置显示文字「我」（该行能解绑时显示「移除」）。
//   · 「移除」按钮（2026-11-05 起后端控制）：成员接口每条带 isCanDel，== 1 才显示、才能移除，前端不再按所有者 / 接收者判断。
//     自己那条被移除（接收者解绑自己）后这台设备就不在自己名下，提示后回首页。
//   · 第一栏固定所有者（头像 + 昵称 + 身份），与接收者用不同底色区分；
//   · 下面是接收者（头像 + 昵称 + 加入时间 + 移除）；底部按钮「分享设备」。
// 数据：老服务 getShareUserProductList（按后端设备号）；列表里没有所有者时用当前用户资料兜底（仅所有者本人进来时）。
// 分享（简化版，无邀请码）：底部按钮 open-type="share" 发微信卡片，卡片路径带设备号 / 产品 / 所有者 userId，
//   对方在接受页确认后以非所有者身份绑定（见 utils/wifi-share.js）。拿不到自己的 userId 或产品 ID 时不让分享。
// 移除：isCanDel == 1 的成员才有，确认后 delUserProduct 删成员那条记录，再刷新列表。加入时间取接口 joinTime，为空时显示「--」。
// 有效期（2026-11-04）：卡片带服务器时间戳 t（getCurrentTime），接受页拿它调 chkTimeValid 判断是否过期。
//   进页面先取一次（取不到不让分享，点按钮会重取）；真正分享时 onShareAppMessage 的 promise 再取一次最新的，
//   3 秒内没取到或失败，微信按默认参数（进页面时取到的时间戳）发出。
// 卡片封面（2026-11-04）：不用微信默认的页面截图，拿到设备详情后用离屏 Canvas 画一张（utils/share-card.js），
//   分享时还没画好就在 promise 里等它；画不出来用机型设备图。
// 仅开发版：底部多一个「复制测试参数」，复制卡片参数，粘到开发者工具自定义编译的启动参数里，预览二维码即可在开发版打开接受页
//   （开发版发出的卡片别人点开进的是正式版，正式版没有接受页会提示「页面不存在」）。
Page(fold.adapt({
  data: {
    statusBarHeight: 20,
    safeBottom: 0,
    id: '',
    loading: true,
    loadError: false,
    isOwner: false,
    owner: null,
    members: [],
    canShare: false,
    showDevCopy: false
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
    const isOwner = wifiShare.isOwner(device)
    if (isOwner) {
      this.cardPromise = shareCard.render(device).then(file => {
        this.cardImage = file
        return file
      })
    }
    const deviceId = device.rawProductDeviceId || device.productDeviceId || device.deviceNo
    let list
    try {
      list = await api.getShareUsers({ deviceId })
    } catch (error) {
      list = null
    }
    let user = null
    if (isOwner) {
      try {
        user = await api.getUserProfile()
      } catch (error) {
        user = null
      }
      await this.refreshShareTime()
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
    // 进得来这页的所有者可以拿自己兜底所有者栏；接收者不行（那会把自己显示成所有者）
    const split = wifiShare.splitMembers(list, isOwner ? profile : null)
    // 接收者自己那行（成员 userProductId = 本人这条记录）在原「移除」位置标「我」（2026-11-05）
    const selfId = String(device.userProductId != null ? device.userProductId : '')
    const members = split.members.map(item => Object.assign({}, item, { isMe: !isOwner && !!selfId && item.id === selfId }))
    const canShare = isOwner && this.shareReady()
    this.setData({
      loading: false,
      loadError: false,
      isOwner,
      owner: split.owner,
      members,
      canShare,
      showDevCopy: canShare && system.isDevEnv()
    })
  },

  retryLoad() {
    this.setData({ loading: true, loadError: false })
    this.load()
  },

  removeMember(e) {
    const id = String(e.currentTarget.dataset.id || '')
    const member = this.data.members.filter(item => item.id === id)[0]
    if (!member || this._removing || !member.canDel) {
      return
    }
    wx.showModal({
      title: '移除成员',
      content: member.isMe ? '移除后你将不能再使用这台设备，确认移除？' : `移除后「${member.name}」将不能再使用这台设备，确认移除？`,
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
    if (this._removing || !member || !member.canDel) {
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
    if (member.isMe) {
      // 解绑的是自己：设备已不在自己名下，留在这页只会加载失败
      setTimeout(() => wx.reLaunch({ url: '/pages/home/home' }), 800)
      return
    }
    this.load()
  },

  // 取服务器时间戳，成功时记到 this.shareTime；失败返回 false，保留上一次取到的
  async refreshShareTime() {
    try {
      this.shareTime = await api.getServerTime()
      return true
    } catch (error) {
      console.warn('[设备分享] 获取服务器时间戳失败', error && error.message)
      return false
    }
  },

  // 能不能发卡片：自己的 userId、产品 ID、设备号、分享时间戳都要有
  shareReady() {
    const device = this.device || {}
    const user = this.user || {}
    return !!(user.userId && device.productId && device.productDeviceId && this.shareTime)
  },

  // 拿不到自己的 userId / 产品 ID / 时间戳时底部是普通按钮（只有所有者有这个按钮）。只缺时间戳的，点了重取一次，取到就换回分享按钮
  async shareUnavailable() {
    const device = this.device || {}
    const user = this.user || {}
    if (!this.data.isOwner) {
      return
    }
    if (!this._timeRetrying && user.userId && device.productId && device.productDeviceId && !this.shareTime) {
      this._timeRetrying = true
      const ok = await this.refreshShareTime()
      this._timeRetrying = false
      if (ok && !this.unloaded) {
        this.setData({ canShare: true, showDevCopy: system.isDevEnv() })
        toast.show({ title: '已就绪，请再点一次「分享设备」', icon: 'none' })
        return
      }
    }
    toast.show({ title: '暂时无法分享，请稍后重试', icon: 'none' })
  },

  acceptPath() {
    const device = this.device || {}
    const user = this.user || {}
    return wifiShare.buildAcceptPath({
      deviceId: device.productDeviceId,
      productId: device.productId,
      ownerUserId: user.userId,
      deviceName: device.name,
      ownerName: user.nickName || '',
      shareTime: this.shareTime
    })
  },

  // 开发版「复制测试参数」：只复制 ? 后面那段，启动页面固定为 wifiShare.ACCEPT_PAGE；先取一次最新时间戳
  async copyTestQuery() {
    if (!this.data.showDevCopy) {
      return
    }
    await this.refreshShareTime()
    wx.setClipboardData({ data: this.acceptPath().split('?')[1] || '' })
  },

  // 底部「分享设备」（open-type="share"）与右上角菜单都走这里；不能分享（含接收者）时退回小程序首页卡片
  onShareAppMessage() {
    const device = this.device || {}
    const user = this.user || {}
    if (!this.data.canShare) {
      return { title: 'BoltStar 智能相框', path: '/pages/home/home' }
    }
    const title = `${user.nickName || '好友'}邀请你共用电子纸设备「${device.name || '智能相框'}」`
    const imageUrl = this.cardImage || shareCard.cardInfo(device).thumb
    const fallback = { title, path: this.acceptPath(), imageUrl }
    // 分享这一刻再取一次服务器时间戳，顺带等封面画完；失败也 resolve 默认参数，不让分享失败
    const card = this.cardPromise || Promise.resolve(imageUrl)
    const promise = Promise.all([this.refreshShareTime(), card]).then(
      ([, image]) => ({ title, path: this.acceptPath(), imageUrl: image || imageUrl }),
      () => fallback
    )
    return Object.assign({ promise }, fallback)
  }
}))
