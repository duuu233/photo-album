const api = require('../../../utils/api')
const otaBle = require('../../../utils/ota-ble')
const deviceBle = require('../../../utils/device-ble')
const toast = require('../../../utils/toast')
const system = require('../../../utils/system')
const batteryUtil = require('../../../utils/battery')
const activeDevice = require('../../../utils/active-device')
const connCache = require('../../../utils/device-conn-cache')
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
  const readVersion = textValue(
    device && (device.firmwareVersion || device.currentVersion)
  )
  const currentVersion = readVersion || '--'
  // 2026-08-12：判定口径与详情页「固件升级」行统一（subpackages/device/detail/detail.js
  // evaluateFirmwareUpdate）——以设备实际在跑的固件版本(0x03 GET_SW_VER)与详情接口下发的
  // newVersionNo 比较为准，版本号不同才算有更新，即便后台 isUpdate=1 也不例外。
  // 只有**读不到设备当前版本**（未连接/0x03 读失败）时才退回后端 isUpdate 标志——否则详情页
  // 判定「有版本可更新」、点「立刻更新」进来这里却显示「已是最新版本」，用户永远升不了级。
  const hasUpdate = readVersion
    ? !!version && !sameVersion(readVersion, version)
    : isUpdateFlag(device)
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

  // 页面退出 = 中断本轮升级。中断的收尾必须与「失败」完全同一套（2026-08-12）：
  // 只断 OTA(FF10) 会话是不够的 —— FF10 与 FF00 是**同一条物理连接**，断了链路却把 device-ble 的
  // FF00 会话、0x01 读数、电量缓存留在原地，详情页/首页会拿着一条死链路继续发指令，
  // 一直等到超时（现场那句「升级完/中断后读不到设备信息」）。
  // 设备侧同理：中断时它的 DFU 状态机停在半截，只有断链才能让它复位，否则下次 START 必被回 0x05。
  onUnload() {
    const interrupted = this.data.state === 'upgrading'
    this._abortUpgrade = true

    // 仅在真的开过 OTA(FF10) 会话、或本轮升级正在跑时才收尾，避免未升级时误关详情页持有的 FF00 连接。
    const bleDeviceId = this.getBleDeviceId()
    if (bleDeviceId && (otaBle.isConnected(bleDeviceId) || interrupted)) {
      // 页面正在卸载，等不了：收尾里的蓝牙栈硬复位（关适配器 → 重开，见 ota-ble.resetAfterUpgrade）
      // 交给它自己跑完，失败也只记日志——不能让一个 unhandled rejection 打断卸载。
      Promise.resolve(
        otaBle.resetAfterUpgrade(
          bleDeviceId,
          interrupted ? '页面退出，中断本轮升级' : '离开升级页'
        )
      ).catch(error => {
        console.warn('[OTA页] 离开升级页时的收尾复位失败：', (error && error.message) || error)
      })
    }
    if (interrupted) {
      // 记录级复位：直连缓存 + 全局选中设备的连接态。页面已在卸载，跳过 setData。
      this.resetDeviceStateAfterUpgrade('升级中断（页面退出）', { skipSetData: true })
    }

    wx.setKeepScreenOn && wx.setKeepScreenOn({ keepScreenOn: false })
    // 返回拦截随页面一起走：升级中途被系统/异常路径卸载时，别把拦截留给下一个页面
    wx.disableAlertBeforeUnload && wx.disableAlertBeforeUnload({ fail: () => {} })
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

      // auto=1（详情页「立刻更新」直接进来升级）时，「发现新版本」这一屏只是**路过**：
      // 80ms 后 runUpgrade 就把画面切成进行中。但这一帧照旧会把底部按钮区渲染出来，
      // 用户看到的就是「页面下方闪一下『立即升级』和『返回』」（2026-08-12 需求 2）。
      // 所以这条路直接以进行中画面落地——按钮区一次都不出现，与随后的「连接电子纸设备中」无缝接上。
      const willAutoStart = !!(
        this._autoStart &&
        !this._autoStartConsumed &&
        viewData.canUpgrade
      )
      this.setData(Object.assign({
        loading: false,
        device,
        firmware,
        state: nextState
      }, viewData, willAutoStart ? {
        screenStatus: 'progress',
        statusTitle: '准备升级',
        statusDesc: '正在准备固件升级，请保持电子纸设备已开机并靠近手机…',
        artImage: artFor('progress'),
        progressPercent: 0,
        showPrimary: false
      } : this.screenForLoaded(nextState, firmware, viewData)))

      if (willAutoStart) {
        this._autoStartConsumed = true
        setTimeout(() => {
          // 自动开始这条路没有调用方兜底：万一 runUpgrade 抛到这里，得把画面退回可操作态，
          // 否则用户会一直卡在没有任何按钮的「准备升级」上（上面刚把按钮区收起来了）。
          Promise.resolve(this.runUpgrade()).catch(error => {
            console.warn('[OTA页] 自动开始升级失败：', (error && error.message) || error)
            this.setData(
              Object.assign(
                { state: 'available' },
                this.screenForLoaded('available', this.data.firmware, this.data)
              )
            )
          })
        }, 80)
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
    // 全链路日志的起点：用户点了什么、当时页面处在什么状态。
    // 后面每个节点由 utils/ota-ble.js 以 [OTA#n +x.xxs] 打印，两段合起来就是一次完整升级的时间线。
    console.log('[OTA页] 点击主按钮', {
      按钮文案: this.data.actionText,
      当前状态: this.data.state,
      设备记录: this.data.id,
      已连接: !!(this.data.device && this.data.device.connected),
      当前版本: this.data.currentVersion,
      目标版本: this.data.latestVersion
    })
    if (this._starting) {
      console.log('[OTA页] 忽略：上一次点击仍在处理中')
      return
    }

    if (this.data.state === 'upgrading') {
      console.log('[OTA页] 忽略：正在升级中')
      toast.show({ title: '正在升级中，请稍候', icon: 'none' })
      return
    }

    if (this.data.state === 'failed' && !this.data.firmware) {
      console.log('[OTA页] 检查失败且无固件信息 → 重新检查版本')
      this.loadFirmware()
      return
    }

    const pkg = this.data.firmware && this.data.firmware.package
    if (!pkg) {
      console.log('[OTA页] 没有可用升级包 → 提示并重新检查', this.data.errorMessage || '')
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
      console.log('[OTA页] 设备已连接，直接使用当前会话', { bleDeviceId: existing })
      return existing
    }
    console.log('[OTA页] 设备未连接 → 就地扫描重连', {
      设备记录: this.data.id,
      记录设备ID: (this.data.device && (this.data.device.productDeviceId || this.data.device.deviceNo)) || '(无)'
    })

    this.setData({
      screenStatus: 'progress',
      statusTitle: '连接电子纸设备中',
      statusDesc: '正在连接电子纸设备，请保持设备已开机并靠近手机…',
      artImage: artFor('progress'),
      progressPercent: 0,
      showPrimary: false
    })

    const deviceId = await activeDevice.ensureConnectedForAction(this.data.device)
    if (!deviceId) {
      console.warn('[OTA页] 连接失败，升级未开始（失败原因已由连接层提示）')
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
    console.log('[OTA页] 连接成功，可以开始升级', { bleDeviceId: deviceId })
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
    // 协议层给的说明文案（形如「传输中：1234/56789 字节（12/345 包）」「握手中（MTU 247）」）。
    // 2026-09-02 需求把进度条下面这行**屏蔽**，所以它只往下面的阶段日志里走、不再进 data
    // （wxml 里的 .progress-note 已同步摘掉）—— 字节数/包序只在排查时有用。
    const progressText = progress.message || ''
    // 阶段切换各打一条（不打每个百分比，否则窗口 ACK 驱动的高频回调会刷屏）：
    // 页面看到的阶段与 ota-ble 打的协议节点能对上，出问题时一眼看出卡在哪一段。
    if (phase && phase !== this._loggedPhase) {
      this._loggedPhase = phase
      console.log(`[OTA页] 进度阶段 → ${phase}（${statusTitle}）`, {
        百分比: percent,
        说明: progressText
      })
    }
    // 去重：进度回调由 PRN 窗口 ACK 驱动、频率较高，两个展示值都没变就不 setData；
    // 静态字段(标题/插画/screenStatus)只在标题切换时才重传（参照 result.js 的进度节流思路）。
    // ⚠️ 说明文案不再上屏后也就退出了去重条件：以前「百分比没动、只有字节数在变」的那些回调
    // 会白刷一次 setData，现在直接被挡在这里。
    if (
      percent === this._lastProgressPercent &&
      statusTitle === this._lastProgressTitle
    ) {
      return
    }
    const payload = { progressPercent: percent }
    if (statusTitle !== this._lastProgressTitle || this.data.screenStatus !== 'progress') {
      payload.screenStatus = 'progress'
      payload.statusTitle = statusTitle
      payload.artImage = artFor('progress')
    }
    this._lastProgressPercent = percent
    this._lastProgressTitle = statusTitle
    this.setData(payload)
  },

  // 一轮 OTA 结束后（**成功或失败都要走**）把页面/全局侧的设备状态与缓存复位。
  //
  // 链路层的缓存由 ota-ble.resetAfterUpgrade 清（OTA 会话、FF00 会话、0x01 读数、电量），
  // 这里清的是「记录级」的那两处，它们按后端稳定设备ID 存、ota-ble 拿不到：
  //   · device-conn-cache：稳定ID → 上次的微信 deviceId。设备刚复位，这个句柄多半连不上，
  //     留着只会让下一次连接先白花 3 秒直连探测，再回落扫描（现场「OTA 完连不上」的一部分）；
  //   · 本页 device 与 app.globalData.selectedDevice 里的 connected/bleDeviceId —— 设备已经重启，
  //     再把它当「已连接」会让详情页/首页拿着死句柄发指令，表现就是「读不到设备信息」。
  // 下次要用这台设备时正常走一遍扫描重连即可（多花一次扫描，换来状态一定是真的）。
  // options.skipSetData：页面正在卸载（onUnload 的中断收尾）时跳过 setData —— 此时 setData 不会生效，
  // 但全局选中设备与直连缓存仍必须复位，否则下一个页面照旧拿着死句柄当「已连接」。
  resetDeviceStateAfterUpgrade(reason, options = {}) {
    const device = this.data.device || {}
    const stableId = device.productDeviceId || device.deviceNo || ''
    console.log(`[OTA页] 收尾复位（${reason}）：清直连缓存 + 把设备标记为未连接`, {
      稳定设备ID: stableId || '(无)',
      原BLE句柄: device.deviceId || device.bleDeviceId || '(无)'
    })
    try {
      if (stableId) {
        connCache.remove(stableId)
      }
    } catch (error) {
      // 清缓存失败不影响升级结论
    }
    const reset = Object.assign({}, device, {
      deviceId: '',
      bleDeviceId: '',
      connected: false
    })
    if (!options.skipSetData) {
      this.setData({ device: reset })
    }
    const selected = app.globalData && app.globalData.selectedDevice
    if (selected && sameDevice(selected, reset) && typeof app.setSelectedDevice === 'function') {
      app.setSelectedDevice(Object.assign({}, selected, {
        deviceId: '',
        bleDeviceId: '',
        connected: false
      }))
    }
    return reset
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

    console.log('[OTA页] 开始升级流程', {
      bleDeviceId,
      当前版本: firmware.currentVersion,
      目标版本: firmware.latestVersion,
      包大小: pkg.sizeBytes || '(下载后确认)',
      包地址: pkg.packageUrl || '(本地)',
      期望面板: otaBle.panelOfDevice(this.data.device) || '(判不出，跳过面板预检)'
    })
    this._abortUpgrade = false
    this._lastPhase = '' // 重置阶段，供失败时区分下载/升级
    this._loggedPhase = '' // 重置阶段日志去重
    // 重置进度去重追踪器（onUpgradeProgress），避免「重新升级」时与上一轮的值误判为未变化
    this._lastProgressPercent = -1
    this._lastProgressTitle = ''
    wx.setKeepScreenOn && wx.setKeepScreenOn({ keepScreenOn: true })
    this.setData({
      state: 'upgrading',
      statusText: '升级中',
      statusClass: 'is-upgrading',
      canUpgrade: false,
      actionText: '升级中',
      progressPercent: 0,
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
      console.log('[OTA页] 底层升级返回', {
        设备已确认: !unconfirmed,
        文件字节: result && result.size,
        bin字节: result && result.payloadSize,
        总包数: result && result.totalPackets,
        每包字节: result && result.chunkSize,
        CRC32: result && result.crc32 !== undefined ? '0x' + (result.crc32 >>> 0).toString(16).toUpperCase() : '--'
      })

      // 未确认 = 没拿到设备 0xF3：不能假报成功——不把本地版本改成新版、
      // 保留升级包并开放「重新升级」，否则用户既被误导"已升级"又没有任何重试入口。
      if (unconfirmed) {
        this.setData({
          state: 'failed',
          statusText: '未确认(请重试)',
          statusClass: 'is-error',
          canUpgrade: true,
          actionText: '重新升级',
          progressPercent: 100,
          errorMessage: '数据已全部发送，但未收到电子纸设备 0xF3 确认——升级未确认成功，请重试。',
          screenStatus: 'fail',
          statusTitle: '升级失败',
          statusDesc: '数据已全部发送，但未收到电子纸设备确认，升级未确认成功，请重试。',
          artImage: artFor('fail'),
          showPrimary: true
        })
        // 未确认是失败语义（没拿到设备 0xF3 确认）：按约定走 warn 加「设备-」来源前缀
        toast.warn({ title: '电子纸设备-' + doneText, icon: 'none' })
        this.resetDeviceStateAfterUpgrade('升级未确认')
        return
      }

      // 升级成功。⚠️ 不上报后端（2026-08-13 产品口径：OTA 升级结果不需要通知后端；
      // 原来调的 `/devices/:id/firmware/upgrade-result` 是 mock 时代的假接口，真实后端没有这条路由）。
      console.log('[OTA页] 升级成功', {
        设备记录: this.data.id,
        版本: firmware.latestVersion
      })

      // ⚠️ connected 必须置 false：设备在 END 校验通过约 100ms 后就复位运行新固件，这条连接已经没了。
      // 之前这里写 connected:true，页面/首页会拿着一条死链路的旧句柄继续发指令，
      // 表现就是「升级完读不到设备信息」。链路层缓存由 ota-ble.resetAfterUpgrade 清，
      // 记录级缓存（直连句柄、selectedDevice 连接态）由下面这行清。
      const updatedDevice = Object.assign({}, this.resetDeviceStateAfterUpgrade('升级成功，设备正在重启'), {
        firmwareVersion: firmware.latestVersion
      })
      const updatedFirmware = Object.assign({}, firmware, {
        currentVersion: firmware.latestVersion,
        hasUpdate: false,
        invalidUpdate: false,
        invalidReason: '',
        package: null
      })

      // 合并而不是整体替换（2026-08-12）：本页的 device 来自 getUserProductDetail，
      // 而 selectedDevice 上还挂着别处才拿得到的运行时字段（0x01/广播读到的 screenType、
      // 首页/列表补的展示字段…）。整体替换会把它们一并抹掉，升级成功后详情页分辨率、
      // OTA 面板预检(panelOfDevice 先看 screenType)这些都会跟着降级——
      // 与三行前 resetDeviceStateAfterUpgrade 的合并口径保持一致。
      const selectedNow = app.globalData.selectedDevice
      if (selectedNow && sameDevice(selectedNow, updatedDevice)) {
        app.setSelectedDevice(Object.assign({}, selectedNow, updatedDevice))
      }

      this.setData(Object.assign({
        device: updatedDevice,
        firmware: updatedFirmware,
        state: 'success',
        progressPercent: 100,
        statusText: doneText,
        statusClass: 'is-latest'
      }, this.deriveViewData(updatedDevice, updatedFirmware), {
        screenStatus: 'success',
        statusTitle: '升级成功',
        // 如实告诉用户「设备正在重启、连接已断开」：升级成功后设备约 100ms 复位，
        // 重新广播要等几秒。不说清楚的话，用户立刻回去点投屏/读信息会以为是升级把设备弄坏了。
        statusDesc: '固件已升级到最新版本。电子纸设备正在重启，请稍等几秒后重新连接。',
        artImage: artFor('success'),
        showPrimary: false
      }))

      toast.show({ title: doneText, icon: 'none' })
    } catch (error) {
      const aborted = this._abortUpgrade || (error && error.message === 'OTA_ABORTED')
      const message = aborted
        ? '升级已中断：升级过程中手机切到后台或页面离开。请保持屏幕常亮后重试。'
        : (error.message || '固件升级失败')
      // 还没碰过设备就失败了（升级包下载/读取/校验阶段，见 ota-ble.upgradeFirmware 的 deviceUntouched）：
      // 链路与设备都完好，ota-ble 也没有断链。此时再做记录级复位，就会把用户已经连着的那条连接
      // 标记成未连接、并删掉直连缓存 —— 下次连接白花一整轮扫描。一次网络失败不该有这种代价。
      const deviceUntouched = !!(error && error.deviceUntouched)
      console.warn('[OTA页] 升级失败/中断', {
        是否用户中断: !!aborted,
        最后阶段: this._lastPhase || '(未进入任何阶段)',
        是否碰过设备: !deviceUntouched,
        错误: message
      })
      // 失败同样复位：链路已被 ota-ble 断掉，页面再显示「已连接」就会误导下一次操作
      if (!deviceUntouched) {
        this.resetDeviceStateAfterUpgrade('升级失败/中断')
      } else {
        console.log('[OTA页] 本轮未与设备交互（包下载/校验阶段失败），保留连接与直连缓存')
      }

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
