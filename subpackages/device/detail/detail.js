const api = require('../../../utils/api')
const toast = require('../../../utils/toast')
const system = require('../../../utils/system')
const batteryUtil = require('../../../utils/battery')
const deviceBle = require('../../../utils/device-ble')
const otaBle = require('../../../utils/ota-ble')
const protocol = require('../../../utils/frame-protocol')
const media = require('../../../utils/media')
const bluetooth = require('../../../utils/bluetooth')
const permission = require('../../../utils/permission')

const app = getApp()

// 计算设备存储使用百分比（已用/总量），上限 100，用于进度条展示
function memoryPercent(device) {
  if (!device || !device.totalMemory) {
    return 0
  }
  return Math.min(
    100,
    Math.round((device.usedMemory / device.totalMemory) * 100)
  )
}

function getPlaybackLabel(device) {
  if (
    !device ||
    device.playbackMode === 'manual' ||
    device.carouselEnabled === false
  ) {
    return '已关闭'
  }
  return device.playbackMode === 'random' ? '随机轮播' : '顺序轮播'
}

function hexStringToBytes(hex) {
  return String(hex || '')
    .split(/\s+/)
    .filter(Boolean)
    .map(part => parseInt(part, 16))
    .filter(value => Number.isFinite(value))
}

function formatHexByte(value) {
  return Number(value || 0)
    .toString(16)
    .padStart(2, '0')
    .toUpperCase()
}

function logClearDeviceFrame(traceId, record) {
  if (!record) {
    return
  }
  const cmdHex = formatHexByte(record.cmd)
  const dirText = record.dir === 'TX' ? '发送给设备' : '设备返回'
  const note = record.note ? ' ' + record.note : ''
  let ackText = ''

  if (record.dir === 'RX' && Number(record.cmd) === protocol.ACK) {
    const parsed = protocol.tryParseFrame(hexStringToBytes(record.hex))
    if (parsed && parsed.frame) {
      const ack = protocol.parseAck(parsed.frame.payload)
      ackText =
        ' ACK_CMD=0x' +
        formatHexByte(ack.ackCmd) +
        ' RESULT=0x' +
        formatHexByte(ack.result) +
        '(' +
        protocol.resultText(ack.result) +
        ')'
    }
  }

  console.log(
    '[一键清空][' +
      traceId +
      '] ' +
      dirText +
      ' CMD=0x' +
      cmdHex +
      ackText +
      note +
      ': ' +
      record.hex
  )
}

function logClearDeviceData(traceId, label, data) {
  console.log('[一键清空][' + traceId + '] ' + label + ':', data)
}

function textValue(value) {
  return String(value || '').trim()
}

function isUpdateFlag(device) {
  return Number(device && device.isUpdate) === 1
}

function isBinFirmwareUrl(url) {
  return /\.bin(?:[?#]|$)/i.test(textValue(url))
}

function getBleDeviceId(device) {
  return textValue(device && (device.deviceId || device.bleDeviceId))
}

const OTA_OP = otaBle.OP // { START:0xF1, DATA:0xF2, RESULT:0xF3, ACK:0xFC }

// 把一帧 OTA 收发记录解析成可读中文，配合原始 16 进制一起打印，方便与硬件日志逐帧比对。
// 设备应答帧头为 0xFC(RSP_OPCODE)，第 2 字节回显被应答的操作码；兼容旧固件「不带 0xFC、直接以操作码打头」。
function describeOtaFrame(record) {
  const bytes = hexStringToBytes(record.hex)
  if (!bytes.length) {
    return '空帧'
  }

  if (record.dir === 'TX') {
    if (bytes[0] === OTA_OP.START) {
      return 'START(0xF1) 开始帧'
    }
    if (bytes[0] === OTA_OP.DATA) {
      return 'DATA(0xF2) 数据包 seq=' + (bytes[1] | (bytes[2] << 8))
    }
    return '发送 opcode=0x' + formatHexByte(bytes[0])
  }

  const hasHeader = bytes[0] === OTA_OP.ACK
  const echo = hasHeader ? bytes[1] : bytes[0]

  if (echo === OTA_OP.START) {
    const i = hasHeader ? 2 : 1
    return (
      'START 应答 回显0xF1 RESULT=0x' +
      formatHexByte(bytes[i]) +
      '(' +
      otaBle.otaResultText(bytes[i]) +
      ') MTU=' +
      (bytes[i + 1] || 0) +
      ' PRN=' +
      (bytes[i + 2] || 0)
    )
  }
  if (echo === OTA_OP.DATA) {
    const i = hasHeader ? 3 : 1
    return 'DATA 应答 回显0xF2 已连续接收到第 ' + (bytes[i] | (bytes[i + 1] << 8)) + ' 包'
  }
  if (echo === OTA_OP.RESULT) {
    const i = hasHeader ? 2 : 1
    return (
      '最终结果(0xF3) RESULT=0x' +
      formatHexByte(bytes[i]) +
      '(' +
      otaBle.otaResultText(bytes[i]) +
      ')'
    )
  }
  return '未识别应答'
}

// 0xF3 最终结果帧的 RESULT 偏移在规格书里未最终敲定（时序图疑似 F3 后还夹了 1 字节子操作码再到 RESULT，
// 见 docs/OTA-DFU-问题排查与修复进度.md §5.2）。联调阶段把两种解读都算出来一起打印：
// 解读A=紧跟 0xF3 的字节(ota-ble 现用)；解读B=再往后 1 字节。哪个是 0x00 成功，真实语义就是哪个。
function decodeFinalResultFrame(hex) {
  const bytes = hexStringToBytes(hex)
  const hasHeader = bytes[0] === OTA_OP.ACK
  const base = hasHeader ? 2 : 1 // 跳过可选的 0xFC 帧头 + 回显的 0xF3
  const fmt = value =>
    value === undefined
      ? '(无此字节)'
      : '0x' + formatHexByte(value) + '(' + otaBle.otaResultText(value) + ')'
  return (
    '0xF3 原始帧=' + hex +
    ' ｜ 解读A(F3+RESULT,现用)=' + fmt(bytes[base]) +
    ' ｜ 解读B(F3+子码+RESULT)=' + fmt(bytes[base + 1])
  )
}

function getOtaValidationError(device) {
  if (!isUpdateFlag(device)) {
    return '当前已是最新版本'
  }

  const version = textValue(device && device.newVersionNo)
  const url = textValue(device && device.downloadPath)

  if (!version || !url) {
    return '检测到设备可更新，但缺少新版本号或固件下载地址，请稍后重试。'
  }

  if (!isBinFirmwareUrl(url)) {
    return '固件下载地址不是有效的 .bin 文件，请稍后重试。'
  }

  return ''
}

Page({
  data: {
    statusBarHeight: 20,
    safeBottom: 0,
    id: '',
    device: null,
    memoryPercent: 0,
    batteryIcon: batteryUtil.getBatteryIcon(batteryUtil.DEFAULT_BATTERY),
    deviceCode: '',
    memoryText: '',
    macAddress: '',
    newVersionNo: '--',
    batteryText: '--',
    playbackLabel: '',
    intervalOptions: [1, 2, 4, 8, 24],
    intervalIndex: 1,
    showClearConfirm: false,
    showDeleteConfirm: false,
    clearClosing: false, // 清空确认弹窗是否正在播放退场动画
    deleteClosing: false, // 删除确认弹窗是否正在播放退场动画
    showMediaSheet: false, // 「拍照/相册」选择弹层是否展示
    mediaSheetClosing: false, // 选择弹层是否正在播放退场动画
    otaTesting: false, // OTA 测试按钮是否正在跑（跑时禁止重复点击）
    otaTestStatus: '点击用本地固件测试', // OTA 测试按钮右侧状态文案
    loading: true,
    loadError: false
  },

  onLoad(options) {
    this.setSystemMetrics()
    this.setData({
      id: options.id || ''
    })
  },

  onShow() {
    this.loadDetail()
  },

  // OTA 测试进行中切到后台：与 ota 页一致，标记中断——DFU 期间手机切后台会导致传输中断。
  onHide() {
    if (this.data.otaTesting) {
      this._otaTestAbort = true
    }
  },

  onUnload() {
    this._otaTestAbort = true
  },

  noop() {},

  setSystemMetrics() {
    this.setData(system.getLayoutMetrics())
  },

  goBack() {
    const pages = getCurrentPages()

    if (pages.length > 1) {
      wx.navigateBack()
      return
    }

    wx.navigateTo({
      url: '/subpackages/device/list/list'
    })
  },

  // 拉取设备详情并派生出页面展示字段（含轮播间隔下标、设备编号、内存文案等）
  // 接口失败时不再让 device 悬空：标记 loadError 走统一空态，提供「重新加载」入口
  async loadDetail() {
    if (!this.data.device) {
      this.setData({ loading: true, loadError: false })
    }

    let device
    try {
      device = await api.getDeviceDetail(this.data.id)
    } catch (error) {
      this.setData({
        loading: false,
        loadError: true
      })
      return
    }

    const selected = app.globalData.selectedDevice

    if (selected && String(selected.id) === String(device && device.id)) {
      device = Object.assign({}, device, {
        deviceId: device.deviceId || selected.deviceId,
        bleDeviceId:
          device.bleDeviceId || selected.bleDeviceId || selected.deviceId,
        battery:
          typeof device.battery === 'number' ? device.battery : selected.battery
      })
    }

    if (device && device.deviceId && deviceBle.isConnected(device.deviceId)) {
      try {
        const info = await deviceBle.readDeviceInfo(device.deviceId)
        device = Object.assign({}, device, {
          connected: true,
          battery: info.battery,
          usedMemory: info.imgCount,
          totalMemory: info.capacity,
          playbackMode: info.playMode,
          intervalSeconds: info.intervalSeconds,
          intervalHours: info.intervalSeconds
            ? Math.max(1, Math.round(info.intervalSeconds / 3600))
            : device.intervalHours,
          firmwareVersion: info.firmwareVersion || device.firmwareVersion
        })
      } catch (error) {
        // 详情展示不因刷新蓝牙状态失败而中断。
      }
    }
    // 把当前间隔小时数映射到选择器下标，缺省落到第 1 项（2 小时）
    const intervalIndex = this.data.intervalOptions.indexOf(
      device ? device.intervalHours : 2
    )
    // 设备编号取末 6 位数字作为展示码；真实数据缺失时用 -- 占位（不再用假的 123456）
    const digitId =
      device && device.deviceNo
        ? String(device.deviceNo).replace(/\D/g, '').slice(-6)
        : ''
    const hasBattery = device && typeof device.battery === 'number'

    this.setData({
      device,
      memoryPercent: memoryPercent(device),
      batteryIcon: batteryUtil.getBatteryIcon(
        hasBattery ? device.battery : batteryUtil.DEFAULT_BATTERY
      ),
      batteryText: hasBattery ? `${device.battery}%` : '--',
      deviceCode: digitId || '--',
      memoryText:
        device && device.totalMemory
          ? `${device.usedMemory}/${device.totalMemory}`
          : '--',
      macAddress: device && device.macAddress ? device.macAddress : '--',
      newVersionNo:
        device && device.newVersionNo
          ? device.newVersionNo
          : device && device.firmwareVersion
            ? device.firmwareVersion
            : '--',
      playbackLabel: getPlaybackLabel(device),
      intervalIndex: intervalIndex > -1 ? intervalIndex : 1,
      loading: false,
      loadError: false
    })
  },

  // 通过可输入的系统弹窗重命名设备，重命名后若是当前选中设备需同步更新全局
  async renameDevice() {
    if (!this.data.device) {
      return
    }

    wx.showModal({
      title: '编辑设备名称',
      editable: true,
      placeholderText: '请输入设备名称',
      content: this.data.device.name,
      success: async res => {
        if (!res.confirm || !res.content.trim()) {
          return // 取消或输入为空则不处理
        }

        const device = await api.renameDevice(this.data.id, res.content.trim())
        if (
          app.globalData.selectedDevice &&
          app.globalData.selectedDevice.id === device.id
        ) {
          app.setSelectedDevice(device)
        }
        this.setData({
          device,
          memoryPercent: memoryPercent(device)
        })
      }
    })
  },

  async toggleCarousel(e) {
    if (!this.data.device) {
      return
    }

    const currentMode =
      this.data.device.playbackMode === 'manual'
        ? 'order'
        : this.data.device.playbackMode
    await this.applyPlayback(
      e.detail.value ? currentMode || 'order' : 'manual',
      this.data.device.intervalHours,
      e.detail.value
    )
  },

  // 切换播放模式：单选值 '0' 为顺序，其余为随机
  async changePlayback(e) {
    if (!this.data.device) {
      return
    }

    const mode = e.detail.value === '0' ? 'order' : 'random'
    await this.applyPlayback(mode, this.data.device.intervalHours, true)
  },

  // 切换轮播间隔：picker 返回的是 intervalOptions 的下标，需转换为实际小时数
  async changeInterval(e) {
    if (!this.data.device) {
      return
    }

    const intervalHours = this.data.intervalOptions[Number(e.detail.value)]
    await this.applyPlayback(
      this.data.device.playbackMode || 'order',
      intervalHours,
      this.data.device.carouselEnabled !== false
    )
  },

  async applyPlayback(mode, intervalHours, carouselEnabled) {
    const device = this.data.device
    if (!device || !device.deviceId) {
      toast.warn({
        title: '请先连接设备',
        icon: 'none'
      })
      return
    }

    const hours = Number(intervalHours) || 2
    const intervalSeconds = Math.max(1, Math.round(hours * 3600))

    wx.showLoading({ title: '保存中', mask: true })
    try {
      await deviceBle.setPlayback(device.deviceId, mode, intervalSeconds)
      const updated = Object.assign({}, device, {
        connected: true,
        playbackMode: mode,
        intervalSeconds,
        intervalHours: hours,
        carouselEnabled
      })
      const intervalIndex = this.data.intervalOptions.indexOf(hours)

      if (
        app.globalData.selectedDevice &&
        app.globalData.selectedDevice.id === updated.id
      ) {
        app.setSelectedDevice(updated)
      }

      this.setData({
        device: updated,
        playbackLabel: getPlaybackLabel(updated),
        intervalIndex:
          intervalIndex > -1 ? intervalIndex : this.data.intervalIndex
      })
      toast.show({ title: '已保存', icon: 'none' })
    } catch (error) {
      toast.warn({
        title: error.message || '保存失败',
        icon: 'none'
      })
    } finally {
      wx.hideLoading()
    }
  },

  // 顶部「投屏」：要求设备已连接，弹出「拍照/相册」二选一，由用户选择投屏方式（与首页一致）。
  startProjection() {
    const device = this.data.device
    if (!device) {
      return
    }
    const bleId = device.deviceId || device.bleDeviceId
    if (!(bleId && deviceBle.isConnected(bleId))) {
      toast.warn({ title: '请先连接设备', icon: 'none' })
      return
    }

    // 设为当前选中设备，预览/结果页据此连接并图传
    app.setSelectedDevice(device)
    this.setData({ showMediaSheet: true, mediaSheetClosing: false })
  },

  // 关闭「拍照/相册」选择弹层（带退场动画，与删除/清空确认弹窗一致）
  hideMediaSheet() {
    if (this.data.mediaSheetClosing) {
      return
    }
    this.setData({ mediaSheetClosing: true })
    setTimeout(() => {
      this.setData({ showMediaSheet: false, mediaSheetClosing: false })
    }, 220)
  },

  // 选「拍照」：调起相机拍一张后进入投屏
  chooseCamera() {
    this.pickAndProject(() => media.chooseFromCamera())
  },

  // 选「相册」：从相册选图后进入投屏
  chooseAlbum() {
    this.pickAndProject(() => media.chooseFromAlbum())
  },

  // 选图（拍照/相册）后跳投屏预览：用户取消选择不报错；选到图先关弹层再带数据跳转，
  // 避免弹层 flag 残留导致从预览返回详情页时弹层又冒出来。
  async pickAndProject(pickImages) {
    const device = this.data.device
    if (!device) {
      return
    }

    let images
    try {
      images = await pickImages()
    } catch (error) {
      if (error && error.errMsg && error.errMsg.indexOf('cancel') > -1) {
        return // 用户取消选择不算错误，保留弹层让其重新选择
      }
      toast.warn({ title: '选择照片失败', icon: 'none' })
      return
    }
    if (!images || !images.length) {
      return
    }

    this.setData({ showMediaSheet: false, mediaSheetClosing: false })
    wx.setStorageSync('pendingProjection', { device, images })
    wx.navigateTo({
      url: '/subpackages/projection/preview/preview'
    })
  },

  // 顶部「连接 / 断开」：已连接则断开；未连接则重扫匹配本设备并连接（BLE deviceId 每次扫描会话才有效）。
  async toggleConnection() {
    const device = this.data.device
    if (!device) {
      return
    }

    if (device.connected) {
      if (device.deviceId) {
        deviceBle.disconnect(device.deviceId)
      }
      const updated = Object.assign({}, device, { connected: false })
      if (
        app.globalData.selectedDevice &&
        app.globalData.selectedDevice.id === updated.id
      ) {
        app.setSelectedDevice(updated)
      }
      this.setData({ device: updated })
      toast.show({ title: '已断开', icon: 'none' })
      return
    }

    wx.showLoading({ title: '搜索设备中', mask: true })
    try {
      const location = await permission.getCurrentLocation()
      if (!location) {
        throw new Error('请先授权定位后再连接')
      }
      await bluetooth.openAdapter()
      const found = await bluetooth.discoverDevices({ timeout: 6000 })
      const target = this.matchScannedDevice(found, device)
      if (!target) {
        throw new Error('未搜索到该设备，请确认设备已开机并在附近')
      }

      wx.showLoading({ title: '连接设备中', mask: true })
      await deviceBle.ensureConnection(target.deviceId)
      const info = await deviceBle.readDeviceInfo(target.deviceId)
      const updated = Object.assign({}, device, {
        deviceId: target.deviceId,
        bleDeviceId: target.deviceId,
        connected: true,
        battery: info.battery,
        usedMemory: info.imgCount,
        totalMemory: info.capacity,
        playbackMode: info.playMode,
        intervalSeconds: info.intervalSeconds,
        intervalHours: info.intervalSeconds
          ? Math.max(1, Math.round(info.intervalSeconds / 3600))
          : device.intervalHours,
        firmwareVersion: info.firmwareVersion || device.firmwareVersion
      })
      app.setSelectedDevice(updated)

      const hasBattery = typeof updated.battery === 'number'
      this.setData({
        device: updated,
        memoryPercent: memoryPercent(updated),
        batteryIcon: batteryUtil.getBatteryIcon(
          hasBattery ? updated.battery : batteryUtil.DEFAULT_BATTERY
        ),
        batteryText: hasBattery ? `${updated.battery}%` : '--',
        memoryText: updated.totalMemory
          ? `${updated.usedMemory}/${updated.totalMemory}`
          : '--',
        playbackLabel: getPlaybackLabel(updated),
        newVersionNo: updated.newVersionNo || updated.firmwareVersion || '--'
      })
      toast.show({ title: '已连接', icon: 'none' })
    } catch (error) {
      if (error && error.code === 'PERMISSION_DENIED') {
        bluetooth.showPermissionGuide()
      } else {
        toast.warn({
          title: (error && error.message) || '连接失败',
          icon: 'none'
        })
      }
    } finally {
      wx.hideLoading()
    }
  },

  // 把后端设备(序列号/名称)与扫描结果匹配，返回带「本次会话有效 deviceId」的那条（序列号优先，名称兜底）。
  matchScannedDevice(found, device) {
    const list = found || []
    const serial = String(
      (device && (device.deviceNo || device.productDeviceId)) || ''
    ).trim()
    if (serial) {
      const bySerial = list.find(
        item => String(item.deviceNo || '').trim() === serial
      )
      if (bySerial) {
        return bySerial
      }
    }
    const name = String((device && device.name) || '').trim()
    if (name) {
      const byName = list.find(item => String(item.name || '').trim() === name)
      if (byName) {
        return byName
      }
    }
    return null
  },

  goSlideshow() {
    wx.navigateTo({
      url: `/subpackages/device/slideshow/slideshow?id=${this.data.id}`
    })
  },

  goOtaUpgrade() {
    const device = this.data.device
    if (!device) {
      return
    }

    const validationError = getOtaValidationError(device)
    if (validationError) {
      wx.showModal({
        title: 'OTA升级',
        content: validationError,
        showCancel: false,
        confirmText: '知道了'
      })
      return
    }

    const bleDeviceId = getBleDeviceId(device)
    if (!(bleDeviceId && deviceBle.isConnected(bleDeviceId))) {
      toast.warn({ title: '请先连接设备', icon: 'none' })
      return
    }

    app.setSelectedDevice(
      Object.assign({}, device, {
        deviceId: bleDeviceId,
        bleDeviceId,
        connected: true
      })
    )

    wx.navigateTo({
      url: `/subpackages/device/ota/ota?id=${this.data.id}&auto=1`
    })
  },

  // 长按「OTA升级」进入本地固件测试流程：用代码包内的测试 .bin 走真实 DFU（设备已连接）
  // 或干跑校验（未连接）。先把当前设备设为全局选中，OTA 页据此拿到 bleDeviceId。
  goOtaTest() {
    if (this.data.device) {
      app.setSelectedDevice(this.data.device)
    }
    wx.showModal({
      title: '本地固件测试',
      content:
        '将使用代码包内的测试固件进入 OTA 流程：设备已连接则执行真实蓝牙 DFU 升级，未连接则仅做干跑校验（不写设备）。是否继续？',
      confirmText: '进入测试',
      confirmColor: '#ff6a20',
      success: res => {
        if (res.confirm) {
          wx.navigateTo({
            url: `/subpackages/device/ota/ota?id=${this.data.id}&test=1`
          })
        }
      }
    })
  },

  // 「OTA测试升级」按钮：一点即用详情接口下发的 downloadPath(当前给的文件)边下边走 DFU 测试。
  // 设备已连接 → 真实蓝牙 DFU；未连接 → 干跑(仅下载校验读包/组帧/分包，无设备应答)。
  // 全程把和设备的交互逐帧打印：设备返回的应答(START ACK / DATA ACK / 0xF3 最终结果)全打印，
  // 尤其是传输完毕设备返回的最终结果；失败也打印完整错误。
  async startOtaTest() {
    if (this.data.otaTesting) {
      return // 跑的过程中禁止重复点击
    }

    const device = this.data.device
    if (!device) {
      return
    }

    const bleDeviceId = getBleDeviceId(device)
    const connected = !!(bleDeviceId && deviceBle.isConnected(bleDeviceId))
    const dryRun = !connected
    const traceId = Date.now().toString(36)

    // 直接用详情接口下发的 downloadPath 作为「当前给的文件」，边下边测（未连接则先下载再干跑校验）。
    const url = textValue(device.downloadPath)
    if (!url) {
      console.warn('[OTA测试][' + traceId + '] 设备详情缺少固件下载地址 downloadPath，无法测试。')
      toast.warn({ title: '缺少固件下载地址(downloadPath)', icon: 'none' })
      return
    }
    const fileName = url.split('?')[0].split('#')[0].split('/').pop() || 'firmware.bin'
    const pkg = {
      version: textValue(device.newVersionNo) || 'TEST',
      fileName,
      packageUrl: url,
      sizeBytes: Number(device.firmwareSize || device.sizeBytes) || 0
    }

    console.log('[OTA测试][' + traceId + '] ========== 开始 OTA 测试 ==========')
    console.log('[OTA测试][' + traceId + '] 固件下载地址：' + url)
    console.log(
      '[OTA测试][' + traceId + '] 目标设备 bleDeviceId=' + (bleDeviceId || '(无)') +
        '，蓝牙连接=' + (connected ? '已连接 → 真实 DFU' : '未连接 → 干跑(无设备应答)')
    )
    if (dryRun) {
      console.warn(
        '[OTA测试][' + traceId +
          '] 设备未连接：本次为干跑，仅校验读包/组帧/分包，不会有设备返回信息。' +
          '如需看设备应答，请先在详情页点「连接」后再测试。'
      )
    }

    this._otaTestAbort = false
    wx.setKeepScreenOn && wx.setKeepScreenOn({ keepScreenOn: true })
    this.setData({ otaTesting: true, otaTestStatus: dryRun ? '干跑测试中…' : '测试升级中…' })

    // 逐帧监听：设备→APP 的应答全部打印（这正是「和设备交互」「设备返回的信息」的重点）；
    // APP→设备海量 DATA 包只打印首包 + 计数，避免刷屏。
    let txDataCount = 0
    let finalRxHex = '' // 捕获设备最终结果帧(0xF3)，收尾时按两种偏移解读，判定到底成没成
    const DATA_HEX_PREFIX = formatHexByte(OTA_OP.DATA) // 'F2'：不整包解析，靠前缀识别海量数据包
    const RESULT_HEX_PREFIX = formatHexByte(OTA_OP.RESULT) // 'F3'
    const ACK_HEX_PREFIX = formatHexByte(OTA_OP.ACK) // 'FC'
    otaBle.setMonitor(record => {
      if (record.dir === 'TX') {
        if (record.hex.slice(0, 2) === DATA_HEX_PREFIX) {
          txDataCount += 1
          if (txDataCount > 1) {
            return // 数据包只打印第 1 包，其余仅计数，避免刷屏
          }
        }
        console.log('[OTA测试][' + traceId + '] APP→设备 ' + describeOtaFrame(record) + ' | ' + record.hex)
        return
      }
      const head = record.hex.slice(0, 2)
      if (head === RESULT_HEX_PREFIX || (head === ACK_HEX_PREFIX && record.hex.slice(3, 5) === RESULT_HEX_PREFIX)) {
        finalRxHex = record.hex // 0xF3（可能带 0xFC 帧头）
      }
      console.log('[OTA测试][' + traceId + '] 设备→APP ' + describeOtaFrame(record) + ' | ' + record.hex)
    })

    try {
      const result = await otaBle.upgradeFirmware(bleDeviceId, pkg, {
        pace: 20,
        dryRun,
        onProgress: progress => {
          const percent = Math.max(0, Math.min(100, progress.percent || 0))
          console.log(
            '[OTA测试][' + traceId + '] 进度 ' + percent + '% [' + (progress.phase || '') + '] ' +
              (progress.message || '')
          )
          this.setData({ otaTestStatus: (dryRun ? '干跑' : '测试') + ' ' + percent + '%' })
        },
        shouldAbort: () => this._otaTestAbort
      })

      console.log('[OTA测试][' + traceId + '] ========== 传输完毕，设备返回结果 ==========')
      console.log('[OTA测试][' + traceId + '] 已发送数据包 ' + txDataCount + ' 个')
      console.log('[OTA测试][' + traceId + '] 结果对象：', result)

      let okText
      if (result.dryRun) {
        const crcHex = '0x' + (result.crc32 >>> 0).toString(16).toUpperCase().padStart(8, '0')
        console.log(
          '[OTA测试][' + traceId + '] 干跑通过：' + result.size + ' 字节 / ' + result.totalPackets +
            ' 包 / 每包 ' + result.chunkSize + ' 字节，PRN=' + result.prn + '，本地 CRC32=' + crcHex
        )
        console.log('[OTA测试][' + traceId + '] START 帧：' + result.startFrameHex)
        console.log('[OTA测试][' + traceId + '] 首个 DATA 帧：' + result.firstDataFrameHex)
        okText = '干跑完成'
      } else if (result.confirmed === false) {
        // 固件已确认：收满且 CRC 无误必回 0xF3。正常不会再走到这里（收不到 0xF3 会在 ota-ble 抛错走 catch）；
        // 一旦出现，说明确实没拿到 0xF3 → 升级未确认成功，如实提示、不再谎报"已写入"。
        console.warn(
          '[OTA测试][' + traceId + '] 数据已全部发送，但未收到设备 0xF3 确认——升级未确认成功，请重试或抓帧核对。'
        )
        okText = '未确认(请重试)'
      } else {
        console.log(
          '[OTA测试][' + traceId + '] 设备已回最终结果 0xF3=成功：升级完成，共 ' + result.size +
            ' 字节 / ' + result.totalPackets + ' 包。'
        )
        if (finalRxHex) {
          console.log('[OTA测试][' + traceId + '] ' + decodeFinalResultFrame(finalRxHex))
        }
        okText = '测试完成'
      }

      this.setData({ otaTestStatus: okText })
      toast.show({ title: okText, icon: 'none' })
    } catch (error) {
      const aborted = this._otaTestAbort || (error && error.message === 'OTA_ABORTED')
      console.error('[OTA测试][' + traceId + '] ========== 升级失败 ==========')
      console.error('[OTA测试][' + traceId + '] 已发送数据包 ' + txDataCount + ' 个')
      console.error('[OTA测试][' + traceId + '] 失败原因：' + ((error && error.message) || error))
      if (finalRxHex) {
        // 设备回了 0xF3 才判失败（如「校验/芯片信息错误」）：把最终帧按两种偏移都解读一遍，
        // 若「解读B=0x00 成功」，说明其实升级成功、只是 ota-ble 的 RESULT 偏移读错了（见 §5.2）。
        console.error('[OTA测试][' + traceId + '] 设备最终结果帧：' + decodeFinalResultFrame(finalRxHex))
      }
      console.error('[OTA测试][' + traceId + '] 错误对象：', error)
      this.setData({ otaTestStatus: aborted ? '已中断' : '测试失败' })
      toast.warn({
        title: aborted ? '测试已中断' : (error && error.message) || 'OTA测试失败',
        icon: 'none'
      })
    } finally {
      otaBle.setMonitor(null)
      wx.setKeepScreenOn && wx.setKeepScreenOn({ keepScreenOn: false })
      this.setData({ otaTesting: false })
      console.log('[OTA测试][' + traceId + '] ========== 测试结束 ==========')
    }
  },

  showClearConfirm() {
    this.setData({
      showClearConfirm: true
    })
  },

  // 先播放退场动画再卸载，避免弹窗瞬间消失
  hideClearConfirm() {
    if (this.data.clearClosing) {
      return
    }
    this.setData({ clearClosing: true })
    setTimeout(() => {
      this.setData({ showClearConfirm: false, clearClosing: false })
    }, 220)
  },

  clearCopies() {
    this.showClearConfirm()
  },

  async confirmClearCopies() {
    if (!this.data.device) {
      return
    }

    if (!this.data.device.deviceId) {
      toast.warn({
        title: '请先连接设备',
        icon: 'none'
      })
      return
    }

    const traceId = Date.now().toString(36)
    const deviceId = this.data.device.deviceId
    logClearDeviceData(traceId, '点击确认，开始清空设备图片', {
      pageDeviceId: this.data.id,
      bleDeviceId: deviceId
    })
    deviceBle.setMonitor(record => logClearDeviceFrame(traceId, record))
    let clearSucceeded = false

    wx.showLoading({ title: '清空中', mask: true })
    try {
      await deviceBle.ensureConnection(deviceId)
      logClearDeviceData(traceId, 'BLE 连接已就绪', { deviceId })

      const info = await deviceBle.readDeviceInfo(deviceId)
      const indexes = protocol.maskToIndexes(info.imgMask)
      logClearDeviceData(traceId, '设备信息(0x01/0x03解析结果)', Object.assign({}, info, {
        imgMaskHex: protocol.bytesToHex(info.imgMask),
        existingIndexes: indexes
      }))

      if (indexes.length) {
        const deleteMask = protocol.indexesToMask(indexes)
        logClearDeviceData(traceId, '准备发送删除全部图片指令(0x12)', {
          indexes,
          imgIndexMask: deleteMask,
          imgIndexMaskHex: protocol.bytesToHex(deleteMask)
        })
        const deleteResult = await deviceBle.deleteImage(deviceId, indexes)
        logClearDeviceData(traceId, '删除图片应答(0x12解析结果)', Object.assign({}, deleteResult, {
          imgMaskHex: protocol.bytesToHex(deleteResult.imgMask)
        }))
      } else {
        logClearDeviceData(traceId, '设备本地没有图片，不发送删除指令(0x12)', { indexes })
      }

      await api.clearUserProductImg(this.data.id)
      logClearDeviceData(traceId, '后端清空记录完成', { id: this.data.id })
      clearSucceeded = true
    } catch (error) {
      console.error('[一键清空][' + traceId + '] 清空失败:', error)
      toast.warn({
        title: error.message || '清空失败',
        icon: 'none'
      })
      return
    } finally {
      wx.hideLoading()
      if (!clearSucceeded) {
        deviceBle.setMonitor(null)
      }
    }

    this.hideClearConfirm() // 带退场动画关闭确认弹窗
    toast.show({
      title: '已清空',
      icon: 'none'
    })
    try {
      await this.loadDetail()
    } finally {
      logClearDeviceData(traceId, '一键清空设备指令打印结束')
      deviceBle.setMonitor(null)
    }
  },

  showDeleteConfirm() {
    this.setData({
      showDeleteConfirm: true
    })
  },

  hideDeleteConfirm() {
    if (this.data.deleteClosing) {
      return
    }
    this.setData({ deleteClosing: true })
    setTimeout(() => {
      this.setData({ showDeleteConfirm: false, deleteClosing: false })
    }, 220)
  },

  // 删除设备：若删除的是当前选中设备，需清空全局选中状态
  async confirmDeleteDevice() {
    if (!this.data.device) {
      return
    }

    await api.deleteDevice(this.data.id)
    if (
      app.globalData.selectedDevice &&
      app.globalData.selectedDevice.id === this.data.id
    ) {
      app.setSelectedDevice(null)
    }
    toast.show({
      title: '已删除',
      icon: 'none'
    })
    setTimeout(() => wx.navigateBack(), 500)
  },

  formatDevice() {
    if (!this.data.device) {
      return
    }

    wx.showModal({
      title: '格式化设备',
      content: '格式化会删除设备上的照片数据，请确认是否继续。',
      confirmText: '格式化',
      confirmColor: '#c7372f',
      success: async res => {
        if (!res.confirm) {
          return
        }

        await api.formatDevice(this.data.id)
        toast.show({
          title: '格式化完成',
          icon: 'none'
        })
        this.loadDetail()
      }
    })
  }
})
