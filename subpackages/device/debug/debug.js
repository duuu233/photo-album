// 硬件联调调试台：把 PRD 文档里能对接的功能全做成按钮，点一下就发一条 BLE 指令，
// 下方控制台实时打印「发送/接收」的 16 进制原始字节，方便第一次对接时和硬件侧日志对照排查。
//
// 整体链路（自下而上）：
//   wx 蓝牙 API  →  utils/bluetooth.js(扫描/连接)  →  utils/frame-protocol.js(组帧/解析)
//                →  utils/device-ble.js(发指令/收应答/图传)  →  本页面(按钮 + 日志)
//
// 推荐联调顺序（页面上从上到下就是这个顺序）：
//   1) 连接设备   2) 读设备信息(0x01，拿到屏幕类型/容量/图片掩码/电量)   3) 逐个点其它按钮试。

const permission = require('../../../utils/permission')
const bluetooth = require('../../../utils/bluetooth')
const deviceBle = require('../../../utils/device-ble')
const protocol = require('../../../utils/frame-protocol')
const imageCodec = require('../../../utils/image-codec')
const system = require('../../../utils/system')

// 调试页专用校准档：nibble 为协议编码值（不可改）；rgb 仅参与「原图像素 → 六色」最近色匹配。
// 只在当前硬件调试页试用，不影响 utils/image-codec.js 和其它正式上传入口。
const DEBUG_CALIBRATION_PROFILE_SOURCE = [
  {
    id: 'shot-20260622',
    name: '实拍 2026-06-22',
    note: '本次六色测试图取样；适合当前这台样机/批次。',
    palette: [
      { nibble: 0x0, rgb: [0, 0, 0], name: '黑' },
      { nibble: 0x1, rgb: [255, 255, 255], name: '白' },
      { nibble: 0x2, rgb: [255, 250, 0], name: '黄' },
      { nibble: 0x3, rgb: [97, 0, 0], name: '红' },
      { nibble: 0x5, rgb: [20, 56, 180], name: '蓝' },
      { nibble: 0x6, rgb: [57, 104, 57], name: '绿' }
    ]
  },
  {
    id: 'app-6color',
    name: 'APP 6色基准',
    note: 'Flutter APP 中 6色.jpg 校准值；用于和 APP 当前效果对齐。',
    palette: [
      { nibble: 0x0, rgb: [0, 0, 0], name: '黑' },
      { nibble: 0x1, rgb: [255, 255, 255], name: '白' },
      { nibble: 0x2, rgb: [255, 246, 32], name: '黄' },
      { nibble: 0x3, rgb: [129, 22, 0], name: '红' },
      { nibble: 0x5, rgb: [47, 77, 151], name: '蓝' },
      { nibble: 0x6, rgb: [57, 109, 68], name: '绿' }
    ]
  },
  {
    id: 'mini-default',
    name: '小程序默认基准',
    note: 'utils/image-codec.js 默认 palette；用于回退对比旧效果。',
    palette: [
      { nibble: 0x0, rgb: [0, 0, 0], name: '黑' },
      { nibble: 0x1, rgb: [255, 255, 255], name: '白' },
      { nibble: 0x2, rgb: [255, 255, 29], name: '黄' },
      { nibble: 0x3, rgb: [140, 65, 43], name: '红' },
      { nibble: 0x5, rgb: [71, 97, 192], name: '蓝' },
      { nibble: 0x6, rgb: [90, 129, 96], name: '绿' }
    ]
  }
]

const DEBUG_PROFILE_STORAGE_PREFIX = 'debug:image-calibration-profile:'
const DEBUG_CALIBRATION_PROFILES = DEBUG_CALIBRATION_PROFILE_SOURCE.map(profile => Object.assign({}, profile, {
  palette: withLabPalette(profile.palette)
}))
const DEBUG_CALIBRATION_PROFILE_OPTIONS = DEBUG_CALIBRATION_PROFILES.map(profile => profile.name)
const DEFAULT_DEBUG_PROFILE_ID = 'shot-20260622'
const DEFAULT_DEBUG_PROFILE_INDEX = Math.max(0, DEBUG_CALIBRATION_PROFILES.findIndex(profile => profile.id === DEFAULT_DEBUG_PROFILE_ID))
const DEFAULT_DEBUG_PROFILE = DEBUG_CALIBRATION_PROFILES[DEFAULT_DEBUG_PROFILE_INDEX]

const DEFAULT_DEBUG_QUANTIZE = {
  dither: true,
  contrast: 1.12,
  saturation: 1.28,
  distanceMetric: 'Lab ΔE76',
  // 实拍/相册图的黑白灰常带轻微色偏；低饱和像素只在黑白之间抖动，避免暗部被归成绿/红。
  achromaticChromaMax: 28
}

const DEBUG_RESAMPLE = {
  predecodeQuality: 96,
  maxStageEdge: 2048,
  stageScale: 0.5
}

function clamp255(v) {
  return v < 0 ? 0 : (v > 255 ? 255 : v)
}

function enhanceDebugPixel(r, g, b, settings) {
  const contrast = settings.contrast
  const saturation = settings.saturation
  r = (r - 128) * contrast + 128
  g = (g - 128) * contrast + 128
  b = (b - 128) * contrast + 128
  const lum = 0.299 * r + 0.587 * g + 0.114 * b
  r = lum + (r - lum) * saturation
  g = lum + (g - lum) * saturation
  b = lum + (b - lum) * saturation
  return [clamp255(r), clamp255(g), clamp255(b)]
}

function srgbToLinear(v) {
  const n = clamp255(v) / 255
  return n <= 0.04045 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4)
}

function xyzPivot(v) {
  return v > 0.008856 ? Math.pow(v, 1 / 3) : (7.787 * v) + (16 / 116)
}

function rgbToLab(r, g, b) {
  const lr = srgbToLinear(r)
  const lg = srgbToLinear(g)
  const lb = srgbToLinear(b)
  const x = (0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb) / 0.95047
  const y = (0.2126729 * lr + 0.7151522 * lg + 0.0721750 * lb) / 1.00000
  const z = (0.0193339 * lr + 0.1191920 * lg + 0.9503041 * lb) / 1.08883
  const fx = xyzPivot(x)
  const fy = xyzPivot(y)
  const fz = xyzPivot(z)
  return [(116 * fy) - 16, 500 * (fx - fy), 200 * (fy - fz)]
}

function labDistance(lab, entry) {
  const [pl, pa, pb] = entry.lab
  const dl = lab[0] - pl
  const da = lab[1] - pa
  const db = lab[2] - pb
  return dl * dl + da * da + db * db
}

function withLabPalette(palette) {
  return palette.map(entry => Object.assign({}, entry, {
    lab: rgbToLab(entry.rgb[0], entry.rgb[1], entry.rgb[2])
  }))
}

function findDebugCalibrationProfile(id) {
  return DEBUG_CALIBRATION_PROFILES.find(profile => profile.id === id) || null
}

function nearestDebugPaletteIndex(r, g, b, settings) {
  const palette = settings.palette || DEFAULT_DEBUG_PROFILE.palette
  const cr = clamp255(r)
  const cg = clamp255(g)
  const cb = clamp255(b)
  const chroma = Math.max(cr, cg, cb) - Math.min(cr, cg, cb)
  const paletteLength = chroma <= settings.achromaticChromaMax ? 2 : palette.length
  const lab = rgbToLab(cr, cg, cb)
  let best = 0
  let bestDist = Infinity
  for (let i = 0; i < paletteLength; i++) {
    const dist = labDistance(lab, palette[i])
    if (dist < bestDist) {
      bestDist = dist
      best = i
    }
  }
  return best
}

function spreadDebugError(buf, x, y, width, height, er, eg, eb, weight) {
  if (x < 0 || x >= width || y < 0 || y >= height) {
    return
  }
  const i = (y * width + x) * 3
  buf[i] += er * weight
  buf[i + 1] += eg * weight
  buf[i + 2] += eb * weight
}

function fromImageDataWithDebugCalibration(imageData, width, height, options) {
  const settings = Object.assign({}, DEFAULT_DEBUG_QUANTIZE, options || {})
  const palette = settings.palette || DEFAULT_DEBUG_PROFILE.palette
  const px = imageData.data
  const count = width * height
  const nibbles = new Uint8Array(count)

  if (!settings.dither) {
    for (let i = 0; i < count; i++) {
      const [r, g, b] = enhanceDebugPixel(px[i * 4], px[i * 4 + 1], px[i * 4 + 2], settings)
      nibbles[i] = palette[nearestDebugPaletteIndex(r, g, b, settings)].nibble
    }
    const data = imageCodec.packNibbles(nibbles)
    return { data, width, height, dataSize: data.length }
  }

  const buf = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    const [r, g, b] = enhanceDebugPixel(px[i * 4], px[i * 4 + 1], px[i * 4 + 2], settings)
    buf[i * 3] = r
    buf[i * 3 + 1] = g
    buf[i * 3 + 2] = b
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      const r = buf[i * 3]
      const g = buf[i * 3 + 1]
      const b = buf[i * 3 + 2]
      const pi = nearestDebugPaletteIndex(r, g, b, settings)
      nibbles[i] = palette[pi].nibble
      const [pr, pg, pb] = palette[pi].rgb
      const er = r - pr
      const eg = g - pg
      const eb = b - pb
      spreadDebugError(buf, x + 1, y, width, height, er, eg, eb, 7 / 16)
      spreadDebugError(buf, x - 1, y + 1, width, height, er, eg, eb, 3 / 16)
      spreadDebugError(buf, x, y + 1, width, height, er, eg, eb, 5 / 16)
      spreadDebugError(buf, x + 1, y + 1, width, height, er, eg, eb, 1 / 16)
    }
  }

  const data = imageCodec.packNibbles(nibbles)
  return { data, width, height, dataSize: data.length }
}

Page({
  data: {
    statusBarHeight: 20,
    safeBottom: 0,

    // 连接相关
    deviceId: '', // 微信蓝牙 deviceId（连接用的唯一标识）
    deviceName: '',
    connected: false,
    connecting: false,
    scanning: false,
    devices: [], // 扫描到的设备列表

    // 设备信息（0x01 读回后填充）
    info: null,
    connInterval: null,
    existingIndexes: '', // 设备上已有图片的索引列表，便于决定删哪张/传到哪
    autoUploadIndex: -1, // 自动挑选的空闲槽位

    // 指令输入框
    playMode: 'order', // 'order' 顺序 / 'random' 随机
    intervalInput: '60', // 切换间隔(秒)
    connIntervalInput: '30', // BLE 连接间隔(ms)，协议会换算为 1.25ms 单位
    switchInput: '0', // 0x24 要显示的图片索引
    deleteInput: '', // 0x12 要删除的图片索引，逗号分隔，如 "0,2"
    uploadIndexInput: '', // 上传槽位，留空则自动选空闲位
    pace: 45, // 图传每包发送间隔(ms)，越小越快；从慢到快试，找你这台设备不丢包的最快值
    cropMode: 'cover', // cover 与 APP centerCropCover 对齐；contain 用白底完整显示原图
    debugDither: DEFAULT_DEBUG_QUANTIZE.dither,
    debugContrastPercent: Math.round(DEFAULT_DEBUG_QUANTIZE.contrast * 100),
    debugContrastText: DEFAULT_DEBUG_QUANTIZE.contrast.toFixed(2),
    debugSaturationPercent: Math.round(DEFAULT_DEBUG_QUANTIZE.saturation * 100),
    debugSaturationText: DEFAULT_DEBUG_QUANTIZE.saturation.toFixed(2),
    debugDistanceMetric: DEFAULT_DEBUG_QUANTIZE.distanceMetric,
    calibrationProfileOptions: DEBUG_CALIBRATION_PROFILE_OPTIONS,
    calibrationProfileIndex: DEFAULT_DEBUG_PROFILE_INDEX,
    calibrationProfileId: DEFAULT_DEBUG_PROFILE.id,
    calibrationProfileName: DEFAULT_DEBUG_PROFILE.name,
    calibrationProfileNote: DEFAULT_DEBUG_PROFILE.note,

    // 状态
    busy: false, // 有指令正在等应答，避免并发
    uploading: false,
    uploadPercent: 0,
    uploadStatus: '', // 图传结果/失败原因（常驻显示，方便排查）
    uploadStatusType: '', // info / ok / err

    logs: [] // 收发日志（最新在最上）
  },

  onLoad(options) {
    this.setData(system.getLayoutMetrics())
    this._logId = 0

    // 注册监听器：device-ble 每发送/接收一帧都会回调这里，把 16 进制打到控制台
    deviceBle.setMonitor(record => this.onMonitorFrame(record))

    // 从绑定页跳进来时会带 id/name，直接连接；否则停在「扫描」状态让用户自己挑设备
    if (options && options.id) {
      this.setData({
        deviceId: options.id,
        deviceName: decodeURIComponent(options.name || '') || options.id
      })
      this.connect()
    }
  },

  onUnload() {
    deviceBle.setMonitor(null) // 取消监听，避免离开页面后还在往已销毁的页面 setData
    bluetooth.stopDiscovery()
    wx.setKeepScreenOn && wx.setKeepScreenOn({ keepScreenOn: false }) // 离开页面恢复正常息屏
    if (this.data.deviceId) {
      deviceBle.disconnect(this.data.deviceId) // 释放连接，让设备能重新广播被别的手机连
    }
  },

  // 页面进入后台（息屏 / 切到微信外 / 跳走）。图传在后台无法继续（蓝牙被挂起、设备会超时中止），
  // 这里打上中止标记，让正在进行的图传尽快干净停下，避免回前台后报含糊错误。
  onHide() {
    if (this.data.uploading) {
      this._uploadAborted = true
    }
  },

  noop() {},

  // ── 日志 ────────────────────────────────────────────────
  formatTime(ts) {
    const d = new Date(ts || Date.now())
    const p2 = n => String(n).padStart(2, '0')
    const p3 = n => String(n).padStart(3, '0')
    return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${p3(d.getMilliseconds())}`
  },

  // type: tx 发送 / rx 接收 / act 操作 / ok 成功 / err 失败
  appendLog(entry) {
    const item = {
      id: ++this._logId,
      time: this.formatTime(entry.time),
      type: entry.type,
      text: entry.text
    }
    // 最新一条放最前；最多保留 300 条，防止越积越多卡顿
    const logs = [item].concat(this.data.logs).slice(0, 300)
    this.setData({ logs })
  },

  clearLogs() {
    this.setData({ logs: [] })
  },

  // device-ble 上报的每一帧原始字节。图传数据包(0x21)与其应答(0x23)数量巨大，不逐条刷屏，用进度条体现。
  onMonitorFrame(record) {
    if (record.cmd === protocol.CMD.IMG_DATA || record.cmd === protocol.CMD.IMG_ACK) {
      return
    }
    const cmdHex = record.cmd.toString(16).padStart(2, '0').toUpperCase()
    const arrow = record.dir === 'TX' ? '▶ 发送' : '◀ 接收'
    const note = record.note ? `[${record.note}] ` : ''
    this.appendLog({
      type: record.dir === 'TX' ? 'tx' : 'rx',
      time: record.time,
      text: `${arrow} CMD=0x${cmdHex} ${note}${record.hex}`
    })
  },

  // ── 连接 / 扫描 ─────────────────────────────────────────
  requireDevice() {
    if (!this.data.deviceId || !this.data.connected) {
      wx.showToast({ title: '请先连接设备', icon: 'none' })
      return false
    }
    return true
  },

  // 扫描附近设备（与绑定页一致：定位授权 → 开蓝牙 → 扫描）
  async scan() {
    if (this.data.scanning) {
      return
    }
    this.setData({ scanning: true, devices: [] })
    try {
      const location = await permission.getCurrentLocation()
      if (!location) {
        wx.showToast({ title: '请先授权定位', icon: 'none' })
        return
      }
      await bluetooth.openAdapter()
      const devices = await bluetooth.discoverDevices({ timeout: 8000 })
      this.setData({ devices })
      this.appendLog({ type: 'act', text: `扫描完成，发现 ${devices.length} 个设备` })
    } catch (error) {
      wx.showToast({ title: error.message || '扫描失败', icon: 'none' })
    } finally {
      this.setData({ scanning: false })
    }
  },

  // 选中某个扫描结果并连接
  selectDevice(e) {
    const id = e.currentTarget.dataset.id
    const device = this.data.devices.find(item => item.id === id || item.deviceId === id)
    if (!device) {
      return
    }
    this.setData({
      deviceId: device.deviceId,
      deviceName: device.name || device.deviceId
    })
    this.connect()
  },

  // 建立连接并读一次设备信息
  async connect() {
    if (!this.data.deviceId) {
      return
    }
    this.setData({ connecting: true })
    try {
      const session = await deviceBle.ensureConnection(this.data.deviceId)
      this.setData({ connected: true })
      this.appendLog({ type: 'ok', text: `已连接：${this.data.deviceName}` })
      // MTU 决定图传每包能塞多少字节，连接后打出来便于排查图传问题
      const writeTypeText = session.writeType === 'write' ? '有应答写(可靠)' : '无应答写'
      this.appendLog({ type: 'act', text: `协商 MTU=${session.mtu} 字节，图传每包数据 ${session.dataChunk} 字节，写入方式：${writeTypeText}` })
      await this.refreshInfoSilently()
      this.loadSavedCalibrationProfile()
      await this.refreshConnectionIntervalSilently()
    } catch (error) {
      this.setData({ connected: false })
      this.appendLog({ type: 'err', text: `连接失败：${error.message}` })
      wx.showToast({ title: error.message || '连接失败', icon: 'none' })
    } finally {
      this.setData({ connecting: false })
    }
  },

  disconnectDevice() {
    if (this.data.deviceId) {
      deviceBle.disconnect(this.data.deviceId)
    }
    this.setData({ connected: false, info: null, connInterval: null })
    this.appendLog({ type: 'act', text: '已断开连接' })
  },

  // 静默读取设备信息并刷新信息卡片（被各指令成功后调用，用来同步最新掩码/电量）
  async refreshInfoSilently() {
    try {
      const info = await deviceBle.readDeviceInfo(this.data.deviceId)
      const indexes = protocol.maskToIndexes(info.imgMask)
      this.setData({
        info,
        existingIndexes: indexes.length ? indexes.join(', ') : '无',
        autoUploadIndex: protocol.firstFreeIndex(info.imgMask, info.capacity)
      })
    } catch (error) {
      // 读取失败不阻断主流程
    }
  },

  async refreshConnectionIntervalSilently() {
    try {
      const connInterval = await deviceBle.getConnectionInterval(this.data.deviceId)
      this.setData({
        connInterval,
        connIntervalInput: String(connInterval.ms)
      })
    } catch (error) {
      // v1.4 新增能力，读取失败不影响其它指令调试。
    }
  },

  // 指令统一包装：连接校验 + 防并发 + 成功/失败日志 + 可选刷新信息
  async runCommand(label, fn, options) {
    if (!this.requireDevice()) {
      return
    }
    if (this.data.busy) {
      wx.showToast({ title: '请等待上一条指令完成', icon: 'none' })
      return
    }
    this.setData({ busy: true })
    this.appendLog({ type: 'act', text: `点击：${label}` })
    try {
      const result = await fn()
      const text = options && options.format ? options.format(result) : `${label} 成功`
      this.appendLog({ type: 'ok', text })
      if (options && options.refresh) {
        await this.refreshInfoSilently()
      }
      wx.showToast({ title: '指令成功', icon: 'none' })
      return result
    } catch (error) {
      this.appendLog({ type: 'err', text: `${label} 失败：${error.message}` })
      wx.showToast({ title: error.message || '指令失败', icon: 'none' })
    } finally {
      this.setData({ busy: false })
    }
  },

  // ── 读取类指令 ──────────────────────────────────────────
  cmdGetInfo() {
    this.runCommand('获取设备信息(0x01)', async () => {
      await this.refreshInfoSilently()
      const info = this.data.info
      return info
    }, {
      format: info => info
        ? `设备信息：电量 ${info.battery}% · ${info.screen} · 容量 ${info.capacity} · 已存 ${info.imgCount} 张 · 固件 ${info.firmwareVersion || '--'}`
        : '设备信息已刷新'
    })
  },

  cmdGetPlay() {
    this.runCommand('获取播放配置(0x02)', () => deviceBle.getPlayConfig(this.data.deviceId), {
      format: cfg => `播放配置：${this.playModeText(cfg.playMode)} · 间隔 ${cfg.intervalSeconds} 秒`
    })
  },

  cmdGetVersion() {
    this.runCommand('获取软件版本(0x03)', () => deviceBle.getSwVersion(this.data.deviceId), {
      format: ver => `固件版本：${ver || '(空)'}`
    })
  },

  cmdGetBattery() {
    this.runCommand('获取电量(0x04)', () => deviceBle.readBattery(this.data.deviceId), {
      format: battery => `当前电量：${battery}%`
    })
  },

  async cmdGetConnInterval() {
    const connInterval = await this.runCommand('获取连接间隔(0x05)', () => deviceBle.getConnectionInterval(this.data.deviceId), {
      format: value => `连接间隔：${value.ms}ms · CONN_INTERVAL=${value.units}`
    })
    if (connInterval) {
      this.setData({
        connInterval,
        connIntervalInput: String(connInterval.ms)
      })
    }
  },

  // ── 设置类指令 ──────────────────────────────────────────
  // 播放模式中文名：order 顺序 / random 随机 / manual 手动
  playModeText(mode) {
    return mode === 'random' ? '随机' : (mode === 'manual' ? '手动' : '顺序')
  },

  onPlayModeChange(e) {
    this.setData({ playMode: e.detail.value })
  },

  onIntervalInput(e) {
    this.setData({ intervalInput: e.detail.value })
  },

  onConnIntervalInput(e) {
    this.setData({ connIntervalInput: e.detail.value })
  },

  cmdSetPlay() {
    const interval = Number(this.data.intervalInput)
    if (!Number.isFinite(interval) || interval < 1) {
      wx.showToast({ title: '请输入有效的间隔秒数', icon: 'none' })
      return
    }
    this.runCommand('设置播放配置(0x10)', () => deviceBle.setPlayback(this.data.deviceId, this.data.playMode, interval), {
      refresh: true,
      format: () => `已设为 ${this.playModeText(this.data.playMode)} 播放 · 间隔 ${interval} 秒`
    })
  },

  async cmdSetConnInterval() {
    const ms = Number(this.data.connIntervalInput)
    if (!Number.isFinite(ms) || ms <= 0) {
      wx.showToast({ title: '请输入有效的连接间隔毫秒数', icon: 'none' })
      return
    }
    const units = protocol.connectionIntervalMsToUnits(ms)
    if (units < protocol.CONN_INTERVAL_MIN_UNITS || units > protocol.CONN_INTERVAL_MAX_UNITS) {
      wx.showToast({ title: '范围需在 7.5~4000ms', icon: 'none' })
      return
    }
    const connInterval = await this.runCommand('设置连接间隔(0x13)', () => deviceBle.setConnectionInterval(this.data.deviceId, units), {
      format: value => `已设连接间隔：${value.ms}ms · CONN_INTERVAL=${value.units}`
    })
    if (connInterval) {
      this.setData({
        connInterval,
        connIntervalInput: String(connInterval.ms)
      })
    }
  },

  cmdSetTime() {
    this.runCommand('校准时间(0x11)', () => deviceBle.setTime(this.data.deviceId, new Date()), {
      format: () => `已把手机当前时间同步给设备：${new Date().toLocaleString()}`
    })
  },

  // ── 图片类指令 ──────────────────────────────────────────
  onSwitchInput(e) {
    this.setData({ switchInput: e.detail.value })
  },

  cmdSwitch() {
    const index = Number(this.data.switchInput)
    if (!Number.isInteger(index) || index < 0) {
      wx.showToast({ title: '请输入要显示的图片索引', icon: 'none' })
      return
    }
    this.runCommand('切换显示(0x24)', () => deviceBle.refreshScreen(this.data.deviceId, index), {
      refresh: true,
      format: res => `屏幕已切到索引 ${res.curImgIndex === 0xff ? '保持不变' : res.curImgIndex}`
    })
  },

  onDeleteInput(e) {
    this.setData({ deleteInput: e.detail.value })
  },

  cmdDelete() {
    const indexes = String(this.data.deleteInput)
      .split(/[,，\s]+/)
      .filter(s => s !== '')
      .map(Number)
    if (!indexes.length || indexes.some(n => !Number.isInteger(n) || n < 0 || n > 95)) {
      wx.showToast({ title: '请输入要删除的索引(0~95，逗号分隔)', icon: 'none' })
      return
    }
    this.runCommand(`删除图片(0x12) 索引[${indexes.join(',')}]`, () => deviceBle.deleteImage(this.data.deviceId, indexes), {
      refresh: true,
      format: res => `删除完成，设备现存 ${protocol.maskToIndexes(res.imgMask).length} 张`
    })
  },

  onUploadIndexInput(e) {
    this.setData({ uploadIndexInput: e.detail.value })
  },

  // 切换图传发送速度（每包间隔 ms）。建议从「稳」往「快」试：哪一档开始丢包/卡住，就退回上一档。
  onPaceChange(e) {
    this.setData({ pace: Number(e.detail.value) })
  },

  formatTuningValue(percent) {
    const value = Number(percent) / 100
    return Number.isFinite(value) ? value.toFixed(2) : '1.00'
  },

  onCropModeChange(e) {
    this.setData({ cropMode: e.detail.value === 'contain' ? 'contain' : 'cover' })
  },

  onDebugDitherChange(e) {
    this.setData({ debugDither: !!e.detail.value })
  },

  onDebugContrastChange(e) {
    const percent = Number(e.detail.value)
    if (!Number.isFinite(percent)) {
      return
    }
    this.setData({
      debugContrastPercent: percent,
      debugContrastText: this.formatTuningValue(percent)
    })
  },

  onDebugSaturationChange(e) {
    const percent = Number(e.detail.value)
    if (!Number.isFinite(percent)) {
      return
    }
    this.setData({
      debugSaturationPercent: percent,
      debugSaturationText: this.formatTuningValue(percent)
    })
  },

  getCalibrationProfileStorageKey() {
    return `${DEBUG_PROFILE_STORAGE_PREFIX}${encodeURIComponent(this.data.deviceId || '')}`
  },

  applyCalibrationProfile(profile, options) {
    const index = DEBUG_CALIBRATION_PROFILES.findIndex(item => item.id === profile.id)
    this.setData({
      calibrationProfileIndex: index >= 0 ? index : DEFAULT_DEBUG_PROFILE_INDEX,
      calibrationProfileId: profile.id,
      calibrationProfileName: profile.name,
      calibrationProfileNote: profile.note
    })
    if (options && options.log) {
      this.appendLog({ type: 'act', text: `${options.log}：${profile.name} · ${profile.note}` })
    }
  },

  onCalibrationProfileChange(e) {
    const index = Number(e.detail.value)
    const profile = DEBUG_CALIBRATION_PROFILES[index] || DEFAULT_DEBUG_PROFILE
    this.applyCalibrationProfile(profile, { log: '切换色彩校准档' })
  },

  loadSavedCalibrationProfile() {
    if (!this.data.deviceId || !wx.getStorageSync) {
      return
    }
    try {
      const savedId = wx.getStorageSync(this.getCalibrationProfileStorageKey())
      const profile = findDebugCalibrationProfile(savedId)
      if (profile) {
        this.applyCalibrationProfile(profile, { log: '已恢复本设备校准档' })
      }
    } catch (error) {
      // 读取本地调试配置失败不影响上传链路。
    }
  },

  saveDeviceCalibrationProfile() {
    if (!this.data.deviceId) {
      wx.showToast({ title: '请先连接设备', icon: 'none' })
      return
    }
    if (!wx.setStorageSync) {
      wx.showToast({ title: '当前环境不支持本地保存', icon: 'none' })
      return
    }
    try {
      wx.setStorageSync(this.getCalibrationProfileStorageKey(), this.data.calibrationProfileId)
      this.appendLog({ type: 'ok', text: `已保存本设备校准档：${this.data.calibrationProfileName}` })
      wx.showToast({ title: '已保存本设备校准档', icon: 'none' })
    } catch (error) {
      wx.showToast({ title: '保存失败：' + error.message, icon: 'none' })
    }
  },

  getSelectedCalibrationProfile() {
    return findDebugCalibrationProfile(this.data.calibrationProfileId) || DEFAULT_DEBUG_PROFILE
  },

  getDebugQuantizeOptions() {
    const contrast = Number(this.data.debugContrastPercent) / 100
    const saturation = Number(this.data.debugSaturationPercent) / 100
    const profile = this.getSelectedCalibrationProfile()
    return {
      dither: !!this.data.debugDither,
      contrast: Number.isFinite(contrast) ? contrast : DEFAULT_DEBUG_QUANTIZE.contrast,
      saturation: Number.isFinite(saturation) ? saturation : DEFAULT_DEBUG_QUANTIZE.saturation,
      distanceMetric: DEFAULT_DEBUG_QUANTIZE.distanceMetric,
      palette: profile.palette,
      calibrationProfileId: profile.id,
      calibrationProfileName: profile.name,
      achromaticChromaMax: DEFAULT_DEBUG_QUANTIZE.achromaticChromaMax
    }
  },

  // 上传彩条测试图：不依赖任何图片，数据尺寸天然正确，最适合首次验证图传链路是否打通
  cmdUploadTest() {
    if (!this.ensureUploadReady()) {
      return
    }
    const info = this.data.info
    const frame = imageCodec.buildColorBars(info.width, info.height)
    this.uploadFrame(frame, '上传彩条测试图(0x20~0x22)')
  },

  // 上传相册里选的图片：把图片画到目标尺寸 canvas → 量化成六色帧缓存 → 走图传协议上传
  async cmdUploadAlbum() {
    if (!this.ensureUploadReady()) {
      return
    }
    const info = this.data.info
    let media
    try {
      media = await new Promise((resolve, reject) => {
        // sizeType 取 'original'：拿原图而不是微信压缩过的低清版。'compressed' 会先被微信降分辨率+重压一遍，
        // 是「上屏发糊」最大的源头(APP 走的就是原图)。原图偏大时由下面 shrinkIfHuge 仅做防 OOM 的轻量预缩。
        wx.chooseMedia({ count: 1, mediaType: ['image'], sizeType: ['original'], success: resolve, fail: reject })
      })
    } catch (error) {
      return // 用户取消选择
    }
    const tempPath = media.tempFiles[0].tempFilePath

    wx.showLoading({ title: '转换图片中', mask: true })
    let frame
    try {
      // 大图先按比例压一遍再解码：超大原图(几千万像素)在离屏 canvas 全分辨率解码时易内存吃紧/失败。
      // 注意：这步只为让解码更稳，不改变上传量——上传的是定长六色帧缓存(宽×高÷2)，与原图大小无关。
      const srcPath = await this.shrinkIfHuge(tempPath, info.width, info.height)
      const cropMode = this.data.cropMode === 'contain' ? 'contain' : 'cover'
      const quantize = this.getDebugQuantizeOptions()
      const decoded = await this.imageToImageData(srcPath, info.width, info.height, cropMode)
      const imageData = decoded.imageData
      if (decoded.resampleLog) {
        this.appendLog({ type: 'act', text: decoded.resampleLog })
      }
      this.appendLog({
        type: 'act',
        text: `调试页色准量化：${quantize.calibrationProfileName} / ${quantize.distanceMetric} / 裁剪${cropMode} / 抖动${quantize.dither ? '开' : '关'} / 对比度${quantize.contrast.toFixed(2)} / 饱和度${quantize.saturation.toFixed(2)} / 低饱和保护≤${quantize.achromaticChromaMax}`
      })
      frame = fromImageDataWithDebugCalibration(imageData, info.width, info.height, quantize)
    } catch (error) {
      wx.hideLoading()
      wx.showToast({ title: '图片转换失败：' + error.message, icon: 'none' })
      return
    }
    wx.hideLoading()
    this.uploadFrame(frame, '上传相册图片(0x20~0x22)')
  },

  // 上传前置检查：必须已连接且已读到设备信息（拿到屏幕尺寸/容量/掩码才能组帧头、选槽位）
  ensureUploadReady() {
    if (!this.requireDevice()) {
      return false
    }
    if (this.data.busy || this.data.uploading) {
      wx.showToast({ title: '请等待当前操作完成', icon: 'none' })
      return false
    }
    if (!this.data.info || !this.data.info.width) {
      wx.showToast({ title: '请先点「获取设备信息」', icon: 'none' })
      return false
    }
    if (this.data.info.screenType === 0x03) {
      wx.showToast({ title: '7.3寸为占位型号，固件未实现图传', icon: 'none' })
      return false
    }
    return true
  },

  computeAppLikeSample(width, height, targetW, targetH) {
    let sample = 1
    while (width / (sample * 2) >= targetW && height / (sample * 2) >= targetH) {
      sample *= 2
    }
    return sample
  },

  setupImageSmoothing(ctx) {
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
  },

  createResizeCanvas(width, height) {
    const canvas = wx.createOffscreenCanvas({
      type: '2d',
      width: Math.max(1, Math.round(width)),
      height: Math.max(1, Math.round(height))
    })
    const ctx = canvas.getContext('2d')
    this.setupImageSmoothing(ctx)
    return { canvas, ctx }
  },

  getImageDrawPlan(iw, ih, width, height, cropMode) {
    if (cropMode === 'contain') {
      const scale = Math.min(width / iw, height / ih)
      const dw = iw * scale
      const dh = ih * scale
      return {
        sx: 0,
        sy: 0,
        sw: iw,
        sh: ih,
        dx: (width - dw) / 2,
        dy: (height - dh) / 2,
        dw,
        dh
      }
    }
    // 中心裁剪「覆盖」：先算目标画布在原图上的等比例取样区域，再分阶段缩到目标尺寸。
    // 对正常照片这与 APP 的「先缩放整图再居中裁剪」等价；对超宽/超高图则避免创建超大中间画布。
    const scale = Math.max(width / iw, height / ih)
    const sw = width / scale
    const sh = height / scale
    return {
      sx: (iw - sw) / 2,
      sy: (ih - sh) / 2,
      sw,
      sh,
      dx: 0,
      dy: 0,
      dw: width,
      dh: height
    }
  },

  drawImageResampled(ctx, image, plan) {
    let source = image
    let sx = plan.sx
    let sy = plan.sy
    let sw = plan.sw
    let sh = plan.sh
    const finalW = Math.max(1, Math.round(plan.dw))
    const finalH = Math.max(1, Math.round(plan.dh))
    const stages = []

    while (sw > finalW * 2 || sh > finalH * 2 || Math.max(sw, sh) > DEBUG_RESAMPLE.maxStageEdge) {
      const maxEdge = Math.max(sw, sh)
      const capScale = maxEdge > DEBUG_RESAMPLE.maxStageEdge ? DEBUG_RESAMPLE.maxStageEdge / maxEdge : 1
      const stepScale = Math.min(DEBUG_RESAMPLE.stageScale, capScale)
      const nextW = Math.max(finalW, Math.round(sw * stepScale))
      const nextH = Math.max(finalH, Math.round(sh * stepScale))
      if (nextW >= Math.round(sw) && nextH >= Math.round(sh)) {
        break
      }

      const stage = this.createResizeCanvas(nextW, nextH)
      stage.ctx.clearRect(0, 0, nextW, nextH)
      stage.ctx.drawImage(source, sx, sy, sw, sh, 0, 0, nextW, nextH)
      stages.push(`${Math.round(sw)}×${Math.round(sh)}→${nextW}×${nextH}`)

      source = stage.canvas
      sx = 0
      sy = 0
      sw = nextW
      sh = nextH
    }

    ctx.drawImage(source, sx, sy, sw, sh, plan.dx, plan.dy, plan.dw, plan.dh)
    return stages
  },

  // 大图预采样：模拟 APP Android 端 BitmapFactory.inSampleSize 的 power-of-two 下采样。
  // 小程序不能直接控制解码采样，只能用 compressImage 生成一个接近 inSampleSize 后尺寸的临时图。
  // 这样比按固定长边硬压更接近 APP：普通图保持原图；超大图只降到「仍大于目标」的 2 的倍数。
  // 任何环节失败（老版本不支持 / 取不到尺寸 / 压缩报错）都退回用原图，绝不阻断上传。
  shrinkIfHuge(path, targetW, targetH) {
    return new Promise(resolve => {
      if (!wx.compressImage) {
        resolve(path) // 基础库过老不支持 compressImage，直接用原图，后续分阶段 canvas 缩放兜底
        return
      }
      wx.getImageInfo({
        src: path,
        success: ({ width, height }) => {
          const sample = this.computeAppLikeSample(width, height, targetW, targetH)
          if (sample <= 1) {
            resolve(path) // APP 也不会下采样的尺寸，直接保留原图细节
            return
          }
          const compressedWidth = Math.max(targetW, Math.round(width / sample))
          const compressedHeight = Math.max(targetH, Math.round(height / sample))
          wx.compressImage({
            src: path,
            compressedWidth,
            compressedHeight,
            quality: DEBUG_RESAMPLE.predecodeQuality,
            success: res => {
              this.appendLog({ type: 'act', text: `APP式预采样：原图 ${width}×${height}，sample=${sample}，预解码约 ${compressedWidth}×${compressedHeight}` })
              resolve(res.tempFilePath)
            },
            fail: () => resolve(path) // 压缩失败退回原图
          })
        },
        fail: () => resolve(path) // 取尺寸失败退回原图
      })
    })
  },

  // 用离屏 canvas 把图片解码并缩放到目标尺寸，取出 RGBA 像素（ImageData）
  imageToImageData(path, width, height, cropMode) {
    return new Promise((resolve, reject) => {
      if (!wx.createOffscreenCanvas) {
        reject(new Error('当前微信版本不支持离屏 canvas'))
        return
      }
      const canvas = wx.createOffscreenCanvas({ type: '2d', width, height })
      const ctx = canvas.getContext('2d')
      this.setupImageSmoothing(ctx)
      const img = canvas.createImage()
      img.onload = () => {
        ctx.clearRect(0, 0, width, height)
        const iw = img.width || width
        const ih = img.height || height
        const plan = this.getImageDrawPlan(iw, ih, width, height, cropMode)
        let stages = []
        let fallbackLog = ''
        try {
          ctx.clearRect(0, 0, width, height)
          if (cropMode === 'contain') {
            ctx.fillStyle = '#fff'
            ctx.fillRect(0, 0, width, height)
          }
          try {
            stages = this.drawImageResampled(ctx, img, plan)
          } catch (resampleError) {
            ctx.clearRect(0, 0, width, height)
            if (cropMode === 'contain') {
              ctx.fillStyle = '#fff'
              ctx.fillRect(0, 0, width, height)
            }
            ctx.drawImage(img, plan.sx, plan.sy, plan.sw, plan.sh, plan.dx, plan.dy, plan.dw, plan.dh)
            fallbackLog = `APP式分阶段缩放不可用，已退回单步缩放：${resampleError.message || resampleError}`
          }
          const imageData = ctx.getImageData(0, 0, width, height)
          const sourceText = `${Math.round(plan.sw)}×${Math.round(plan.sh)}`
          const targetText = `${Math.round(plan.dw)}×${Math.round(plan.dh)}`
          const resampleLog = fallbackLog || (stages.length
            ? `APP式分阶段缩放：原图 ${iw}×${ih}，${cropMode} 取样 ${sourceText} → ${stages.join(' → ')} → ${targetText}`
            : `APP式缩放：原图 ${iw}×${ih}，${cropMode} 取样 ${sourceText} → ${targetText}`)
          resolve({ imageData, resampleLog })
        } catch (error) {
          reject(error)
        }
      }
      img.onerror = () => reject(new Error('图片解码失败'))
      img.src = path
    })
  },

  // 图传前置诊断：把连接间隔设到目标值并复读确认（0x05 读 → 0x13 设 → 0x05 复读）。
  // 这一步专门用来区分两类「停在第N包」的根因：
  //   ① 连接间隔指令根本没生效（设备不支持 / 0x13 被拒 / 设了复读没变）；
  //   ② 间隔已确认生效，仍卡住 → 就是「设备吃不下这个速率」，该动的是 pace/窗口而非连接参数。
  // 返回 { category, verdict, before, after }，全过程同步打到控制台日志。
  // category: 'unsupported'(读不到0x05) / 'rejected'(0x13被拒) / 'not-applied'(设了没变) /
  //           'unconfirmed'(设了但复读失败) / 'applied'(已确认生效)
  async applyAndVerifyConnInterval(targetMs) {
    const deviceId = this.data.deviceId
    const targetUnits = protocol.connectionIntervalMsToUnits(targetMs)

    // 1) 传前读当前连接间隔（0x05）。读不到 → 这台固件没有连接间隔能力，提速只能靠 pace。
    let before
    try {
      before = await deviceBle.getConnectionInterval(deviceId)
      this.appendLog({ type: 'act', text: `图传前 连接间隔(0x05)=${before.ms}ms · units=${before.units}` })
    } catch (error) {
      const verdict = `设备不支持读取连接间隔(0x05)：${error.message}`
      this.appendLog({ type: 'err', text: verdict })
      return { category: 'unsupported', verdict, before: null, after: null }
    }

    // 2) 设到目标值（0x13）。被拒（0x08 不支持 / 0x0B 忙等）→ 连接间隔没生效。
    try {
      await deviceBle.setConnectionInterval(deviceId, targetUnits)
    } catch (error) {
      const verdict = `设置连接间隔(0x13)被拒：${error.message}`
      this.appendLog({ type: 'err', text: verdict })
      return { category: 'rejected', verdict, before, after: null }
    }

    // 3) 复读确认设备是否「真的」应用了（0x05）。这是判定「生效 vs 没生效」最可靠的一步。
    let after
    try {
      after = await deviceBle.getConnectionInterval(deviceId)
      this.setData({ connInterval: after, connIntervalInput: String(after.ms) })
    } catch (error) {
      const verdict = `已发 0x13 设为 ${targetMs}ms，但复读(0x05)失败：${error.message}`
      this.appendLog({ type: 'act', text: verdict })
      return { category: 'unconfirmed', verdict, before, after: null }
    }

    if (after.units === targetUnits) {
      const verdict = `连接间隔已生效：${before.ms}ms → ${after.ms}ms（units=${after.units}）`
      this.appendLog({ type: 'ok', text: verdict })
      return { category: 'applied', verdict, before, after }
    }
    const verdict = `连接间隔未实际应用：请求 ${targetMs}ms(units=${targetUnits})，复读仍为 ${after.ms}ms(units=${after.units})`
    this.appendLog({ type: 'err', text: verdict })
    return { category: 'not-applied', verdict, before, after }
  },

  // 把连接间隔诊断分类翻成「下一步该怎么办」，附到图传失败提示里，直接给出可执行结论。
  connDiagConclusion(category) {
    switch (category) {
      case 'applied':
        return '连接间隔已确认生效仍卡住 → 基本可判定是「设备吃不下这个速率」：把发送速度调慢一档（pace 调大）后重试，问题不在连接参数。'
      case 'not-applied':
        return '设备对 0x13 回了成功但复读没变 → 连接间隔实际没生效：先查固件 0x13 是否真正更新链路参数，再谈速率。'
      case 'rejected':
        return '0x13 被拒（不支持/忙）→ 连接间隔没生效：先解决 0x13 设置，或只靠 pace/窗口调速。'
      case 'unsupported':
        return '设备不支持连接间隔指令(0x05) → 用不了它提速：只能靠 pace（每包间隔）/窗口来调。'
      case 'unconfirmed':
        return '设了 0x13 但复读失败，无法确认是否生效：建议重连后手动点「获取连接间隔(0x05)」核对。'
      default:
        return ''
    }
  },

  // 执行一次图传：挑槽位 → 调 device-ble.uploadImage（内部走 0x20→0x21窗口→0x22）→ 自动刷新显示这张
  async uploadFrame(frame, label) {
    const info = this.data.info
    // 槽位：输入框优先；留空则自动选第一个空闲位
    let index
    if (this.data.uploadIndexInput !== '') {
      index = Number(this.data.uploadIndexInput)
      if (!Number.isInteger(index) || index < 0 || index >= info.capacity) {
        wx.showToast({ title: `槽位需在 0~${info.capacity - 1}`, icon: 'none' })
        return
      }
    } else {
      index = protocol.firstFreeIndex(info.imgMask, info.capacity)
      if (index < 0) {
        wx.showToast({ title: '设备已存满，请先删除图片', icon: 'none' })
        return
      }
    }

    const totalPackets = Math.ceil(frame.dataSize / 236)
    this._uploadAborted = false // 重置中止标记
    // 上传期间保持屏幕常亮：避免自动息屏导致蓝牙被挂起、传输中断
    wx.setKeepScreenOn && wx.setKeepScreenOn({ keepScreenOn: true })
    this.setData({
      uploading: true,
      uploadPercent: 0,
      uploadStatus: `传输中：槽位 ${index}，共 ${totalPackets} 包…（请保持屏幕常亮，勿锁屏/切后台）`,
      uploadStatusType: 'info'
    })
    this.appendLog({ type: 'act', text: `${label} → 槽位 ${index}，数据 ${frame.dataSize} 字节 / ${totalPackets} 包` })

    // 图传前：按「连接间隔」输入框的值把链路间隔设好并复读确认。卡住时据此区分
    // 「连接间隔没生效」还是「设备吃不下速率」（结论见 applyAndVerifyConnInterval / connDiagConclusion）。
    let connDiag = null
    const targetMs = Number(this.data.connIntervalInput)
    const targetUnits = protocol.connectionIntervalMsToUnits(targetMs)
    if (Number.isFinite(targetMs) && targetMs > 0 &&
        targetUnits >= protocol.CONN_INTERVAL_MIN_UNITS && targetUnits <= protocol.CONN_INTERVAL_MAX_UNITS) {
      connDiag = await this.applyAndVerifyConnInterval(targetMs)
    }

    try {
      const summary = await deviceBle.uploadImage(this.data.deviceId, {
        screenType: info.screenType,
        index,
        width: info.width,
        height: info.height,
        data: frame.data,
        pace: this.data.pace, // 发送速度（每包间隔 ms），由页面"发送速度"档位决定
        shouldAbort: () => this._uploadAborted, // 息屏/切后台时由 onHide 置为 true
        onProgress: (done, total, phase, detail) => {
          const patch = { uploadPercent: Math.floor((done / total) * 100) }
          if (phase === 'retry' && detail) {
            // 卡顿重试：把「停在第几包、重发第几次」实时显示出来。
            // 若 stuckAt 长时间不变 → 多为设备中断/链路断；若缓慢变大 → 只是慢，可能还能传完。
            patch.uploadStatus = `传输卡顿：停在第 ${detail.stuckAt} 包，正第 ${detail.retries} 次重发…（此数字若长时间不动，基本是设备侧中断或链路问题）`
            patch.uploadStatusType = 'info'
          } else {
            patch.uploadStatus = `传输中：${done}/${total} 包`
            patch.uploadStatusType = 'info'
          }
          this.setData(patch)
        }
      })
      const okText = `图传完成 ✓ 设备现存 ${summary.imgCount} 张，剩余 ${summary.storageFree} 字节`
      this.appendLog({ type: 'ok', text: okText })
      this.setData({ uploadStatus: okText, uploadStatusType: 'ok' })
      // 传完顺手刷新屏幕显示这张，便于直接在屏上确认
      await deviceBle.refreshScreen(this.data.deviceId, index)
      await this.refreshInfoSilently()
      wx.showToast({ title: '上传成功', icon: 'none' })
    } catch (error) {
      // 失败原因常驻显示在页面上（可长按复制），不用去翻一闪而过的弹窗
      // 只要期间发生过息屏/切后台(_uploadAborted)，无论报的是中止还是写失败，都按"息屏中断"提示
      const aborted = this._uploadAborted || (error && error.message === 'UPLOAD_ABORTED')
      let text = aborted
        ? '图传已中断：上传时手机息屏/切到后台，蓝牙在后台会暂停、设备也会超时。请保持屏幕常亮后重新上传。'
        : `图传失败：${error.message}`
      // 非息屏类失败：把图传前的连接间隔诊断结论拼上，直接告诉是「没生效」还是「吃不下速率」。
      if (!aborted && connDiag) {
        text += `\n连接间隔诊断：${connDiag.verdict}\n→ ${this.connDiagConclusion(connDiag.category)}`
      }
      this.appendLog({ type: 'err', text })
      this.setData({ uploadStatus: text, uploadStatusType: 'err' })
    } finally {
      this.setData({ uploading: false })
      wx.setKeepScreenOn && wx.setKeepScreenOn({ keepScreenOn: false }) // 传输结束恢复正常息屏
    }
  },

  goBack() {
    const pages = getCurrentPages()
    if (pages.length > 1) {
      wx.navigateBack()
      return
    }
    wx.switchTab({ url: '/pages/home/home' })
  }
})
