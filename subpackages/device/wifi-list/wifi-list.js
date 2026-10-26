const system = require('../../../utils/system')
const fold = require('../../../utils/fold-adapt')
const bluetooth = require('../../../utils/bluetooth')
const blufi = require('../../../utils/blufi')
const wifiProvision = require('../../../utils/wifi-provision')
const signal = require('../../../utils/signal')

// WiFi 版设备配网第一步：选择 WiFi（2026-10-26 产品定的流程）：
//   App 蓝牙连接设备 → 设备扫描附近 WiFi（3~5 秒，页面显示「正在搜索网络...」）→ 显示列表（名称 + 信号强度）
//   → 用户选中进 WiFi 账号密码页 → 配网状态页下发 WiFi 参数（+ MQTT 参数，来源未定前不发）。
//
//   · 列表来自**设备扫描**（BluFi 0x09，设备回 0x11 或自定义文本，见 utils/blufi.js），不用手机扫：iOS 微信拿不到
//     附近列表、手机扫到的也不一定是设备那边收得到的；本设备是双频芯片，按回包里的信道只留 2.4G（ch 1~14，国内外通用）；
//   · 设备分批回就边收边显示，最后一批后再等 5 秒才结束转圈；
//   · 同名去重取信号强的，信号强的在前；隐藏网络（名称为空）不列；
//   · 这条蓝牙连接一直留着给配网状态页复用（同一会话、序号连续），离开本页（返回搜索页）才断开；
//   · 连不上设备 / 设备没回列表 / 设备报扫描失败：提示原因，给「重新搜索」，也可「手动输入WiFi名称」；
//   · 页面依次显示「正在连接设备...」「正在搜索网络...」；非正式版另有联调日志（每一步 + 收发原始帧 + 设备报错）。
// BLE 句柄从搜索页经 utils/wifi-provision 内存交接（getTarget），url 只带展示用的设备信息。
// 等设备回 WiFi 列表的上限：联调期先放到 60 秒（2026-10-26，原 12 秒嫌短）；设备报错会立即结束，不必等满
const SCAN_TIMEOUT_MS = 60000

// 联调查看：非正式版（开发版 / 体验版）在每个 WiFi 下面打出设备回包的全部字段与原始字节，并且不去重，
// 用来确认设备回了哪些参数（乐鑫标准格式只有 SSID + RSSI，没有信道 / 频率，无法按频段过滤）。正式版不显示。
function showRawFields() {
  try {
    return wx.getAccountInfoSync().miniProgram.envVersion !== 'release'
  } catch (error) {
    return false
  }
}

// 信号格数与搜索设备列表同一套（utils/signal.js）：满格 4、最弱 1、未知 0
function signalLevel(rssi) {
  return signal.rssiToLevel(rssi)
}

// 设备回的列表整理成页面数据：去掉空名称、同名取信号强的、按信号排序。
// raw 模式（联调查看）不去重，原样保留每条的全部字段；5G 与名称为空的隐藏网络两种模式都不列。
function toWifiList(list, raw) {
  const view = item => ({
    ssid: String((item && item.ssid) || '').trim(),
    rssi: Number(item && item.rssi) || 0,
    level: signalLevel(item && item.rssi),
    len: item && item.len !== undefined ? item.len : '-',
    raw: (item && item.raw) || '',
    // 本设备回信道（自定义文本格式）；乐鑫标准格式没有，页面显示「未返回」
    channel: item && item.channel !== undefined ? item.channel : '',
    frequency: item && item.frequency ? item.frequency : ''
  })
  // 只留 2.4G：信道 1~14 为 2.4G（国内外通用），其余（36 起的 5G）去掉；
  // 设备没回信道（乐鑫标准格式）时无从判断，照常列出（这类设备多为单 2.4G 芯片）
  const is24G = item => blufi.is24GChannel(item && item.channel) !== false
  const band24 = (list || []).filter(is24G)
  const filtered5G = (list || []).length - band24.length
  // 名称为空的（隐藏网络，联调里显示成「SSID：(空)」）一律不列，联调查看也不列（2026-10-26 产品要求）
  const kept = band24.filter(item => String((item && item.ssid) || '').trim())
  const filteredHidden = band24.length - kept.length
  if (raw) {
    return {
      items: kept.map((item, index) => Object.assign(view(item), { key: `${index}` })),
      filtered5G,
      filteredHidden
    }
  }
  const best = {}
  kept.forEach(item => {
    const ssid = String((item && item.ssid) || '').trim()
    if (!ssid) {
      return
    }
    if (!best[ssid] || Number(item.rssi) > Number(best[ssid].rssi)) {
      best[ssid] = item
    }
  })
  const items = Object.keys(best)
    .map(ssid => Object.assign(view(best[ssid]), { key: ssid }))
    .sort((a, b) => b.rssi - a.rssi)
  return { items, filtered5G, filteredHidden }
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
    tip: '',
    phase: 'connecting', // connecting 连接设备中 / scanning 设备扫描中
    logs: [], // 联调日志（非正式版显示）：每一步与收发的原始帧
    showRaw: false, // 联调查看：每个 WiFi 下打出设备回包字段（非正式版）
    rawSummary: '',
    rawHex: ''
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
      showRaw: showRawFields()
    })
    this.scan()
  },

  // 返回搜索页（或整个配网流程结束）时断开蓝牙；往后跳到账号密码页时本页不卸载，连接保留给配网复用
  onUnload() {
    this.unloaded = true
    ;(this._offHooks || []).forEach(off => off())
    if (this.session) {
      this.session.close()
      this.session = null
    }
  },

  // 联调日志：非正式版显示在页面上，同时打到控制台
  log(text) {
    console.log('[WiFi列表]', text)
    if (!this.data.showRaw || this.unloaded) {
      return
    }
    const now = new Date()
    const pad = n => (n < 10 ? '0' : '') + n
    const time = `${pad(now.getMinutes())}:${pad(now.getSeconds())}.${String(now.getMilliseconds()).padStart(3, '0')}`
    this._logId = (this._logId || 0) + 1
    this.setData({ logs: this.data.logs.concat({ id: this._logId, text: `${time} ${text}` }).slice(-80) })
  },

  // 会话的收发帧 / 控制帧 / 设备报错接进联调日志（同一会话只接一次）
  hookSession(session) {
    if (this._hookedSession === session) {
      return
    }
    ;(this._offHooks || []).forEach(off => off())
    this._hookedSession = session
    this._offHooks = [
      session.on('frame', frame => this.log(`${frame.dir === 'tx' ? '发 →' : '收 ←'} ${frame.hex}`)),
      session.on('ctrl', ctrl => this.log(`设备控制帧 子类型 0x${ctrl.subtype.toString(16)}`)),
      session.on('deviceError', detail => this.log(`设备报错：${detail.message}`)),
      session.on('disconnect', () => this.log('设备断开了蓝牙连接'))
    ]
  },

  async scan() {
    const target = wifiProvision.getTarget()
    if (!target || !target.bleDeviceId) {
      this.setData({ scanning: false, wifiList: [], tip: '设备信息已失效，请返回重新搜索设备' })
      return
    }
    // ① 蓝牙连接设备（从搜索页进来时已连上，这里直接复用；断了就重连）
    this.setData({ scanning: true, phase: 'connecting', tip: '', logs: [] })
    this.log(`① 蓝牙连接设备 ${target.bleDeviceId}`)
    try {
      await bluetooth.openAdapter()
      await bluetooth.whenScanStopped()
      this.session = await blufi.connect(target.bleDeviceId)
    } catch (error) {
      console.warn('[WiFi列表] 蓝牙连接设备失败', error && error.message)
      this.log(`连接失败：${(error && error.message) || error}`)
      if (!this.unloaded) {
        this.setData({ scanning: false, tip: '连接设备失败，请将手机靠近设备后重新搜索' })
      }
      return
    }
    if (this.unloaded) {
      return
    }
    this.hookSession(this.session)
    const info = this.session.info ? this.session.info() : {}
    this.log(`已连接：服务 ${info.serviceId || '-'}，单帧上限 ${info.frameLimit || '-'} 字节`)

    // ② 设备扫描附近 WiFi
    this.setData({ phase: 'scanning' })
    this.log(`② 切 STA 模式（0x02）并发送获取WiFi列表（0x09），最多等 ${SCAN_TIMEOUT_MS / 1000} 秒`)
    let list = null
    try {
      // 设备每回一批就先显示出来（边扫边显示），转圈保持到扫描结束
      list = await this.session.scanWifi(SCAN_TIMEOUT_MS, (all, batch) => {
        this.log(`收到一批 ${batch.length} 条（累计 ${all.length} 条）`)
        if (!this.unloaded) {
          this.applyList(all)
        }
      })
    } catch (error) {
      console.warn('[WiFi列表] 设备扫描失败', error && error.message)
      this.log(`扫描失败：${(error && error.message) || error}`)
      if (!this.unloaded) {
        // 设备报的错（带 code：扫描失败、要求加密等）原样告诉用户；写指令本身失败（蓝牙断了等）给通用提示
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
      this.log(`${SCAN_TIMEOUT_MS / 1000} 秒内没收到设备的 WiFi 列表`)
      this.setData({
        scanning: false,
        tip: '设备未返回WiFi列表（可能没扫到网络或设备不支持），请重新搜索或手动输入WiFi名称'
      })
      return
    }
    this.log(`③ 收到 WiFi 列表：${list.length} 条`)
    const shown = this.applyList(list)
    this.setData({
      scanning: false,
      tip: shown ? '' : '设备附近没有搜到2.4G WiFi，请重新搜索或手动输入WiFi名称'
    })
  },

  // 把设备回的（累计）列表刷到页面：只留 2.4G、去重排序；联调模式另给整包统计。返回显示的条数
  applyList(list) {
    const result = toWifiList(list, this.data.showRaw)
    const tailHex = list.tailHex || ''
    const bytes = list.rawHex ? list.rawHex.split(' ').length : 0
    this.setData({
      wifiList: result.items,
      rawSummary: `设备回包 ${bytes} 字节 · 解析出 ${list.length} 条 · 过滤掉 5G ${result.filtered5G} 条 · 隐藏网络（名称为空）${result.filteredHidden} 条${tailHex ? ` · 解析不了的残尾 ${tailHex.split(' ').length} 字节：${tailHex}` : ''}`,
      rawHex: list.rawHex || ''
    })
    return result.items.length
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
