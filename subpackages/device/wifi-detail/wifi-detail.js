const api = require('../../../utils/api')
const iotApi = require('../../../utils/iot-api')
const iotWs = require('../../../utils/iot-ws')
const toast = require('../../../utils/toast')
const system = require('../../../utils/system')
const fold = require('../../../utils/fold-adapt')
const media = require('../../../utils/media')
const batteryUtil = require('../../../utils/battery')
const signal = require('../../../utils/signal')
const wifiStatus = require('../../../utils/wifi-status')

// WiFi 版设备详情（2026-10-27，对接进度 STEP 4 设备查询 + STEP 3 投屏入口）。
// 蓝牙版详情（detail 页）全是蓝牙能力（连接、读 0x01、轮播、清空、OTA），WiFi 版一个都用不上，单独成页：
//   · 设备记录：老服务 getDeviceDetail（名称、设备 ID、尺寸、设备图）；
//   · 状态：IoT GET /api/device/info（在线、最后上线、固件版本、影子：电量 / WiFi 信号与名称 / TF / 国家码 / 最后心跳）；
//     订阅 WS device.status，上下线时自动重查（只推信号不推详情，文档 1.6）；
//   · 操作：「投屏」（弹拍照 / 相册 → 预览构图 → WiFi 投屏结果页）、「轮播设置」（V1.4 更新说明 1.5，取代原「刷新状态」，
//     进 wifi-slideshow 页；状态随进页与 WS device.status 自动重查）。
//   · 入口（V1.4 实现报告反馈二 / 三）：「休眠设置」进 wifi-sleep；「消息中心」进 wifi-messages，带未读角标
//    （IoT GET /api/notification/unread-count，进页时查，收到本设备 WS notification.new 再查）。
// 刷新屏幕、TF、休眠、OTA 等设备控制属于 STEP 5/6，未接；App 也没有删除 / 重新配网操作（设备入网流程 2.2）。
function plainDeviceNo(value) {
  return String(value || '').replace(/[:\-\s]/g, '').toUpperCase()
}

function countryText(code) {
  const value = String(code == null ? '' : code).trim()
  if (!value) {
    return ''
  }
  return value === '1' || value === '01' ? '世界通用模式' : value
}

function tfText(shadow) {
  if (shadow.tfStatus === 'absent') {
    return '未插卡'
  }
  if (shadow.tfStatus !== 'present') {
    return ''
  }
  const total = Number(shadow.tfTotal)
  const used = Number(shadow.tfUsed)
  return total > 0 ? `已用 ${Number.isFinite(used) ? used : 0}MB / 共 ${total}MB` : '已插卡'
}

// 设备信息 → 页面字段。info 为 null 表示查不到（403 / 503 / 网络）
function statusFields(info) {
  if (!info) {
    return { status: 'unknown', statusText: '状态未知', rows: [] }
  }
  const shadow = info.shadow || {}
  const status = wifiStatus.deviceState(info) // online / sleeping / shutdown / offline（非在线时电量 / 信号不显示）
  const online = status === 'online'
  const battery = batteryUtil.normalizeBattery(shadow.battery)
  const rssi = Number(shadow.wifiRssi)
  const rows = [
    { key: 'battery', label: '电量', value: online && battery !== null ? `${battery}%` : '', icon: online && battery !== null ? batteryUtil.getBatteryIcon(battery) : '' },
    { key: 'signal', label: 'WiFi信号', value: online && rssi < 0 ? `${rssi}dBm` : '', level: online ? signal.rssiToLevel(rssi) : 0 },
    { key: 'wifiName', label: 'WiFi名称', value: shadow.wifiName || '' },
    { key: 'version', label: '固件版本', value: info.firmwareVersion || shadow.espVersion || shadow.version || '' },
    { key: 'tf', label: 'TF卡', value: tfText(shadow) },
    { key: 'country', label: '国家码', value: countryText(shadow.countryCode) },
    { key: 'lastOnline', label: '最后上线', value: info.lastOnlineAt || '' },
    { key: 'lastHeart', label: '最后心跳', value: shadow.lastHeartAt || '' }
  ].map(row => Object.assign(row, { value: row.value || '--' }))
  return { status, statusText: wifiStatus.STATUS_TEXT[status], rows }
}

Page(fold.adapt({
  data: {
    statusBarHeight: 20,
    safeBottom: 0,
    id: '',
    loading: true,
    loadError: false,
    device: null,
    status: 'loading', // loading / online / sleeping / shutdown / offline / unknown
    statusText: '查询中',
    rows: [],
    unreadCount: 0,
    unreadText: '',
    showMediaSheet: false,
    mediaSheetClosing: false
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
    this.load()
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
    this.setData({ device, loading: false, loadError: false })
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

  // 「轮播设置」：查询离线也能看，不拦状态；保存时由接口裁决
  openSlideshow() {
    if (!this.data.device) {
      return
    }
    wx.navigateTo({ url: `/subpackages/device/wifi-slideshow/wifi-slideshow?id=${this.data.id}` })
  },

  // 「投屏」：离线 / 休眠先拦；在线 / 状态未知照常弹拍照 / 相册（未知时让接口裁决，离线会返回 4041）
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
  }
}))
