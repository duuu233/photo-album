const api = require('../../../utils/api')
const otaBle = require('../../../utils/ota-ble')
const deviceBle = require('../../../utils/device-ble')
const toast = require('../../../utils/toast')
const system = require('../../../utils/system')

const app = getApp()

// 本地测试固件（代码包内）：详情页「OTA升级」长按进入测试流程时使用。
// 真机连上设备 → 走真实蓝牙 DFU；未连接（如开发者工具）→ 自动降级为干跑，仅校验编码/分包。
const TEST_FW_PATH = 'docs/BR1601A02_260609_r8122_5139_5D89_V100_OTA.bin'
const TEST_FW_NAME = 'BR1601A02_260609_r8122_5139_5D89_V100_OTA.bin'

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
  if (!a || !b) {
    return false
  }
  const aId = textValue(a.id || a.userProductId)
  const bId = textValue(b.id || b.userProductId)
  return !!(aId && bId && aId === bId)
}

function mergeSelectedDevice(device) {
  const selected = (app.globalData && app.globalData.selectedDevice) || null
  let merged = device

  if (sameDevice(device, selected)) {
    merged = Object.assign({}, device, {
      deviceId: device.deviceId || selected.deviceId || selected.bleDeviceId,
      bleDeviceId:
        device.bleDeviceId || selected.bleDeviceId || selected.deviceId,
      battery:
        typeof device.battery === 'number' ? device.battery : selected.battery,
      firmwareVersion: device.firmwareVersion || selected.firmwareVersion
    })
  }

  const bleDeviceId = textValue(
    merged && (merged.deviceId || merged.bleDeviceId)
  )
  return Object.assign({}, merged, {
    connected: !!(bleDeviceId && deviceBle.isConnected(bleDeviceId))
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

Page({
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
    testMode: false
  },

  onLoad(options = {}) {
    this._abortUpgrade = false
    // test=1：本地固件测试流程；dry=1：强制干跑（不连蓝牙，仅校验编码）。
    this._testMode = options.test === '1' || options.test === 'true'
    this._forceDryRun = options.dry === '1' || options.dry === 'true'
    this._autoStart = options.auto === '1' || options.auto === 'true'
    this._autoStartConsumed = false
    this.setData(Object.assign(system.getLayoutMetrics(), {
      id: options.id || '',
      testMode: this._testMode
    }))

    if (this._testMode) {
      this.loadLocalTestFirmware()
    } else {
      this.loadFirmware()
    }
  },

  onHide() {
    if (this.data.state === 'upgrading') {
      this._abortUpgrade = true
    }
  },

  onUnload() {
    this._abortUpgrade = true

    // 仅在真的开过 OTA(FF10) 会话时才断开，避免干跑/未升级时误关详情页持有的 FF00 连接。
    const bleDeviceId = this.getBleDeviceId()
    if (bleDeviceId && otaBle.isConnected(bleDeviceId)) {
      otaBle.disconnect(bleDeviceId)
    }

    wx.setKeepScreenOn && wx.setKeepScreenOn({ keepScreenOn: false })
  },

  setSystemMetrics() {
    this.setData(system.getLayoutMetrics())
  },

  getBleDeviceId() {
    const firmware = this.data.firmware || {}
    const device = this.data.device || {}
    const selected = (app.globalData && app.globalData.selectedDevice) || {}
    return (
      firmware.bleDeviceId ||
      device.deviceId ||
      device.bleDeviceId ||
      selected.deviceId ||
      selected.bleDeviceId ||
      ''
    )
  },

  // 本地固件测试流程：跳过后台，直接把代码包内的 .bin 当作升级包。
  // bleDeviceId 取当前全局选中设备（详情页连接后会写入）。已连接走真实蓝牙；未连接则提示将做干跑校验。
  loadLocalTestFirmware() {
    const selected = (app.globalData && app.globalData.selectedDevice) || {}
    const bleDeviceId = selected.deviceId || selected.bleDeviceId || ''
    const connected = !!(bleDeviceId && deviceBle.isConnected(bleDeviceId))
    const willDryRun = this._forceDryRun || !connected

    const device = {
      name: selected.name || '测试设备',
      battery: typeof selected.battery === 'number' ? selected.battery : null,
      connected,
      deviceId: bleDeviceId
    }
    const firmware = {
      hasUpdate: true,
      currentVersion: selected.firmwareVersion || '--',
      latestVersion: 'TEST-LOCAL',
      bleDeviceId,
      minBattery: 0,
      releaseNotes: [
        `本地固件：${TEST_FW_NAME}`,
        willDryRun
          ? '当前未连接设备：点击将进行「干跑」，仅校验读包/组帧/分包（不经过真实蓝牙）'
          : '设备已连接：点击将通过蓝牙执行真实 DFU 升级',
        'DFU 协议：FF10/FF11 · 1 字节累加校验 · 信用窗口 PRN'
      ],
      package: {
        version: 'TEST-LOCAL',
        fileName: TEST_FW_NAME,
        sizeBytes: 0,
        localPath: TEST_FW_PATH,
        isLocalTest: true
      }
    }

    const batteryText = typeof device.battery === 'number' ? `${device.battery}%` : '--'
    this.setData({
      loading: false,
      device,
      firmware,
      state: 'available',
      canUpgrade: true,
      statusText: willDryRun ? '本地测试(干跑)' : '本地测试',
      statusClass: 'is-available',
      actionText: willDryRun ? '开始干跑测试' : '开始本地升级',
      errorMessage: '',
      currentVersion: firmware.currentVersion,
      latestVersion: firmware.latestVersion,
      packageSizeText: '本地包',
      batteryText,
      minBatteryText: '--',
      releaseNotes: firmware.releaseNotes
    })
  },

  deriveViewData(device, firmware) {
    const pkg = firmware && firmware.package ? firmware.package : null
    const batteryText = device && typeof device.battery === 'number' ? `${device.battery}%` : '--'
    const hasPackage = !!(firmware && firmware.hasUpdate && pkg)
    const bleDeviceId = (firmware && firmware.bleDeviceId) || (device && device.deviceId) || ''
    let canUpgrade = hasPackage && !!bleDeviceId && device && device.connected !== false
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
        '检测到设备可更新，但固件版本号或下载地址无效，请稍后重试。'
    } else if (hasPackage) {
      statusText = '发现新版本'
      statusClass = 'is-available'
      actionText = '立即升级'
    }

    if (hasPackage && !bleDeviceId) {
      canUpgrade = false
      statusText = '无法升级'
      statusClass = 'is-error'
      actionText = '重新绑定设备'
      errorMessage = '设备缺少蓝牙连接ID，请重新绑定后再升级。'
    } else if (hasPackage && device && device.connected === false) {
      canUpgrade = false
      statusText = '设备未连接'
      statusClass = 'is-error'
      actionText = '设备未连接'
      errorMessage = '请先连接设备，并在升级过程中保持设备在线。'
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
        statusText: '设备不存在',
        statusClass: 'is-error',
        errorMessage: '缺少设备ID，无法检查固件版本。'
      })
      return
    }

    this.setData({
      loading: true,
      state: 'checking',
      progressPercent: 0,
      progressText: '',
      errorMessage: ''
    })

    try {
      await app.ensureLogin()
      let device = await api.getDeviceDetail(this.data.id)

      if (!device) {
        throw new Error('设备不存在')
      }

      device = mergeSelectedDevice(device)
      const firmware = buildFirmwareFromDevice(device)
      const viewData = this.deriveViewData(device, firmware)

      this.setData(Object.assign({
        loading: false,
        device,
        firmware,
        state: firmware.invalidUpdate
          ? 'invalid'
          : firmware.hasUpdate
            ? 'available'
            : 'latest'
      }, viewData))

      if (
        this._autoStart &&
        !this._autoStartConsumed &&
        viewData.canUpgrade
      ) {
        this._autoStartConsumed = true
        setTimeout(() => this.runUpgrade(), 80)
      }
    } catch (error) {
      this.setData({
        loading: false,
        state: 'failed',
        statusText: '检查失败',
        statusClass: 'is-error',
        errorMessage: error.message || '固件版本检查失败',
        canUpgrade: false,
        actionText: '重新检查'
      })
    }
  },

  startUpgrade() {
    if (this.data.state === 'failed' && !this.data.firmware) {
      if (this._testMode) {
        this.loadLocalTestFirmware()
      } else {
        this.loadFirmware()
      }
      return
    }

    if (!this.data.canUpgrade || this.data.state === 'upgrading') {
      return
    }

    const pkg = (this.data.firmware && this.data.firmware.package) || {}
    const dryRun = this.willDryRun(pkg)

    if (dryRun) {
      this.runUpgrade() // 干跑不写设备，无需「保持供电」提示，直接跑
      return
    }

    this.runUpgrade()
  },

  // 是否走干跑：强制干跑，或（本地测试包且设备未连接）。
  willDryRun(pkg) {
    if (this._forceDryRun) {
      return true
    }
    if (!(pkg && pkg.isLocalTest)) {
      return false
    }
    const bleDeviceId = this.getBleDeviceId()
    return !(bleDeviceId && deviceBle.isConnected(bleDeviceId))
  },

  onUpgradeProgress(progress) {
    const percent = Math.max(0, Math.min(100, progress.percent || 0))
    this.setData({
      progressPercent: percent,
      progressText: progress.message || ''
    })
  },

  async runUpgrade() {
    // 防重入：auto=1 的 setTimeout 自动触发（loadFirmware 里）不经过 startUpgrade 的闸门，
    // 与用户点击可能并发出两条 DFU 流——同一 session 上交叉写 DATA seq，设备收到乱序流必败。
    if (this.data.state === 'upgrading') {
      return
    }

    const firmware = this.data.firmware
    const pkg = firmware && firmware.package
    const bleDeviceId = this.getBleDeviceId()
    const dryRun = this.willDryRun(pkg)

    if (!pkg) {
      return
    }
    // 真实升级（非干跑）必须有可用的 BLE 连接 id；干跑只在本地校验，不需要连设备。
    if (!dryRun && !bleDeviceId) {
      this.setData({
        state: 'failed',
        statusText: '无法升级',
        statusClass: 'is-error',
        canUpgrade: true,
        actionText: '重新升级',
        errorMessage: '未获取到设备蓝牙连接，请先在详情页连接设备后再升级。'
      })
      return
    }

    this._abortUpgrade = false
    wx.setKeepScreenOn && wx.setKeepScreenOn({ keepScreenOn: true })
    this.setData({
      state: 'upgrading',
      statusText: dryRun ? '干跑中' : '升级中',
      statusClass: 'is-upgrading',
      canUpgrade: false,
      actionText: dryRun ? '干跑中' : '升级中',
      progressPercent: 0,
      progressText: dryRun ? '准备干跑' : '准备升级',
      errorMessage: ''
    })

    try {
      const result = await otaBle.upgradeFirmware(bleDeviceId, pkg, {
        pace: 20,
        dryRun,
        onProgress: progress => this.onUpgradeProgress(progress),
        shouldAbort: () => this._abortUpgrade
      })

      if (dryRun) {
        this.onDryRunDone(result)
        return
      }

      // 固件已确认(2026-07-01)：收满且 CRC32 无误必回 0xF3、回完 0xF3 后约 2s 才复位重启。故 confirmed:false
      // 已成兜底死路——真拿不到 0xF3(尾包没送达/设备没收满)时 ota-ble 会抛错走下方 catch，不再返回"软成功"。
      // 万一仍走到这里，说明确实没收到 0xF3 → 升级未确认，如实提示重试，绝不谎报"升级完成"。
      const unconfirmed = result && result.confirmed === false
      const doneText = unconfirmed ? '未确认(请重试)' : '升级完成'

      // 未确认 = 没拿到设备 0xF3：不能假报成功——不上报 success、不把本地版本改成新版、
      // 保留升级包并开放「重新升级」，否则用户既被误导"已升级"又没有任何重试入口，后端记录也是假的。
      if (unconfirmed) {
        if (!this._testMode) {
          await api.reportDeviceFirmwareUpgrade(this.data.id, {
            status: 'fail',
            version: firmware.latestVersion,
            message: '数据已全部发送，但未收到设备 0xF3 确认，升级未确认成功'
          }).catch(() => {})
        }
        this.setData({
          state: 'failed',
          statusText: '未确认(请重试)',
          statusClass: 'is-error',
          canUpgrade: true,
          actionText: '重新升级',
          progressPercent: 100,
          progressText: doneText,
          errorMessage: '数据已全部发送，但未收到设备 0xF3 确认——升级未确认成功，请重试。'
        })
        toast.show({ title: doneText, icon: 'none' })
        return
      }

      // 真实升级：测试流程不回报后台（无对应设备记录）；正常流程才上报结果。
      if (!this._testMode) {
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
        }, this.deriveViewData(updatedDevice, updatedFirmware)))
      } else {
        this.setData({
          state: 'success',
          progressPercent: 100,
          progressText: `${doneText}（${result.size} 字节 / ${result.totalPackets} 包）`,
          statusText: '测试完成',
          statusClass: 'is-latest',
          canUpgrade: false,
          actionText: '已完成'
        })
      }

      toast.show({
        title: dryRun ? '干跑完成' : doneText,
        icon: 'none'
      })
    } catch (error) {
      const aborted = this._abortUpgrade || (error && error.message === 'OTA_ABORTED')
      const message = aborted
        ? '升级已中断：升级过程中手机切到后台或页面离开。请保持屏幕常亮后重试。'
        : (error.message || 'OTA升级失败')

      if (!this._testMode) {
        await api.reportDeviceFirmwareUpgrade(this.data.id, {
          status: 'fail',
          version: firmware.latestVersion,
          message
        }).catch(() => {})
      }

      this.setData({
        state: 'failed',
        statusText: dryRun ? '干跑失败' : '升级失败',
        statusClass: 'is-error',
        canUpgrade: true,
        actionText: dryRun ? '重新干跑' : '重新升级',
        errorMessage: message
      })
    } finally {
      wx.setKeepScreenOn && wx.setKeepScreenOn({ keepScreenOn: false })
    }
  },

  // 干跑完成：把组帧/分包结果回显到页面，并打印帧样例方便与硬件日志比对。
  onDryRunDone(result) {
    console.log('[OTA] 干跑结果：', result)
    console.log('[OTA] START 帧：', result.startFrameHex)
    console.log('[OTA] 首个 DATA 帧：', result.firstDataFrameHex)

    const crcHex = `0x${(result.crc32 >>> 0).toString(16).toUpperCase().padStart(8, '0')}`
    this.setData({
      state: 'success',
      progressPercent: 100,
      progressText: `干跑通过：${result.size} 字节 / ${result.totalPackets} 包 / 每包 ${result.chunkSize} 字节`,
      statusText: '干跑通过',
      statusClass: 'is-latest',
      canUpgrade: true,
      actionText: '再次干跑',
      releaseNotes: [
        `固件大小：${result.size} 字节`,
        `本地 CRC32：${crcHex}`,
        `分包：${result.totalPackets} 包 × ${result.chunkSize} 字节，PRN=${result.prn}`,
        `START 帧：${result.startFrameHex}`,
        `首个 DATA 帧：${result.firstDataFrameHex.slice(0, 47)} …`
      ]
    })
    toast.show({ title: '干跑完成', icon: 'none' })
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
})
