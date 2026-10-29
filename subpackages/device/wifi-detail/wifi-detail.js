const api = require('../../../utils/api')
const iotApi = require('../../../utils/iot-api')
const iotWs = require('../../../utils/iot-ws')
const toast = require('../../../utils/toast')
const system = require('../../../utils/system')
const fold = require('../../../utils/fold-adapt')
const media = require('../../../utils/media')
const batteryUtil = require('../../../utils/battery')
const deviceIdentity = require('../../../utils/device-identity')
const wifiStatus = require('../../../utils/wifi-status')
const wifiTf = require('../../../utils/wifi-tf')
const wifiShare = require('../../../utils/wifi-share')

const app = getApp()

// WiFi 版设备详情（2026-10-27 建页；2026-10-29 按产品要求改版，布局与蓝牙版详情对齐）。
// 蓝牙版详情（detail 页）全是蓝牙能力，WiFi 版单独成页：
//   · 设备记录：老服务 getDeviceDetail（名称、设备 ID、尺寸、设备图、isToHave / shareUserId）；
//   · 状态：IoT GET /api/device/info，订阅 WS device.status，上下线时自动重查（只推信号不推详情）；
//     电量放在在线状态那一栏（与蓝牙版一致，仅在线时显示）。
//   · 顶部卡片下方：「投屏」「轮播设置」（与蓝牙版位置一致）；
//   · 功能栏依次：设备信息（二级页 wifi-info：WiFi信号 / WiFi名称 / 最后上线 / 最后心跳 / 固件版本）、休眠设置、
//     消息中心（未读角标）、TF卡（未插卡不可点；有卡显示已用 / 总量，进 wifi-tf）、分享设备（仅所有者，进 wifi-share）、
//     解除绑定（只删设备）；页底「删除设备」（仅所有者，样式同蓝牙版：先删云端图片再删设备）。
//   · 本地模式（status=LOCAL_TF，2026-10-29）：投屏 / 轮播设置 / TF卡 可以点，但只提示「当前设备状态：本地模式，
//     请恢复设备网络再试」；设备信息、休眠设置、消息中心、分享、解绑、删除照常。WiFi 版暂无 OTA 入口。
function plainDeviceNo(value) {
  return String(value || '').replace(/[:\-\s]/g, '').toUpperCase()
}

// 设备信息 → 页面字段。info 为 null 表示查不到（403 / 503 / 网络）
function statusFields(info) {
  if (!info) {
    return { status: 'unknown', statusText: '状态未知', batteryText: '', batteryIcon: '', tfState: 'unknown', tfText: '--' }
  }
  const status = wifiStatus.deviceState(info) // 非在线时电量不显示（本地模式影子冻结）
  const battery = status === 'online' ? batteryUtil.normalizeBattery((info.shadow || {}).battery) : null
  const tf = wifiTf.tfState(info.shadow)
  return {
    status,
    statusText: wifiStatus.STATUS_TEXT[status] || wifiStatus.STATUS_TEXT.unknown,
    batteryText: battery === null ? '' : `${battery}%`,
    batteryIcon: battery === null ? '' : batteryUtil.getBatteryIcon(battery),
    tfState: tf.state,
    tfText: tf.text
  }
}

Page(fold.adapt({
  data: {
    statusBarHeight: 20,
    safeBottom: 0,
    id: '',
    loading: true,
    loadError: false,
    device: null,
    isOwner: false,
    status: 'loading', // loading / online / sleeping / shutdown / local / offline / unknown
    statusText: '查询中',
    batteryText: '',
    batteryIcon: '',
    tfState: 'unknown', // absent / present / unknown
    tfText: '--',
    unreadCount: 0,
    unreadText: '',
    showMediaSheet: false,
    mediaSheetClosing: false,
    showUnbindConfirm: false,
    unbindClosing: false,
    showDeleteConfirm: false,
    deleteClosing: false,
    showDeleteConfirm2: false,
    deleteClosing2: false
  },

  noop() {},

  onLoad(options) {
    this.setData(Object.assign(system.getLayoutMetrics(), { id: (options && options.id) || '' }))
    // 上下线推送：只推信号，收到就重查一次（需先订阅，订阅在拿到设备号后发）
    this._offStatus = iotWs.on('device.status', event => {
      if (this.data.device && event && plainDeviceNo(event.deviceNo) === this.deviceNo()) {
        this.refreshStatus()
      }
    })
    // 新消息只推信号：收到就重查未读数
    this._offNotice = iotWs.on('notification.new', event => {
      if (this.data.device && event && plainDeviceNo(event.deviceNo) === this.deviceNo()) {
        this.refreshUnread()
      }
    })
  },

  onShow() {
    if (!this._removed) {
      this.load()
    }
  },

  onUnload() {
    this.unloaded = true
    if (this._offStatus) {
      this._offStatus()
    }
    if (this._offNotice) {
      this._offNotice()
    }
    if (this._subscribed) {
      iotWs.unsubscribe(this._subscribed)
    }
  },

  deviceNo() {
    const device = this.data.device || {}
    return plainDeviceNo(device.productDeviceId || device.deviceNo)
  },

  async load() {
    if (!this.data.device) {
      this.setData({ loading: true, loadError: false })
    }
    let device
    try {
      device = await api.getDeviceDetail(this.data.id)
    } catch (error) {
      if (!this.data.device) {
        this.setData({ loading: false, loadError: true })
      }
      return
    }
    if (this.unloaded) {
      return
    }
    this.setData({ device, isOwner: wifiShare.isOwner(device), loading: false, loadError: false })
    const deviceNo = this.deviceNo()
    if (deviceNo && this._subscribed !== deviceNo && iotWs.getSubscriptions().indexOf(deviceNo) === -1) {
      iotWs.subscribe(deviceNo)
      this._subscribed = deviceNo
    }
    this.refreshStatus()
    this.refreshUnread()
  },

  // 消息中心未读角标；查不到不显示，不弹错
  async refreshUnread() {
    const deviceNo = this.deviceNo()
    if (!deviceNo) {
      return
    }
    let count = 0
    try {
      const res = await iotApi.getUnreadCount(deviceNo, { showError: false })
      count = Number(res && res.unreadCount) || 0
    } catch (error) {
      console.warn('[WiFi消息] 未读数查询失败', error && error.code, error && error.message)
      return
    }
    if (!this.unloaded) {
      this.setData({ unreadCount: count, unreadText: count > 99 ? '99+' : String(count) })
    }
  },

  retryLoad() {
    this.setData({ loading: true, loadError: false })
    this.load()
  },

  // 查在线 / 影子；各次带序号，旧请求晚到不覆盖
  async refreshStatus() {
    const deviceNo = this.deviceNo()
    if (!deviceNo) {
      this.setData(statusFields(null))
      return
    }
    const seq = (this._statusSeq || 0) + 1
    this._statusSeq = seq
    let info = null
    try {
      info = await iotApi.getDeviceInfo(deviceNo, { showError: false })
    } catch (error) {
      info = null
    }
    if (this.unloaded || this._statusSeq !== seq) {
      return
    }
    this.setData(statusFields(info))
  },

  // 本地模式下的远程操作（投屏、轮播设置、TF卡）：按钮可点，只提示；拦下返回 true
  blockedByLocal() {
    if (this.data.status !== 'local') {
      return false
    }
    toast.show({ title: wifiStatus.LOCAL_TIP, icon: 'none' })
    return true
  },

  openInfo() {
    if (this.data.device) {
      wx.navigateTo({ url: `/subpackages/device/wifi-info/wifi-info?id=${this.data.id}` })
    }
  },

  openSleep() {
    if (this.data.device) {
      wx.navigateTo({ url: `/subpackages/device/wifi-sleep/wifi-sleep?id=${this.data.id}` })
    }
  },

  openMessages() {
    if (this.data.device) {
      wx.navigateTo({ url: `/subpackages/device/wifi-messages/wifi-messages?deviceNo=${this.deviceNo()}` })
    }
  },

  // 「TF卡」：未插卡 / 没上报过不可点；有卡进 TF 卡设置
  openTf() {
    if (!this.data.device || this.data.tfState !== 'present' || this.blockedByLocal()) {
      return
    }
    wx.navigateTo({ url: `/subpackages/device/wifi-tf/wifi-tf?id=${this.data.id}` })
  },

  openShare() {
    if (this.data.device && this.data.isOwner) {
      wx.navigateTo({ url: `/subpackages/device/wifi-share/wifi-share?id=${this.data.id}` })
    }
  },

  // 「轮播设置」：离线也能查看，不拦；本地模式只提示。保存时轮播页会再判断设备状态
  openSlideshow() {
    if (!this.data.device || this.blockedByLocal()) {
      return
    }
    wx.navigateTo({ url: `/subpackages/device/wifi-slideshow/wifi-slideshow?id=${this.data.id}` })
  },

  // 「投屏」：本地模式 / 离线 / 休眠 / 关机先拦；在线 / 状态未知照常弹拍照 / 相册（预览页「开始投屏」再严格判断）
  startProjection() {
    if (!this.data.device) {
      return
    }
    const tip = wifiStatus.blockedTip(this.data.status)
    if (tip) {
      toast.show({ title: tip, icon: 'none' })
      return
    }
    this.setData({ showMediaSheet: true, mediaSheetClosing: false })
  },

  hideMediaSheet() {
    if (this.data.mediaSheetClosing) {
      return
    }
    this.setData({ mediaSheetClosing: true })
    setTimeout(() => {
      this.setData({ showMediaSheet: false, mediaSheetClosing: false })
    }, 220)
  },

  chooseCamera() {
    this.pickAndProject(() => media.chooseFromCamera())
  },

  chooseAlbum() {
    this.pickAndProject(() => media.chooseFromAlbum())
  },

  // 选图后进预览页构图；预览页认出 WiFi 版，导出后去 WiFi 投屏结果页
  async pickAndProject(pickImages) {
    let images
    try {
      images = await pickImages()
    } catch (error) {
      if (error && error.errMsg && error.errMsg.indexOf('cancel') > -1) {
        return
      }
      toast.warn({ title: '选择照片失败', icon: 'none' })
      return
    }
    if (!images || !images.length) {
      return
    }
    this.setData({ showMediaSheet: false, mediaSheetClosing: false })
    wx.setStorageSync('pendingProjection', { device: Object.assign({}, this.data.device, { isWifi: true }), images })
    wx.navigateTo({ url: '/subpackages/projection/preview/preview' })
  },

  // ── 解除绑定 / 删除设备（与蓝牙版同一做法；WiFi 版设备端不存图，图片只处理云端）──────────

  // 设备记录删掉之后的收尾：清身份登记与当前选中、退订，返回上一页
  afterRemoved() {
    this._removed = true
    deviceIdentity.forget(this.data.id)
    if (app.globalData.selectedDevice && String(app.globalData.selectedDevice.id) === String(this.data.id)) {
      app.setSelectedDevice(null)
    }
    if (this._subscribed) {
      iotWs.unsubscribe(this._subscribed)
      this._subscribed = ''
    }
    setTimeout(() => wx.navigateBack(), 500)
  },

  showUnbindConfirm() {
    this.setData({ showUnbindConfirm: true, unbindClosing: false })
  },

  hideUnbindConfirm() {
    if (this.data.unbindClosing) {
      return
    }
    this.setData({ unbindClosing: true })
    setTimeout(() => {
      this.setData({ showUnbindConfirm: false, unbindClosing: false })
    }, 220)
  },

  // 解除绑定：只删设备记录，不动照片
  async confirmUnbind() {
    if (!this.data.device || this._unbinding) {
      return
    }
    this._unbinding = true
    try {
      await api.deleteDevice(this.data.id)
    } catch (error) {
      this._unbinding = false
      return // 失败已由接口层统一提示，确认弹窗保留供重试
    }
    this.hideUnbindConfirm()
    this.afterRemoved()
  },

  // 删除设备（仅所有者）：两级确认 → 清「我的上传」记录 → 删该设备全部云端图片 → 删设备记录
  showDeleteConfirm() {
    if (this.data.isOwner) {
      this.setData({ showDeleteConfirm: true, deleteClosing: false })
    }
  },

  hideDeleteConfirm() {
    if (this.data.deleteClosing) {
      return
    }
    this.setData({ deleteClosing: true })
    setTimeout(() => {
      this.setData({ showDeleteConfirm: false, deleteClosing: false })
    }, 220)
  },

  openDeleteStep2() {
    this.setData({ showDeleteConfirm: false, deleteClosing: false, showDeleteConfirm2: true, deleteClosing2: false })
  },

  hideDeleteConfirm2() {
    if (this.data.deleteClosing2) {
      return
    }
    this.setData({ deleteClosing2: true })
    setTimeout(() => {
      this.setData({ showDeleteConfirm2: false, deleteClosing2: false })
    }, 220)
  },

  async confirmDeleteDevice() {
    if (!this.data.device || this._deleting) {
      return
    }
    this._deleting = true
    const deviceNo = this.deviceNo()
    // ① 老服务清这台设备的相册记录（含级联删投屏记录，同蓝牙版一键清空的后端那一步）；失败已由接口层提示
    try {
      await api.clearUserProductImg(this.data.id)
    } catch (error) {
      this._deleting = false
      return
    }
    // ② IoT 删该设备全部云端 bin（V1.4 更新说明九 all=true；设备离线照删，有 TF 卡时服务端顺带清 TF 里的云端图）
    wx.showLoading({ title: '删除中', mask: true })
    try {
      const res = await iotApi.deletePhotos({ deviceNo, all: true }, { showError: false })
      console.log('[WiFi删除设备] 云端图片删除返回', JSON.stringify(res))
    } catch (error) {
      wx.hideLoading()
      this._deleting = false
      console.warn('[WiFi删除设备] 云端图片删除失败', error && error.code, error && error.message)
      toast.warn({ title: `云端照片删除失败：${String((error && error.message) || '请稍后重试').replace(/^接口\(IoT\)-/, '')}`, icon: 'none' })
      return
    }
    // ③ 删设备记录
    try {
      await api.deleteDevice(this.data.id)
    } catch (error) {
      this._deleting = false
      return
    } finally {
      wx.hideLoading()
    }
    this.setData({ showDeleteConfirm2: false })
    toast.show({ title: '电子纸设备已删除', icon: 'none' })
    this.afterRemoved()
  }
}))
