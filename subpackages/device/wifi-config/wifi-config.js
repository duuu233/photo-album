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
// 平台差异（微信能力限制，做不到的部分页面上给提示、可直接手动输入）：
//   · 安卓：getConnectedWifi 带频段，2.4G / 5G 判得准；wx.getWifiList 拿附近列表（需要手机定位开着），
//     按 frequency 落在 2400~2500MHz 筛 2.4G。不传 partialInfo：传 true 时只回 SSID / BSSID，没有频段就判不了 2.4G。
//   · iOS：getConnectedWifi 不回频段，判不了当前是 2.4G 还是 5G。只有**确认是 2.4G 才回填**（2026-10-26 真机反馈：
//     连着 5G 被回填了），判不了一律按「不是 2.4G」直接弹列表；弹层里先放当前连接的网络（标「当前连接」，点一下即回填），
//     wx.getWifiList 在 iOS 上会跳到系统设置、要用户手动进「无线局域网」页才回调，也不带频段，所以另给
//     「获取附近WiFi」按钮由用户自己点，拿到的列表无法按频段筛选，原样列出。
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
    ssid: '',
    password: '',
    showWifiList: false,
    wifiList: [],
    wifiListLoading: false,
    wifiListTip: '',
    // iOS：获取附近 WiFi 要跳系统设置，放一个按钮让用户自己决定
    iosNearbyEntry: false,
    // iOS 回填的名称判不了频段：输入框下提示用户确认是 2.4G
    bandHint: ''
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
      const res = await wxp(wx.getConnectedWifi, {})
      current = (res && res.wifi) || null
    } catch (error) {
      current = null // 没连 WiFi / 没开定位 / 不支持：都按「没连」处理
    }
    if (this.unloaded) {
      return
    }
    this.currentWifi = current
    const ssid = String((current && current.SSID) || '').trim()
    // 只有确认是 2.4G 才直接回填；没连、5G、频段判不了（iOS）都直接弹列表
    if (ssid && is24G(current.frequency)) {
      if (!this.data.ssid) {
        this.setData({ ssid, bandHint: '' })
      }
      return
    }
    this.openWifiList()
  },

  onSsidInput(e) {
    this.setData({ ssid: e.detail.value, bandHint: '' })
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

  // iOS：先列当前连接的网络（频段判不了，原样给），附近列表要用户点按钮、跳系统设置去取
  showCurrentOnly() {
    const current = this.currentWifi
    const list =
      current && current.SSID && (is24G(current.frequency) || !Number(current.frequency))
        ? [{ ssid: current.SSID, band: is24G(current.frequency) ? '2.4G' : '', current: true }]
        : []
    this.setData({
      wifiList: list,
      wifiListLoading: false,
      iosNearbyEntry: true,
      wifiListTip: 'iOS 无法区分2.4G/5G，请选择2.4G网络，或直接输入WiFi名称'
    })
  },

  // iOS「获取附近WiFi」：微信会跳到系统设置，用户进「无线局域网」页后列表才回来
  async loadNearbyWifiIOS() {
    this.setData({ wifiListLoading: true, wifiListTip: '' })
    this.loadNearbyWifi()
  },

  async loadNearbyWifi() {
    try {
      await wxp(wx.startWifi, {})
      if (!this.wifiListHandler && wx.onGetWifiList) {
        this.wifiListHandler = res => this.applyWifiList((res && res.wifiList) || [])
        wx.onGetWifiList(this.wifiListHandler)
      }
      if (this.isIOS) {
        toast.show({ title: '请在系统设置中进入「无线局域网」，再返回小程序', icon: 'none', duration: 3000 })
      }
      await wxp(wx.getWifiList, {})
      // 个别机型 getWifiList 成功却迟迟不回调 onGetWifiList：等一会儿还没列表就收起转圈，让用户手动输入。
      // iOS 要等用户从系统设置回来，不设这个超时（回调随时到都会刷新列表）
      if (!this.isIOS) {
        setTimeout(() => {
          if (!this.unloaded && this.data.wifiListLoading) {
            this.setData({ wifiListLoading: false, wifiListTip: '没有获取到WiFi列表，请直接输入WiFi名称' })
          }
        }, 8000)
      }
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

  // 只留 2.4G、按 SSID 去重（同名取信号强的）、信号强的在前。
  // 没有频段信息时：安卓不列（判断不了是不是 2.4G）；iOS 本来就不给频段，只能原样列出、不标 2.4G
  applyWifiList(list) {
    if (this.unloaded) {
      return
    }
    const best = {}
    list.forEach(item => {
      const ssid = String((item && item.SSID) || '').trim()
      const bandUnknown = !Number(item && item.frequency)
      if (!ssid || !(is24G(item.frequency) || (this.isIOS && bandUnknown))) {
        return
      }
      if (!best[ssid] || Number(item.signalStrength) > Number(best[ssid].signalStrength)) {
        best[ssid] = item
      }
    })
    const wifiList = Object.keys(best)
      .map(ssid => ({
        ssid,
        band: is24G(best[ssid].frequency) ? '2.4G' : '',
        signal: Number(best[ssid].signalStrength) || 0
      }))
      .sort((a, b) => b.signal - a.signal)
    this.setData({
      wifiList,
      wifiListLoading: false,
      iosNearbyEntry: false,
      wifiListTip: wifiList.length
        ? this.isIOS
          ? 'iOS 无法区分2.4G/5G，请选择2.4G网络'
          : ''
        : '附近没有搜到2.4G WiFi，可直接输入WiFi名称'
    })
  },

  closeWifiList() {
    this.setData({ showWifiList: false })
  },

  // 点一下即选中并回填，不需要额外的确认按钮
  pickWifi(e) {
    const band = e.currentTarget.dataset.band || ''
    this.setData({
      ssid: e.currentTarget.dataset.ssid || '',
      showWifiList: false,
      bandHint: band ? '' : '无法识别该WiFi频段，请确认是2.4G网络'
    })
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
