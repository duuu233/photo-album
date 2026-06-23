const api = require('../../../utils/api')
const system = require('../../../utils/system')
const batteryUtil = require('../../../utils/battery')
const deviceBle = require('../../../utils/device-ble')
const protocol = require('../../../utils/frame-protocol')

const app = getApp()

// 计算设备存储使用百分比（已用/总量），上限 100，用于进度条展示
function memoryPercent(device) {
  if (!device || !device.totalMemory) {
    return 0
  }
  return Math.min(100, Math.round((device.usedMemory / device.totalMemory) * 100))
}

function getPlaybackLabel(device) {
  if (!device || device.playbackMode === 'manual' || device.carouselEnabled === false) {
    return '已关闭'
  }
  return device.playbackMode === 'random' ? '随机轮播' : '顺序轮播'
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
    firmwareVersion: '--',
    batteryText: '--',
    playbackLabel: '',
    intervalOptions: [1, 2, 4, 8, 24],
    intervalIndex: 1,
    showClearConfirm: false,
    showDeleteConfirm: false,
    clearClosing: false, // 清空确认弹窗是否正在播放退场动画
    deleteClosing: false, // 删除确认弹窗是否正在播放退场动画
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
        bleDeviceId: device.bleDeviceId || selected.bleDeviceId || selected.deviceId,
        battery: typeof device.battery === 'number' ? device.battery : selected.battery
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
          intervalHours: info.intervalSeconds ? Math.max(1, Math.round(info.intervalSeconds / 3600)) : device.intervalHours,
          firmwareVersion: info.firmwareVersion || device.firmwareVersion
        })
      } catch (error) {
        // 详情展示不因刷新蓝牙状态失败而中断。
      }
    }
    // 把当前间隔小时数映射到选择器下标，缺省落到第 1 项（2 小时）
    const intervalIndex = this.data.intervalOptions.indexOf(device ? device.intervalHours : 2)
    // 设备编号取末 6 位数字作为展示码；真实数据缺失时用 -- 占位（不再用假的 123456）
    const digitId = device && device.deviceNo ? String(device.deviceNo).replace(/\D/g, '').slice(-6) : ''
    const hasBattery = device && typeof device.battery === 'number'

    this.setData({
      device,
      memoryPercent: memoryPercent(device),
      batteryIcon: batteryUtil.getBatteryIcon(hasBattery ? device.battery : batteryUtil.DEFAULT_BATTERY),
      batteryText: hasBattery ? `${device.battery}%` : '--',
      deviceCode: digitId || '--',
      memoryText: device && device.totalMemory ? `${device.usedMemory}/${device.totalMemory}` : '--',
      macAddress: device && device.macAddress ? device.macAddress : '--',
      firmwareVersion: device && device.firmwareVersion ? device.firmwareVersion : '--',
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
        if (app.globalData.selectedDevice && app.globalData.selectedDevice.id === device.id) {
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

    const currentMode = this.data.device.playbackMode === 'manual'
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
    await this.applyPlayback(this.data.device.playbackMode || 'order', intervalHours, this.data.device.carouselEnabled !== false)
  },

  async applyPlayback(mode, intervalHours, carouselEnabled) {
    const device = this.data.device
    if (!device || !device.deviceId) {
      wx.showToast({
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

      if (app.globalData.selectedDevice && app.globalData.selectedDevice.id === updated.id) {
        app.setSelectedDevice(updated)
      }

      this.setData({
        device: updated,
        playbackLabel: getPlaybackLabel(updated),
        intervalIndex: intervalIndex > -1 ? intervalIndex : this.data.intervalIndex
      })
      wx.showToast({ title: '已保存', icon: 'none' })
    } catch (error) {
      wx.showToast({
        title: error.message || '保存失败',
        icon: 'none'
      })
    } finally {
      wx.hideLoading()
    }
  },

  goSlideshow() {
    wx.navigateTo({
      url: `/subpackages/device/slideshow/slideshow?id=${this.data.id}`
    })
  },

  goOtaUpgrade() {
    wx.navigateTo({
      url: `/subpackages/device/ota/ota?id=${this.data.id}`
    })
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
      wx.showToast({
        title: '请先连接设备',
        icon: 'none'
      })
      return
    }

    wx.showLoading({ title: '清空中', mask: true })
    try {
      await deviceBle.ensureConnection(this.data.device.deviceId)
      const info = await deviceBle.readDeviceInfo(this.data.device.deviceId)
      const indexes = protocol.maskToIndexes(info.imgMask)

      if (indexes.length) {
        await deviceBle.deleteImage(this.data.device.deviceId, indexes)
      }

      await api.clearDevicePhotoCopies(this.data.id)
    } catch (error) {
      wx.showToast({
        title: error.message || '清空失败',
        icon: 'none'
      })
      wx.hideLoading()
      return
    }
    wx.hideLoading()
    this.hideClearConfirm() // 带退场动画关闭确认弹窗
    wx.showToast({
      title: '已清空',
      icon: 'none'
    })
    this.loadDetail()
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
    if (app.globalData.selectedDevice && app.globalData.selectedDevice.id === this.data.id) {
      app.setSelectedDevice(null)
    }
    wx.showToast({
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
        wx.showToast({
          title: '格式化完成',
          icon: 'none'
        })
        this.loadDetail()
      }
    })
  }
})
