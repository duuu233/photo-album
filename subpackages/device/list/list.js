const api = require('../../../utils/api')

const app = getApp()

function memoryPercent(device) {
  if (!device.totalMemory) {
    return 0
  }
  return Math.min(100, Math.round((device.usedMemory / device.totalMemory) * 100))
}

Page({
  data: {
    devices: [],
    selectedId: '',
    selectMode: false,
    loading: true
  },

  onLoad(options) {
    this.setData({
      selectMode: options.select === '1'
    })
  },

  onShow() {
    this.loadDevices()
  },

  async loadDevices() {
    this.setData({
      loading: true
    })
    const devices = await api.getDevices()
    const selected = app.globalData.selectedDevice

    this.setData({
      devices: devices.map(item => Object.assign({}, item, {
        memoryPercent: memoryPercent(item)
      })),
      selectedId: selected ? selected.id : '',
      loading: false
    })
  },

  selectDevice(e) {
    const id = e.currentTarget.dataset.id
    const device = this.data.devices.find(item => item.id === id)

    if (!device) {
      return
    }

    if (this.data.selectMode) {
      app.setSelectedDevice(device)
      wx.showToast({
        title: '已切换设备',
        icon: 'success'
      })
      setTimeout(() => wx.navigateBack(), 350)
      return
    }

    wx.navigateTo({
      url: `/subpackages/device/detail/detail?id=${id}`
    })
  },

  goBind() {
    wx.navigateTo({
      url: '/subpackages/device/bind/bind'
    })
  }
})
