// 硬件联调调试台：把 PRD 文档里能对接的功能全做成按钮，点一下就发一条 BLE 指令，
// 下方控制台实时打印「发送/接收」的 16 进制原始字节，方便第一次对接时和硬件侧日志对照排查。
//
// 整体链路（自下而上）：
//   wx 蓝牙 API  →  utils/bluetooth.js(扫描/连接)  →  utils/frame-protocol.js(组帧/解析)
//                →  utils/device-ble.js(发指令/收应答/图传)  →  本页面(按钮 + 日志)
//
// 推荐联调顺序（页面上从上到下就是这个顺序）：
//   1) 连接设备   2) 读设备信息(0x01，拿到屏幕类型/容量/图片掩码/电量)   3) 逐个点其它按钮试。
//
// 「上传相册图片」＝真实投屏的竖向链路（2026-08-07 起）：
//   选图(原图) → 按设备物理分辨率竖向中心裁切导出 → 统一压缩 → 第三方 seekink 抖动接口出
//   六色 4bpp 帧 → 字节数铁闸校验 → BLE 图传。与「我的相框」正式投屏逐步同源，唯一的差别是
//   **不碰设备管理/投屏记录接口**（不调 setUserProductUpload / editUserProductImgRecord），
//   联调不会在真实环境留下投屏记录与图库图片。客户端不再做任何量化/调色，帧由第三方算好。

const permission = require('../../../utils/permission')
const toast = require('../../../utils/toast')
const bluetooth = require('../../../utils/bluetooth')
const deviceBle = require('../../../utils/device-ble')
const protocol = require('../../../utils/frame-protocol')
const imageCodec = require('../../../utils/image-codec')
const dithering = require('../../../utils/dithering')
const deviceRotation = require('../../../utils/device-rotation')
const media = require('../../../utils/media')
const system = require('../../../utils/system')
const api = require('../../../utils/api')
const fold = require('../../../utils/fold-adapt')

// 第三方（seekink 抖动出帧接口）鉴权 token 的返回归一化：与 dithering.js normalizeAuthToken 保持一致
// （那份未导出，调试台单独复制一份）。接口返回形态未定——可能直接是 token 串，也可能包在
// token/xtyToken/userToken/accessToken/access_token 字段里；若带 Bearer 前缀则剥掉，只留纯 token 串
// （正式出帧时由 dithering.js 统一拼「Bearer 空格 token」）。
function normalizeAuthToken(data) {
  const raw =
    typeof data === 'string'
      ? data
      : (data &&
          (data.token ||
            data.xtyToken ||
            data.userToken ||
            data.accessToken ||
            data.access_token)) ||
        ''
  return String(raw).replace(/^Bearer\s+/i, '').trim()
}

// ── 真实投屏竖向链路用到的常量（与投屏预览页 / 结果页同源，改这里前先核对那两处）────────
// 画布导出格式：与预览页 _exportCanvas 一致。第三方抖动接口在设备物理分辨率上量化成六色，
// q=0.92 对最终成像无损，体积却只有 png 的 1/10（png 会让上传慢好几秒）。
const EXPORT_FILE_TYPE = 'jpg'
const EXPORT_QUALITY = 0.92
// 上传前统一压缩的质量：与 result.js compressForUpload 同值（长边已等于设备长边时不会触发压缩）。
const UPLOAD_COMPRESS_QUALITY = 90

// 广播ID(广播名) → 屏幕规格。调试台按「连接设备的广播名」区分大尺寸/小尺寸：
//   EF6-370 = 小尺寸 480×720、EF6-589 = 大尺寸 680×960（真源是 protocol.SCREEN_TYPES，勿写死数字）。
// 取不到/认不出返回 null，由调用方回落到 0x01 自报的 screenType。
function screenSpecByBroadcastName(name) {
  const upper = String(name || '').toUpperCase()
  if (!upper) {
    return null
  }
  const keys = Object.keys(protocol.SCREEN_TYPES)
  for (let i = 0; i < keys.length; i++) {
    const screenType = Number(keys[i])
    const spec = protocol.SCREEN_TYPES[screenType]
    const model = String((spec && spec.model) || '').toUpperCase()
    if (model && upper.indexOf(model) > -1) {
      return {
        screenType,
        model: spec.model,
        label: spec.label,
        width: spec.width,
        height: spec.height
      }
    }
  }
  return null
}

// ── 调试台图传参数默认值（2026-08-07 设备侧优化后的口径）────────────────────────────
//   · 发包窗口 50 包：设备扩了收包缓冲，一次可缓 50 包（此前 10 包）；
//   · 0x21 图片数据 489 字节：设备把单包数据上限从 236 放宽到 489
//     （0x21 的 PAYLOAD = PKT_SEQ(2) + 数据，故 PAYLOAD 最大 491 字节）；
//   · MTU 500：489 + 8 字节整帧固定开销(SOF/CMD/LEN/CRC) = 497，正好等于 MTU 500 的单次可写上限(MTU-3)。
// 三者是一组：MTU 顶不上去（iOS 不支持手动设置 / 安卓协商下来更小）时，每包数据会被自动夹回
// 链路真正能承载的值，见 device-ble.effectiveChunkSize——不会出现「写下去被静默丢弃」。
//   · 每包间隔 3ms：极速档起步，链路干净还会自动往 0 探。
// 这一组是**最快默认值**，可以放心留着：device-ble 的图传按 AIMD 自适应（卡顿即窗口减半、
// 每包间隔翻倍，稳定后再慢慢涨回），设备一时吃不下也只会自动收敛到它受得了的速率，
// 不会再出现「窗口 10 → 50 反而更慢更容易卡死」的死循环。
// 2026-08-14 起这一组已同步为**真实投屏的默认值**（device-ble 的 DEFAULT_TRANSFER_WINDOW /
// IMG_DATA_CHUNK_MAX / MTU_REQUEST_DEFAULT / PACKET_PACE_MS），两条链路自此同参数、可直接对照；
// 连接间隔不在此列，仍按平台默认（安卓/鸿蒙 7.5ms、iOS 及其他 15ms）。
const DEBUG_TRANSFER_WINDOW = 50
const DEBUG_IMG_DATA_BYTES = 489
const DEBUG_MTU = 500
const DEBUG_PACE_MS = 3

// 在画布上铺白底（与预览页 fillWhite 同源）：jpg 无 alpha 通道，不铺底时透明像素会被压成黑色。
function fillWhite(ctx, width, height) {
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)
}

// 折叠屏/分屏适配：Page 配置外面包一层 fold.adapt（方案见 utils/fold-adapt.js 与
// styles/fold-adapt.wxss）。只叠加「形态变化后重测状态栏/安全区」等钩子，页面原有配置一字不改。
Page(fold.adapt({
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
    // 后端设备记录：调试台**不调设备管理接口**，所以恒为 null。竖向导出角(verticalRotation)
    // 因此取缺省 0°=不旋转，与「后端没下发该字段」的真实设备表现一致（见 utils/device-rotation.js）。
    device: null,
    connInterval: null,
    firmwareVersion: '', // 当前页面已读取到的软件/固件版本（0x03）
    existingIndexes: '', // 设备上已有图片的索引列表，便于决定删哪张/传到哪
    autoUploadIndex: -1, // 自动挑选的空闲槽位

    // 指令输入框
    playMode: 'order', // 'order' 顺序 / 'random' 随机
    intervalInput: '60', // 切换间隔(秒)
    // BLE 连接间隔(ms)，协议会换算为 1.25ms 单位（7.5ms=6单位，协议最小值）。这里的 7.5 只是渲染前的占位，
    // onLoad 会立刻用 getTransferConnIntervalMs() 覆盖成真实生效值（默认 安卓/鸿蒙 7.5ms、iOS 及其他 15ms）
    connIntervalInput: '7.5',
    projectionConnIntervalMs: 7.5, // 真实投屏图传前要设的连接间隔(ms)，由「保存给真实投屏」写入，onLoad 时回显（同上，7.5 是占位）
    projectionPaceMs: 3, // 真实投屏图传每包发送间隔(ms)，由「保存给真实投屏」写入，onLoad 时回显
    projectionWindow: 50, // 真实投屏图传窗口包数，由「保存给真实投屏」写入，onLoad 时回显（同上，50 是占位）
    switchInput: '0', // 0x24 要显示的图片索引
    deleteInput: '', // 0x12 要删除的图片索引，逗号分隔，如 "0,2"
    uploadIndexInput: '', // 上传槽位，留空则自动选空闲位
    // 图传每包发送间隔(ms)，越小越快。默认极速 3ms：它只是**起点**——链路一直干净时
    // device-ble 会继续往 0 探，卡顿时自动翻倍退让，所以不必再手动往「稳」退档来救卡顿。
    pace: DEBUG_PACE_MS,
    // ── 三项传输参数：输入框改完立即生效，下一次图传就按新值走（不必重连、不必点同步）──
    windowSize: DEBUG_TRANSFER_WINDOW, // 图传窗口(发满多少包等一次累计应答)，设备侧已支持 50
    windowInput: String(DEBUG_TRANSFER_WINDOW),
    dataChunkSize: DEBUG_IMG_DATA_BYTES, // 0x21 每包图片数据字节数（PAYLOAD = PKT_SEQ(2) + 它）
    chunkInput: String(DEBUG_IMG_DATA_BYTES),
    mtuRequest: DEBUG_MTU, // 想协商到的 MTU（安卓可即时重协商；iOS 由系统定，只能读回实际值）
    mtuInput: String(DEBUG_MTU),
    sessionMtu: 0, // 当前会话**实际**协商到的 MTU（连接/重协商后回填）
    effectiveChunk: DEBUG_IMG_DATA_BYTES, // 按实际 MTU 夹取后、本次图传真正会用的每包数据字节数

    // 第三方 Token（seekink 抖动出帧接口鉴权，/Client/Basic/getXTYUserToken）
    authToken: '', // 获取到的 token 串，展示并可复制
    authTokenError: '', // 获取失败原因，常驻显示便于排查
    fetchingToken: false, // 正在请求 token，避免并发点击

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

    // 调试台自己的三项传输参数一律取「最快」默认值（连接间隔按平台取安卓/鸿蒙 7.5ms、
    // iOS 及其他 15ms · 每包间隔 3ms · 窗口 50 包 · 每包 489 字节 · MTU 500），不再被
    // 上次「保存给真实投屏」写下的值带偏——调试台的职责就是先跑最快的一组，卡了让 device-ble 的
    // 自适应退让去收敛，再把实测调稳的值同步给真实投屏。
    // 真实投屏当前生效的那组值单独读出来只做对照展示（projectionXxx，页面提示行里显示）。
    this.setData({
      projectionConnIntervalMs: deviceBle.getTransferConnIntervalMs(),
      projectionPaceMs: deviceBle.getTransferPaceMs(),
      projectionWindow: deviceBle.getTransferWindow(),
      connIntervalInput: String(deviceBle.defaultTransferConnIntervalMs())
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

  // ── 第三方 Token ────────────────────────────────────────
  // 调用 /Client/Basic/getXTYUserToken 取 seekink 抖动出帧接口的鉴权 token 并展示（可复制）。
  // 与正式投屏出帧（dithering.js requestFrameBin → ensureAuthToken）用的是同一接口、同一归一化逻辑，
  // 方便在这里单独验证「token 能不能取到、长什么样」。纯网络请求，不依赖蓝牙连接。
  // data-force="1" 时带 isNewLogin=1，强制后端重新登录取新 token（对应线上 401 自愈刷新那条路径）。
  async cmdFetchAuthToken(e) {
    if (this.data.fetchingToken) {
      return
    }
    const forceNewLogin =
      e && e.currentTarget && e.currentTarget.dataset.force === '1'
    this.setData({ fetchingToken: true, authTokenError: '' })
    this.appendLog({
      type: 'act',
      text: `点击：获取第三方Token（isNewLogin=${forceNewLogin ? 1 : 0}）`
    })
    try {
      const data = await api.getXTYUserToken(forceNewLogin ? 1 : 0)
      const token = normalizeAuthToken(data)
      if (!token) {
        throw new Error('接口返回为空（未解析到 token 字段）')
      }
      this.setData({ authToken: token })
      this.appendLog({
        type: 'ok',
        text: `已获取第三方Token（${token.length} 字符）：${token}`
      })
      toast.show({ title: '已获取 Token', icon: 'none' })
    } catch (error) {
      const msg = (error && error.message) || '获取失败'
      this.setData({ authTokenError: `获取第三方Token失败：${msg}` })
      this.appendLog({ type: 'err', text: `获取第三方Token失败：${msg}` })
      toast.warn({ title: msg, icon: 'none' })
    } finally {
      this.setData({ fetchingToken: false })
    }
  },

  // 复制当前展示的第三方 token 到剪贴板。wx.setClipboardData 成功后系统自带「已复制」提示，
  // 这里不再叠加 toast，只补一条控制台日志便于对照。
  copyAuthToken() {
    const token = this.data.authToken
    if (!token) {
      toast.warn({ title: '暂无可复制的 Token', icon: 'none' })
      return
    }
    wx.setClipboardData({
      data: token,
      success: () => {
        this.appendLog({ type: 'act', text: '已复制第三方Token到剪贴板' })
      },
      fail: () => {
        toast.warn({ title: '复制失败', icon: 'none' })
      }
    })
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
    // 顺带回填本页设备实际协商到的 MTU，并按它重算「本次图传每包真正能装多少字节」
    const current = connections.find(conn => conn.isCurrent)
    this.setData({
      mpConnected: connections.length > 0,
      mpConnections: connections,
      sessionMtu: current ? current.mtu : 0
    })
    this.refreshEffectiveChunk()
  },

  // 断开小程序当前持有的全部 BLE 会话，释放被占用的设备（让它重新广播，能再次被搜索/连接）。
  disconnectAllConnections() {
    const ids = deviceBle.disconnectAll()
    if (!ids.length) {
      toast.warn({ title: '当前没有已连接的电子纸设备', icon: 'none' })
      this.refreshMpConnections()
      return
    }
    // 若断的是本页正在用的设备，同步本页连接态，避免上方还显示「已连接」
    if (ids.indexOf(this.data.deviceId) > -1) {
      this.setData({ connected: false, info: null, connInterval: null })
    }
    this.appendLog({
      type: 'act',
      text: `已断开全部连接（${ids.length} 个），电子纸设备已释放，可重新搜索/连接`
    })
    toast.show({ title: `已释放 ${ids.length} 个连接`, icon: 'none' })
    this.refreshMpConnections()
  },

  // ── 连接 / 扫描 ─────────────────────────────────────────
  requireDevice() {
    if (!this.data.deviceId || !this.data.connected) {
      toast.warn({ title: '请先连接电子纸设备', icon: 'none' })
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
        text: `扫描完成（已放开过滤），发现 ${devices.length} 个电子纸设备`
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
        text: `建连协商 MTU=${session.mtu} 字节（分包上限 ${deviceBle.IMG_DATA_CHUNK_MAX} 字节/包，与真实投屏同一套），写入方式：${writeTypeText}`
      })
      // 建连走的就是真实投屏那套（2026-08-14 起同为请求 MTU 500 / 每包 ≤489 字节）；这里仍按
      // 页面上的 MTU 输入框重协商一次，方便把 MTU 手动改成其它档位做对照，改完即时生效。
      await this.applyMtuFromInput({ silent: true })
      await this.refreshInfoSilently()
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
            ? `电子纸设备信息：Device_ID ${info.deviceId || '--'} · 电量 ${info.battery}% · ${info.screen} · 容量 ${info.capacity} · 已存 ${info.imgCount} 张 · 固件 ${info.firmwareVersion || '--'}`
            : '电子纸设备信息已刷新'
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

  // 保存给真实投屏：把调试台当前调好的三项传输参数——连接间隔 / 发送速度(pace) / 发包窗口——一并持久化给真实投屏。
  // 之后正式投屏(result.js → optimizeConnectionIntervalForTransfer + uploadImage)图传前会按这些值来传，
  // 而不是走默认(连接间隔 安卓/鸿蒙 7.5ms、iOS 及其他 15ms · 极速 3ms · 50 包)。只写本地存储、不依赖蓝牙连接，
  // 所以未连接设备也能同步。
  // 2026-08-14 起默认值本身已与调试台一致，这个按钮的用途收窄成「实测出更稳的一组就覆盖默认」；
  // 存储值优先级高于默认值，本机存过旧值(如窗口 10)就一直用旧值，页面提示行显示的即当前生效值。
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
        // 窗口回填输入框：落库会夹到 [1, TRANSFER_WINDOW_MAX]，回填后所见即真实投屏会用的值
        windowSize: appliedWindow,
        windowInput: String(appliedWindow)
      })
      this.appendLog({
        type: 'ok',
        text: `已保存为真实投屏的参数：连接间隔 ${appliedConn.ms}ms（0x13 CONN_INTERVAL=${appliedConn.units}）· 每包间隔 ${appliedPace}ms · 窗口 ${appliedWindow} 包。此后用户在「我的相框」正式投屏就按这三项传（「0x21 数据字节」与「MTU」不参与保存：它们的默认值已是 489 / 500，本页改动只作用于当次调试）`
      })
      toast.show({ title: '已保存给真实投屏', icon: 'success' })
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
          `已把手机当前时间同步给电子纸设备：${new Date().toLocaleString()}`
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
          `删除完成，电子纸设备现存 ${protocol.maskToIndexes(res.imgMask).length} 张`
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

  // ── 图传参数（发包窗口 / 0x21 数据字节 / MTU）：改完立即生效，下一次图传就按新值走 ──
  //
  // 三者的关系：一包 0x21 整帧 = 数据 + 8 字节固定开销(SOF/CMD/LEN/CRC)，而蓝牙单次可写 = MTU - 3，
  // 所以「每包数据 ≤ MTU - 11」。默认 MTU 500 / 每包 489 正好卡满；MTU 顶不上去时每包数据会被
  // 自动夹回链路能承载的值（下方 refreshEffectiveChunk 会把实际值回显出来）。

  // 发包窗口：发满多少包等一次累计应答(0x23)。设备侧 2026-08-07 起可缓 50 包（此前 10）。
  onWindowInput(e) {
    const text = String(e.detail.value).replace(/[^0-9]/g, '')
    const value = Number(text)
    const patch = { windowInput: text }
    if (Number.isFinite(value) && value >= 1) {
      // 夹到 [1, TRANSFER_WINDOW_MAX]：超过设备收包缓冲会溢出丢包，device-ble 也会再夹一次
      patch.windowSize = Math.min(deviceBle.TRANSFER_WINDOW_MAX, Math.round(value))
    }
    this.setData(patch)
  },

  // 0x21 每包图片数据字节数。设备侧 2026-08-07 由 236 放宽到 489
  //（0x21 的 PAYLOAD = PKT_SEQ(2) + 数据，故 PAYLOAD 最大 491 字节）。
  onChunkInput(e) {
    const text = String(e.detail.value).replace(/[^0-9]/g, '')
    const value = Number(text)
    const patch = { chunkInput: text }
    if (Number.isFinite(value) && value >= 1) {
      patch.dataChunkSize = Math.round(value)
    }
    this.setData(patch)
    this.refreshEffectiveChunk()
  },

  // 想协商到的 MTU。安卓可在连接存活期间重协商（点「应用 MTU」即时生效）；
  // iOS 由系统自动协商、setBLEMTU 无效，点了只会把系统给的实际值读回来。
  onMtuInput(e) {
    const text = String(e.detail.value).replace(/[^0-9]/g, '')
    const value = Number(text)
    const patch = { mtuInput: text }
    if (Number.isFinite(value) && value > 23) {
      patch.mtuRequest = Math.round(value)
    }
    this.setData(patch)
  },

  // 把 MTU 输入框的值下发重协商，并回填「实际协商到的 MTU / 本次图传实际每包字节数」。
  // silent：连接后自动调用的那次不弹 toast，只写控制台。
  async applyMtuFromInput(options) {
    const silent = !!(options && options.silent)
    if (!this.data.connected || !this.data.deviceId) {
      if (!silent) {
        toast.warn({ title: '请先连接电子纸设备', icon: 'none' })
      }
      return
    }
    const requested = Number(this.data.mtuRequest)
    if (!Number.isFinite(requested) || requested <= 23) {
      if (!silent) {
        toast.warn({ title: '请输入有效的 MTU（>23）', icon: 'none' })
      }
      return
    }
    try {
      const applied = await deviceBle.renegotiateMtu(this.data.deviceId, requested)
      this.setData({ sessionMtu: applied.mtu })
      const chunk = this.refreshEffectiveChunk()
      const capped = chunk < Number(this.data.dataChunkSize)
      this.appendLog({
        type: capped ? 'err' : 'ok',
        text:
          `MTU 已协商：请求 ${requested} → 实际 ${applied.mtu} 字节；` +
          `本次图传每包数据 ${chunk} 字节` +
          (capped
            ? `（输入的 ${this.data.dataChunkSize} 塞不进 MTU ${applied.mtu}，已夹到 MTU-11=${chunk}。iOS 无法手动设 MTU，安卓也可能协商不到请求值）`
            : '')
      })
      this.refreshMpConnections()
      if (!silent) {
        toast.show({ title: `MTU ${applied.mtu}`, icon: 'none' })
      }
    } catch (error) {
      this.appendLog({ type: 'err', text: `MTU 协商失败：${error.message}` })
      if (!silent) {
        toast.warn({ title: error.message || 'MTU 协商失败', icon: 'none' })
      }
    }
  },

  // 按当前会话的实际 MTU 算出「本次图传真正会用的每包数据字节数」并回显（与 uploadImage 内部同一套夹取规则）。
  refreshEffectiveChunk() {
    const requested = Number(this.data.dataChunkSize)
    // 未连接时没有会话可参照，直接回显输入值（连上后会按真实 MTU 再夹一次）
    const effective =
      this.data.connected && this.data.deviceId
        ? deviceBle.getEffectiveChunkSize(this.data.deviceId, requested)
        : requested
    this.setData({ effectiveChunk: effective })
    return effective
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

  // 本次要用的屏幕规格（大尺寸 / 小尺寸）。
  // 口径：**按广播ID(广播名)判大小尺寸**——EF6-370 = 小尺寸 480×720、EF6-589 = 大尺寸 680×960；
  // 广播名认不出（无名设备/从别处跳进来只带了 deviceId）时回落 0x01 自报的 screenType。
  // 两者都拿得到却不一致时以 0x01 为准并告警：0x20 帧头的宽高与帧字节数(宽×高÷2)必须与设备
  // 实际屏幕严格对齐，否则设备直接拒收；广播名只是外壳标识，不能盖过设备自报。
  getScreenSpec() {
    const info = this.data.info || {}
    const fromInfo = {
      screenType: info.screenType,
      width: info.width,
      height: info.height,
      label: info.screen || '',
      source: '0x01 设备信息'
    }
    const fromBroadcast = screenSpecByBroadcastName(this.data.deviceName)
    if (!fromBroadcast) {
      return fromInfo
    }
    if (fromBroadcast.screenType !== info.screenType) {
      this.appendLog({
        type: 'err',
        text: `尺寸判定冲突：广播ID「${fromBroadcast.model}」= ${fromBroadcast.label} ${fromBroadcast.width}×${fromBroadcast.height}，但 0x01 自报 ${info.screen} ${info.width}×${info.height}。以 0x01 为准（帧头/帧长必须跟设备实际屏幕走），请核对这台机子的广播名。`
      })
      return fromInfo
    }
    return {
      screenType: fromBroadcast.screenType,
      width: fromBroadcast.width,
      height: fromBroadcast.height,
      label: fromBroadcast.label,
      source: `广播ID ${fromBroadcast.model}`
    }
  },

  // 上传相册图片 = 真实投屏的**竖向**链路（2026-08-07 起与「我的相框」正式投屏同源）：
  //   ① 选图：sizeType=original 取原图（与 utils/media.chooseFromAlbum 同参，走同一个入口）；
  //   ② 竖向构图：按设备物理分辨率做 aspectFill 中心裁切，并按设备竖向导出角旋转后导出 jpg
  //      （几何与预览页 coverCropOne 一致；调试台没有后端设备记录，verticalRotation 取缺省 0=不旋转）；
  //   ③ 统一压缩：长边缩到设备长边（②的产物恰为设备分辨率 → 原样通过，不二次降质），
  //      与 result.js compressForUpload 同口径；
  //   ④ 第三方 seekink 抖动接口出六色 4bpp 帧：type 按大/小尺寸取（dithering.typeForDevice）；
  //   ⑤ 铁闸校验字节数 = 宽×高÷2，然后走 0x20→0x21→0x22 图传。
  // 与正式投屏唯一的差别：**不调设备管理/投屏记录接口**（setUserProductUpload、
  // editUserProductImgRecord 一概不发），联调不会在真实环境留下投屏记录和图库图片。
  async cmdUploadAlbum() {
    if (!this.ensureUploadReady()) {
      return
    }
    const spec = this.getScreenSpec()
    if (!(spec.width > 0) || !(spec.height > 0)) {
      toast.warn({ title: '未取到设备分辨率，请先点「获取设备信息」', icon: 'none' })
      return
    }

    // ① 选图（与真实投屏同一个入口：原图，不要微信压缩版，压缩版是「上屏发糊」最大来源）
    let picked
    try {
      picked = await media.chooseFromAlbum(1)
    } catch (error) {
      return // 用户取消选择
    }
    const source = picked && picked[0] && picked[0].tempFilePath
    if (!source) {
      return
    }

    const verticalDegree = deviceRotation.verticalDegreeFor(this.data.device)
    this.appendLog({
      type: 'act',
      text: `点击：上传相册图片（真实投屏竖向链路）｜尺寸判定 ${spec.source} → ${spec.label || '--'} ${spec.width}×${spec.height}｜竖向导出角 ${verticalDegree}°｜不调用设备管理/投屏记录接口`
    })

    wx.showLoading({ title: '处理图片中', mask: true })
    let frameData
    try {
      // ② 竖向构图 → 设备物理分辨率
      const composed = await this.coverCropPortrait(source, spec, verticalDegree)
      // ③ 统一压缩（长边 > 设备长边才压；②的产物恰好等于设备分辨率，正常都会原样通过）
      const shrunk = await this.compressForUpload(composed, spec)
      this.appendLog({
        type: 'act',
        text: `已按设备物理分辨率出图：${spec.width}×${spec.height}（${EXPORT_FILE_TYPE} q${EXPORT_QUALITY}），上传 ${(shrunk.bytes / 1024).toFixed(0)}KB${shrunk.compressed ? `（统一压缩 ${shrunk.compressMs}ms）` : '（已不大于设备尺寸，未二次压缩）'}`
      })
      // ④ 第三方抖动接口出帧：客户端不做任何量化/调色，拿到什么就发什么
      const type = dithering.typeForDevice(spec)
      this.appendLog({
        type: 'act',
        text: `调用第三方抖动接口出帧：color=BWRYGB imageDitheringModes=2 type=${type}（${type === '1' ? '小尺寸' : '大尺寸'}）`
      })
      const ditherStartedAt = Date.now()
      frameData = await dithering.requestFrameBin({
        filePath: shrunk.filePath,
        type
      })
      // ⑤ 铁闸校验：字节数必须 = 宽×高÷2，对不上一律不发（与 result.js 主循环同一道闸）
      const expected = Math.floor((spec.width * spec.height) / 2)
      const head = protocol.bytesToHex(frameData.subarray(0, 16))
      this.appendLog({
        type: frameData.length === expected ? 'ok' : 'err',
        text: `第三方出帧完成 ${Date.now() - ditherStartedAt}ms：${frameData.length} 字节（设备需六色4bpp ${expected} 字节）头16=${head}`
      })
      if (frameData.length !== expected) {
        throw new Error(
          `第三方返回的不是电子纸设备要的六色4bpp帧：收到 ${frameData.length} 字节，${spec.width}×${spec.height} 需要 ${expected} 字节`
        )
      }
    } catch (error) {
      wx.hideLoading()
      const text = `上传相册图片失败：${error.message}`
      this.appendLog({ type: 'err', text })
      this.setData({ uploadStatus: text, uploadStatusType: 'err' })
      toast.warn({ title: error.message || '处理失败', icon: 'none' })
      return
    }
    wx.hideLoading()
    this.uploadFrame(
      {
        data: frameData,
        width: spec.width,
        height: spec.height,
        dataSize: frameData.length
      },
      '上传相册图片(真实投屏竖向链路 0x20~0x22)'
    )
  },

  // 竖向构图：按设备物理分辨率做 aspectFill 中心裁切 + 按竖向导出角旋转，导出 jpg 临时文件。
  // 几何与预览页 coverCropOne 逐行对齐（含「奇数直角要对调目标矩形宽高」那条），改前先核对那边。
  // 导出画布恒为设备物理分辨率：第三方按上传图的像素量化成六色帧(字节数=宽×高÷2)，
  // 上传图必须正好是设备尺寸，否则帧大小对不上设备、图传必失败。
  coverCropPortrait(src, spec, rotateDegree) {
    return new Promise((resolve, reject) => {
      wx.getImageInfo({
        src,
        success: info => {
          const natW = info.width
          const natH = info.height
          // 导出角是奇数直角(90/270)时画面在画布上会宽高对调：中心裁切的目标比例与目标矩形都要跟着换
          const quarterTurn = deviceRotation.isQuarterTurn(rotateDegree)
          const destW = quarterTurn ? spec.height : spec.width
          const destH = quarterTurn ? spec.width : spec.height
          const targetRatio = destW / destH
          if (!(natW > 0) || !(natH > 0) || !(targetRatio > 0)) {
            reject(new Error('图片尺寸不可用'))
            return
          }
          // aspectFill 中心裁切：从原图中心取「设备比例」的最大矩形，超出的边裁掉
          let sw
          let sh
          let sx
          let sy
          if (natW / natH > targetRatio) {
            sh = natH // 原图偏宽：高取满，裁掉左右
            sw = Math.round(natH * targetRatio)
            sx = Math.round((natW - sw) / 2)
            sy = 0
          } else {
            sw = natW // 原图偏高（或相等）：宽取满，裁掉上下
            sh = Math.round(natW / targetRatio)
            sx = 0
            sy = Math.round((natH - sh) / 2)
          }
          this.appendLog({
            type: 'act',
            text: `竖向中心裁切：原图 ${natW}×${natH} → 取样 ${sw}×${sh} → 画布 ${spec.width}×${spec.height}${rotateDegree ? `（整幅旋转 ${rotateDegree}°）` : ''}`
          })
          this.exportCanvas(spec.width, spec.height, src, (ctx, img) => {
            const rotateRad = (rotateDegree * Math.PI) / 180
            ctx.save()
            ctx.translate(spec.width / 2, spec.height / 2)
            ctx.rotate(rotateRad)
            ctx.drawImage(img, sx, sy, sw, sh, -destW / 2, -destH / 2, destW, destH)
            ctx.restore()
          }).then(resolve, reject)
        },
        fail: () => reject(new Error('图片读取失败'))
      })
    })
  },

  // 离屏画布导出（与预览页 _exportCanvas 同源）：把 src 载入后交给 draw(ctx, img) 绘制，
  // 导出为 outW×outH 的 jpg 临时文件。用页面里那块定位到屏幕外的 #cropCanvas，串行使用。
  exportCanvas(outW, outH, src, draw) {
    return new Promise((resolve, reject) => {
      const query = wx.createSelectorQuery()
      query
        .select('#cropCanvas')
        .fields({ node: true })
        .exec(res => {
          const node = res && res[0] && res[0].node
          if (!node) {
            reject(new Error('画布不可用'))
            return
          }
          node.width = outW
          node.height = outH
          const ctx = node.getContext('2d')
          const img = node.createImage()
          img.onload = () => {
            ctx.clearRect(0, 0, outW, outH)
            fillWhite(ctx, outW, outH)
            draw(ctx, img)
            wx.canvasToTempFilePath({
              canvas: node,
              fileType: EXPORT_FILE_TYPE,
              quality: EXPORT_QUALITY,
              success: r => resolve(r.tempFilePath),
              fail: () => reject(new Error('画布导出失败'))
            })
          }
          img.onerror = () => reject(new Error('图片解码失败'))
          img.src = src
        })
    })
  },

  // 上传前统一压缩（与 result.js compressForUpload 同口径）：长边缩到「设备长边」、只缩分辨率不改比例。
  // 竖向构图出的图恰为设备分辨率 → 原样通过，不会二次降质。任何失败都原样返回原文件，不阻断联调。
  async compressForUpload(filePath, spec) {
    const bytes = await this.readFileSize(filePath)
    const original = { filePath, bytes, compressMs: 0, compressed: false }
    if (!wx.compressImage || !(spec.width > 0) || !(spec.height > 0)) {
      return original
    }
    const startedAt = Date.now()
    try {
      const size = await new Promise((resolve, reject) => {
        wx.getImageInfo({ src: filePath, success: resolve, fail: reject })
      })
      const longEdge = Math.max(size.width, size.height)
      const deviceLongEdge = Math.max(spec.width, spec.height)
      if (!(longEdge > deviceLongEdge)) {
        return Object.assign({}, original, { compressMs: Date.now() - startedAt })
      }
      const ratio = deviceLongEdge / longEdge
      const compressed = await new Promise((resolve, reject) => {
        wx.compressImage({
          src: filePath,
          quality: UPLOAD_COMPRESS_QUALITY,
          compressedWidth: Math.max(1, Math.round(size.width * ratio)),
          compressedHeight: Math.max(1, Math.round(size.height * ratio)),
          success: resolve,
          fail: reject
        })
      })
      const shrunkBytes = await this.readFileSize(compressed.tempFilePath)
      return {
        filePath: compressed.tempFilePath,
        bytes: shrunkBytes,
        compressMs: Date.now() - startedAt,
        compressed: true
      }
    } catch (error) {
      return Object.assign({}, original, { compressMs: Date.now() - startedAt })
    }
  },

  // 读文件字节数；读不到按 0 处理（只用于日志与压缩判断，不参与正确性）
  readFileSize(filePath) {
    return new Promise(resolve => {
      try {
        wx.getFileSystemManager().getFileInfo({
          filePath,
          success: res => resolve(Number(res.size) || 0),
          fail: () => resolve(0)
        })
      } catch (error) {
        resolve(0)
      }
    })
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
          text: `头部宽高 ${hWidth}×${hHeight} 与本电子纸设备 ${info.width}×${info.height} 不一致：仍按本电子纸设备尺寸取尾部 ${expectBytes} 字节发送，请核对文件是否为本机型。`
        })
      }
      if (hFormat !== 0x01) {
        notes.push({
          type: 'err',
          text: `头部 FORMAT=0x${hFormat.toString(16).padStart(2, '0')} 非 0x01：固件目前只支持 0x01（六色 4bpp 原始帧），继续直发但可能被电子纸设备拒绝。`
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
      const verdict = `电子纸设备不支持读取连接间隔(0x05)：${error.message}`
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
        return '连接间隔已确认生效仍卡住 → 基本可判定是「电子纸设备吃不下这个速率」：把发送速度调慢一档（pace 调大）后重试，问题不在连接参数。'
      case 'not-applied':
        return '电子纸设备对 0x13 回了成功但复读没变 → 连接间隔实际没生效：先查固件 0x13 是否真正更新链路参数，再谈速率。'
      case 'rejected':
        return '0x13 被拒（不支持/忙）→ 连接间隔没生效：先解决 0x13 设置，或只靠 pace/窗口调速。'
      case 'unsupported':
        return '电子纸设备不支持连接间隔指令(0x05) → 用不了它提速：只能靠 pace（每包间隔）/窗口来调。'
      case 'unconfirmed':
        return '设了 0x13 但复读失败，无法确认是否生效：建议重连后手动点「获取连接间隔(0x05)」核对。'
      default:
        return ''
    }
  },

  // 把 uploadImage 返回的 transferStats 压成一行「调参要看的数」写进页面日志。
  // 重点是「配置值 → 实际收敛值」这一对：窗口/每包间隔若被自适应压到远低于配置值，
  // 说明设备吃不下这组参数，页面上把它调小才有意义；两者接近就说明参数已经跑满，
  // 再快得靠 MTU/每包字节数（减少包数）而不是继续往下压间隔。
  transferStatsText(stats) {
    if (!stats) {
      return '本次图传无统计数据'
    }
    const seconds = ms => (Number(ms || 0) / 1000).toFixed(1)
    return (
      `[实测] 数据 ${stats.dataSize} 字节 / ${stats.totalPackets} 包 · ` +
      `MTU ${stats.mtu} · 每包 ${stats.chunkSize} 字节 · ` +
      `吞吐 ${stats.throughputKbps || 0} KB/s · ` +
      `数据段 ${seconds(stats.dataMs)}s（其中等应答 ${seconds(stats.ackWaitMs)}s）· ` +
      `总耗时 ${seconds(stats.totalMs)}s\n` +
      `[自适应] 窗口 ${stats.window} → 最低 ${stats.minWindow} → 收尾 ${stats.finalWindow} 包 · ` +
      `每包间隔 ${stats.configuredPace} → ${stats.finalPace}ms · ` +
      `退让 ${stats.retryEvents} 次（宽限等待 ${stats.ackGraceWaits} 次）· ` +
      `重发 ${stats.retransmittedPackets} 包 / 共发 ${stats.sentPackets} 包 · ` +
      `写失败重试 ${stats.writeFailures} 次 · 预组帧 ${stats.prebuiltFrames ? '是' : '否'}`
    )
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
        toast.warn({ title: '电子纸设备已存满，请先删除图片', icon: 'none' })
        return
      }
    }

    // 每包数据字节数取「0x21 数据字节」输入框的值，并按当前会话 MTU 夹一次（塞不进就自动降到
    // MTU-11）——与 uploadImage 内部同一套规则，故这里算出的包数就是实际包数。
    const chunkSize = this.refreshEffectiveChunk()
    const totalPackets = Math.ceil(frame.dataSize / chunkSize)
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
      text: `${label} → 槽位 ${index}，数据 ${frame.dataSize} 字节 / ${totalPackets} 包（每包 ${chunkSize} 字节 · 窗口 ${this.data.windowSize} 包 · 每包间隔 ${this.data.pace}ms · MTU ${this.data.sessionMtu || '--'}）`
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

    // 与真实投屏对齐的预处理（D1/D2）：先把整图 CRC32 算好、按本次实际分包大小把全部 0x21 帧
    // 预组出来，发送循环里就只剩「写一包」。此前调试台没做这步，每包都要在两次 write 之间现组帧，
    // 这笔 CPU 正好挤在 BLE 热路径上——同一张图调试台因此天生比真实投屏慢一截。
    let prepared = null
    try {
      prepared = await deviceBle.prepareImageTransfer(
        this.data.deviceId,
        frame.data,
        { chunkSize }
      )
    } catch (error) {
      // 预处理纯属提速，失败就退回「发送时现组」，不影响图传本身
    }

    let lastProgressAt = 0
    let lastPercent = -1
    try {
      const summary = await deviceBle.uploadImage(this.data.deviceId, {
        screenType: info.screenType,
        index,
        prepared,
        // 0x20 帧头必须描述**正在发的这份数据**：取帧自带的宽高（三条上传路径都按它出的数据），
        // 缺省才回落设备自报值。帧长与宽高对不上时设备会在 0x22 拒收。
        width: frame.width || info.width,
        height: frame.height || info.height,
        data: frame.data,
        pace: this.data.pace, // 发送速度（每包间隔 ms）起点，由页面"发送速度"档位决定
        window: this.data.windowSize, // 图传窗口上限(发满多少包等一次累计应答)，由页面"发包窗口"输入框决定
        chunkSize, // 0x21 每包图片数据字节数，由页面"0x21 数据字节"输入框决定（真实投屏不传此项）
        // 自适应调速（AIMD：卡顿即窗口减半+间隔翻倍、稳定后再涨回）。2026-08-14 起它已是
        // uploadImage 的默认策略（真实投屏同样走这条），这里显式写着只为让调试台的口径一目了然。
        adaptive: true,
        shouldAbort: () => this._uploadAborted, // 息屏/切后台时由 onHide 置为 true
        // 进度更新节流到约 8 次/秒（与真实投屏 result.js 同一口径）：每个窗口都 setData 会把
        // 长字符串跨线程推给视图层，反过来占住 JS 线程、推迟 0x23 应答的处理，越刷越慢。
        // start/done/retry 与 100% 仍立即更新，卡顿提示不会被压掉。
        onProgress: (done, total, phase, detail) => {
          const percent = total ? Math.min(100, Math.floor((done / total) * 100)) : 0
          const now = Date.now()
          const immediate =
            phase === 'start' ||
            phase === 'done' ||
            phase === 'retry' ||
            percent === 100
          if (
            !immediate &&
            (percent === lastPercent || now - lastProgressAt < 120)
          ) {
            return
          }
          lastProgressAt = now
          lastPercent = percent
          const patch = { uploadPercent: percent, uploadStatusType: 'info' }
          if (phase === 'retry' && detail) {
            // 卡顿重试：把「停在第几包、第几次退让、退到什么速率」实时显示出来。
            // 若 stuckAt 长时间不变 → 多为设备中断/链路断；若缓慢变大 → 只是慢，仍在收敛，多半能传完。
            patch.uploadStatus =
              `传输卡顿：停在第 ${detail.stuckAt} 包，第 ${detail.retries} 次退让…` +
              `已自动降到 窗口 ${detail.window} 包 / 每包间隔 ${detail.pace}ms` +
              `（包号长时间不动才是电子纸设备侧中断或链路问题；缓慢变大只是设备吃不下当前速率，正在自动收敛）`
          } else {
            patch.uploadStatus = `传输中：${done}/${total} 包`
          }
          this.setData(patch)
        }
      })
      // 与真实投屏的「[投屏性能] 单张汇总」打同一组字段（uploadImage 返回的 transferStats：
      // mtu/chunkSize/totalPackets/window/configuredPace/finalPace/dataMs/ackWaitMs/
      // ackTimeouts/retryEvents/throughputKbps…）。同一张图两边各传一次，字段一对就知道慢在哪。
      console.log('[调试台图传]', summary.transferStats)
      const okText = `图传完成 ✓ 电子纸设备现存 ${summary.imgCount} 张，剩余 ${summary.storageFree} 字节`
      this.appendLog({ type: 'ok', text: okText })
      // 实测口径直接落到页面日志里：调参靠的就是这几个数，不用去翻 vConsole
      this.appendLog({
        type: 'act',
        text: this.transferStatsText(summary.transferStats)
      })
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
        ? '图传已中断：上传时手机息屏/切到后台，蓝牙在后台会暂停、电子纸设备也会超时。请保持屏幕常亮后重新上传。'
        : `图传失败：${error.message}`
      // 非息屏类失败：把图传前的连接间隔诊断结论拼上，直接告诉是「没生效」还是「吃不下速率」。
      if (!aborted && connDiag) {
        text += `\n连接间隔诊断：${connDiag.verdict}\n→ ${this.connDiagConclusion(connDiag.category)}`
      }
      this.appendLog({ type: 'err', text })
      // 失败也把实测数据打出来：自适应最后退到多少窗口/多少 ms 仍传不动，是判读设备侧问题的关键
      if (error && error.transferStats) {
        console.log('[调试台图传失败]', error.transferStats)
        this.appendLog({
          type: 'act',
          text: this.transferStatsText(error.transferStats)
        })
      }
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
}))
