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
const toast = require('../../../utils/toast')
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
const DEBUG_CALIBRATION_PROFILES = DEBUG_CALIBRATION_PROFILE_SOURCE.map(
  profile =>
    Object.assign({}, profile, {
      palette: withLabPalette(profile.palette)
    })
)
const DEBUG_CALIBRATION_PROFILE_OPTIONS = DEBUG_CALIBRATION_PROFILES.map(
  profile => profile.name
)
const DEBUG_DISTANCE_RGB = 'APP RGB 欧氏距离'
const DEBUG_DISTANCE_LAB = 'Lab ΔE76'
const DEFAULT_DEBUG_PROFILE_ID = 'app-6color'
const DEFAULT_DEBUG_PROFILE_INDEX = Math.max(
  0,
  DEBUG_CALIBRATION_PROFILES.findIndex(
    profile => profile.id === DEFAULT_DEBUG_PROFILE_ID
  )
)
const DEFAULT_DEBUG_PROFILE =
  DEBUG_CALIBRATION_PROFILES[DEFAULT_DEBUG_PROFILE_INDEX]

const DEFAULT_DEBUG_QUANTIZE = {
  dither: true,
  ditherStrength: 1,
  contrast: 1.12,
  saturation: 1.28,
  // 默认先和 Flutter APP 端 FrameImageCodec.fromRgba 对齐：RGB 最近色 + 完整 Floyd 抖动。
  distanceMetric: DEBUG_DISTANCE_RGB,
  // <0 表示关闭。APP 端没有低饱和黑白保护；需要色准实验时再打开。
  achromaticChromaMax: -1
}

const DEBUG_RESAMPLE = {
  predecodeQuality: 96,
  maxStageEdge: 2048,
  stageScale: 0.5
}

function clamp255(v) {
  return v < 0 ? 0 : v > 255 ? 255 : v
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
  return v > 0.008856 ? Math.pow(v, 1 / 3) : 7.787 * v + 16 / 116
}

function rgbToLab(r, g, b) {
  const lr = srgbToLinear(r)
  const lg = srgbToLinear(g)
  const lb = srgbToLinear(b)
  const x = (0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb) / 0.95047
  const y = (0.2126729 * lr + 0.7151522 * lg + 0.072175 * lb) / 1.0
  const z = (0.0193339 * lr + 0.119192 * lg + 0.9503041 * lb) / 1.08883
  const fx = xyzPivot(x)
  const fy = xyzPivot(y)
  const fz = xyzPivot(z)
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}

function labDistance(lab, entry) {
  const [pl, pa, pb] = entry.lab
  const dl = lab[0] - pl
  const da = lab[1] - pa
  const db = lab[2] - pb
  return dl * dl + da * da + db * db
}

function withLabPalette(palette) {
  return palette.map(entry =>
    Object.assign({}, entry, {
      lab: rgbToLab(entry.rgb[0], entry.rgb[1], entry.rgb[2])
    })
  )
}

function findDebugCalibrationProfile(id) {
  return DEBUG_CALIBRATION_PROFILES.find(profile => profile.id === id) || null
}

// 把单个 0~255 通道值解析并钳位：非法/空串按 0 处理（用于把输入框字符串转成可计算的整数）。
function clampChannelInput(v) {
  const n = Math.round(Number(v))
  return Number.isFinite(n) ? clamp255(n) : 0
}

// 调色板(含 rgb 数组) → 页面可编辑的六色行 {nibble,name,r,g,b,css}。
// r/g/b 用字符串绑定输入框；css 为色块预览背景（按当前值实时算）。nibble 严格沿用协议编码值，不可改。
function paletteToCustomColors(palette) {
  return palette.map(entry => {
    const r = clampChannelInput(entry.rgb[0])
    const g = clampChannelInput(entry.rgb[1])
    const b = clampChannelInput(entry.rgb[2])
    return {
      nibble: entry.nibble,
      name: entry.name,
      r: String(r),
      g: String(g),
      b: String(b),
      css: `rgb(${r}, ${g}, ${b})`
    }
  })
}

// 页面可编辑的六色行 → 带 lab 的调色板（供调试页量化 / 同步投屏使用）。非法通道按 0 处理。
function customColorsToPalette(customColors) {
  return customColors.map(entry => {
    const rgb = [
      clampChannelInput(entry.r),
      clampChannelInput(entry.g),
      clampChannelInput(entry.b)
    ]
    return {
      nibble: entry.nibble,
      name: entry.name,
      rgb,
      lab: rgbToLab(rgb[0], rgb[1], rgb[2])
    }
  })
}

function nearestDebugPaletteIndex(r, g, b, settings) {
  const palette = settings.palette || DEFAULT_DEBUG_PROFILE.palette
  const useAchromaticGuard =
    Number.isFinite(settings.achromaticChromaMax) &&
    settings.achromaticChromaMax >= 0
  if (settings.distanceMetric !== DEBUG_DISTANCE_LAB) {
    const rr = Number(r) || 0
    const gg = Number(g) || 0
    const bb = Number(b) || 0
    const chroma =
      Math.max(clamp255(rr), clamp255(gg), clamp255(bb)) -
      Math.min(clamp255(rr), clamp255(gg), clamp255(bb))
    const paletteLength =
      useAchromaticGuard && chroma <= settings.achromaticChromaMax
        ? 2
        : palette.length
    let best = 0
    let bestDist = Infinity
    for (let i = 0; i < paletteLength; i++) {
      const [pr, pg, pb] = palette[i].rgb
      const dr = rr - pr
      const dg = gg - pg
      const db = bb - pb
      const dist = dr * dr + dg * dg + db * db
      if (dist < bestDist) {
        bestDist = dist
        best = i
      }
    }
    return best
  }
  const cr = clamp255(r)
  const cg = clamp255(g)
  const cb = clamp255(b)
  const chroma = Math.max(cr, cg, cb) - Math.min(cr, cg, cb)
  const paletteLength =
    useAchromaticGuard && chroma <= settings.achromaticChromaMax
      ? 2
      : palette.length
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

// screenType：透传给打包层，3.7寸(EF6-370)按「横向源图」布局打包（见 image-codec.buildScreenFrameBytes）。
function fromImageDataWithDebugCalibration(
  imageData,
  width,
  height,
  options,
  screenType
) {
  const settings = Object.assign({}, DEFAULT_DEBUG_QUANTIZE, options || {})
  const palette = settings.palette || DEFAULT_DEBUG_PROFILE.palette
  const px = imageData.data
  const count = width * height
  const nibbles = new Uint8Array(count)

  if (!settings.dither) {
    for (let i = 0; i < count; i++) {
      const [r, g, b] = enhanceDebugPixel(
        px[i * 4],
        px[i * 4 + 1],
        px[i * 4 + 2],
        settings
      )
      nibbles[i] = palette[nearestDebugPaletteIndex(r, g, b, settings)].nibble
    }
    const data = imageCodec.buildScreenFrameBytes(
      nibbles,
      width,
      height,
      screenType
    )
    return { data, width, height, dataSize: data.length }
  }

  const buf = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    const [r, g, b] = enhanceDebugPixel(
      px[i * 4],
      px[i * 4 + 1],
      px[i * 4 + 2],
      settings
    )
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
      const er = (r - pr) * settings.ditherStrength
      const eg = (g - pg) * settings.ditherStrength
      const eb = (b - pb) * settings.ditherStrength
      spreadDebugError(buf, x + 1, y, width, height, er, eg, eb, 7 / 16)
      spreadDebugError(buf, x - 1, y + 1, width, height, er, eg, eb, 3 / 16)
      spreadDebugError(buf, x, y + 1, width, height, er, eg, eb, 5 / 16)
      spreadDebugError(buf, x + 1, y + 1, width, height, er, eg, eb, 1 / 16)
    }
  }

  const data = imageCodec.buildScreenFrameBytes(
    nibbles,
    width,
    height,
    screenType
  )
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

    // 小程序全局 BLE 连接状态（不只看本页：真实投屏/绑定等流程留下的未释放会话也会在这里出现）
    mpConnected: false, // 小程序当前是否持有任意一条 BLE 连接（设备被占用）
    mpConnections: [], // 每条存活会话的设备信息（deviceId/MTU/写类型等）

    // 设备信息（0x01 读回后填充）
    info: null,
    connInterval: null,
    firmwareVersion: '', // 当前页面已读取到的软件/固件版本（0x03）
    existingIndexes: '', // 设备上已有图片的索引列表，便于决定删哪张/传到哪
    autoUploadIndex: -1, // 自动挑选的空闲槽位

    // 指令输入框
    playMode: 'order', // 'order' 顺序 / 'random' 随机
    intervalInput: '60', // 切换间隔(秒)
    connIntervalInput: '7.5', // BLE 连接间隔(ms)，协议会换算为 1.25ms 单位（7.5ms=6单位，协议最小值）
    projectionConnIntervalMs: 7.5, // 真实投屏图传前要设的连接间隔(ms)，由「同步投屏」写入，onLoad 时回显
    projectionPaceMs: 3, // 真实投屏图传每包发送间隔(ms)，由「同步投屏」写入，onLoad 时回显
    projectionWindow: 10, // 真实投屏图传窗口包数，由「同步投屏」写入，onLoad 时回显
    switchInput: '0', // 0x24 要显示的图片索引
    deleteInput: '', // 0x12 要删除的图片索引，逗号分隔，如 "0,2"
    uploadIndexInput: '', // 上传槽位，留空则自动选空闲位
    pace: 3, // 图传每包发送间隔(ms)，越小越快；默认极速档，与真实投屏同步；卡住就往「稳」退一档
    windowSize: 10, // 图传窗口(发满多少包等一次累计应答)。固件扩内存后默认 10，可切 5 做对照
    cropMode: 'cover', // cover 与 APP centerCropCover 对齐；contain 用白底完整显示原图
    debugResizeMode: 'staged', // staged=当前分阶段缩放；single=APP对照用单步 drawImage 缩放
    debugSkipCompressImage: false, // 开启后跳过 wx.compressImage，直接用 chooseMedia 原图进 canvas 解码
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
    // 自定义六色：套餐只是「一键回填」的预设，真正参与量化/同步的是下面这份可逐项编辑的 RGB。
    customColors: paletteToCustomColors(DEFAULT_DEBUG_PROFILE.palette),

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

    // 回显当前真实投屏要用的传输参数（同步过则是同步值，否则用默认：连接间隔 7.5ms / pace 3ms / 窗口 10 包），
    // 让调试台的输入/档位与真实投屏保持一致——调试台看到的就是投屏会用的值。
    const projectionConnIntervalMs = deviceBle.getTransferConnIntervalMs()
    const projectionPaceMs = deviceBle.getTransferPaceMs()
    const projectionWindow = deviceBle.getTransferWindow()
    this.setData({
      projectionConnIntervalMs,
      connIntervalInput: String(projectionConnIntervalMs),
      projectionPaceMs,
      pace: projectionPaceMs,
      projectionWindow,
      windowSize: projectionWindow
    })

    // 注册监听器：device-ble 每发送/接收一帧都会回调这里，把 16 进制打到控制台
    deviceBle.setMonitor(record => this.onMonitorFrame(record))

    // 进页面先照一次小程序全局连接状态：若真实业务流程留了残留连接占着设备，这里能立刻看到
    this.refreshMpConnections()

    // 从绑定页跳进来时会带 id/name，直接连接；否则停在「扫描」状态让用户自己挑设备
    if (options && options.id) {
      this.setData({
        deviceId: options.id,
        deviceName: decodeURIComponent(options.name || '') || options.id
      })
      this.connect()
    }
  },

  // 每次回到页面都重新核对小程序全局连接状态：从真实投屏页跳回时，能看到那边是否还占着设备
  onShow() {
    this.refreshMpConnections()
  },

  onUnload() {
    deviceBle.setMonitor(null) // 取消监听，避免离开页面后还在往已销毁的页面 setData
    bluetooth.stopDiscovery()
    wx.setKeepScreenOn && wx.setKeepScreenOn({ keepScreenOn: false }) // 离开页面恢复正常息屏
    // 离开调试页不再主动断开：按用户要求保持连接（非手动/物理断开就一直连着）。
    // 需要断开时用页面上的「断开连接」按钮(disconnectDevice)。
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
    if (
      record.cmd === protocol.CMD.IMG_DATA ||
      record.cmd === protocol.CMD.IMG_ACK
    ) {
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

  // ── 小程序全局连接状态 ──────────────────────────────────
  // 刷新「小程序连接状态」模块：读 device-ble 里真实存活的会话（不只本页）。
  // 设备是单连接，若真实业务(投屏/绑定)流程结束没断开，这里会显示残留会话——它正占着设备，
  // 导致再次「搜索/连接」搜不到/连不上。可用模块里的「断开全部」释放。
  refreshMpConnections() {
    const connections = deviceBle.getActiveConnections().map(conn => ({
      deviceId: conn.deviceId,
      shortId: String(conn.deviceId || '').slice(-8) || conn.deviceId, // deviceId 很长，只显示末段便于辨认
      name: conn.deviceId === this.data.deviceId ? this.data.deviceName : '', // 仅本页连的设备才知道名字
      isCurrent: conn.deviceId === this.data.deviceId,
      mtu: conn.mtu,
      dataChunk: conn.dataChunk,
      writeType: conn.writeType === 'write' ? '有应答写' : '无应答写'
    }))
    this.setData({
      mpConnected: connections.length > 0,
      mpConnections: connections
    })
  },

  // 断开小程序当前持有的全部 BLE 会话，释放被占用的设备（让它重新广播，能再次被搜索/连接）。
  disconnectAllConnections() {
    const ids = deviceBle.disconnectAll()
    if (!ids.length) {
      toast.warn({ title: '当前没有已连接的设备', icon: 'none' })
      this.refreshMpConnections()
      return
    }
    // 若断的是本页正在用的设备，同步本页连接态，避免上方还显示「已连接」
    if (ids.indexOf(this.data.deviceId) > -1) {
      this.setData({ connected: false, info: null, connInterval: null })
    }
    this.appendLog({
      type: 'act',
      text: `已断开全部连接（${ids.length} 个），设备已释放，可重新搜索/连接`
    })
    toast.show({ title: `已释放 ${ids.length} 个连接`, icon: 'none' })
    this.refreshMpConnections()
  },

  // ── 连接 / 扫描 ─────────────────────────────────────────
  requireDevice() {
    if (!this.data.deviceId || !this.data.connected) {
      toast.warn({ title: '请先连接设备', icon: 'none' })
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
        toast.warn({ title: '请先授权定位', icon: 'none' })
        return
      }
      await bluetooth.openAdapter()
      // 调试页放开白名单(allowAll)：收录附近所有蓝牙设备，便于核对相框真实广播名/排查搜不到的问题
      const devices = await bluetooth.discoverDevices({
        timeout: 8000,
        allowAll: true
      })
      this.setData({ devices })
      this.appendLog({
        type: 'act',
        text: `扫描完成（已放开过滤），发现 ${devices.length} 个设备`
      })
      // 逐个打印名字+信号，方便和白名单 EF6-370 / EF6-589 对照，确认设备到底叫什么
      devices.forEach(device => {
        this.appendLog({
          type: 'act',
          text: `· ${device.name}（信号 ${device.RSSI || '--'}，id 末段 ${String(device.deviceId || '').slice(-5)}）`
        })
      })
      if (!devices.length) {
        bluetooth.showEmptyResultGuide() // 鸿蒙兼容兜底：搜不到时给鸿蒙用户排查引导
      }
    } catch (error) {
      // 系统级「附近设备」权限被拒：弹引导去系统设置
      if (error.code === 'PERMISSION_DENIED') {
        bluetooth.showPermissionGuide()
      } else {
        toast.warn({ title: error.message || '扫描失败', icon: 'none' })
      }
    } finally {
      this.setData({ scanning: false })
    }
  },

  // 选中某个扫描结果并连接
  selectDevice(e) {
    const id = e.currentTarget.dataset.id
    const device = this.data.devices.find(
      item => item.id === id || item.deviceId === id
    )
    if (!device) {
      return
    }
    this.setData({
      deviceId: device.deviceId,
      deviceName: device.name || device.deviceId,
      info: null,
      connInterval: null,
      firmwareVersion: ''
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
      this.refreshMpConnections() // 连接后同步「小程序连接状态」模块
      this.appendLog({ type: 'ok', text: `已连接：${this.data.deviceName}` })
      // MTU 决定图传每包能塞多少字节，连接后打出来便于排查图传问题
      const writeTypeText =
        session.writeType === 'write' ? '有应答写(可靠)' : '无应答写'
      this.appendLog({
        type: 'act',
        text: `协商 MTU=${session.mtu} 字节，图传每包数据 ${session.dataChunk} 字节，写入方式：${writeTypeText}`
      })
      await this.refreshInfoSilently()
      this.loadSavedCalibrationProfile()
      await this.refreshConnectionIntervalSilently()
    } catch (error) {
      this.setData({ connected: false })
      this.appendLog({ type: 'err', text: `连接失败：${error.message}` })
      toast.warn({ title: error.message || '连接失败', icon: 'none' })
    } finally {
      this.setData({ connecting: false })
    }
  },

  disconnectDevice() {
    if (this.data.deviceId) {
      deviceBle.disconnect(this.data.deviceId)
    }
    this.setData({
      connected: false,
      info: null,
      connInterval: null,
      firmwareVersion: ''
    })
    this.refreshMpConnections() // 断开后同步「小程序连接状态」模块
    this.appendLog({ type: 'act', text: '已断开连接' })
  },

  // 静默读取设备信息并刷新信息卡片（被各指令成功后调用，用来同步最新掩码/电量）
  async refreshInfoSilently() {
    try {
      const info = await deviceBle.readDeviceInfo(this.data.deviceId)
      const indexes = protocol.maskToIndexes(info.imgMask)
      this.setData({
        info,
        firmwareVersion: info.firmwareVersion || '',
        existingIndexes: indexes.length ? indexes.join(', ') : '无',
        autoUploadIndex: protocol.firstFreeIndex(info.imgMask, info.capacity)
      })
    } catch (error) {
      // 读取失败不阻断主流程
    }
  },

  async refreshConnectionIntervalSilently() {
    try {
      const connInterval = await deviceBle.getConnectionInterval(
        this.data.deviceId
      )
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
      toast.warn({ title: '请等待上一条指令完成', icon: 'none' })
      return
    }
    this.setData({ busy: true })
    this.appendLog({ type: 'act', text: `点击：${label}` })
    try {
      const result = await fn()
      const text =
        options && options.format ? options.format(result) : `${label} 成功`
      this.appendLog({ type: 'ok', text })
      if (options && options.refresh) {
        await this.refreshInfoSilently()
      }
      toast.show({ title: '指令成功', icon: 'none' })
      return result
    } catch (error) {
      this.appendLog({ type: 'err', text: `${label} 失败：${error.message}` })
      toast.warn({ title: error.message || '指令失败', icon: 'none' })
    } finally {
      this.setData({ busy: false })
    }
  },

  // ── 读取类指令 ──────────────────────────────────────────
  cmdGetInfo() {
    this.runCommand(
      '获取设备信息(0x01)',
      async () => {
        await this.refreshInfoSilently()
        const info = this.data.info
        return info
      },
      {
        format: info =>
          info
            ? `设备信息：Device_ID ${info.deviceId || '--'} · 电量 ${info.battery}% · ${info.screen} · 容量 ${info.capacity} · 已存 ${info.imgCount} 张 · 固件 ${info.firmwareVersion || '--'}`
            : '设备信息已刷新'
      }
    )
  },

  cmdGetPlay() {
    this.runCommand(
      '获取播放配置(0x02)',
      () => deviceBle.getPlayConfig(this.data.deviceId),
      {
        format: cfg =>
          `播放配置：${this.playModeText(cfg.playMode)} · 间隔 ${cfg.intervalSeconds} 秒`
      }
    )
  },

  async cmdGetVersion() {
    const firmwareVersion = await this.runCommand(
      '获取软件版本(0x03)',
      () => deviceBle.getSwVersion(this.data.deviceId),
      {
        format: ver => '固件版本：' + (ver || '(空)')
      }
    )
    if (firmwareVersion !== undefined) {
      const patch = { firmwareVersion: firmwareVersion || '' }
      if (this.data.info) {
        patch.info = Object.assign({}, this.data.info, {
          firmwareVersion: firmwareVersion || ''
        })
      }
      this.setData(patch)
    }
  },

  cmdGetBattery() {
    this.runCommand(
      '获取电量(0x04)',
      () => deviceBle.readBattery(this.data.deviceId),
      {
        format: battery => `当前电量：${battery}%`
      }
    )
  },

  async cmdGetConnInterval() {
    const connInterval = await this.runCommand(
      '获取连接间隔(0x05)',
      () => deviceBle.getConnectionInterval(this.data.deviceId),
      {
        format: value =>
          `连接间隔：${value.ms}ms · CONN_INTERVAL=${value.units}`
      }
    )
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
    return mode === 'random' ? '随机' : mode === 'manual' ? '手动' : '顺序'
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
      toast.warn({ title: '请输入有效的间隔秒数', icon: 'none' })
      return
    }
    this.runCommand(
      '设置播放配置(0x10)',
      () =>
        deviceBle.setPlayback(this.data.deviceId, this.data.playMode, interval),
      {
        refresh: true,
        format: () =>
          `已设为 ${this.playModeText(this.data.playMode)} 播放 · 间隔 ${interval} 秒`
      }
    )
  },

  async cmdSetConnInterval() {
    const ms = Number(this.data.connIntervalInput)
    if (!Number.isFinite(ms) || ms <= 0) {
      toast.warn({ title: '请输入有效的连接间隔毫秒数', icon: 'none' })
      return
    }
    const units = protocol.connectionIntervalMsToUnits(ms)
    if (
      units < protocol.CONN_INTERVAL_MIN_UNITS ||
      units > protocol.CONN_INTERVAL_MAX_UNITS
    ) {
      toast.warn({ title: '范围需在 7.5~4000ms', icon: 'none' })
      return
    }
    const connInterval = await this.runCommand(
      '设置连接间隔(0x13)',
      () => deviceBle.setConnectionInterval(this.data.deviceId, units),
      {
        format: value =>
          `已设连接间隔：${value.ms}ms · CONN_INTERVAL=${value.units}`
      }
    )
    if (connInterval) {
      this.setData({
        connInterval,
        connIntervalInput: String(connInterval.ms)
      })
    }
  },

  // 同步投屏：把调试台当前调好的三项传输参数——连接间隔 / 发送速度(pace) / 发包窗口——一并持久化给真实投屏。
  // 之后正式投屏(result.js → optimizeConnectionIntervalForTransfer + uploadImage)图传前会按这些值来传，
  // 而不是写死默认(7.5ms / 极速 3ms / 10 包)。只写本地存储、不依赖蓝牙连接，所以未连接设备也能同步。
  cmdSyncTransferToProjection() {
    const ms = Number(this.data.connIntervalInput)
    if (!Number.isFinite(ms) || ms <= 0) {
      toast.warn({ title: '请输入有效的连接间隔毫秒数', icon: 'none' })
      return
    }
    const units = protocol.connectionIntervalMsToUnits(ms)
    if (
      units < protocol.CONN_INTERVAL_MIN_UNITS ||
      units > protocol.CONN_INTERVAL_MAX_UNITS
    ) {
      toast.warn({ title: '范围需在 7.5~4000ms', icon: 'none' })
      return
    }
    try {
      // 连接间隔按 1.25ms 单位归一；pace/窗口各自归一后落库，返回实际生效值用于回显
      const appliedConn = deviceBle.setTransferConnIntervalMs(ms)
      const appliedPace = deviceBle.setTransferPaceMs(this.data.pace)
      const appliedWindow = deviceBle.setTransferWindow(this.data.windowSize)
      this.setData({
        projectionConnIntervalMs: appliedConn.ms,
        connIntervalInput: String(appliedConn.ms),
        projectionPaceMs: appliedPace,
        pace: appliedPace,
        projectionWindow: appliedWindow,
        windowSize: appliedWindow
      })
      this.appendLog({
        type: 'ok',
        text: `已同步到真实投屏：连接间隔 ${appliedConn.ms}ms（CONN_INTERVAL=${appliedConn.units}）· 每包间隔 ${appliedPace}ms · 窗口 ${appliedWindow} 包`
      })
      toast.show({ title: '已同步到投屏', icon: 'success' })
    } catch (error) {
      toast.warn({ title: error.message || '同步失败', icon: 'none' })
    }
  },

  cmdSetTime() {
    this.runCommand(
      '校准时间(0x11)',
      () => deviceBle.setTime(this.data.deviceId, new Date()),
      {
        format: () =>
          `已把手机当前时间同步给设备：${new Date().toLocaleString()}`
      }
    )
  },

  // ── 图片类指令 ──────────────────────────────────────────
  onSwitchInput(e) {
    this.setData({ switchInput: e.detail.value })
  },

  cmdSwitch() {
    const index = Number(this.data.switchInput)
    if (!Number.isInteger(index) || index < 0) {
      toast.warn({ title: '请输入要显示的图片索引', icon: 'none' })
      return
    }
    this.runCommand(
      '切换显示(0x24)',
      () => deviceBle.refreshScreen(this.data.deviceId, index),
      {
        refresh: true,
        format: res =>
          `屏幕已切到索引 ${res.curImgIndex === 0xff ? '保持不变' : res.curImgIndex}`
      }
    )
  },

  onDeleteInput(e) {
    this.setData({ deleteInput: e.detail.value })
  },

  cmdDelete() {
    const indexes = String(this.data.deleteInput)
      .split(/[,，\s]+/)
      .filter(s => s !== '')
      .map(Number)
    if (
      !indexes.length ||
      indexes.some(n => !Number.isInteger(n) || n < 0 || n > 95)
    ) {
      toast.warn({ title: '请输入要删除的索引(0~95，逗号分隔)', icon: 'none' })
      return
    }
    this.runCommand(
      `删除图片(0x12) 索引[${indexes.join(',')}]`,
      () => deviceBle.deleteImage(this.data.deviceId, indexes),
      {
        refresh: true,
        format: res =>
          `删除完成，设备现存 ${protocol.maskToIndexes(res.imgMask).length} 张`
      }
    )
  },

  onUploadIndexInput(e) {
    this.setData({ uploadIndexInput: e.detail.value })
  },

  // 切换图传发送速度（每包间隔 ms）。建议从「稳」往「快」试：哪一档开始丢包/卡住，就退回上一档。
  onPaceChange(e) {
    this.setData({ pace: Number(e.detail.value) })
  },

  // 切换图传窗口(发满多少包等一次累计应答)。固件收包内存上限 10 包，默认 10；调小(如 5)可做丢包对照。
  onWindowChange(e) {
    this.setData({ windowSize: Number(e.detail.value) })
  },

  formatTuningValue(percent) {
    const value = Number(percent) / 100
    return Number.isFinite(value) ? value.toFixed(2) : '1.00'
  },

  onCropModeChange(e) {
    this.setData({
      cropMode: e.detail.value === 'contain' ? 'contain' : 'cover'
    })
  },

  onDebugResizeModeChange(e) {
    this.setData({
      debugResizeMode: e.detail.value === 'single' ? 'single' : 'staged'
    })
  },

  onDebugDitherChange(e) {
    this.setData({ debugDither: !!e.detail.value })
  },

  onDebugSkipCompressImageChange(e) {
    this.setData({ debugSkipCompressImage: !!e.detail.value })
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
    const index = DEBUG_CALIBRATION_PROFILES.findIndex(
      item => item.id === profile.id
    )
    this.setData({
      calibrationProfileIndex: index >= 0 ? index : DEFAULT_DEBUG_PROFILE_INDEX,
      calibrationProfileId: profile.id,
      calibrationProfileName: profile.name,
      calibrationProfileNote: profile.note,
      // 切换套餐 = 把该套餐的六色 RGB 回填到下面的自定义输入，之后可继续逐项微调
      customColors: paletteToCustomColors(profile.palette)
    })
    if (options && options.log) {
      this.appendLog({
        type: 'act',
        text: `${options.log}：${profile.name} · ${profile.note}`
      })
    }
  },

  // 单个颜色的 R/G/B 输入：只保留数字、上限钳到 255，并实时刷新色块预览。
  onCustomColorInput(e) {
    const index = Number(e.currentTarget.dataset.index)
    const channel = e.currentTarget.dataset.channel
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= this.data.customColors.length
    ) {
      return
    }
    if (channel !== 'r' && channel !== 'g' && channel !== 'b') {
      return
    }
    let text = String(e.detail.value).replace(/[^0-9]/g, '')
    if (text !== '' && Number(text) > 255) {
      text = '255' // 超 255 直接钳住，避免输入无意义大数
    }
    const customColors = this.data.customColors.slice()
    const entry = Object.assign({}, customColors[index])
    entry[channel] = text
    entry.css = `rgb(${clampChannelInput(entry.r)}, ${clampChannelInput(entry.g)}, ${clampChannelInput(entry.b)})`
    customColors[index] = entry
    this.setData({ customColors })
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
      const saved = wx.getStorageSync(this.getCalibrationProfileStorageKey())
      if (!saved) {
        return
      }
      // 旧版本只存了套餐 id（字符串）：找回套餐并回填其六色。
      if (typeof saved === 'string') {
        const profile = findDebugCalibrationProfile(saved)
        if (profile) {
          this.applyCalibrationProfile(profile, { log: '已恢复本设备校准档' })
        }
        return
      }
      // 新版本存的是完整自定义配置对象（套餐 + 自定义六色 + 抖动 + 对比度 + 饱和度）。
      if (typeof saved === 'object') {
        this.restoreSavedCustomConfig(saved)
      }
    } catch (error) {
      // 读取本地调试配置失败不影响上传链路。
    }
  },

  // 还原「保存本机」存下的完整自定义配置：套餐标签 + 自定义六色 + 抖动 + 对比度 + 饱和度。
  restoreSavedCustomConfig(saved) {
    const profile =
      findDebugCalibrationProfile(saved.profileId) || DEFAULT_DEBUG_PROFILE
    const profileIndex = Math.max(
      0,
      DEBUG_CALIBRATION_PROFILES.findIndex(item => item.id === profile.id)
    )
    const hasColors =
      Array.isArray(saved.colors) &&
      saved.colors.length === DEFAULT_DEBUG_PROFILE.palette.length
    const customColors = hasColors
      ? paletteToCustomColors(
          saved.colors.map((color, i) => ({
            nibble: DEFAULT_DEBUG_PROFILE.palette[i].nibble,
            name: DEFAULT_DEBUG_PROFILE.palette[i].name,
            rgb: [color.r, color.g, color.b]
          }))
        )
      : paletteToCustomColors(profile.palette)
    const patch = {
      calibrationProfileIndex: profileIndex,
      calibrationProfileId: profile.id,
      calibrationProfileName: profile.name,
      calibrationProfileNote: profile.note,
      customColors
    }
    if (typeof saved.dither === 'boolean') {
      patch.debugDither = saved.dither
    }
    if (Number.isFinite(saved.contrastPercent)) {
      patch.debugContrastPercent = saved.contrastPercent
      patch.debugContrastText = this.formatTuningValue(saved.contrastPercent)
    }
    if (Number.isFinite(saved.saturationPercent)) {
      patch.debugSaturationPercent = saved.saturationPercent
      patch.debugSaturationText = this.formatTuningValue(
        saved.saturationPercent
      )
    }
    this.setData(patch)
    this.appendLog({
      type: 'act',
      text: `已恢复本设备校准配置：${profile.name}（含自定义六色）`
    })
  },

  saveDeviceCalibrationProfile() {
    if (!this.data.deviceId) {
      toast.warn({ title: '请先连接设备', icon: 'none' })
      return
    }
    if (!wx.setStorageSync) {
      toast.warn({ title: '当前环境不支持本地保存', icon: 'none' })
      return
    }
    try {
      const colors = this.data.customColors.map(color => ({
        nibble: color.nibble,
        r: clampChannelInput(color.r),
        g: clampChannelInput(color.g),
        b: clampChannelInput(color.b)
      }))
      wx.setStorageSync(this.getCalibrationProfileStorageKey(), {
        v: 2,
        profileId: this.data.calibrationProfileId,
        colors,
        dither: !!this.data.debugDither,
        contrastPercent: Number(this.data.debugContrastPercent),
        saturationPercent: Number(this.data.debugSaturationPercent)
      })
      this.appendLog({
        type: 'ok',
        text: `已保存本设备校准配置：${this.data.calibrationProfileName}（含自定义六色）`
      })
      toast.show({ title: '已保存本设备配置', icon: 'none' })
    } catch (error) {
      toast.warn({ title: '保存失败：' + error.message, icon: 'none' })
    }
  },

  getSelectedCalibrationProfile() {
    return (
      findDebugCalibrationProfile(this.data.calibrationProfileId) ||
      DEFAULT_DEBUG_PROFILE
    )
  },

  getDebugQuantizeOptions() {
    const contrast = Number(this.data.debugContrastPercent) / 100
    const saturation = Number(this.data.debugSaturationPercent) / 100
    const profile = this.getSelectedCalibrationProfile()
    return {
      dither: !!this.data.debugDither,
      contrast: Number.isFinite(contrast)
        ? contrast
        : DEFAULT_DEBUG_QUANTIZE.contrast,
      saturation: Number.isFinite(saturation)
        ? saturation
        : DEFAULT_DEBUG_QUANTIZE.saturation,
      distanceMetric: DEFAULT_DEBUG_QUANTIZE.distanceMetric,
      // 量化用「自定义六色」而非套餐原值：套餐只是回填的起点，用户的逐项微调要真正生效
      palette: customColorsToPalette(this.data.customColors),
      calibrationProfileId: profile.id,
      calibrationProfileName: profile.name,
      achromaticChromaMax: DEFAULT_DEBUG_QUANTIZE.achromaticChromaMax
    }
  },

  // 同步到真实投屏：把「自定义六色 + 抖动 + 对比度 + 饱和度」持久化给正式投屏。
  // 之后在「我的相框」正式投屏(result.js)量化上屏时会优先读这套参数，而不是代码内置默认。
  // 只写本地存储、不依赖蓝牙连接，所以未连接设备也能同步。
  cmdSyncQuantizeToProjection() {
    const contrast = Number(this.data.debugContrastPercent) / 100
    const saturation = Number(this.data.debugSaturationPercent) / 100
    const palette = customColorsToPalette(this.data.customColors)
    try {
      imageCodec.setTransferQuantizeOptions({
        dither: !!this.data.debugDither,
        contrast: Number.isFinite(contrast)
          ? contrast
          : DEFAULT_DEBUG_QUANTIZE.contrast,
        saturation: Number.isFinite(saturation)
          ? saturation
          : DEFAULT_DEBUG_QUANTIZE.saturation,
        palette
      })
      const summary = palette
        .map(p => `${p.name}(${p.rgb.join(',')})`)
        .join(' · ')
      this.appendLog({
        type: 'ok',
        text: `已同步到真实投屏：抖动${this.data.debugDither ? '开' : '关'} · 对比度${this.data.debugContrastText} · 饱和度${this.data.debugSaturationText}`
      })
      this.appendLog({ type: 'act', text: `六色：${summary}` })
      toast.show({ title: '已同步到真实投屏', icon: 'success' })
    } catch (error) {
      toast.warn({ title: error.message || '同步失败', icon: 'none' })
    }
  },

  // 清除同步：让正式投屏回到代码内置默认参数（实拍 2026-06-22 校准 + 抖动）。
  cmdResetProjectionQuantize() {
    try {
      imageCodec.clearTransferQuantizeOptions()
      this.appendLog({
        type: 'act',
        text: '已清除真实投屏的同步参数：恢复为代码内置默认（实拍 2026-06-22 校准 + 抖动）'
      })
      toast.show({ title: '已恢复默认', icon: 'none' })
    } catch (error) {
      toast.warn({ title: error.message || '操作失败', icon: 'none' })
    }
  },

  // 上传彩条测试图：不依赖任何图片，数据尺寸天然正确，最适合首次验证图传链路是否打通
  cmdUploadTest() {
    if (!this.ensureUploadReady()) {
      return
    }
    const info = this.data.info
    // 传 screenType：3.7寸(EF6-370)彩条会按「横向源图」布局打包（固件旋转 90° 上屏）。
    // 若上屏后竖彩条变成横彩条，说明旋转方向反了，调 image-codec.THREE_INCH_SOURCE_ROTATION。
    const frame = imageCodec.buildColorBars(
      info.width,
      info.height,
      info.screenType
    )
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
        wx.chooseMedia({
          count: 1,
          mediaType: ['image'],
          sizeType: ['original'],
          success: resolve,
          fail: reject
        })
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
      const skipCompressImage = !!this.data.debugSkipCompressImage
      const srcPath = skipCompressImage
        ? tempPath
        : await this.shrinkIfHuge(tempPath, info.width, info.height)
      if (skipCompressImage) {
        this.appendLog({
          type: 'act',
          text: '已跳过 wx.compressImage：直接使用 chooseMedia 原图进入 canvas 解码缩放'
        })
      }
      const cropMode = this.data.cropMode === 'contain' ? 'contain' : 'cover'
      const resizeMode =
        this.data.debugResizeMode === 'single' ? 'single' : 'staged'
      const quantize = this.getDebugQuantizeOptions()
      const decoded = await this.imageToImageData(
        srcPath,
        info.width,
        info.height,
        cropMode,
        resizeMode
      )
      const imageData = decoded.imageData
      if (decoded.resampleLog) {
        this.appendLog({ type: 'act', text: decoded.resampleLog })
      }
      this.appendLog({
        type: 'act',
        text: `调试页色准量化：${quantize.calibrationProfileName} / ${quantize.distanceMetric} / 裁剪${cropMode} / 缩放${resizeMode === 'single' ? 'APP单步' : '分阶段'} / 预压缩${skipCompressImage ? '跳过' : '自动'} / 抖动${quantize.dither ? '开' : '关'}${quantize.dither ? `(${DEFAULT_DEBUG_QUANTIZE.ditherStrength})` : ''} / 对比度${quantize.contrast.toFixed(2)} / 饱和度${quantize.saturation.toFixed(2)} / 低饱和保护${quantize.achromaticChromaMax >= 0 ? `≤${quantize.achromaticChromaMax}` : '关'}`
      })
      frame = fromImageDataWithDebugCalibration(
        imageData,
        info.width,
        info.height,
        quantize,
        info.screenType
      )
    } catch (error) {
      wx.hideLoading()
      toast.warn({ title: '图片转换失败：' + error.message, icon: 'none' })
      return
    }
    wx.hideLoading()
    this.uploadFrame(frame, '上传相册图片(0x20~0x22)')
  },

  // 上传手机上的 .raw/.bin 文件，直发设备。.bin 即后端转换生成的 frame.bin（正式投屏下载的那份），
  // .raw 是硬件给的 demo 帧，帧数据都是「已打包好的六色 4bpp 帧」：字节数 = 宽×高÷2
  // （EF6-370 480×720 = 172800），3.7 寸横向源图的旋转也已烘进文件里，原样发送、不旋转/不转换。
  // 两种打包都兼容：纯帧（无头部）与「头部 + 帧数据」（如 15 字节 0x20 帧头前缀），
  // 解析/剥头/校验统一在 resolveLocalFrameData，不区分扩展名。
  //
  // 为什么用 chooseMessageFile：小程序被沙箱限制，读不了手机上任意目录的文件，
  // 只能从「微信聊天会话」里选文件。最快的拿文件办法——电脑微信把 .raw/.bin 发给「文件传输助手」，
  // 手机上就能在这里的选择器里选到。该 API 在体验版/正式版都可用，无需特殊权限。
  cmdUploadLocalRaw() {
    if (!this.ensureUploadReady()) {
      return
    }
    if (!wx.chooseMessageFile || !wx.getFileSystemManager) {
      toast.warn({ title: '当前微信版本不支持选择文件', icon: 'none' })
      return
    }
    const info = this.data.info
    const expectBytes = Math.floor((info.width * info.height) / 2)
    wx.chooseMessageFile({
      count: 1,
      type: 'file', // 聊天里的普通文件（非图片/视频）；.raw 归此类
      success: res => {
        const file = res.tempFiles && res.tempFiles[0]
        if (!file) {
          return
        }
        const name = file.name || '(未命名)'
        // 体验/正式版无法对聊天文件按扩展名强过滤（.raw/.bin 都能选到），故用「字节数 == 宽×高÷2」兜底校验，文件名仅作提示。
        wx.getFileSystemManager().readFile({
          filePath: file.path,
          success: r => {
            const data = new Uint8Array(r.data)
            // 兼容「纯帧」与「带头部」两种 .raw/.bin，解析细节见 resolveLocalFrameData。
            const resolved = this.resolveLocalFrameData(data, info, name)
            resolved.notes.forEach(note => this.appendLog(note))
            if (!resolved.ok) {
              const errText =
                resolved.notes
                  .filter(note => note.type === 'err')
                  .map(note => note.text)
                  .join('；') || '文件不可用'
              this.setData({ uploadStatus: errText, uploadStatusType: 'err' })
              toast.warn({ title: resolved.toast || '文件不可用，已拦下', icon: 'none' })
              return
            }
            const payload = resolved.payload
            const frame = {
              data: payload,
              width: info.width,
              height: info.height,
              dataSize: payload.length
            }
            this.uploadFrame(frame, '上传本地 .raw/.bin 直发(0x20~0x22)')
          },
          fail: err => {
            this.appendLog({
              type: 'err',
              text: `读取 .raw/.bin 失败：${err.errMsg || '未知错误'}`
            })
            toast.warn({ title: '读取文件失败', icon: 'none' })
          }
        })
      },
      fail: () => {
        // 用户取消选择，无需提示
      }
    })
  },

  // 把本地 .raw/.bin 解析成「要直发给设备的六色 4bpp 帧」，兼容两种打包：
  //   1) 纯帧：字节数 == 宽×高÷2（帧数据本身），原样直发。
  //   2) 带头部：文件 = 头部 + 帧数据。约定帧数据在文件「尾部」（尾 宽×高÷2 字节），头部在前——
  //      故只要文件比一帧长，就把多出来的前缀当头部剥掉、按尾部帧发送，能兼容任意长度头部。
  //      头部恰为 15 字节时按 0x20 IMG_START 头精确解析（SCREEN_TYPE/INDEX/WIDTH/HEIGHT/FORMAT/
  //      DATA_SIZE/CRC32），并做宽高/长度/CRC32 交叉校验，把结果打进控制台便于核对。
  // 返回 { ok, payload(Uint8Array), notes:[{type,text}], toast }。用 .slice 拷出独立帧，避免下游按
  // .buffer 取整块缓冲时把头部也带上。校验只拦「文件比一帧还短」，其余一律放行直发（设备端 0x22 会兜底校验整图 CRC32）。
  resolveLocalFrameData(data, info, name) {
    const label = name || '(未命名)'
    const expectBytes = Math.floor((info.width * info.height) / 2)
    const notes = []
    if (data.length < expectBytes) {
      return {
        ok: false,
        toast: '文件太小，已拦下',
        notes: [
          {
            type: 'err',
            text: `.raw/.bin 太小：选中「${label}」${data.length} 字节 < 一帧 ${expectBytes} 字节（${info.width}×${info.height} 六色4bpp = 宽×高÷2）。不是该尺寸的帧。`
          }
        ]
      }
    }
    if (data.length === expectBytes) {
      notes.push({
        type: 'act',
        text: `本地纯帧「${label}」：${data.length} 字节，无头部，原样直发（不旋转/不转换）`
      })
      return { ok: true, payload: data, notes }
    }
    // 文件比一帧长 => 带头部：尾部 expectBytes 字节为帧数据，前部为头部
    const headerLen = data.length - expectBytes
    const header = data.subarray(0, headerLen)
    const payload = data.slice(headerLen)
    if (headerLen === 15) {
      // 疑似 0x20 IMG_START 头（15 字节，小端）：SCREEN_TYPE(1) INDEX(1) WIDTH(2) HEIGHT(2) FORMAT(1) DATA_SIZE(4) CRC32(4)
      const hWidth = header[2] | (header[3] << 8)
      const hHeight = header[4] | (header[5] << 8)
      const hFormat = header[6]
      const hDataSize =
        (header[7] | (header[8] << 8) | (header[9] << 16) | (header[10] << 24)) >>> 0
      const hCrc32 =
        (header[11] | (header[12] << 8) | (header[13] << 16) | (header[14] << 24)) >>> 0
      const actualCrc32 = imageCodec.crc32Mpeg2(payload)
      const crcOk = actualCrc32 === hCrc32
      const sizeOk = hDataSize === payload.length
      const dimOk = hWidth === info.width && hHeight === info.height
      const hex = v => '0x' + (v >>> 0).toString(16).padStart(8, '0').toUpperCase()
      notes.push({
        type: crcOk && sizeOk && dimOk ? 'act' : 'err',
        text:
          `带头部「${label}」：检测到 15 字节 0x20 帧头 ${hWidth}×${hHeight} format=0x${hFormat
            .toString(16)
            .padStart(2, '0')} DATA_SIZE=${hDataSize}${sizeOk ? '' : `(实际帧 ${payload.length}✗)`} ` +
          `CRC32=${hex(hCrc32)}(实算${hex(actualCrc32)}${crcOk ? '✓' : '✗'}) 头=${protocol.bytesToHex(header)}，已剥头按尾部帧直发`
      })
      if (!dimOk) {
        notes.push({
          type: 'err',
          text: `头部宽高 ${hWidth}×${hHeight} 与本设备 ${info.width}×${info.height} 不一致：仍按本设备尺寸取尾部 ${expectBytes} 字节发送，请核对文件是否为本机型。`
        })
      }
      if (hFormat !== 0x01) {
        notes.push({
          type: 'err',
          text: `头部 FORMAT=0x${hFormat.toString(16).padStart(2, '0')} 非 0x01：固件目前只支持 0x01（六色 4bpp 原始帧），继续直发但可能被设备拒绝。`
        })
      }
      return { ok: true, payload, notes }
    }
    // 未知长度头部：只按「尾部一帧」剥离并告警，交由设备端校验
    notes.push({
      type: 'act',
      text: `带头部「${label}」：文件 ${data.length} 字节 = 头部 ${headerLen} 字节 + 帧 ${expectBytes} 字节，已剥头按尾部帧直发。头部前16=${protocol.bytesToHex(header.subarray(0, Math.min(16, headerLen)))}（非 15 字节 0x20 头，未做 CRC 校验，请留意方向/颜色）`
    })
    return { ok: true, payload, notes }
  },

  // 上传前置检查：必须已连接且已读到设备信息（拿到屏幕尺寸/容量/掩码才能组帧头、选槽位）
  ensureUploadReady() {
    if (!this.requireDevice()) {
      return false
    }
    if (this.data.busy || this.data.uploading) {
      toast.warn({ title: '请等待当前操作完成', icon: 'none' })
      return false
    }
    if (!this.data.info || !this.data.info.width) {
      toast.warn({ title: '请先点「获取设备信息」', icon: 'none' })
      return false
    }
    if (this.data.info.screenType === 0x03) {
      toast.warn({ title: '7.3寸为占位型号，固件未实现图传', icon: 'none' })
      return false
    }
    return true
  },

  computeAppLikeSample(width, height, targetW, targetH) {
    let sample = 1
    while (
      width / (sample * 2) >= targetW &&
      height / (sample * 2) >= targetH
    ) {
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

    while (
      sw > finalW * 2 ||
      sh > finalH * 2 ||
      Math.max(sw, sh) > DEBUG_RESAMPLE.maxStageEdge
    ) {
      const maxEdge = Math.max(sw, sh)
      const capScale =
        maxEdge > DEBUG_RESAMPLE.maxStageEdge
          ? DEBUG_RESAMPLE.maxStageEdge / maxEdge
          : 1
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
          const sample = this.computeAppLikeSample(
            width,
            height,
            targetW,
            targetH
          )
          if (sample <= 1) {
            resolve(path) // APP 也不会下采样的尺寸，直接保留原图细节
            return
          }
          const compressedWidth = Math.max(targetW, Math.round(width / sample))
          const compressedHeight = Math.max(
            targetH,
            Math.round(height / sample)
          )
          wx.compressImage({
            src: path,
            compressedWidth,
            compressedHeight,
            quality: DEBUG_RESAMPLE.predecodeQuality,
            success: res => {
              this.appendLog({
                type: 'act',
                text: `APP式预采样：原图 ${width}×${height}，sample=${sample}，预解码约 ${compressedWidth}×${compressedHeight}`
              })
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
  imageToImageData(path, width, height, cropMode, resizeMode) {
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
          if (resizeMode === 'single') {
            ctx.drawImage(
              img,
              plan.sx,
              plan.sy,
              plan.sw,
              plan.sh,
              plan.dx,
              plan.dy,
              plan.dw,
              plan.dh
            )
          } else {
            try {
              stages = this.drawImageResampled(ctx, img, plan)
            } catch (resampleError) {
              ctx.clearRect(0, 0, width, height)
              if (cropMode === 'contain') {
                ctx.fillStyle = '#fff'
                ctx.fillRect(0, 0, width, height)
              }
              ctx.drawImage(
                img,
                plan.sx,
                plan.sy,
                plan.sw,
                plan.sh,
                plan.dx,
                plan.dy,
                plan.dw,
                plan.dh
              )
              fallbackLog = `分阶段缩放不可用，已退回单步缩放：${resampleError.message || resampleError}`
            }
          }
          const imageData = ctx.getImageData(0, 0, width, height)
          const sourceText = `${Math.round(plan.sw)}×${Math.round(plan.sh)}`
          const targetText = `${Math.round(plan.dw)}×${Math.round(plan.dh)}`
          const resampleLog =
            fallbackLog ||
            (resizeMode === 'single'
              ? `APP单步缩放：原图 ${iw}×${ih}，${cropMode} 取样 ${sourceText} → ${targetText}`
              : stages.length
                ? `分阶段缩放：原图 ${iw}×${ih}，${cropMode} 取样 ${sourceText} → ${stages.join(' → ')} → ${targetText}`
                : `分阶段缩放未触发：原图 ${iw}×${ih}，${cropMode} 取样 ${sourceText} → ${targetText}`)
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
      this.appendLog({
        type: 'act',
        text: `图传前 连接间隔(0x05)=${before.ms}ms · units=${before.units}`
      })
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
        toast.warn({ title: `槽位需在 0~${info.capacity - 1}`, icon: 'none' })
        return
      }
    } else {
      index = protocol.firstFreeIndex(info.imgMask, info.capacity)
      if (index < 0) {
        toast.warn({ title: '设备已存满，请先删除图片', icon: 'none' })
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
    this.appendLog({
      type: 'act',
      text: `${label} → 槽位 ${index}，数据 ${frame.dataSize} 字节 / ${totalPackets} 包`
    })

    // 图传前：按「连接间隔」输入框的值把链路间隔设好并复读确认。卡住时据此区分
    // 「连接间隔没生效」还是「设备吃不下速率」（结论见 applyAndVerifyConnInterval / connDiagConclusion）。
    let connDiag = null
    const targetMs = Number(this.data.connIntervalInput)
    const targetUnits = protocol.connectionIntervalMsToUnits(targetMs)
    if (
      Number.isFinite(targetMs) &&
      targetMs > 0 &&
      targetUnits >= protocol.CONN_INTERVAL_MIN_UNITS &&
      targetUnits <= protocol.CONN_INTERVAL_MAX_UNITS
    ) {
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
        window: this.data.windowSize, // 图传窗口(发满多少包等一次累计应答)，由页面"发包窗口"档位决定
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
      // 与真实投屏的「[投屏性能] 单张汇总」打同一组字段（uploadImage 返回的 transferStats：
      // mtu/chunkSize/totalPackets/window/configuredPace/finalPace/dataMs/ackWaitMs/
      // ackTimeouts/retryEvents/throughputKbps…）。同一张图两边各传一次，字段一对就知道慢在哪。
      console.log('[调试台图传]', summary.transferStats)
      const okText = `图传完成 ✓ 设备现存 ${summary.imgCount} 张，剩余 ${summary.storageFree} 字节`
      this.appendLog({ type: 'ok', text: okText })
      this.setData({ uploadStatus: okText, uploadStatusType: 'ok' })
      // 传完顺手刷新屏幕显示这张，便于直接在屏上确认。
      // refreshScreen 现在会在设备拒绝(0x24 result≠0)时抛错——但图传本身已确认成功，
      // 这步只是「顺手刷新」，失败不该把成功翻成失败，单独 try 掉并记日志即可。
      try {
        await deviceBle.refreshScreen(this.data.deviceId, index)
      } catch (refreshError) {
        this.appendLog({
          type: 'err',
          text: `传后刷新屏幕失败：${refreshError.message}`
        })
      }
      await this.refreshInfoSilently()
      toast.show({ title: '上传成功', icon: 'none' })
    } catch (error) {
      // 失败原因常驻显示在页面上（可长按复制），不用去翻一闪而过的弹窗
      // 只要期间发生过息屏/切后台(_uploadAborted)，无论报的是中止还是写失败，都按"息屏中断"提示
      const aborted =
        this._uploadAborted || (error && error.message === 'UPLOAD_ABORTED')
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
