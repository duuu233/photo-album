const toast = require('../../../utils/toast')
const system = require('../../../utils/system')
const fold = require('../../../utils/fold-adapt')
const wifiProvision = require('../../../utils/wifi-provision')

// WiFi 版设备配网第二步：WiFi 账号密码（2026-10-26 产品调整流程：先在 WiFi 列表页选网络，再进本页填密码）。
//   · 名称由列表页带过来（选「手动输入」时为空，用户自己填）；名称后的切换图标回到 WiFi 列表重选；
//   · 密码默认明文，右侧小眼睛切换明文 / ****（2026-10-26）；「下一步」把名称 / 密码交给配网流程（内存交接，**密码不进页面路由**），进配网状态页。
const WIFI_LIST_URL = '/subpackages/device/wifi-list/wifi-list'

Page(fold.adapt({
  data: {
    statusBarHeight: 20,
    safeBottom: 0,
    deviceNo: '',
    deviceName: '',
    spec: '',
    ssid: '',
    password: '',
    showPassword: true // true 明文、false 显示 ****；默认明文便于核对
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
      spec: decode(options && options.spec),
      ssid: decode(options && options.ssid)
    })
  },

  onSsidInput(e) {
    this.setData({ ssid: e.detail.value })
  },

  onPasswordInput(e) {
    this.setData({ password: e.detail.value })
  },

  // 小眼睛：切换明文 / ****，只改显示，不动已输入的密码
  togglePassword() {
    this.setData({ showPassword: !this.data.showPassword })
  },

  // 切换图标：回到 WiFi 列表重选（正常从列表页进来，返回上一页即可；页面栈里没有列表页时重新打开）
  openWifiList() {
    const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : []
    const prev = pages.length > 1 ? pages[pages.length - 2] : null
    if (prev && prev.route === WIFI_LIST_URL.slice(1)) {
      wx.navigateBack()
      return
    }
    const query = [
      `deviceNo=${encodeURIComponent(this.data.deviceNo)}`,
      `name=${encodeURIComponent(this.data.deviceName)}`,
      `spec=${encodeURIComponent(this.data.spec)}`
    ].join('&')
    wx.redirectTo({ url: `${WIFI_LIST_URL}?${query}` })
  },

  goNext() {
    const ssid = String(this.data.ssid || '').trim()
    if (!ssid) {
      toast.warn({ title: '请输入或选择WiFi名称', icon: 'none' })
      return
    }
    if (!wifiProvision.getTarget()) {
      toast.warn({ title: '设备信息已失效，请返回重新搜索', icon: 'none' })
      return
    }
    wifiProvision.setCredentials({ ssid, password: this.data.password || '' })
    const query = [
      `deviceNo=${encodeURIComponent(this.data.deviceNo)}`,
      `name=${encodeURIComponent(this.data.deviceName)}`
    ].join('&')
    wx.navigateTo({ url: `/subpackages/device/wifi-provision/wifi-provision?${query}` })
  }
}))
