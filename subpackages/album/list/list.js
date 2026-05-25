const api = require('../../../utils/api')
const media = require('../../../utils/media')

const app = getApp()

Page({
  data: {
    photos: [],
    selectedMap: {},
    selectedCount: 0,
    manageMode: false
  },

  onShow() {
    this.loadPhotos()
  },

  async loadPhotos() {
    const photos = await api.getAlbumPhotos()
    this.setData({
      photos,
      selectedMap: {},
      selectedCount: 0,
      manageMode: false
    })
  },

  toggleManage() {
    this.setData({
      manageMode: !this.data.manageMode,
      selectedMap: {},
      selectedCount: 0
    })
  },

  toggleSelect(e) {
    if (!this.data.manageMode) {
      return
    }

    const id = e.currentTarget.dataset.id
    const selectedMap = Object.assign({}, this.data.selectedMap)

    if (selectedMap[id]) {
      delete selectedMap[id]
    } else {
      selectedMap[id] = true
    }

    this.setData({
      selectedMap,
      selectedCount: Object.keys(selectedMap).length
    })
  },

  deleteSelected() {
    const ids = Object.keys(this.data.selectedMap)

    if (!ids.length) {
      wx.showToast({
        title: '请选择照片',
        icon: 'none'
      })
      return
    }

    wx.showModal({
      title: '删除照片',
      content: '会删除当前用户与设备的绑定关系，并从相册列表移除。',
      confirmText: '删除',
      confirmColor: '#c72e2e',
      success: async res => {
        if (!res.confirm) {
          return
        }

        await api.deleteAlbumPhotos(ids)
        wx.showToast({
          title: '已删除',
          icon: 'success'
        })
        this.loadPhotos()
      }
    })
  },

  async chooseForProjection() {
    let images = []

    try {
      images = await media.chooseFromAlbum()
    } catch (error) {
      if (error.errMsg && error.errMsg.indexOf('cancel') > -1) {
        return
      }
      wx.showToast({
        title: '选择照片失败',
        icon: 'none'
      })
      return
    }

    if (!images.length) {
      return
    }

    const device = app.globalData.selectedDevice

    if (!device) {
      wx.showToast({
        title: '请先选择设备',
        icon: 'none'
      })
      return
    }

    wx.setStorageSync('pendingProjection', {
      device,
      images
    })
    wx.navigateTo({
      url: '/subpackages/projection/preview/preview'
    })
  }
})
