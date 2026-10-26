const system = require('../../../utils/system')
const fold = require('../../../utils/fold-adapt')

// WiFi 版设备配网第一步：选择 WiFi（2026-10-26 产品调整流程：先进 WiFi 列表，选中后再进 WiFi 账号密码页）。
// 入口：搜索设备页点了规格已查到的 WiFi 设备（未知设备在那一页就被拦下，进不来）。
//
//   · 列表只列 2.4G：安卓 wx.getWifiList 拿附近列表（需要手机定位开着），按 frequency 落在 2400~2500MHz 筛选，
//     同名取信号强的、信号强的在前；点一下即进入账号密码页并带上名称，无确认按钮；
//   · 列表底部「手动输入WiFi名称」：搜不到 / 隐藏网络 / 列表拿不到时用，进账号密码页自己填；
//   · iOS：微信拿不到附近 WiFi 列表（getWifiList 会跳系统设置，且不带频段），只列当前连接的网络（频段判不了，不标 2.4G），
//     其余手动输入。
// 设备信息（deviceNo / name / spec）原样透传给账号密码页，配网用的 BLE 句柄与产品已由搜索页交给 utils/wifi-provision。

// 2.4G 信道 2412~2484MHz。只认这个区间：5G（5xxx）、6G 都不算；个别机型若按 GHz 给（2.4 / 5），按 GHz 判一次
function is24G(frequency) {
  const value = Number(frequency)
  if (!Number.isFinite(value) || value <= 0) {
    return false
  }
  const mhz = value < 10 ? value * 1000 : value
  return mhz >= 2400 && mhz < 2500
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
    wifiList: [],
    loading: true,
    tip: ''
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
    this.loadWifi()
  },

  onUnload() {
    this.unloaded = true
    if (this.wifiListHandler && wx.offGetWifiList) {
      wx.offGetWifiList(this.wifiListHandler)
    }
  },

  // 重新获取（页面上的刷新入口）
  refresh() {
    if (!this.data.loading) {
      this.loadWifi()
    }
  },

  loadWifi() {
    this.setData({ loading: true, tip: '' })
    if (this.isIOS) {
      this.loadCurrentOnly()
      return
    }
    this.loadNearby()
  },

  async loadCurrentOnly() {
    let current = null
    try {
      await wxp(wx.startWifi, {})
      const res = await wxp(wx.getConnectedWifi, {})
      current = (res && res.wifi) || null
    } catch (error) {
      current = null
    }
    if (this.unloaded) {
      return
    }
    const ssid = String((current && current.SSID) || '').trim()
    // iOS 不回频段：判不了的原样列出；明确是 5G 的不列
    const usable = ssid && (is24G(current.frequency) || !Number(current.frequency))
    this.setData({
      loading: false,
      wifiList: usable ? [{ ssid, band: is24G(current.frequency) ? '2.4G' : '' }] : [],
      tip: 'iOS 无法获取附近WiFi列表，请选择2.4G网络或手动输入WiFi名称'
    })
  },

  async loadNearby() {
    try {
      await wxp(wx.startWifi, {})
      if (!this.wifiListHandler && wx.onGetWifiList) {
        this.wifiListHandler = res => this.applyWifiList((res && res.wifiList) || [])
        wx.onGetWifiList(this.wifiListHandler)
      }
      await wxp(wx.getWifiList, {})
      // 个别机型 getWifiList 成功却迟迟不回调 onGetWifiList：等一会儿还没列表就收起转圈，让用户手动输入
      setTimeout(() => {
        if (!this.unloaded && this.data.loading) {
          this.setData({ loading: false, tip: '没有获取到WiFi列表，请手动输入WiFi名称' })
        }
      }, 8000)
    } catch (error) {
      if (this.unloaded) {
        return
      }
      // 12006：手机定位没开；其余按通用失败提示
      const gpsOff = error && (error.errCode === 12006 || /12006|location/i.test(error.errMsg || ''))
      this.setData({
        loading: false,
        tip: gpsOff ? '请打开手机定位后重试，或手动输入WiFi名称' : '获取WiFi列表失败，请手动输入WiFi名称'
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
      loading: false,
      tip: wifiList.length ? '' : '附近没有搜到2.4G WiFi，可手动输入WiFi名称'
    })
  },

  // 选中即进入账号密码页，名称带过去
  pickWifi(e) {
    this.goConfig(e.currentTarget.dataset.ssid || '')
  },

  manualInput() {
    this.goConfig('')
  },

  goConfig(ssid) {
    const query = [
      `deviceNo=${encodeURIComponent(this.data.deviceNo)}`,
      `name=${encodeURIComponent(this.data.deviceName)}`,
      `spec=${encodeURIComponent(this.data.spec)}`,
      `ssid=${encodeURIComponent(ssid)}`
    ].join('&')
    wx.navigateTo({ url: `/subpackages/device/wifi-config/wifi-config?${query}` })
  }
}))
