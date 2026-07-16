const api = require('../../../utils/api')
const toast = require('../../../utils/toast')
const system = require('../../../utils/system')
const batteryUtil = require('../../../utils/battery')
const deviceBle = require('../../../utils/device-ble')
const otaBle = require('../../../utils/ota-ble')
const protocol = require('../../../utils/frame-protocol')
const media = require('../../../utils/media')
const activeDevice = require('../../../utils/active-device')
const deviceName = require('../../../utils/device-name')

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
    return '未启用'
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

// 设备硬件序列号(Device_ID)：跨扫描会话稳定，用于匹配同一台物理设备。
// 归一化（去分隔符 + 大写）以兼容后端与蓝牙广播两侧可能的格式差异（与 list.js 的 deviceSerial 一致）。
function deviceSerial(device) {
  return String((device && (device.deviceNo || device.productDeviceId)) || '')
    .replace(/[:\-\s]/g, '')
    .toUpperCase()
}

// 给「设备返回 / 蓝牙链路」类错误统一加「设备-」前缀（与 toast 来源前缀约定一致：
// 设备-/小程序-/接口-）。幂等：已带任一来源前缀时原样返回，避免重复叠加。
function prefixDeviceError(error) {
  const e =
    error instanceof Error ? error : new Error((error && error.message) || '设备操作失败')
  const msg = e.message || '设备操作失败'
  if (!/^接口-|^设备-|^小程序-/.test(msg)) {
    e.message = '设备-' + msg
  }
  return e
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

const OTA_OP = otaBle.OP // v1.5: { START:0xF1, DATA:0xF2, END:0xF3, ACK:0xFC }（OP.RESULT 为 END 别名）

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
      // v1.5：首个 DATA=128字节头信息（含操作码+校验共 130 字节），其余为 payload 分片。
      const dataLen = Math.max(0, bytes.length - 2) // 去掉操作码 + 末尾校验
      return dataLen === 128 ? 'DATA(0xF2) 128字节头信息握手包' : 'DATA(0xF2) payload 分片(' + dataLen + '字节)'
    }
    if (bytes[0] === OTA_OP.END) {
      return 'END(0xF3) 结束帧'
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
    // v1.5 DATA 应答只带结果码，不再回「已连续接收包号」。
    const i = hasHeader ? 2 : 1
    return 'DATA 应答 回显0xF2 RESULT=0x' + formatHexByte(bytes[i]) + '(' + otaBle.otaResultText(bytes[i]) + ')'
  }
  if (echo === OTA_OP.END) {
    const i = hasHeader ? 2 : 1
    return (
      'END/整包校验结果(0xF3) RESULT=0x' +
      formatHexByte(bytes[i]) +
      '(' +
      otaBle.otaResultText(bytes[i]) +
      ')'
    )
  }
  return '未识别应答'
}

// v1.5：升级最终结果即 END(0xF3) 的应答帧 [0xFC, 0xF3, RESULT, checksum]（或旧固件不带 0xFC 帧头）。
// RESULT 紧跟回显的 0xF3，偏移已确定；这里把该字节解出来打印，便于与硬件日志逐帧比对。
function decodeFinalResultFrame(hex) {
  const bytes = hexStringToBytes(hex)
  const hasHeader = bytes[0] === OTA_OP.ACK
  const base = hasHeader ? 2 : 1 // 跳过可选的 0xFC 帧头 + 回显的 0xF3
  const value = bytes[base]
  const fmt =
    value === undefined
      ? '(无此字节)'
      : '0x' + formatHexByte(value) + '(' + otaBle.otaResultText(value) + ')'
  return 'END 应答原始帧=' + hex + ' ｜ RESULT=' + fmt
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
    showClearConfirm2: false, // 一键清空二级确认弹窗
    showDeleteConfirm: false,
    showDisconnectConfirm: false, // 删除前置确认弹窗（设备连接中需先断开）
    clearClosing: false, // 清空确认弹窗是否正在播放退场动画
    clearClosing2: false, // 二级清空确认弹窗是否正在播放退场动画
    deleteClosing: false, // 删除确认弹窗是否正在播放退场动画
    disconnectClosing: false, // 删除前置确认弹窗是否正在播放退场动画
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

  // 登记最近一次 0x01 设备信息（loadDetail 的 15s 节流缓存）；写类操作改了设备状态后调
  // invalidateBleInfo() 作废，下次 loadDetail 必然重读
  cacheBleInfo(deviceId, info) {
    this._lastBleInfo = info
    this._lastBleInfoDeviceId = deviceId
    this._lastBleInfoAt = Date.now()
    this._bleInfoDirty = false
  },

  invalidateBleInfo() {
    this._bleInfoDirty = true
  },

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

  // 在途去重：onShow 与「重新加载」/操作后刷新可能并发触发 loadDetail，并发的 0x01 读还会
  // 撞上 device-ble 的同指令限制(CMD_PENDING)，让用户此刻点「连接」时被误判——见 connectBoundDevice。
  async loadDetail() {
    if (this._loadingDetail) {
      return
    }
    this._loadingDetail = true
    try {
      await this.doLoadDetail()
    } finally {
      this._loadingDetail = false
    }
  },

  // 拉取设备详情并派生出页面展示字段（含轮播间隔下标、设备编号、内存文案等）
  // 接口失败时不再让 device 悬空：标记 loadError 走统一空态，提供「重新加载」入口
  async doLoadDetail() {
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

    // 选中设备的 BLE deviceId（连接用、后端不存）要回填到详情记录，连接状态才显示得对。
    // 选中设备与详情记录可能「不同源」（绑定返回的 id 可能落到序列号，详情记录是 userProductId，
    // 或同一台设备的重复绑定记录），只按 id 匹配会漏配、错显示成「未连接」——
    // 与 list.js 一致：id 匹配不上时按硬件序列号兜底。
    const selectedSerial = deviceSerial(selected)
    const isSelected =
      !!selected &&
      !!device &&
      (String(selected.id) === String(device.id) ||
        // 序列号容错比对（归一化+互为子串也算同一台）：绑定侧广播 4 字节 vs 后端 6 字节
        // 精确相等必对不上，正连着的设备会被误判「未连接」（与首页/列表页同一套规则）
        activeDevice.serialsMatch(deviceSerial(device), selectedSerial))

    if (isSelected) {
      device = Object.assign({}, device, {
        deviceId: device.deviceId || selected.deviceId,
        bleDeviceId:
          device.bleDeviceId || selected.bleDeviceId || selected.deviceId,
        battery:
          typeof device.battery === 'number' ? device.battery : selected.battery
      })
    }

    // 判连接用「deviceId 直连 + 设备ID×广播ID 序列号交叉匹配」：详情记录从接口重拉后常不带 BLE deviceId，
    // 只按 deviceId 判断会把还连着的设备错显示成「未连接」（假断联）；命中后把当下有效 deviceId 回填给记录，
    // 顶部「断开」、投屏、轮播设置等操作才有正确的 deviceId 可用。
    const liveId = activeDevice.findConnectedDeviceId(device)
    if (liveId) {
      // 连接态以 BLE 会话为准，先行置位；readDeviceInfo 只用于补充电量/内存/播放模式，
      // 读失败不影响「已连接」显示（此前读失败会被静默吞掉，明明连着却显示成未连接）。
      device = Object.assign({}, device, {
        deviceId: liveId,
        bleDeviceId: liveId,
        connected: true
      })
      // 0x01 读节流：空闲连接间隔(100ms)下一次读要数百 ms，每次 onShow 都读让页面切换「闪一下才稳定」。
      // 同一连接 15s 内复用上次读到的信息；换了连接、超窗、或被写操作作废(_bleInfoDirty，见
      // applyPlayback/formatDevice/一键清空)才真正重读，保证改完立即刷新不吃缓存。
      const nowTs = Date.now()
      let info =
        !this._bleInfoDirty &&
        this._lastBleInfo &&
        this._lastBleInfoDeviceId === liveId &&
        nowTs - (this._lastBleInfoAt || 0) < 15000
          ? this._lastBleInfo
          : null
      if (!info) {
        try {
          info = await deviceBle.readDeviceInfo(device.deviceId)
          this.cacheBleInfo(liveId, info)
        } catch (error) {
          // 详情展示不因读取设备信息失败而中断，电量/内存等沿用接口/选中设备的数据。
        }
      }
      if (info) {
        device = Object.assign({}, device, {
          battery: info.battery,
          usedMemory: info.imgCount,
          totalMemory: info.capacity,
          playbackMode: info.playMode,
          intervalSeconds: info.intervalSeconds,
          intervalHours: info.intervalSeconds
            ? Math.max(1, Math.round(info.intervalSeconds / 3600))
            : device.intervalHours,
          firmwareVersion: info.firmwareVersion || device.firmwareVersion,
          // 固件真实 Device_ID（0x01 返回，与调试台一致）：设备ID行优先展示它
          firmwareDeviceId: info.deviceId || device.firmwareDeviceId
        })
      }
    }
    // 把当前间隔小时数映射到选择器下标，缺省落到第 1 项（2 小时）
    const intervalIndex = this.data.intervalOptions.indexOf(
      device ? device.intervalHours : 2
    )
    // 设备ID优先展示固件读到的真实 Device_ID（0x01，与调试台一致）；
    // 未连接/读取失败时回退后端序列号末 6 位数字，再缺失用 -- 占位（不再用假的 123456）
    const digitId =
      device && device.deviceNo
        ? String(device.deviceNo).replace(/\D/g, '').slice(-6)
        : ''
    const deviceCode = (device && device.firmwareDeviceId) || digitId || '--'
    const hasBattery = device && typeof device.battery === 'number'
    // 轮播设置/固件升级的右侧值只在已连接时展示，未连接一律 -- 占位（点击时提示先连接设备）
    const connected = !!(device && device.connected)

    this.setData({
      device,
      memoryPercent: memoryPercent(device),
      batteryIcon: batteryUtil.getBatteryIcon(
        hasBattery ? device.battery : batteryUtil.DEFAULT_BATTERY
      ),
      batteryText: hasBattery ? `${device.battery}%` : '--',
      deviceCode,
      memoryText:
        device && device.totalMemory
          ? `${device.usedMemory}/${device.totalMemory}`
          : '--',
      macAddress: device && device.macAddress ? device.macAddress : '--',
      newVersionNo: connected
        ? device.newVersionNo || device.firmwareVersion || '--'
        : '--',
      playbackLabel: connected ? getPlaybackLabel(device) : '--',
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
      placeholderText: `请输入设备名称（1-${deviceName.DEVICE_NAME_MAX_LEN}个字符）`,
      content: this.data.device.name,
      success: async res => {
        if (!res.confirm) {
          return // 取消则不处理
        }

        // 弹窗自身无法限制输入长度，只能在确定后校验；不合法则提示并放弃本次保存
        const checked = deviceName.validateDeviceName(res.content)
        if (!checked.ok) {
          toast.warn(checked.message)
          return
        }

        const newName = checked.name
        try {
          await api.renameDevice(this.data.id, newName)
        } catch (error) {
          return // 失败已由接口层统一提示；本地不改名，避免界面与后端不一致
        }
        // 改名是纯后端存储（名称以用户为维度，不写设备、不动蓝牙连接/广播）：
        // 只把新名字合并回现有 device，绝不能用接口的精简返回整体替换——
        // 那会丢 deviceId/deviceNo，页面误判断联；此时会话仍占着设备（单连接、不再广播），
        // 点「连接」重扫必然搜不到，形成「改名后断联且搜不到」的假象。
        const updated = Object.assign({}, this.data.device, {
          name: newName,
          productName: newName
        })
        const selected = app.globalData.selectedDevice
        if (selected && selected.id === updated.id) {
          // 全局选中设备同理：只改名字，保留它自己的 deviceId 等连接字段
          app.setSelectedDevice(
            Object.assign({}, selected, { name: newName, productName: newName })
          )
        }
        this.setData({
          device: updated,
          memoryPercent: memoryPercent(updated)
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
    if (!device) {
      return
    }
    // 操作前先确保已连接：断联则自动重连(扫描+连接)，连不上再提示「请先连接设备」。
    const deviceId = await activeDevice.ensureConnectedForAction(device)
    if (!deviceId) {
      return
    }

    const hours = Number(intervalHours) || 2
    const intervalSeconds = Math.max(1, Math.round(hours * 3600))

    wx.showLoading({ title: '保存中', mask: true })
    try {
      await deviceBle.setPlayback(deviceId, mode, intervalSeconds)
      this.invalidateBleInfo() // 播放配置已变，作废 0x01 节流缓存，下次 loadDetail 重读
      const updated = Object.assign({}, device, {
        deviceId,
        bleDeviceId: deviceId,
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
      // 轮播设置保存成功不再弹提示（右侧值已刷新即为反馈）；仅保存失败时提示。
    } catch (error) {
      toast.warn({
        title: error.message || '保存失败',
        icon: 'none'
      })
    } finally {
      wx.hideLoading()
    }
  },

  // 顶部「投屏」：先确保设备已连接（未连接则自动扫描匹配并连接，连不上按标准规则提示），
  // 再弹出「拍照/相册」二选一，由用户选择投屏方式（与首页一致）。
  async startProjection() {
    let device = this.data.device
    if (!device) {
      return
    }
    // deviceId 直连 + 序列号交叉匹配：记录丢了 deviceId 但会话还活着也算已连接（connectDevice 内部会复用）
    if (!activeDevice.isDeviceConnected(device)) {
      device = await this.connectDevice()
      if (!device) {
        return // 连接失败，提示已由 connectDevice 弹出
      }
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

  // 断开当前设备：断 BLE + 连接态回落（顶部「断开」与删除前置弹窗的「断开」共用）
  performDisconnect() {
    const device = this.data.device
    if (!device || !device.connected) {
      return
    }
    if (device.deviceId) {
      deviceBle.disconnect(device.deviceId)
    }
    // 断开后这些「连接才可信」的实时数据不再有效：清掉固件读到的设备ID(0x01)与内存占用，
    // 让 device 与显示一致回落。注意保留 deviceNo(后端序列号)——重连时 matchScannedDevice 靠它匹配本机。
    const updated = Object.assign({}, device, {
      connected: false,
      firmwareDeviceId: '',
      usedMemory: 0,
      totalMemory: 0
    })
    if (
      app.globalData.selectedDevice &&
      app.globalData.selectedDevice.id === updated.id
    ) {
      app.setSelectedDevice(updated)
    }
    // 断开后轮播设置/固件版本/设备ID/内存都不再可信，与未连接态一致回落到 --（内存进度条一并归零）
    this.setData({
      device: updated,
      deviceCode: '--',
      memoryText: '--',
      memoryPercent: 0,
      playbackLabel: '--',
      newVersionNo: '--'
    })
    // 断开成功不再弹提示（顶部按钮已切「未连接」态即为反馈）；仅失败时提示。
  },

  // 顶部「连接 / 断开」：已连接则断开；未连接则重扫匹配本设备并连接（BLE deviceId 每次扫描会话才有效）。
  async toggleConnection() {
    const device = this.data.device
    if (!device) {
      return
    }

    if (device.connected) {
      this.performDisconnect()
      return
    }

    await this.connectDevice()
  },

  // 扫描匹配并连接当前设备（「连接」按钮与「投屏」按钮共用）：
  // 成功返回带有效 deviceId/实时信息的设备对象并刷新页面 UI；失败按标准规则提示后返回 null。
  async connectDevice() {
    const device = this.data.device
    if (!device) {
      return null
    }
    try {
      // 扫描+匹配+连接主链已收敛到 active-device.connectBoundDevice（首页/列表/详情共用一份，改一处全生效）。
      // 详情页传入带「名称兜底」的匹配器(老记录没序列号时按名连)，并对复用的活动会话先读设备信息做活性校验。
      const res = await activeDevice.connectBoundDevice(device, {
        match: (found, dev) => this.matchScannedDevice(found, dev),
        verifyReuse: true
      })
      const updated = this.applyConnectedDevice(device, res.deviceId, res.info)
      // 连接成功不再弹提示（顶部切「已连接」态即为反馈，投屏流程也直接继续）；仅连接失败时提示。
      return updated
    } catch (error) {
      // 系统级「附近设备」权限被拒：弹引导去系统设置，而非笼统的「连接失败」
      activeDevice.showConnectError(error)
      return null
    }
  },

  // 连接成功后的统一收尾（新连接与复用活动会话共用）：合并设备实时信息 → 设为全局选中设备 → 刷新页面 UI。
  // info 可能为 null（复用活动会话且活性校验撞上在途指令 CMD_PENDING 时不读设备信息）：
  // 此时只置连接态，电量/内存等沿用现有数据，稍后 loadDetail 会补齐。
  applyConnectedDevice(device, deviceId, info) {
    if (info) {
      this.cacheBleInfo(deviceId, info) // 新鲜 0x01 数据同步进节流缓存，紧随的 loadDetail 直接复用
    }
    const updated = Object.assign(
      {},
      device,
      {
        deviceId,
        bleDeviceId: deviceId,
        connected: true
      },
      info
        ? {
            battery: info.battery,
            usedMemory: info.imgCount,
            totalMemory: info.capacity,
            playbackMode: info.playMode,
            intervalSeconds: info.intervalSeconds,
            intervalHours: info.intervalSeconds
              ? Math.max(1, Math.round(info.intervalSeconds / 3600))
              : device.intervalHours,
            firmwareVersion: info.firmwareVersion || device.firmwareVersion,
            // 固件真实 Device_ID（0x01 返回，与调试台一致）：设备ID行优先展示它
            firmwareDeviceId: info.deviceId || device.firmwareDeviceId
          }
        : null
    )
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
      newVersionNo: updated.newVersionNo || updated.firmwareVersion || '--',
      // 在详情页内点「连接」成功后，设备ID行立即切换为固件真实 Device_ID
      deviceCode: updated.firmwareDeviceId || this.data.deviceCode
    })
    return updated
  },

  // 把后端设备(序列号/名称)与扫描结果匹配，返回带「本次会话有效 deviceId」的那条。
  // 序列号用 active-device.serialsMatch 容错比对（归一化+互为子串）：广播 Device_ID 只有 4 字节、
  // 后端存 6 字节，之前的精确相等必然对不上，实际一直靠名称兜底碰巧连上（默认设备名=产品广播名）；
  // 用户一改名两条路全断，表现为「改名后点连接提示未搜索到该设备」。
  // 名称兜底只留给没有序列号的老记录：有序列号却没匹配上即视为设备不在附近，不再按名连接——
  // 同型号广播名相同，按名兜底可能连到别人的相框。
  matchScannedDevice(found, device) {
    const bySerial = activeDevice.matchScannedDevice(found, device)
    if (bySerial) {
      return bySerial
    }
    if (deviceSerial(device)) {
      return null
    }
    const name = String((device && device.name) || '').trim()
    if (!name) {
      return null
    }
    return (found || []).find(item => String(item.name || '').trim() === name) || null
  },

  // 点「轮播设置」：未连接设备时不进入，提示先连接（与 startProjection 同一实时判连方式）
  goSlideshow() {
    const device = this.data.device
    if (!device) {
      return
    }
    // deviceId 直连 + 序列号交叉匹配，避免记录丢 deviceId 时误判「未连接」拦住入口
    if (!activeDevice.isDeviceConnected(device)) {
      toast.warn({ title: '请先连接设备', icon: 'none' })
      return
    }
    wx.navigateTo({
      url: `/subpackages/device/slideshow/slideshow?id=${this.data.id}`
    })
  },

  // 点「固件升级」：未连接先提示连接；已连接再调接口检测最新版本 → 有新版本弹二次确认(稍后/立刻更新)，无则提示已是最新、不进升级页。
  async goOtaUpgrade() {
    const device = this.data.device
    if (!device) {
      return
    }
    // deviceId 直连 + 序列号交叉匹配，避免记录丢 deviceId 时误判「未连接」拦住入口
    if (!activeDevice.isDeviceConnected(device)) {
      toast.warn({ title: '请先连接设备', icon: 'none' })
      return
    }

    // 先调接口检测版本（不依赖详情页可能已过期的数据）
    wx.showLoading({ title: '检测版本中', mask: true })
    let latest
    try {
      latest = await api.getDeviceDetail(this.data.id)
    } catch (error) {
      wx.hideLoading()
      toast.warn({ title: (error && error.message) || '版本检测失败', icon: 'none' })
      return
    }
    wx.hideLoading()

    // 无新版本：弹提示框，不进入固件升级详情页
    if (!isUpdateFlag(latest)) {
      wx.showModal({
        title: '固件升级',
        content: '当前固件已是最新版本',
        showCancel: false,
        confirmText: '知道了'
      })
      return
    }

    // 有更新但包信息无效（缺版本号/下载地址/非 .bin）：如实提示，不进入
    const validationError = getOtaValidationError(latest)
    if (validationError) {
      wx.showModal({
        title: '固件升级',
        content: validationError,
        showCancel: false,
        confirmText: '知道了'
      })
      return
    }

    // 有新版本：二次确认；「立刻更新」→ 确保已连接后进入升级页自动开始下载
    wx.showModal({
      title: '固件升级',
      content: `检测到新版本：${textValue(latest.newVersionNo)}，是否升级`,
      cancelText: '稍后',
      confirmText: '立刻更新',
      success: res => {
        if (res.confirm) {
          this.enterOtaUpgrade()
        }
      }
    })
  },

  // 「立刻更新」：确保设备已连接(断联自动重连)，把当下有效连接写回选中设备，再进入固件升级页自动开始下载。
  async enterOtaUpgrade() {
    const device = this.data.device
    if (!device) {
      return
    }
    const deviceId = await activeDevice.ensureConnectedForAction(device)
    if (!deviceId) {
      return // 连不上，提示已弹（请先连接设备 / 权限引导）
    }
    app.setSelectedDevice(
      Object.assign({}, device, { deviceId, bleDeviceId: deviceId, connected: true })
    )
    wx.navigateTo({
      url: `/subpackages/device/ota/ota?id=${this.data.id}&auto=1`
    })
  },

  // 长按「固件升级」进入本地固件测试流程：用代码包内的测试 .bin 走真实 DFU（设备已连接）
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
    let finalRxHex = '' // 捕获设备对 END(0xF3) 的整包校验应答帧，收尾时解出 RESULT 判定成没成
    const DATA_HEX_PREFIX = formatHexByte(OTA_OP.DATA) // 'F2'：不整包解析，靠前缀识别海量数据包
    const RESULT_HEX_PREFIX = formatHexByte(OTA_OP.END) // 'F3'：END 的应答即最终结果
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
          // 同值去重：回调由 PRN 窗口 ACK 驱动、频率较高，百分比没变就不 setData
          const statusText = (dryRun ? '干跑' : '测试') + ' ' + percent + '%'
          if (statusText !== this._lastOtaTestStatus) {
            this._lastOtaTestStatus = statusText
            this.setData({ otaTestStatus: statusText })
          }
        },
        shouldAbort: () => this._otaTestAbort
      })

      console.log('[OTA测试][' + traceId + '] ========== 传输完毕，设备返回结果 ==========')
      console.log('[OTA测试][' + traceId + '] 已发送数据包 ' + txDataCount + ' 个')
      console.log('[OTA测试][' + traceId + '] 结果对象：', result)

      let okText
      let unconfirmedTest = false
      if (result.dryRun) {
        const crcHex = '0x' + (result.crc32 >>> 0).toString(16).toUpperCase().padStart(8, '0')
        console.log(
          '[OTA测试][' + traceId + '] 干跑通过：文件 ' + result.size + ' 字节（128头+payload ' + result.payloadSize +
            '）/ ' + result.totalPackets + ' 包 / 每包 ' + result.chunkSize + ' 字节，PRN=' + result.prn + '，本地 CRC32=' + crcHex
        )
        console.log('[OTA测试][' + traceId + '] START 帧：' + result.startFrameHex)
        console.log('[OTA测试][' + traceId + '] 128字节头信息帧：' + result.headerFrameHex)
        console.log('[OTA测试][' + traceId + '] 首个 payload DATA 帧：' + result.firstDataFrameHex)
        console.log('[OTA测试][' + traceId + '] END 帧：' + result.endFrameHex)
        okText = '干跑完成'
      } else if (result.confirmed === false) {
        // v1.5：升级成败以「APP 发 END(0xF3) 后设备回的整包校验 ACK」为准，任何失败都会在 ota-ble 抛错走 catch。
        // 正常不会走到这里；一旦出现说明未拿到设备最终确认 → 升级未确认成功，如实提示、不再谎报"已写入"。
        console.warn(
          '[OTA测试][' + traceId + '] 数据已全部发送，但未收到设备 END(0xF3) 整包校验确认——升级未确认成功，请重试或抓帧核对。'
        )
        okText = '未确认(请重试)'
        unconfirmedTest = true
      } else {
        console.log(
          '[OTA测试][' + traceId + '] 设备已回 END(0xF3) 整包校验=成功：升级完成，文件 ' + result.size +
            ' 字节 / payload ' + result.totalPackets + ' 包。'
        )
        if (finalRxHex) {
          console.log('[OTA测试][' + traceId + '] ' + decodeFinalResultFrame(finalRxHex))
        }
        okText = '测试完成'
      }

      this.setData({ otaTestStatus: okText })
      if (unconfirmedTest) {
        // 未确认是失败语义（没拿到设备 0xF3 确认）：按约定走 warn 加「设备-」来源前缀
        toast.warn({ title: '设备-' + okText, icon: 'none' })
      } else {
        toast.show({ title: okText, icon: 'none' })
      }
    } catch (error) {
      const aborted = this._otaTestAbort || (error && error.message === 'OTA_ABORTED')
      console.error('[OTA测试][' + traceId + '] ========== 升级失败 ==========')
      console.error('[OTA测试][' + traceId + '] 已发送数据包 ' + txDataCount + ' 个')
      console.error('[OTA测试][' + traceId + '] 失败原因：' + ((error && error.message) || error))
      if (finalRxHex) {
        // 设备回了 END(0xF3) 应答但 RESULT!=0（如「头信息校验失败/整包 CRC32 失败」）：解出结果码便于定位。
        console.error('[OTA测试][' + traceId + '] 设备 END 整包校验应答帧：' + decodeFinalResultFrame(finalRxHex))
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

  // 一级确认点「继续」：关一级、开二级，进入二次确认（我已阅读并了解结果）
  openClearStep2() {
    this.setData({
      showClearConfirm: false,
      clearClosing: false,
      showClearConfirm2: true,
      clearClosing2: false
    })
  },

  // 二级确认弹窗关闭（带退场动画）
  hideClearConfirm2() {
    if (this.data.clearClosing2) {
      return
    }
    this.setData({ clearClosing2: true })
    setTimeout(() => {
      this.setData({ showClearConfirm2: false, clearClosing2: false })
    }, 220)
  },

  clearCopies() {
    // 一键清空需与固件交互：未连接不自动重连，直接提示「请先连接设备」
    if (!activeDevice.isDeviceConnected(this.data.device)) {
      toast.warn({ title: '请先连接设备', icon: 'none' })
      return
    }
    this.showClearConfirm()
  },

  async confirmClearCopies() {
    if (!this.data.device) {
      return
    }

    // 一键清空需已连接：未连接不自动重连(点击时已拦一次，这里作二次保护)，直接提示「请先连接设备」。
    const deviceId = activeDevice.findConnectedDeviceId(this.data.device)
    if (!deviceId) {
      toast.warn({ title: '请先连接设备', icon: 'none' })
      return
    }

    const traceId = Date.now().toString(36)
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
        try {
          const deleteResult = await deviceBle.deleteImage(deviceId, indexes)
          logClearDeviceData(traceId, '删除图片应答(0x12解析结果)', Object.assign({}, deleteResult, {
            imgMaskHex: protocol.bytesToHex(deleteResult.imgMask)
          }))
        } catch (deleteError) {
          // 设备对 0x12 回了非 0 结果码或应答超时——但不少固件其实已经把图删干净了，
          // 只是应答异常/迟到。这里回读一次设备状态核对：真清空了就按成功继续（记一条日志说明），
          // 只有确实还留着图才把这个「设备-」错误抛给用户，避免「已清空却报错误码」误导。
          logClearDeviceData(traceId, '删除指令(0x12)报错，回读设备状态核对是否已实际清空', {
            deviceError: (deleteError && deleteError.message) || String(deleteError)
          })
          // 设备可能还在擦除、此刻回不了 0x01：重读几次(每次间隔 4s、共 3 次)给它删完的时间，
          // 别因一次回读失败就误报「设备暂时无法连接」。任一次读到就用，全部失败才沿用原始设备错误抛出。
          let after
          let reReadError
          for (let attempt = 1; attempt <= 3 && !after; attempt++) {
            if (attempt > 1) {
              await new Promise(resolve => setTimeout(resolve, 4000))
            }
            try {
              after = await deviceBle.readDeviceInfo(deviceId)
            } catch (error) {
              reReadError = error
              logClearDeviceData(traceId, '回读设备状态失败，稍后重试', {
                attempt,
                reReadError: (error && error.message) || String(error)
              })
            }
          }
          if (!after) {
            // 多次回读都失败：无法确认设备是否已清空，沿用原始设备错误如实抛出（带来源前缀）
            logClearDeviceData(traceId, '多次回读设备状态均失败，无法确认清空结果，沿用原始设备错误', {
              reReadError: (reReadError && reReadError.message) || String(reReadError)
            })
            throw prefixDeviceError(deleteError)
          }
          const remaining = protocol.maskToIndexes(after.imgMask)
          logClearDeviceData(traceId, '回读设备状态结果', {
            imgMaskHex: protocol.bytesToHex(after.imgMask),
            remainingIndexes: remaining,
            imgCount: after.imgCount
          })
          if (remaining.length) {
            // 确实没删干净：把设备结果码如实抛出，让用户看到真实失败原因（带「设备-」前缀）
            throw prefixDeviceError(
              new Error(
                ((deleteError && deleteError.message) || '清空失败') +
                  `（设备仍剩 ${remaining.length} 张未删除）`
              )
            )
          }
          // 设备已实际清空，只是 0x12 应答异常：记录后按成功继续，不打断清空流程
          logClearDeviceData(traceId, '设备已实际清空（0x12 应答曾报错，回读确认无残留，按成功处理）', {
            deviceReportedError: (deleteError && deleteError.message) || String(deleteError)
          })
        }
      } else {
        logClearDeviceData(traceId, '设备本地没有图片，不发送删除指令(0x12)', { indexes })
      }

      await api.clearUserProductImg(this.data.id)
      logClearDeviceData(traceId, '后端清空记录完成', { id: this.data.id })
      clearSucceeded = true
    } catch (error) {
      const rawMsg = (error && error.message) || String(error)
      console.error('[一键清空][' + traceId + '] 清空失败:', error)
      // 设备忙(0x0B)：设备答得上话、只是暂时在忙，别被下方「设备-」前缀误判成「设备暂时无法连接」，
      // 原样提示「当前设备繁忙，请稍后重试」，引导用户稍后再清空。
      const isBusy = rawMsg.indexOf(protocol.BUSY_MESSAGE) !== -1
      // 清空中途设备断联 / 连不上 / 应答超时等蓝牙链路问题：会话已断，或错误带「设备-」来源前缀
      // （device-ble 的 ensureConnection/readDeviceInfo/deleteImage 失败都会被前缀成「设备-」）。
      // 这类一律统一提示「设备暂时无法连接」，不把底层设备错误码抛给用户；
      // 后端接口类错误（「接口-」前缀）仍如实提示，避免把接口问题误报成设备连不上。
      const deviceLinkFailed =
        !isBusy && (!deviceBle.isConnected(deviceId) || /^设备-/.test(rawMsg))
      logClearDeviceData(traceId, '清空失败', { deviceLinkFailed, busy: isBusy, error: rawMsg })
      toast.warn({
        title: isBusy
          ? protocol.BUSY_MESSAGE
          : deviceLinkFailed
          ? '设备暂时无法连接'
          : rawMsg || '清空失败',
        icon: 'none'
      })
      return
    } finally {
      wx.hideLoading()
      if (!clearSucceeded) {
        deviceBle.setMonitor(null)
      }
    }

    this.hideClearConfirm2() // 带退场动画关闭二级确认弹窗
    toast.show({
      title: '已清空',
      icon: 'none'
    })
    // 一键清空后马上回读设备信息(0x01)，把内存占用/电量立刻刷新到详情页（不等下面 loadDetail 的接口往返）
    await this.refreshDeviceMemoryFromBle(deviceId)
    try {
      await this.loadDetail()
    } finally {
      logClearDeviceData(traceId, '一键清空设备指令打印结束')
      deviceBle.setMonitor(null)
    }
  },

  // 一键清空成功后立刻回读设备信息(0x01)并刷新详情页的内存占用/电量，不等 loadDetail 的接口往返，
  // 让「已清空」后内存数马上归零。读失败(设备刚擦完可能短暂无响应)不影响清空结果，随后 loadDetail 仍会再同步一次。
  async refreshDeviceMemoryFromBle(deviceId) {
    if (!deviceId) {
      return
    }
    let info
    try {
      info = await deviceBle.readDeviceInfo(deviceId)
      this.cacheBleInfo(deviceId, info) // 刚读到的最新值同步进节流缓存，紧随的 loadDetail 直接复用
    } catch (error) {
      return
    }
    const prev = this.data.device || {}
    const device = Object.assign({}, prev, {
      battery: typeof info.battery === 'number' ? info.battery : prev.battery,
      usedMemory: info.imgCount,
      totalMemory: info.capacity
    })
    const hasBattery = typeof device.battery === 'number'
    this.setData({
      device,
      memoryPercent: memoryPercent(device),
      memoryText: device.totalMemory
        ? `${device.usedMemory}/${device.totalMemory}`
        : '--',
      batteryIcon: batteryUtil.getBatteryIcon(
        hasBattery ? device.battery : batteryUtil.DEFAULT_BATTERY
      ),
      batteryText: hasBattery ? `${device.battery}%` : '--'
    })
  },

  showDeleteConfirm() {
    // 设备连接中：先弹「需先断开」前置确认，断开后再进入删除确认
    const device = this.data.device
    if (device && device.connected) {
      this.setData({ showDisconnectConfirm: true })
      return
    }
    this.setData({
      showDeleteConfirm: true
    })
  },

  hideDisconnectConfirm() {
    if (this.data.disconnectClosing) {
      return
    }
    this.setData({ disconnectClosing: true })
    setTimeout(() => {
      this.setData({ showDisconnectConfirm: false, disconnectClosing: false })
    }, 220)
  },

  // 删除前置弹窗点「断开」：执行与顶部一致的断开交互，退场后接着弹删除确认框
  confirmDisconnectForDelete() {
    if (this.data.disconnectClosing) {
      return
    }
    this.performDisconnect()
    this.setData({ disconnectClosing: true })
    setTimeout(() => {
      this.setData({
        showDisconnectConfirm: false,
        disconnectClosing: false,
        showDeleteConfirm: true
      })
    }, 220)
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
    // _deleting 锁防连点：成功后到 navigateBack 有 500ms 窗口，期间再点会对已删设备重复请求、
    // 弹一条误导性的报错；成功路径不释放锁（页面马上销毁），仅失败释放供重试
    if (!this.data.device || this._deleting) {
      return
    }
    this._deleting = true
    try {
      await api.deleteDevice(this.data.id)
    } catch (error) {
      this._deleting = false
      return // 失败已由接口层统一提示，确认弹窗保留供重试
    }
    if (
      app.globalData.selectedDevice &&
      app.globalData.selectedDevice.id === this.data.id
    ) {
      app.setSelectedDevice(null)
    }
    // 删除成功立即收起确认弹窗（否则 500ms 窗口内弹窗还停在屏上），再返回上一页（列表刷新即为反馈）
    this.hideDeleteConfirm()
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

        try {
          await api.formatDevice(this.data.id)
        } catch (error) {
          return // 失败已由接口层统一提示
        }
        toast.show({
          title: '格式化完成',
          icon: 'none'
        })
        this.invalidateBleInfo() // 设备照片已被清，作废 0x01 节流缓存让 loadDetail 重读内存占用
        this.loadDetail()
      }
    })
  }
})
