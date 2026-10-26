const toast = require('../../../utils/toast')
const system = require('../../../utils/system')
const fold = require('../../../utils/fold-adapt')
const wifiProvision = require('../../../utils/wifi-provision')

// WiFi 版设备配网第一步：填写 WiFi（2026-10-26，STEP 2 接入真实能力）。
// 入口：搜索设备页点了规格已查到的 WiFi 设备（未知设备在那一页就被拦下，进不来）。
//
// 交互（对接进度 STEP 2）：
//   · 进页面先看手机当前连的 WiFi：是 2.4G 就直接回填名称；没连 WiFi 或连的是 5G 就直接弹出 WiFi 列表；
//   · 名称后的切换图标随时弹列表；列表只列 2.4G，点一下即回填，无确认按钮；
//   · 密码明文输入；「下一步」把名称 / 密码交给配网流程（内存交接，**密码不进页面路由**）。
// 平台差异：
//   · 安卓：wx.getWifiList 拿附近列表（需要手机定位开着），按 frequency < 3000MHz 筛 2.4G；
//   · iOS：微信拿不到附近 WiFi 列表，也常拿不到频段——列表里只放当前连接的那个（频段未知时照样给），并提示可手动输入。
const BAND_24G_MAX_MHZ = 3000

function is24G(frequency) {
  const value = Number(frequency)
  return Number.isFinite(value) && value > 0 && value < BAND_24G_MAX_MHZ
}

function isIOS() {
  try {
    const info = (wx.getDeviceInfo ? wx.getDeviceInfo() : wx.getSystemInfoSync()) || {}
    return String(info.platform || info.system || '').toLowerCase().indexOf('ios') > -1
  } catch (error) {
    return false
  }
}

function wxp(fn, options) {
  return new Promise((resolve, reject) => {
    if (typeof fn !== 'function') {
      reject(new Error('当前微信版本不支持 WiFi 能力'))
      return
    }
    fn(Object.assign({}, options, { success: resolve, fail: reject }))
  })
}

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
    wifiListLoading: false,
    wifiListTip: ''
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
    this.isIOS = isIOS()
    this.prefillCurrentWifi()
  },

  onUnload() {
    this.unloaded = true
    if (this.wifiListHandler && wx.offGetWifiList) {
      wx.offGetWifiList(this.wifiListHandler)
    }
  },

  noop() {},

  // 读手机当前连接的 WiFi：2.4G 直接回填；没连 / 5G 直接弹列表。iOS 拿不到频段时按「可能是 2.4G」回填，由用户确认。
  async prefillCurrentWifi() {
    let current = null
    try {
      await wxp(wx.startWifi, {})
      const res = await wxp(wx.getConnectedWifi, { partialInfo: true })
      current = (res && res.wifi) || null
    } catch (error) {
      current = null // 没连 WiFi / 没开定位 / 不支持：都按「没连」处理
    }
    if (this.unloaded) {
      return
    }
    this.currentWifi = current
    const ssid = String((current && current.SSID) || '').trim()
    const bandUnknown = current && !Number(current.frequency)
    if (ssid && (is24G(current.frequency) || (this.isIOS && bandUnknown))) {
      if (!this.data.ssid) {
        this.setData({ ssid })
      }
      return
    }
    this.openWifiList()
  },

  onSsidInput(e) {
    this.setData({ ssid: e.detail.value })
  },

  onPasswordInput(e) {
    this.setData({ password: e.detail.value })
  },

  openWifiList() {
    this.setData({ showWifiList: true, wifiList: [], wifiListLoading: true, wifiListTip: '' })
    if (this.isIOS) {
      this.showCurrentOnly()
      return
    }
    this.loadNearbyWifi()
  },

  showCurrentOnly() {
    const current = this.currentWifi
    const list =
      current && current.SSID && (is24G(current.frequency) || !Number(current.frequency))
        ? [{ ssid: current.SSID, band: is24G(current.frequency) ? '2.4G' : '' }]
        : []
    this.setData({
      wifiList: list,
      wifiListLoading: false,
      wifiListTip: 'iOS 无法获取附近WiFi列表，请直接输入WiFi名称'
    })
  },

  async loadNearbyWifi() {
    try {
      await wxp(wx.startWifi, {})
      if (!this.wifiListHandler && wx.onGetWifiList) {
        this.wifiListHandler = res => this.applyWifiList((res && res.wifiList) || [])
        wx.onGetWifiList(this.wifiListHandler)
      }
      await wxp(wx.getWifiList, {})
      // 个别机型 getWifiList 成功却迟迟不回调 onGetWifiList：等一会儿还没列表就收起转圈，让用户手动输入
      setTimeout(() => {
        if (!this.unloaded && this.data.wifiListLoading) {
          this.setData({ wifiListLoading: false, wifiListTip: '没有获取到WiFi列表，请直接输入WiFi名称' })
        }
      }, 8000)
    } catch (error) {
      if (this.unloaded) {
        return
      }
      // 12006：手机定位没开；其余按通用失败提示
      const gpsOff = error && (error.errCode === 12006 || /12006|location/i.test(error.errMsg || ''))
      this.setData({
        wifiListLoading: false,
        wifiListTip: gpsOff
          ? '请打开手机定位后重试，或直接输入WiFi名称'
          : '获取WiFi列表失败，请直接输入WiFi名称'
      })
    }
  },

  // 只留 2.4G、按 SSID 去重（同名取信号强的）、信号强的在前；没有频段信息的不列（判断不了是不是 2.4G）
  applyWifiList(list) {
    if (this.unloaded) {
      return
    }
    const best = {}
    list.forEach(item => {
      const ssid = String((item && item.SSID) || '').trim()
      if (!ssid || !is24G(item.frequency)) {
        return
      }
      if (!best[ssid] || Number(item.signalStrength) > Number(best[ssid].signalStrength)) {
        best[ssid] = item
      }
    })
    const wifiList = Object.keys(best)
      .map(ssid => ({ ssid, band: '2.4G', signal: Number(best[ssid].signalStrength) || 0 }))
      .sort((a, b) => b.signal - a.signal)
    this.setData({
      wifiList,
      wifiListLoading: false,
      wifiListTip: wifiList.length ? '' : '附近没有搜到2.4G WiFi，可直接输入WiFi名称'
    })
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
