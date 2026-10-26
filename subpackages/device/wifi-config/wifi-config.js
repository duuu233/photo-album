const toast = require('../../../utils/toast')
const system = require('../../../utils/system')
const fold = require('../../../utils/fold-adapt')

// WiFi 版设备配网第一步：填写 WiFi（2026-10-26，STEP 1 静态页）。
// 入口：搜索设备页选中规格已查到的 WiFi 设备 → 「立即配网」（未知设备在那一页就被拦下，进不来）。
//
// 本阶段只做版式与交互骨架，不调用任何微信 WiFi 能力，也不给设备下发配置：
//   · 切换图标弹出的 WiFi 列表是示例数据（DEMO_WIFI_LIST），选中即回填名称、无需确认按钮；
//   · 下一步（STEP 2）改为 wx.startWifi + wx.getConnectedWifi：当前连的是 2.4G 就直接回填名称，
//     没连 WiFi 或连的是 5G 就直接弹出列表；列表取 wx.getWifiList，只保留 2.4G。
//   · 「下一步」只带 deviceNo / 名称进入配网状态页，**密码不进页面路由**（STEP 2 由 BLE 直接下发给设备）。
const DEMO_WIFI_LIST = [
  { ssid: 'BoltStar-2.4G', level: 3 },
  { ssid: 'Home_WiFi', level: 2 },
  { ssid: 'Office-Guest', level: 1 }
]

Page(fold.adapt({
  data: {
    statusBarHeight: 20,
    safeBottom: 0,
    deviceNo: '',
    deviceName: '',
    spec: '',
    ssid: '',
    password: '',
    showWifiList: false,
    wifiList: [],
    wifiListIsDemo: true
  },

  onLoad(options) {
    this.setData(system.getLayoutMetrics())
    const decode = value => {
      try {
        return decodeURIComponent(value || '')
      } catch (error) {
        return value || ''
      }
    }
    this.setData({
      deviceNo: decode(options && options.deviceNo),
      deviceName: decode(options && options.name),
      spec: decode(options && options.spec)
    })
  },

  noop() {},

  onSsidInput(e) {
    this.setData({ ssid: e.detail.value })
  },

  onPasswordInput(e) {
    this.setData({ password: e.detail.value })
  },

  openWifiList() {
    this.setData({ showWifiList: true, wifiList: DEMO_WIFI_LIST, wifiListIsDemo: true })
  },

  closeWifiList() {
    this.setData({ showWifiList: false })
  },

  // 点一下即选中并回填，不需要额外的确认按钮
  pickWifi(e) {
    this.setData({ ssid: e.currentTarget.dataset.ssid || '', showWifiList: false })
  },

  goNext() {
    const ssid = String(this.data.ssid || '').trim()
    if (!ssid) {
      toast.warn({ title: '请输入或选择WiFi名称', icon: 'none' })
      return
    }
    const query = [
      `deviceNo=${encodeURIComponent(this.data.deviceNo)}`,
      `name=${encodeURIComponent(this.data.deviceName)}`,
      `ssid=${encodeURIComponent(ssid)}`
    ].join('&')
    wx.navigateTo({ url: `/subpackages/device/wifi-provision/wifi-provision?${query}` })
  }
}))
