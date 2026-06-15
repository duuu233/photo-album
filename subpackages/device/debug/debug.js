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
      wx.showToast({ title: '指令成功', icon: 'success' })
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
        wx.chooseMedia({ count: 1, mediaType: ['image'], sizeType: ['compressed'], success: resolve, fail: reject })
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
      const imageData = await this.imageToImageData(srcPath, info.width, info.height)
      frame = imageCodec.fromImageData(imageData, info.width, info.height)
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

  // 大图预压缩：仅在原图长边明显大于目标显示尺寸时，按比例把长边限制到 maxEdge 再返回新临时路径。
  // 目的是给后面的离屏 canvas 解码减负，避免超大原图直接全分辨率解码导致内存吃紧/解码失败。
  // 任何环节失败（老版本不支持 / 取不到尺寸 / 压缩报错）都退回用原图，绝不阻断上传。
  shrinkIfHuge(path, targetW, targetH) {
    return new Promise(resolve => {
      if (!wx.compressImage) {
        resolve(path) // 基础库过老不支持 compressImage，直接用原图
        return
      }
      wx.getImageInfo({
        src: path,
        success: ({ width, height }) => {
          // 长边上限取「目标长边 ×2」并兜底 1280：留一倍清晰度余量，又把内存压在可控范围
          const maxEdge = Math.max(1280, Math.max(targetW, targetH) * 2)
          const srcMax = Math.max(width, height)
          if (!srcMax || srcMax <= maxEdge) {
            resolve(path) // 原图本就不大，无需压缩（也避免被放大）
            return
          }
          const scale = maxEdge / srcMax
          wx.compressImage({
            src: path,
            // 同一缩放系数算出的宽高，宽高比不变；设了尺寸后 quality 会失效，留着无害
            compressedWidth: Math.round(width * scale),
            compressedHeight: Math.round(height * scale),
            quality: 80,
            success: res => {
              this.appendLog({ type: 'act', text: `原图 ${width}×${height} 较大，已预压到约 ${Math.round(width * scale)}×${Math.round(height * scale)} 再解码` })
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
  imageToImageData(path, width, height) {
    return new Promise((resolve, reject) => {
      if (!wx.createOffscreenCanvas) {
        reject(new Error('当前微信版本不支持离屏 canvas'))
        return
      }
      const canvas = wx.createOffscreenCanvas({ type: '2d', width, height })
      const ctx = canvas.getContext('2d')
      const img = canvas.createImage()
      img.onload = () => {
        ctx.clearRect(0, 0, width, height)
        ctx.drawImage(img, 0, 0, width, height) // 拉伸铺满目标尺寸（不保持比例，联调够用）
        try {
          resolve(ctx.getImageData(0, 0, width, height))
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
      wx.showToast({ title: '上传成功', icon: 'success' })
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
