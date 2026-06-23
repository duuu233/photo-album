const api = require('../../../utils/api')
const system = require('../../../utils/system')
const deviceBle = require('../../../utils/device-ble')

const app = getApp()

Page({
  data: {
    statusBarHeight: 20,
    safeBottom: 0,
    id: '',
    device: null,
    intervalOptions: [1, 2, 4, 8, 24],
    intervalIndex: 1,
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
    this.loadDevice()
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
      url: `/subpackages/device/detail/detail?id=${this.data.id}`
    })
  },

  // 加载设备并把当前轮播间隔小时数映射为选择器下标（缺省落到第 1 项）
  // 接口失败时不再让 device 悬空：标记 loadError 走统一空态，提供「重新加载」入口
  async loadDevice() {
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
        bleDeviceId: device.bleDeviceId || selected.bleDeviceId || selected.deviceId
      })
    }

    const intervalIndex = this.data.intervalOptions.indexOf(device ? device.intervalHours : 2)
    this.setData({
      device,
      intervalIndex: intervalIndex > -1 ? intervalIndex : 1,
      loading: false,
      loadError: false
    })
  },

  async toggleCarousel(e) {
    const currentMode = this.data.device && this.data.device.playbackMode === 'manual'
      ? 'order'
      : this.data.device && this.data.device.playbackMode
    await this.applyPlayback(
      e.detail.value ? currentMode || 'order' : 'manual',
      this.data.device && this.data.device.intervalHours,
      e.detail.value
    )
  },

  // 切换轮播间隔：picker 返回下标，转成实际小时数后保存
  async changeInterval(e) {
    const intervalHours = this.data.intervalOptions[Number(e.detail.value)]
    await this.applyPlayback(this.data.device.playbackMode || 'order', intervalHours, this.data.device.carouselEnabled !== false)
  },

  // 切换播放模式（顺序/随机），模式值由按钮 data-mode 提供
  async changePlayback(e) {
    await this.applyPlayback(e.currentTarget.dataset.mode, this.data.device.intervalHours, true)
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
  }
})
