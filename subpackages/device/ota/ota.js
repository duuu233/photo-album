const api = require('../../../utils/api')
const otaBle = require('../../../utils/ota-ble')
const deviceBle = require('../../../utils/device-ble')
const toast = require('../../../utils/toast')
const system = require('../../../utils/system')
const batteryUtil = require('../../../utils/battery')
const activeDevice = require('../../../utils/active-device')
const fold = require('../../../utils/fold-adapt')

const app = getApp()

// 简化版固件升级界面（参照投屏结果页）用的占位插画：进行中 / 失败 / 成功。
// 暂借用投屏结果页的三张图占位，后续换成 OTA 专用图时只改这里即可。
const OTA_ART = {
  progress: '/assets/images/upload-icon01.png',
  fail: '/assets/images/upload-icon02.png',
  success: '/assets/images/upload-icon03.png'
}

// 把内部 state/phase 归一成 5 种画面：checking(检测中) / ready(可升级待开始) / progress(进行中) /
// success(成功/已是最新) / fail(失败/无法升级)。这里按画面挑对应占位图。
function artFor(screenStatus) {
  if (screenStatus === 'success') {
    return OTA_ART.success
  }
  if (screenStatus === 'fail') {
    return OTA_ART.fail
  }
  return OTA_ART.progress // checking / ready / progress
}

function formatSize(bytes) {
  const value = Number(bytes) || 0

  if (value >= 1024 * 1024) {
    return `${(value / 1024 / 1024).toFixed(1)}MB`
  }

  if (value >= 1024) {
    return `${Math.round(value / 1024)}KB`
  }

  return `${value}B`
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

function firmwareFileName(url, version) {
  const cleanUrl = textValue(url).split('?')[0].split('#')[0]
  const parts = cleanUrl.split('/')
  return parts[parts.length - 1] || `${version || 'firmware'}.bin`
}

function sameDevice(a, b) {
  return activeDevice.devicesMatch(a, b)
}

function mergeSelectedDevice(device) {
  const selected = (app.globalData && app.globalData.selectedDevice) || null
  const isSelected = sameDevice(device, selected)
  let merged = device

  if (isSelected) {
    merged = Object.assign({}, device, {
      deviceId: device.deviceId || selected.deviceId || selected.bleDeviceId,
      bleDeviceId:
        device.bleDeviceId || selected.bleDeviceId || selected.deviceId,
      firmwareVersion: device.firmwareVersion || selected.firmwareVersion
    })
  }

  // 本页记录来自 getUserProductDetail，而详情接口不返回设备 ID：不补齐的话这条记录永远没有
  // 完整 6 字节身份。后果不只是显示——deviceSerials 为空时 findConnectedDeviceId 直接返回 ''
  //（设备连着也显示未连接、电量不刷），点升级还会被 ensureDeviceConnected 的身份闸报
  //「记录缺少完整的6字节设备ID，请删除后重新绑定」，把一台好设备说成要重新绑定。
  // 与详情/列表/首页同一套补齐链：记录自身 > selectedDevice（确认是同一台才传） > 身份登记表。
  merged = activeDevice.inheritStableIdentity(merged, isSelected ? selected : null)

  // OTA 属于不可逆风险较高的设备操作，绝不能只凭 selectedDevice 里的旧 BLE 句柄判断连接。
  // 只有完整设备身份与当前详情记录一致的活动会话才可进入真实升级。
  const bleDeviceId = activeDevice.findConnectedDeviceId(merged)
  return Object.assign({}, merged, {
    deviceId: bleDeviceId,
    bleDeviceId,
    connected: !!bleDeviceId
  })
}

// 版本号一致性判断：去空格后不区分大小写比较；任一为空则不视为一致（避免「未知版本」被误判为已最新）。
function sameVersion(a, b) {
  const na = textValue(a).toUpperCase()
  const nb = textValue(b).toUpperCase()
  return !!na && !!nb && na === nb
}

function buildFirmwareFromDevice(device) {
  const version = textValue(device && device.newVersionNo)
  const url = textValue(device && device.downloadPath)
  const currentVersion =
    textValue(device && (device.firmwareVersion || device.currentVersion)) || '--'
  // 当前固件版本已与详情接口下发的 newVersionNo 一致时，视为已是最新，不再触发更新（即便后台 isUpdate=1）。
  const alreadyLatest = sameVersion(currentVersion, version)
  const hasUpdate = isUpdateFlag(device) && !alreadyLatest
  const hasValidPackage = hasUpdate && !!version && !!url && isBinFirmwareUrl(url)
  let invalidReason = ''

  if (hasUpdate && (!version || !url)) {
    invalidReason = '检测到可更新状态，但缺少新版本号或固件下载地址，请稍后重试。'
  } else if (hasUpdate && !isBinFirmwareUrl(url)) {
    invalidReason = '固件下载地址不是有效的 .bin 文件，请稍后重试。'
  }

  const firmware = {
    hasUpdate: hasValidPackage,
    invalidUpdate: hasUpdate && !hasValidPackage,
    invalidReason,
    currentVersion,
    latestVersion: version || '--',
    bleDeviceId: textValue(device && (device.deviceId || device.bleDeviceId)),
    releaseNotes: hasValidPackage ? [`发现新版本：${version}`] : []
  }

  if (hasValidPackage) {
    firmware.package = {
      version,
      fileName: firmwareFileName(url, version),
      packageUrl: url,
      sizeBytes: Number(device.firmwareSize || device.sizeBytes) || 0
    }
  }

  return firmware
}

// 折叠屏/分屏适配：Page 配置外面包一层 fold.adapt（方案见 utils/fold-adapt.js 与
// styles/fold-adapt.wxss）。只叠加「形态变化后重测状态栏/安全区」等钩子，页面原有配置一字不改。
Page(fold.adapt({
  data: {
    statusBarHeight: 20,
    safeBottom: 0,
    id: '',
    loading: true,
    device: null,
    firmware: null,
    state: 'checking',
    progressPercent: 0,
    progressText: '',
    errorMessage: '',
    canUpgrade: false,
    actionText: '立即升级',
    statusText: '检查中',
    statusClass: '',
    currentVersion: '--',
    latestVersion: '--',
    packageSizeText: '--',
    batteryText: '--',
    minBatteryText: '--',
    releaseNotes: [],
    // ── 简化版界面字段（参照投屏结果页）：图标 + 进度条 + 文案 ──
    screenStatus: 'checking', // checking | ready | progress | success | fail
    statusTitle: '检测版本中',
    statusDesc: '正在检查固件版本，请稍候…',
    artImage: OTA_ART.progress,
    showPrimary: false // 是否显示底部主按钮（开始升级 / 重新升级 / 重新检查）
  },

  onLoad(options = {}) {
    this._abortUpgrade = false
    // auto=1：从详情页「立刻更新」进来，加载完自动开始（本页唯一的入参，2026-08-11 起
    // test/dry 两个测试开关随「OTA测试升级」模块一并删除）。
    this._autoStart = options.auto === '1' || options.auto === 'true'
    this._autoStartConsumed = false
    this.setData(Object.assign(system.getLayoutMetrics(), { id: options.id || '' }))
    this.loadFirmware()
  },

  onShow() {
    // onLoad 首次进入由 loadFirmware/loadLocalTestFirmware 读取；从后台或下一页返回时再实时读一次。
    if (this.data.device && this.data.state !== 'upgrading') {
      this.refreshDisplayedBattery()
    }
  },

  onHide() {
    if (this.data.state === 'upgrading') {
      this._abortUpgrade = true
    }
  },

  onUnload() {
    this._abortUpgrade = true

    // 仅在真的开过 OTA(FF10) 会话时才断开，避免未升级时误关详情页持有的 FF00 连接。
    const bleDeviceId = this.getBleDeviceId()
    if (bleDeviceId && otaBle.isConnected(bleDeviceId)) {
      otaBle.disconnect(bleDeviceId)
    }

    wx.setKeepScreenOn && wx.setKeepScreenOn({ keepScreenOn: false })
  },

  setSystemMetrics() {
    this.setData(system.getLayoutMetrics())
  },

  // 简化界面：按「加载固件信息完成」后的内部 state 生成画面字段（图标 + 标题 + 说明 + 是否显示主按钮）。
  screenForLoaded(state, firmware, viewData) {
    if (state === 'available') {
      const version =
        firmware && firmware.latestVersion
          ? `最新版本 ${firmware.latestVersion}`
          : '检测到可升级的新固件'
      // 未连接时把「点了会先连设备」说在前面，别让用户以为按钮卡住（配合 actionText「连接并升级」）
      const needConnect = !viewData || viewData.actionText === '连接并升级'
      return {
        screenStatus: 'ready',
        statusTitle: '发现新版本',
        statusDesc: needConnect ? `${version}（将先连接电子纸设备）` : version,
        artImage: artFor('ready'),
        showPrimary: true
      }
    }
    if (state === 'latest') {
      return {
        screenStatus: 'success',
        statusTitle: '已是最新版本',
        statusDesc: '当前固件已是最新，无需升级',
        artImage: artFor('success'),
        showPrimary: false
      }
    }
    // invalid：检测到可更新但包信息无效（缺版本号/下载地址/非 .bin）
    return {
      screenStatus: 'fail',
      statusTitle: '无法升级',
      statusDesc: (viewData && viewData.errorMessage) || '固件包无效，请稍后重试',
      artImage: artFor('fail'),
      showPrimary: false
    }
  },

  // 本页可用的 BLE 连接 id：**只认「与本页设备记录身份一致的活动会话」**。
  // 绝不退回 selectedDevice 的旧句柄——OTA 是不可逆写设备，连错一台就是刷错固件。
  getBleDeviceId() {
    return activeDevice.findConnectedDeviceId(this.data.device || {})
  },

  async refreshDisplayedBattery() {
    const deviceId = this.getBleDeviceId()
    const device = this.data.device
    if (!device || !deviceId || !deviceBle.isConnected(deviceId)) {
      return
    }
    const token = (this._batteryReadToken || 0) + 1
    this._batteryReadToken = token
    const batteryState = await batteryUtil.readLatestBattery(deviceId, {
      fallback: device
    })
    if (this._batteryReadToken !== token) {
      return
    }
    const updated = Object.assign({}, this.data.device || device, batteryState)
    this.setData({
      device: updated,
      batteryText: batteryUtil.batteryText(updated)
    })
    const selected = app.globalData && app.globalData.selectedDevice
    if (
      selected &&
      (selected.deviceId === deviceId || selected.bleDeviceId === deviceId)
    ) {
      app.setSelectedDevice(Object.assign({}, selected, updated))
    }
  },

  deriveViewData(device, firmware) {
    const pkg = firmware && firmware.package ? firmware.package : null
    const batteryText = batteryUtil.batteryText(device)
    const hasPackage = !!(firmware && firmware.hasUpdate && pkg)
    const bleDeviceId = (firmware && firmware.bleDeviceId) || (device && device.deviceId) || ''
    const connected = !!bleDeviceId && device && device.connected !== false
    // ⚠️ canUpgrade 只表示「有包、可以按下按钮」，**不含「已连接」**：
    //    未连接时按钮改成「连接并升级」，点了先自动扫连再升（见 startUpgrade / ensureConnectedDevice）。
    //    2026-08-11 前这里把「未连接」也算进 canUpgrade=false，而按钮照画不误 —— 点了没反应的根因。
    let canUpgrade = !!hasPackage
    let statusText = '已是最新'
    let statusClass = 'is-latest'
    let actionText = '已是最新'
    let errorMessage = ''

    if (firmware && firmware.invalidUpdate) {
      canUpgrade = false
      statusText = '无法升级'
      statusClass = 'is-error'
      actionText = '无法升级'
      errorMessage =
        firmware.invalidReason ||
        '检测到电子纸设备可更新，但固件版本号或下载地址无效，请稍后重试。'
    } else if (hasPackage) {
      statusText = '发现新版本'
      statusClass = 'is-available'
      actionText = '立即升级'
    }

    // 未连接不是错误态，只是「要先连一下」：按钮改成「连接并升级」，点击走自动扫连。
    // （`bleDeviceId` 为空就是「此刻没有与本页设备身份一致的活动会话」，与「记录缺身份」不可区分，
    //   所以一律按未连接处理——真的缺身份时扫连也会失败，那时 ensureConnectedForAction 会如实提示。）
    if (hasPackage && !connected) {
      statusText = '电子纸设备未连接'
      statusClass = 'is-available'
      actionText = '连接并升级'
      errorMessage = ''
    }

    return {
      canUpgrade,
      statusText,
      statusClass,
      actionText,
      errorMessage,
      currentVersion: firmware && firmware.currentVersion ? firmware.currentVersion : (device && device.firmwareVersion) || '--',
      latestVersion: firmware && firmware.latestVersion ? firmware.latestVersion : '--',
      packageSizeText: pkg && pkg.sizeBytes ? formatSize(pkg.sizeBytes) : (pkg ? '下载后确认' : '--'),
      batteryText,
      minBatteryText: '--',
      releaseNotes: firmware && Array.isArray(firmware.releaseNotes) ? firmware.releaseNotes : []
    }
  },

  async loadFirmware() {
    if (!this.data.id) {
      this.setData({
        loading: false,
        state: 'failed',
        statusText: '电子纸设备不存在',
        statusClass: 'is-error',
        errorMessage: '缺少电子纸设备ID，无法检查固件版本。'
      })
      return
    }

    this.setData({
      loading: true,
      state: 'checking',
      progressPercent: 0,
      progressText: '',
      errorMessage: '',
      screenStatus: 'checking',
      statusTitle: '检测版本中',
      statusDesc: '正在检查固件版本，请稍候…',
      artImage: artFor('checking'),
      showPrimary: false
    })

    try {
      await app.ensureLogin()
      let device = await api.getDeviceDetail(this.data.id)

      if (!device) {
        throw new Error('电子纸设备不存在')
      }

      device = mergeSelectedDevice(device)
      const batteryDeviceId = device.deviceId || device.bleDeviceId
      const batteryState =
        device.connected && batteryDeviceId
          ? await batteryUtil.readLatestBattery(batteryDeviceId, {
              fallback: device
            })
          : batteryUtil.stampBattery(null)
      device = Object.assign({}, device, batteryState)
      const firmware = buildFirmwareFromDevice(device)
      const viewData = this.deriveViewData(device, firmware)
      const nextState = firmware.invalidUpdate
        ? 'invalid'
        : firmware.hasUpdate
          ? 'available'
          : 'latest'

      this.setData(Object.assign({
        loading: false,
        device,
        firmware,
        state: nextState
      }, viewData, this.screenForLoaded(nextState, firmware, viewData)))

      if (
        this._autoStart &&
        !this._autoStartConsumed &&
        viewData.canUpgrade
      ) {
        this._autoStartConsumed = true
        setTimeout(() => this.runUpgrade(), 80)
      }
    } catch (error) {
      const message = error.message || '固件版本检查失败'
      this.setData({
        loading: false,
        state: 'failed',
        statusText: '检查失败',
        statusClass: 'is-error',
        errorMessage: message,
        canUpgrade: false,
        actionText: '重新检查',
        // 检查失败：firmware 为空，点主按钮会重新检查（见 startUpgrade）
        screenStatus: 'fail',
        statusTitle: '检查失败',
        statusDesc: message,
        artImage: artFor('fail'),
        showPrimary: true
      })
    }
  },

  // 点主按钮。三种语义按当前画面区分，**任何一条分支都不许静默 return**：
  //   ① 检查失败且没有固件信息 → 重新检查；
  //   ② 没有可用升级包（已是最新 / 包信息无效）→ 如实提示 + 重新检查一次；
  //   ③ 有包 → 交给 runUpgrade（它会先确保连上本页这台设备）。
  //
  // ⚠️ 2026-08-11 修：此前这里是 `if (!this.data.canUpgrade) return` —— 而 canUpgrade 在
  //    「设备未连接」时必为 false，于是按钮画着、点了毫无反应，正是用户反馈的「OTA 没反应」。
  //    现在未连接不再是拦截理由，而是「先连上再升」。
  async startUpgrade() {
    if (this._starting) {
      return
    }

    if (this.data.state === 'upgrading') {
      toast.show({ title: '正在升级中，请稍候', icon: 'none' })
      return
    }

    if (this.data.state === 'failed' && !this.data.firmware) {
      this.loadFirmware()
      return
    }

    const pkg = this.data.firmware && this.data.firmware.package
    if (!pkg) {
      toast.warn({
        title: this.data.errorMessage || '当前没有可用的升级包',
        icon: 'none'
      })
      this.loadFirmware()
      return
    }

    this._starting = true
    try {
      await this.runUpgrade()
    } finally {
      this._starting = false
    }
  },

  // 确保连上**本页这台**设备并返回可用的 BLE 连接 id；连不上返回 ''（提示已由
  // ensureConnectedForAction 弹出：请先连接 / 权限引导）。
  //
  // 与「我的相册」删除、一键清空同一套做法：断联就地自动扫描重连，不把用户赶回详情页。
  // ⚠️ 认的是**设备身份**而不是缓存句柄：OTA 写错设备不可逆（刷错固件直接变砖）。
  async ensureConnectedDevice() {
    const existing = this.getBleDeviceId()
    if (existing && deviceBle.isConnected(existing)) {
      return existing
    }

    this.setData({
      screenStatus: 'progress',
      statusTitle: '连接电子纸设备中',
      statusDesc: '正在连接电子纸设备，请保持设备已开机并靠近手机…',
      artImage: artFor('progress'),
      progressPercent: 0,
      progressText: '',
      showPrimary: false
    })

    const deviceId = await activeDevice.ensureConnectedForAction(this.data.device)
    if (!deviceId) {
      // 连不上：回到可重试画面（提示已弹过，这里不再叠一个 toast）
      this.setData({
        state: 'failed',
        statusText: '电子纸设备未连接',
        statusClass: 'is-error',
        canUpgrade: true,
        actionText: '连接并升级',
        errorMessage: '未能连接电子纸设备，请确认设备已开机并靠近手机后重试。',
        screenStatus: 'fail',
        statusTitle: '无法升级',
        statusDesc: '未能连接电子纸设备，请确认设备已开机并靠近手机后重试。',
        artImage: artFor('fail'),
        showPrimary: true
      })
      return ''
    }

    // 把当下有效的连接句柄写回本页设备与全局选中设备，后续读电量/断开都用它
    const device = Object.assign({}, this.data.device, {
      deviceId,
      bleDeviceId: deviceId,
      connected: true
    })
    this.setData({ device })
    const selected = app.globalData && app.globalData.selectedDevice
    if (selected && sameDevice(selected, device)) {
      app.setSelectedDevice(Object.assign({}, selected, device))
    }
    return deviceId
  },

  // 升级中进度回调：按底层阶段(phase)把标题在「固件下载中 / 固件传输中 / 固件升级中」之间切换，
  // 并记住最后阶段(_lastPhase)，供失败时区分「固件下载失败」还是「升级失败」。
  onUpgradeProgress(progress) {
    const percent = Math.max(0, Math.min(100, progress.percent || 0))
    const phase = progress.phase || ''
    if (phase) {
      this._lastPhase = phase
    }
    // 读包/下载 + 连接握手 → 下载中；128字节头握手 + 窗口化传数据 → 传输中；发结束包/设备整包校验 → 升级中
    const STAGE_TITLE = {
      preparing: '固件下载中',
      prepared: '固件下载中',
      connecting: '固件下载中',
      starting: '固件下载中',
      header: '固件传输中',
      transferring: '固件传输中',
      retry: '固件传输中',
      verifying: '固件升级中',
      done: '固件升级中'
    }
    const statusTitle = STAGE_TITLE[phase] || this.data.statusTitle
    const progressText = progress.message || ''
    // 去重：进度回调由 PRN 窗口 ACK 驱动、频率较高，三个展示值都没变就不 setData；
    // 静态字段(标题/插画/screenStatus)只在标题切换时才重传（参照 result.js 的进度节流思路）
    if (
      percent === this._lastProgressPercent &&
      statusTitle === this._lastProgressTitle &&
      progressText === this._lastProgressText
    ) {
      return
    }
    const payload = { progressPercent: percent }
    if (statusTitle !== this._lastProgressTitle || this.data.screenStatus !== 'progress') {
      payload.screenStatus = 'progress'
      payload.statusTitle = statusTitle
      payload.artImage = artFor('progress')
    }
    if (progressText !== this._lastProgressText) {
      payload.progressText = progressText
    }
    this._lastProgressPercent = percent
    this._lastProgressTitle = statusTitle
    this._lastProgressText = progressText
    this.setData(payload)
  },

  async runUpgrade() {
    // 防重入：auto=1 的 setTimeout 自动触发（loadFirmware 里）不经过 startUpgrade 的闸门，
    // 与用户点击可能并发出两条 DFU 流——同一 session 上交叉写 DATA 数据流，设备收到乱序字节必败。
    // ⚠️ 不能只看 `state === 'upgrading'`：自动扫连（ensureConnectedDevice，可达十几秒）期间
    //    state 还没置成 upgrading，此时用户点一下按钮就会并发出第二条流。用同步闸门 _running 兜住。
    if (this._running || this.data.state === 'upgrading') {
      return
    }
    this._running = true
    try {
      await this.doRunUpgrade()
    } finally {
      this._running = false
    }
  },

  async doRunUpgrade() {

    const firmware = this.data.firmware
    const pkg = firmware && firmware.package

    if (!pkg) {
      toast.warn({ title: '当前没有可用的升级包', icon: 'none' })
      return
    }

    // 真实升级必须有可用的 BLE 连接：断联就地自动重连（见 ensureConnectedDevice），
    // 连不上时它已经把画面切成可重试态并提示过，这里直接收手。
    const bleDeviceId = await this.ensureConnectedDevice()
    if (!bleDeviceId) {
      return
    }

    this._abortUpgrade = false
    this._lastPhase = '' // 重置阶段，供失败时区分下载/升级
    // 重置进度去重追踪器（onUpgradeProgress），避免「重新升级」时与上一轮的值误判为未变化
    this._lastProgressPercent = -1
    this._lastProgressTitle = ''
    this._lastProgressText = ''
    wx.setKeepScreenOn && wx.setKeepScreenOn({ keepScreenOn: true })
    this.setData({
      state: 'upgrading',
      statusText: '升级中',
      statusClass: 'is-upgrading',
      canUpgrade: false,
      actionText: '升级中',
      progressPercent: 0,
      progressText: '准备升级',
      errorMessage: '',
      // 简化界面：进入进行中画面
      screenStatus: 'progress',
      statusTitle: '固件下载中',
      statusDesc: '升级中请保持电子纸设备供电、手机屏幕常亮，勿切后台',
      artImage: artFor('progress'),
      showPrimary: false
    })

    // 升级传输要数分钟且左上角返回始终可点：升级期间拦截返回（左上角/安卓物理键/侧滑），
    // 弹系统确认后才允许离开，防误触一下就静默中断 DFU、用户还以为升级完成了。
    if (wx.enableAlertBeforeUnload) {
      wx.enableAlertBeforeUnload({
        message: '正在升级固件，退出将中断本次升级，确定退出吗？'
      })
    }

    try {
      const result = await otaBle.upgradeFirmware(bleDeviceId, pkg, {
        pace: 20,
        // 传错包/下载截断/刷错面板在发第一帧前就本地拦住：刷错固件不可逆，不能等设备回错误码。
        // 判不出面板时 panelOfDevice 返回 0，预检自动跳过这一项，不误伤。
        expectPanel: otaBle.panelOfDevice(this.data.device),
        expectVersion: firmware.latestVersion,
        onProgress: progress => this.onUpgradeProgress(progress),
        shouldAbort: () => this._abortUpgrade
      })

      // v1.5：升级成败以「APP 发 END(0xF3) 后设备回的整包校验 ACK」为准——成功则 ota-ble 返回 confirmed:true，
      // 任何一步(头信息/数据/END)超时或校验失败都会抛错走下方 catch，不再返回"软成功"。故 confirmed:false 仅作
      // 兜底：万一走到这里说明未拿到设备最终确认 → 升级未确认，如实提示重试，绝不谎报"升级完成"。
      const unconfirmed = result && result.confirmed === false
      const doneText = unconfirmed ? '未确认(请重试)' : '升级完成'

      // 未确认 = 没拿到设备 0xF3：不能假报成功——不上报 success、不把本地版本改成新版、
      // 保留升级包并开放「重新升级」，否则用户既被误导"已升级"又没有任何重试入口，后端记录也是假的。
      if (unconfirmed) {
        await api.reportDeviceFirmwareUpgrade(this.data.id, {
          status: 'fail',
          version: firmware.latestVersion,
          message: '数据已全部发送，但未收到电子纸设备 0xF3 确认，升级未确认成功'
        }).catch(() => {})
        this.setData({
          state: 'failed',
          statusText: '未确认(请重试)',
          statusClass: 'is-error',
          canUpgrade: true,
          actionText: '重新升级',
          progressPercent: 100,
          progressText: doneText,
          errorMessage: '数据已全部发送，但未收到电子纸设备 0xF3 确认——升级未确认成功，请重试。',
          screenStatus: 'fail',
          statusTitle: '升级失败',
          statusDesc: '数据已全部发送，但未收到电子纸设备确认，升级未确认成功，请重试。',
          artImage: artFor('fail'),
          showPrimary: true
        })
        // 未确认是失败语义（没拿到设备 0xF3 确认）：按约定走 warn 加「设备-」来源前缀
        toast.warn({ title: '电子纸设备-' + doneText, icon: 'none' })
        return
      }

      // 升级成功：回报后台
      await api.reportDeviceFirmwareUpgrade(this.data.id, {
        status: 'success',
        version: firmware.latestVersion,
        size: result.size,
        crc32: result.crc32
      }).catch(() => {})

      const updatedDevice = Object.assign({}, this.data.device, {
        firmwareVersion: firmware.latestVersion,
        connected: true
      })
      const updatedFirmware = Object.assign({}, firmware, {
        currentVersion: firmware.latestVersion,
        hasUpdate: false,
        invalidUpdate: false,
        invalidReason: '',
        package: null
      })

      if (app.globalData.selectedDevice && app.globalData.selectedDevice.id === updatedDevice.id) {
        app.setSelectedDevice(updatedDevice)
      }

      this.setData(Object.assign({
        device: updatedDevice,
        firmware: updatedFirmware,
        state: 'success',
        progressPercent: 100,
        progressText: doneText,
        statusText: doneText,
        statusClass: 'is-latest'
      }, this.deriveViewData(updatedDevice, updatedFirmware), {
        screenStatus: 'success',
        statusTitle: '升级成功',
        statusDesc: '固件已升级到最新版本',
        artImage: artFor('success'),
        showPrimary: false
      }))

      toast.show({ title: doneText, icon: 'none' })
    } catch (error) {
      const aborted = this._abortUpgrade || (error && error.message === 'OTA_ABORTED')
      const message = aborted
        ? '升级已中断：升级过程中手机切到后台或页面离开。请保持屏幕常亮后重试。'
        : (error.message || '固件升级失败')

      await api.reportDeviceFirmwareUpgrade(this.data.id, {
        status: 'fail',
        version: firmware.latestVersion,
        message
      }).catch(() => {})

      // 区分「固件下载失败」与「升级失败」：读包/下载阶段(preparing/prepared)出错即下载失败
      const inDownload =
        this._lastPhase === 'preparing' || this._lastPhase === 'prepared' || !this._lastPhase
      const failTitle = inDownload ? '固件下载失败' : '升级失败'
      this.setData({
        state: 'failed',
        statusText: '升级失败',
        statusClass: 'is-error',
        canUpgrade: true,
        actionText: '重新升级',
        errorMessage: message,
        screenStatus: 'fail',
        statusTitle: failTitle,
        statusDesc: message,
        artImage: artFor('fail'),
        showPrimary: true
      })
    } finally {
      wx.setKeepScreenOn && wx.setKeepScreenOn({ keepScreenOn: false })
      // 升级已收尾（成功/失败/中断都会走到这），解除返回拦截
      wx.disableAlertBeforeUnload && wx.disableAlertBeforeUnload({ fail: () => {} })
    }
  },

  goBack() {
    const pages = getCurrentPages()

    if (pages.length > 1) {
      wx.navigateBack()
      return
    }

    wx.navigateTo({
      url: `/subpackages/device/detail/detail?id=${this.data.id}`
    })
  }
}))
