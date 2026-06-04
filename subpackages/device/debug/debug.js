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
    existingIndexes: '', // 设备上已有图片的索引列表，便于决定删哪张/传到哪
    autoUploadIndex: -1, // 自动挑选的空闲槽位

    // 指令输入框
    playMode: 'order', // 'order' 顺序 / 'random' 随机
    intervalInput: '60', // 切换间隔(秒)
    switchInput: '0', // 0x24 要显示的图片索引
    deleteInput: '', // 0x12 要删除的图片索引，逗号分隔，如 "0,2"
    uploadIndexInput: '', // 上传槽位，留空则自动选空闲位

    // 状态
    busy: false, // 有指令正在等应答，避免并发
    uploading: false,
    uploadPercent: 0,

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
    if (this.data.deviceId) {
      deviceBle.disconnect(this.data.deviceId) // 释放连接，让设备能重新广播被别的手机连
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
      await deviceBle.ensureConnection(this.data.deviceId)
      this.setData({ connected: true })
      this.appendLog({ type: 'ok', text: `已连接：${this.data.deviceName}` })
      await this.refreshInfoSilently()
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
    this.setData({ connected: false, info: null })
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
      format: cfg => `播放配置：${cfg.playMode === 'random' ? '随机' : '顺序'} · 间隔 ${cfg.intervalSeconds} 秒`
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

  // ── 设置类指令 ──────────────────────────────────────────
  onPlayModeChange(e) {
    this.setData({ playMode: e.detail.value })
  },

  onIntervalInput(e) {
    this.setData({ intervalInput: e.detail.value })
  },

  cmdSetPlay() {
    const interval = Number(this.data.intervalInput)
    if (!Number.isFinite(interval) || interval < 1) {
      wx.showToast({ title: '请输入有效的间隔秒数', icon: 'none' })
      return
    }
    this.runCommand('设置播放配置(0x10)', () => deviceBle.setPlayback(this.data.deviceId, this.data.playMode, interval), {
      refresh: true,
      format: () => `已设为 ${this.data.playMode === 'random' ? '随机' : '顺序'} 播放 · 间隔 ${interval} 秒`
    })
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
      const imageData = await this.imageToImageData(tempPath, info.width, info.height)
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
    this.setData({ uploading: true, uploadPercent: 0 })
    this.appendLog({ type: 'act', text: `${label} → 槽位 ${index}，数据 ${frame.dataSize} 字节 / ${totalPackets} 包` })

    try {
      const summary = await deviceBle.uploadImage(this.data.deviceId, {
        screenType: info.screenType,
        index,
        width: info.width,
        height: info.height,
        data: frame.data,
        onProgress: (done, total) => {
          this.setData({ uploadPercent: Math.floor((done / total) * 100) })
        }
      })
      this.appendLog({ type: 'ok', text: `图传完成：设备现存 ${summary.imgCount} 张，剩余 ${summary.storageFree} 字节` })
      // 传完顺手刷新屏幕显示这张，便于直接在屏上确认
      await deviceBle.refreshScreen(this.data.deviceId, index)
      await this.refreshInfoSilently()
      wx.showToast({ title: '上传成功', icon: 'success' })
    } catch (error) {
      this.appendLog({ type: 'err', text: `图传失败：${error.message}` })
      wx.showModal({ title: '图传失败', content: error.message, showCancel: false })
    } finally {
      this.setData({ uploading: false })
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
