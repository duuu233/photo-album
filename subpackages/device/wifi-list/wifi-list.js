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
//     附近列表、手机扫到的也不一定是设备那边收得到的；本设备是双频芯片，5G、2.4G 都列出（只留 2.4G 的过滤 10-28 取消、10-29 恢复，2026-11-05 再次取消）；
//   · 搜一个显示一个（2026-11-11，仿搜索设备页）：设备每回一批，没显示过的按信号从强到弱逐条亮出（间隔 REVEAL_INTERVAL_MS）；
//     头部「正在搜索网络...」只在一条都还没有时显示，列表出来后头部即换成「重新搜索」（可随时重搜，旧一轮结果作废）；
//     后台照旧收设备后续的批次，最后一批后再等 5 秒才算结束（用于空列表 / 未返回的提示），不再挂着转圈；
//   · 同名去重取信号强的，信号强的在前；隐藏网络（名称为空）不列；
//   · 点一行即选中该网络，直接带名称进账号密码页（2026-10-26 一度改为「选中 + 连接」两步，按产品要求改回一步）；
//   · 这条蓝牙连接一直留着给配网状态页复用（同一会话、序号连续），离开本页（返回搜索页）才断开；
//   · 连不上设备 / 设备没回列表 / 设备报扫描失败：提示原因，给「重新搜索」；搜不到时可手动输入
//     （提示语下的灰字「若搜索不到您的wifi，请手动输入」与列表下方居中的「手动输入WiFi名称」文字都进账号密码页）；
//   · 页面依次显示「正在连接设备...」「正在搜索网络...」。各环境同一套界面，联调信息只打控制台（2026-10-26 去掉页面调试内容）。
// BLE 句柄从搜索页经 utils/wifi-provision 内存交接（getTarget），url 只带展示用的设备信息。

// 等设备回 WiFi 列表的上限 60 秒（2026-10-26，原 12 秒嫌短）；设备报错会立即结束，不必等满
const SCAN_TIMEOUT_MS = 60000
// 搜一个显示一个：每隔多久亮出下一条（2026-11-11）。设备一批回几十条时约 2~4 秒逐条出完
const REVEAL_INTERVAL_MS = 100

// 设备回的列表整理成页面数据：去掉名称为空的隐藏网络、同名取信号强的、按信号排序。
// 不按频段过滤（2026-11-05 再次取消只留 2.4G，5G、2.4G 都显示）。
function toWifiList(list) {
  const best = {}
  ;(list || []).forEach(item => {
    const ssid = String((item && item.ssid) || '').trim()
    if (!ssid) {
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
    this.resetReveal()
    if (this.session) {
      this.session.close()
      this.session = null
    }
  },

  async scan() {
    // 每轮搜索一个序号：列表出来后可随时重新搜索，旧一轮之后回来的批次 / 结果一律作废
    const seq = (this.scanSeq || 0) + 1
    this.scanSeq = seq
    const current = () => !this.unloaded && this.scanSeq === seq
    this.resetReveal()
    const target = wifiProvision.getTarget()
    if (!target || !target.bleDeviceId) {
      this.setData({ scanning: false, wifiList: [], tip: '设备信息已失效，请返回重新搜索设备' })
      return
    }
    // ① 蓝牙连接设备（从搜索页进来时已连上，这里直接复用；断了就重连）
    this.setData({ scanning: true, phase: 'connecting', tip: '', wifiList: [] })
    try {
      await bluetooth.openAdapter()
      await bluetooth.whenScanStopped()
      this.session = await blufi.connect(target.bleDeviceId)
    } catch (error) {
      console.warn('[WiFi列表] 蓝牙连接设备失败', error && error.message)
      if (current()) {
        this.setData({ scanning: false, tip: '连接设备失败，请将手机靠近设备后重新搜索' })
      }
      return
    }
    if (!current()) {
      return
    }

    // ② 设备扫描附近 WiFi：每回一批就交给逐条显示（搜一个显示一个），扫描结束前头部不再挂转圈
    this.setData({ phase: 'scanning' })
    // 耗时日志（2026-11-11）：发出扫描指令到每一批回来各用了多久，真机日志据此区分慢在设备扫描还是别处
    const startedAt = Date.now()
    let batches = 0
    let list = null
    try {
      list = await this.session.scanWifi(SCAN_TIMEOUT_MS, (all, batch) => {
        if (!current()) {
          return
        }
        batches++
        console.log('[WiFi列表] 第', batches, '批', (batch && batch.length) || 0, '条，距发出扫描', Date.now() - startedAt, 'ms')
        this.reveal(toWifiList(all))
      })
    } catch (error) {
      console.warn('[WiFi列表] 设备扫描失败', error && error.message, '距发出扫描', Date.now() - startedAt, 'ms')
      if (current()) {
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
    if (!current()) {
      return
    }
    if (!list) {
      console.warn('[WiFi列表] 设备未返回 WiFi 列表，等了', Date.now() - startedAt, 'ms')
      this.resetReveal()
      this.setData({
        scanning: false,
        tip: '设备未返回WiFi列表（可能没扫到网络或设备不支持），请重新搜索或手动输入WiFi名称'
      })
      return
    }
    const wifiList = toWifiList(list)
    console.log('[WiFi列表] 设备返回', list.length, '条（', batches, '批），显示', wifiList.length, '条，含收尾等待共', Date.now() - startedAt, 'ms')
    // 收尾：还没逐条亮出的一次补齐（最后一批后已等 5 秒，正常早已亮完）
    this.resetReveal()
    this.setData({
      scanning: false,
      wifiList,
      tip: wifiList.length ? '' : '设备附近没有搜到WiFi，请重新搜索或手动输入WiFi名称'
    })
  },

  // 搜一个显示一个：all 是最新整理好的完整列表（去重、按信号排序）。已亮出的跟着刷新信号与位置，
  // 没亮出的立即亮一条（定时器空闲时），其余每隔 REVEAL_INTERVAL_MS 按信号从强到弱再亮一条
  reveal(all) {
    this.revealAll = all
    this.revealShown = this.revealShown || {}
    if (this.revealPending) {
      this.renderRevealed()
      return
    }
    this.revealNext()
  },

  revealNext() {
    this.revealPending = false
    this.revealTimer = null
    const pending = (this.revealAll || []).filter(item => !this.revealShown[item.ssid])
    if (!pending.length) {
      return
    }
    this.revealShown[pending[0].ssid] = true
    this.renderRevealed()
    if (pending.length > 1) {
      this.revealPending = true
      this.revealTimer = setTimeout(() => this.revealNext(), REVEAL_INTERVAL_MS)
    }
  },

  renderRevealed() {
    if (this.unloaded) {
      return
    }
    this.setData({ wifiList: (this.revealAll || []).filter(item => this.revealShown[item.ssid]) })
  },

  resetReveal() {
    if (this.revealPending) {
      clearTimeout(this.revealTimer)
    }
    this.revealPending = false
    this.revealTimer = null
    this.revealAll = []
    this.revealShown = {}
  },

  // 列表出来后即可重新搜索（不必等后台收尾）；连接设备、一条都没出来时不响应
  rescan() {
    if (!this.data.scanning || this.data.wifiList.length) {
      this.scan()
    }
  },

  // 点一行即选中该网络，带名称进账号密码页
  pickWifi(e) {
    this.goConfig(e.currentTarget.dataset.ssid || '')
  },

  // 手动输入：名称留空进账号密码页（提示语下的灰字、列表下方居中文字都走这里）
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
