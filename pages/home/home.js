const api = require('../../utils/api')
const media = require('../../utils/media')

const app = getApp()

function memoryPercent(device) {
  if (!device || !device.totalMemory) {
    return 0
  }
  return Math.min(100, Math.round((device.usedMemory / device.totalMemory) * 100))
}

Page({
  data: {
    selectedDevice: null,
    memoryPercent: 0,
    recentPhotos: [],
    recentRecords: [],
    loading: true
  },

  onShow() {
    this.loadPageData()
  },

  async loadPageData() {
    this.setData({
      loading: true
    })

    try {
      await app.ensureLogin()
      const [devices, photos, records] = await Promise.all([
        api.getDevices(),
        api.getAlbumPhotos(),
        api.getProjectionRecords()
      ])
      const cached = app.globalData.selectedDevice
      const selectedDevice = devices.find(item => cached && item.id === cached.id) || devices[0] || null

      if (selectedDevice) {
        app.setSelectedDevice(selectedDevice)
      }

      this.setData({
        selectedDevice,
        memoryPercent: memoryPercent(selectedDevice),
        recentPhotos: photos.slice(0, 4),
        recentRecords: records.slice(0, 2)
      })
    } finally {
      this.setData({
        loading: false
      })
    }
  },

  goDeviceList() {
    wx.navigateTo({
      url: '/subpackages/device/list/list?select=1'
    })
  },

  goBindDevice() {
    wx.navigateTo({
      url: '/subpackages/device/bind/bind'
    })
  },

  goAlbum() {
    wx.navigateTo({
      url: '/subpackages/album/list/list'
    })
  },

  goRecords() {
    wx.navigateTo({
      url: '/subpackages/projection/records/records'
    })
  },

  async chooseCamera() {
    await app.ensureLogin()
    try {
      const images = await media.chooseFromCamera()
      this.openPreview(images)
    } catch (error) {
      if (error.errMsg && error.errMsg.indexOf('cancel') > -1) {
        return
      }
      wx.showToast({
        title: '拍照失败',
        icon: 'none'
      })
    }
  },

  async chooseAlbum() {
    await app.ensureLogin()
    try {
      const images = await media.chooseFromAlbum()
      this.openPreview(images)
    } catch (error) {
      if (error.errMsg && error.errMsg.indexOf('cancel') > -1) {
        return
      }
      wx.showToast({
        title: '选择照片失败',
        icon: 'none'
      })
    }
  },

  openPreview(images) {
    if (!images || !images.length) {
      return
    }

    if (!this.data.selectedDevice) {
      wx.showToast({
        title: '请先绑定设备',
        icon: 'none'
      })
      return
    }

    wx.setStorageSync('pendingProjection', {
      device: this.data.selectedDevice,
      images
    })
    wx.navigateTo({
      url: '/subpackages/projection/preview/preview'
    })
  }
})
