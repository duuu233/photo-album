const api = require('../../../utils/api')
const otaBle = require('../../../utils/ota-ble')
const system = require('../../../utils/system')

const app = getApp()

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

function hasEnoughBattery(device, firmware) {
  if (!device || typeof device.battery !== 'number') {
    return true
  }

  return device.battery >= (firmware.minBattery || 20)
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
    releaseNotes: []
  },

  onLoad(options = {}) {
    this._abortUpgrade = false
    this.setData(Object.assign(system.getLayoutMetrics(), {
      id: options.id || ''
    }))
    this.loadFirmware()
  },

  onHide() {
    if (this.data.state === 'upgrading') {
      this._abortUpgrade = true
    }
  },

  onUnload() {
    this._abortUpgrade = true

    const bleDeviceId = this.getBleDeviceId()
    if (bleDeviceId) {
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
    return firmware.bleDeviceId || device.deviceId || ''
  },

  deriveViewData(device, firmware) {
    const pkg = firmware && firmware.package ? firmware.package : null
    const batteryText = device && typeof device.battery === 'number' ? `${device.battery}%` : '--'
    const minBattery = firmware ? firmware.minBattery || 20 : 20
    const hasPackage = !!(firmware && firmware.hasUpdate && pkg)
    const bleDeviceId = (firmware && firmware.bleDeviceId) || (device && device.deviceId) || ''
    let canUpgrade = hasPackage && !!bleDeviceId && hasEnoughBattery(device, firmware) && device && device.connected !== false
    let statusText = '已是最新'
    let statusClass = 'is-latest'
    let actionText = '已是最新'
    let errorMessage = ''

    if (hasPackage) {
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
    } else if (hasPackage && !hasEnoughBattery(device, firmware)) {
      canUpgrade = false
      statusText = '电量不足'
      statusClass = 'is-error'
      actionText = '电量不足'
      errorMessage = `设备电量需不低于 ${minBattery}%。`
    }

    return {
      canUpgrade,
      statusText,
      statusClass,
      actionText,
      errorMessage,
      currentVersion: firmware && firmware.currentVersion ? firmware.currentVersion : (device && device.firmwareVersion) || '--',
      latestVersion: firmware && firmware.latestVersion ? firmware.latestVersion : '--',
      packageSizeText: pkg ? formatSize(pkg.sizeBytes) : '--',
      batteryText,
      minBatteryText: `${minBattery}%`,
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
      const [device, firmware] = await Promise.all([
        api.getDeviceDetail(this.data.id),
        api.getDeviceFirmware(this.data.id)
      ])

      if (!device) {
        throw new Error('设备不存在')
      }

      this.setData(Object.assign({
        loading: false,
        device,
        firmware,
        state: firmware.hasUpdate ? 'available' : 'latest'
      }, this.deriveViewData(device, firmware)))
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
      this.loadFirmware()
      return
    }

    if (!this.data.canUpgrade || this.data.state === 'upgrading') {
      return
    }

    wx.showModal({
      title: 'OTA升级',
      content: '升级时请保持设备供电、手机屏幕常亮，不要切换到后台。确认开始升级？',
      confirmText: '开始升级',
      confirmColor: '#ff6a20',
      success: res => {
        if (res.confirm) {
          this.runUpgrade()
        }
      }
    })
  },

  onUpgradeProgress(progress) {
    const percent = Math.max(0, Math.min(100, progress.percent || 0))
    this.setData({
      progressPercent: percent,
      progressText: progress.message || ''
    })
  },

  async runUpgrade() {
    const firmware = this.data.firmware
    const pkg = firmware && firmware.package
    const bleDeviceId = this.getBleDeviceId()

    if (!pkg || !bleDeviceId) {
      return
    }

    this._abortUpgrade = false
    wx.setKeepScreenOn && wx.setKeepScreenOn({ keepScreenOn: true })
    this.setData({
      state: 'upgrading',
      statusText: '升级中',
      statusClass: 'is-upgrading',
      canUpgrade: false,
      actionText: '升级中',
      progressPercent: 0,
      progressText: '准备升级',
      errorMessage: ''
    })

    try {
      const result = await otaBle.upgradeFirmware(bleDeviceId, pkg, {
        pace: 20,
        onProgress: progress => this.onUpgradeProgress(progress),
        shouldAbort: () => this._abortUpgrade
      })

      await api.reportDeviceFirmwareUpgrade(this.data.id, {
        status: 'success',
        version: firmware.latestVersion,
        size: result.size,
        crc32: result.crc32
      })

      const updatedDevice = Object.assign({}, this.data.device, {
        firmwareVersion: firmware.latestVersion,
        connected: true
      })
      const updatedFirmware = Object.assign({}, firmware, {
        currentVersion: firmware.latestVersion,
        hasUpdate: false,
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
        progressText: '升级完成',
        statusText: '升级完成',
        statusClass: 'is-latest'
      }, this.deriveViewData(updatedDevice, updatedFirmware)))

      wx.showToast({
        title: '升级完成',
        icon: 'success'
      })
    } catch (error) {
      const aborted = this._abortUpgrade || (error && error.message === 'OTA_ABORTED')
      const message = aborted
        ? '升级已中断：升级过程中手机切到后台或页面离开。请保持屏幕常亮后重试。'
        : (error.message || 'OTA升级失败')

      await api.reportDeviceFirmwareUpgrade(this.data.id, {
        status: 'fail',
        version: firmware.latestVersion,
        message
      }).catch(() => {})

      this.setData({
        state: 'failed',
        statusText: '升级失败',
        statusClass: 'is-error',
        canUpgrade: true,
        actionText: '重新升级',
        errorMessage: message
      })
    } finally {
      wx.setKeepScreenOn && wx.setKeepScreenOn({ keepScreenOn: false })
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
})
