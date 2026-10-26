const system = require('../../../utils/system')
const fold = require('../../../utils/fold-adapt')
const bluetooth = require('../../../utils/bluetooth')
const blufi = require('../../../utils/blufi')
const wifiProvision = require('../../../utils/wifi-provision')
const signal = require('../../../utils/signal')

// WiFi 版设备配网第一步：选择 WiFi（2026-10-26 产品定的流程）：
//   App 蓝牙连接设备 → 设备扫描附近 WiFi（3~5 秒，页面显示「正在搜索网络...」）→ 显示列表（名称 + 信号格）
//   → 用户选中进 WiFi 账号密码页 → 配网状态页下发 WiFi 参数（+ MQTT 参数，来源未定前不发）。
//
//   · 列表来自**设备扫描**（BluFi 0x09，设备回 0x11 或自定义文本，见 utils/blufi.js），不用手机扫：iOS 微信拿不到
//     附近列表、手机扫到的也不一定是设备那边收得到的；本设备是双频芯片，按回包里的信道只留 2.4G（ch 1~14，国内外通用）；
//   · 设备分批回就边收边显示，最后一批后再等 5 秒才结束转圈；
//   · 同名去重取信号强的，信号强的在前；隐藏网络（名称为空）不列；
//   · 这条蓝牙连接一直留着给配网状态页复用（同一会话、序号连续），离开本页（返回搜索页）才断开；
//   · 连不上设备 / 设备没回列表 / 设备报扫描失败：提示原因，给「重新搜索」；搜不到时可手动输入
//     （提示语下的灰字「若列表搜索不到您的wifi，请手动输入」与列表底部「手动输入WiFi名称」都进账号密码页）；
//   · 页面依次显示「正在连接设备...」「正在搜索网络...」。各环境同一套界面，联调信息只打控制台（2026-10-26 去掉页面调试内容）。
// BLE 句柄从搜索页经 utils/wifi-provision 内存交接（getTarget），url 只带展示用的设备信息。

// 等设备回 WiFi 列表的上限 60 秒（2026-10-26，原 12 秒嫌短）；设备报错会立即结束，不必等满
const SCAN_TIMEOUT_MS = 60000

// 设备回的列表整理成页面数据：只留 2.4G、去掉名称为空的隐藏网络、同名取信号强的、按信号排序。
// 只留 2.4G：信道 1~14 为 2.4G（国内外通用），其余（36 起的 5G）去掉；设备没回信道（乐鑫标准格式）时
// 无从判断，照常列出（这类设备多为单 2.4G 芯片）。
function toWifiList(list) {
  const best = {}
  ;(list || []).forEach(item => {
    const ssid = String((item && item.ssid) || '').trim()
    if (!ssid || blufi.is24GChannel(item.channel) === false) {
      return
    }
    if (!best[ssid] || Number(item.rssi) > Number(best[ssid].rssi)) {
      best[ssid] = item
    }
  })
  return Object.keys(best)
    .map(ssid => ({
      ssid,
      rssi: Number(best[ssid].rssi) || 0,
      level: signal.rssiToLevel(best[ssid].rssi)
    }))
    .sort((a, b) => b.rssi - a.rssi)
}

Page(fold.adapt({
  data: {
    statusBarHeight: 20,
    safeBottom: 0,
    deviceNo: '',
    deviceName: '',
    spec: '',
    wifiList: [],
    scanning: true,
    phase: 'connecting', // connecting 连接设备中 / scanning 设备扫描中
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
    this.scan()
  },

  // 返回搜索页（或整个配网流程结束）时断开蓝牙；往后跳到账号密码页时本页不卸载，连接保留给配网复用
  onUnload() {
    this.unloaded = true
    if (this.session) {
      this.session.close()
      this.session = null
    }
  },

  async scan() {
    const target = wifiProvision.getTarget()
    if (!target || !target.bleDeviceId) {
      this.setData({ scanning: false, wifiList: [], tip: '设备信息已失效，请返回重新搜索设备' })
      return
    }
    // ① 蓝牙连接设备（从搜索页进来时已连上，这里直接复用；断了就重连）
    this.setData({ scanning: true, phase: 'connecting', tip: '' })
    try {
      await bluetooth.openAdapter()
      await bluetooth.whenScanStopped()
      this.session = await blufi.connect(target.bleDeviceId)
    } catch (error) {
      console.warn('[WiFi列表] 蓝牙连接设备失败', error && error.message)
      if (!this.unloaded) {
        this.setData({ scanning: false, tip: '连接设备失败，请将手机靠近设备后重新搜索' })
      }
      return
    }
    if (this.unloaded) {
      return
    }

    // ② 设备扫描附近 WiFi：每回一批就先显示出来（边扫边显示），转圈保持到扫描结束
    this.setData({ phase: 'scanning' })
    let list = null
    try {
      list = await this.session.scanWifi(SCAN_TIMEOUT_MS, all => {
        if (!this.unloaded) {
          this.setData({ wifiList: toWifiList(all) })
        }
      })
    } catch (error) {
      console.warn('[WiFi列表] 设备扫描失败', error && error.message)
      if (!this.unloaded) {
        // 设备报的错（带 code：扫描失败、要求加密、断开等）原样告诉用户；写指令本身失败给通用提示
        const deviceError = error && error.code !== undefined
        this.setData({
          scanning: false,
          tip: deviceError
            ? `${error.message}，请重新搜索或手动输入WiFi名称`
            : '发送扫描指令失败，请重新搜索或手动输入WiFi名称'
        })
      }
      return
    }
    if (this.unloaded) {
      return
    }
    if (!list) {
      console.warn('[WiFi列表] 设备未返回 WiFi 列表')
      this.setData({
        scanning: false,
        tip: '设备未返回WiFi列表（可能没扫到网络或设备不支持），请重新搜索或手动输入WiFi名称'
      })
      return
    }
    const wifiList = toWifiList(list)
    console.log('[WiFi列表] 设备返回', list.length, '条，显示 2.4G', wifiList.length, '条')
    this.setData({
      scanning: false,
      wifiList,
      tip: wifiList.length ? '' : '设备附近没有搜到2.4G WiFi，请重新搜索或手动输入WiFi名称'
    })
  },

  rescan() {
    if (!this.data.scanning) {
      this.scan()
    }
  },

  // 选中即进入账号密码页，名称带过去
  pickWifi(e) {
    this.goConfig(e.currentTarget.dataset.ssid || '')
  },

  // 手动输入：名称留空进账号密码页（提示语下的灰字、列表底部入口都走这里）
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
