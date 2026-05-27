const api = require('../../../utils/api')
const system = require('../../../utils/system')

Page({
  data: {
    statusBarHeight: 20,
    safeBottom: 0,
    id: '',
    device: null,
    intervalOptions: [1, 2, 4, 8, 24],
    intervalIndex: 1
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

  async loadDevice() {
    const device = await api.getDeviceDetail(this.data.id)
    const intervalIndex = this.data.intervalOptions.indexOf(device ? device.intervalHours : 2)
    this.setData({
      device,
      intervalIndex: intervalIndex > -1 ? intervalIndex : 1
    })
  },

  async toggleCarousel(e) {
    const device = await api.updateDevicePlayback(this.data.id, {
      carouselEnabled: e.detail.value
    })
    this.setData({
      device
    })
  },

  async changeInterval(e) {
    const intervalHours = this.data.intervalOptions[Number(e.detail.value)]
    const device = await api.updateDevicePlayback(this.data.id, {
      intervalHours
    })
    this.setData({
      device,
      intervalIndex: Number(e.detail.value)
    })
  },

  async changePlayback(e) {
    const device = await api.updateDevicePlayback(this.data.id, {
      playbackMode: e.currentTarget.dataset.mode
    })
    this.setData({
      device
    })
  }
})
