const api = require('../../../utils/api')
const media = require('../../../utils/media')
const system = require('../../../utils/system')

const app = getApp()

const TOTAL_PLACEHOLDER_COUNT = 102
const HIDDEN_KEY = 'albumHiddenPhotoIds'
const FILTERS = [
  { label: '全部', value: '全部' },
  { label: '房间相册', value: '房间相册' },
  { label: '客厅相框', value: '客厅相框' },
  { label: '书房相框', value: '书房相框' }
]
const DEVICE_NAMES = ['房间相册', '客厅相框', '书房相框']
const THUMB_TYPES = [
  'tree',
  'kite',
  'dogs',
  'portrait',
  'flower',
  'mountain',
  'field',
  'beach',
  'meadow',
  'cat',
  'puppy',
  'paw',
  'daisy',
  'sea',
  'sunset'
]

function readHiddenMap() {
  const hidden = wx.getStorageSync(HIDDEN_KEY) || {}
  return hidden && typeof hidden === 'object' ? hidden : {}
}

function normalizeDeviceName(name, index) {
  if (name === '客厅相册') return '客厅相框'
  if (name === '书房厅相册') return '书房相框'
  return name || DEVICE_NAMES[index % DEVICE_NAMES.length]
}

function normalizePhoto(photo, index) {
  return Object.assign({}, photo, {
    id: photo.id || `photo_${index}`,
    title: photo.title || `照片 ${index + 1}`,
    deviceName: normalizeDeviceName(photo.deviceName, index),
    thumbType: photo.thumbType || THUMB_TYPES[index % THUMB_TYPES.length],
    size: photo.size || 2.5
  })
}

function buildDisplayPhotos(sourcePhotos) {
  const normalized = sourcePhotos.map(normalizePhoto)
  const photos = normalized.slice()

  for (let index = normalized.length; index < TOTAL_PLACEHOLDER_COUNT; index += 1) {
    photos.push({
      id: `ui_photo_${index + 1}`,
      title: `设备照片 ${index + 1}`,
      url: '',
      deviceName: DEVICE_NAMES[index % DEVICE_NAMES.length],
      thumbType: THUMB_TYPES[index % THUMB_TYPES.length],
      size: 2.5,
      onDevice: true,
      generated: true
    })
  }

  return photos
}

Page({
  data: {
    statusBarHeight: 20,
    safeBottom: 0,
    filters: FILTERS,
    currentFilter: '房间相册',
    showFilterMenu: false,
    sourcePhotos: [],
    photos: [],
    filteredPhotos: [],
    selectedMap: {},
    selectedCount: 0,
    totalCount: TOTAL_PLACEHOLDER_COUNT,
    showDeleteConfirm: false
  },

  onLoad() {
    this.setSystemMetrics()
  },

  onShow() {
    this.loadPhotos()
  },

  setSystemMetrics() {
    this.setData(system.getLayoutMetrics())
  },

  async loadPhotos() {
    const sourcePhotos = await api.getAlbumPhotos()
    const hiddenMap = readHiddenMap()
    const photos = buildDisplayPhotos(sourcePhotos).filter(item => !hiddenMap[item.id])

    this.setData({
      sourcePhotos,
      photos,
      totalCount: photos.length,
      selectedMap: {},
      selectedCount: 0,
      showDeleteConfirm: false
    })
    this.applyFilter(this.data.currentFilter, photos)
  },

  applyFilter(filter, photos = this.data.photos) {
    const filteredPhotos = filter === '全部' ? photos : photos.filter(item => item.deviceName === filter)

    this.setData({
      currentFilter: filter,
      filteredPhotos,
      showFilterMenu: false,
      selectedMap: {},
      selectedCount: 0
    })
  },

  toggleFilterMenu() {
    this.setData({
      showFilterMenu: !this.data.showFilterMenu
    })
  },

  selectFilter(e) {
    this.applyFilter(e.currentTarget.dataset.value)
  },

  toggleSelect(e) {
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

  toggleSelectAll() {
    if (!this.data.filteredPhotos.length) {
      return
    }

    const selectedMap = Object.assign({}, this.data.selectedMap)
    const allSelected = this.data.filteredPhotos.every(item => selectedMap[item.id])

    if (allSelected) {
      this.data.filteredPhotos.forEach(item => {
        delete selectedMap[item.id]
      })
    } else {
      this.data.filteredPhotos.forEach(item => {
        selectedMap[item.id] = true
      })
    }

    this.setData({
      selectedMap,
      selectedCount: Object.keys(selectedMap).length
    })
  },

  showDeleteDialog() {
    if (!this.data.selectedCount) {
      wx.showToast({
        title: '请选择照片',
        icon: 'none'
      })
      return
    }

    this.setData({
      showDeleteConfirm: true
    })
  },

  hideDeleteDialog() {
    this.setData({
      showDeleteConfirm: false
    })
  },

  async confirmDeleteSelected() {
    const ids = Object.keys(this.data.selectedMap)

    if (!ids.length) {
      this.hideDeleteDialog()
      return
    }

    const realIds = ids.filter(id => id.indexOf('ui_photo_') !== 0)
    const hiddenMap = readHiddenMap()
    ids.forEach(id => {
      hiddenMap[id] = true
    })
    wx.setStorageSync(HIDDEN_KEY, hiddenMap)

    if (realIds.length) {
      await api.deleteAlbumPhotos(realIds)
    }

    wx.showToast({
      title: '已删除',
      icon: 'success'
    })
    this.loadPhotos()
  },

  projectSelected() {
    const ids = Object.keys(this.data.selectedMap)

    if (!ids.length) {
      wx.showToast({
        title: '请选择照片',
        icon: 'none'
      })
      return
    }

    const selectedPhotos = this.data.photos.filter(item => this.data.selectedMap[item.id])
    const device = app.globalData.selectedDevice || {
      id: 'd_living_001',
      name: '房间相册',
      connected: true,
      totalMemory: 100,
      usedMemory: 68
    }

    wx.setStorageSync('pendingProjection', {
      device,
      images: selectedPhotos.map((item, index) => ({
        name: item.title || `照片 ${index + 1}`,
        tempFilePath: item.url || '',
        url: item.url || '',
        sizeMb: item.size || 2.5
      }))
    })
    wx.navigateTo({
      url: '/subpackages/projection/preview/preview'
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

    const device = app.globalData.selectedDevice || {
      id: 'd_living_001',
      name: '房间相册',
      connected: true,
      totalMemory: 100,
      usedMemory: 68
    }

    wx.setStorageSync('pendingProjection', {
      device,
      images
    })
    wx.navigateTo({
      url: '/subpackages/projection/preview/preview'
    })
  },

  goBack() {
    const pages = getCurrentPages()

    if (pages.length > 1) {
      wx.navigateBack()
      return
    }

    wx.switchTab({
      url: '/pages/mine/mine'
    })
  },

  noop() {
  }
})
