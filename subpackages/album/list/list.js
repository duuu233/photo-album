const api = require('../../../utils/api')
const media = require('../../../utils/media')
const system = require('../../../utils/system')

const app = getApp()

const TOTAL_PLACEHOLDER_COUNT = 102 // demo 用：把图库补足到这个数量，营造“满相册”的视觉效果
const HIDDEN_KEY = 'albumHiddenPhotoIds' // 本地“软删除”记录的缓存键（被删除照片的 id 集合）
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

// 读取本地软删除记录（id -> true 的映射），格式异常时返回空对象
function readHiddenMap() {
  const hidden = wx.getStorageSync(HIDDEN_KEY) || {}
  return hidden && typeof hidden === 'object' ? hidden : {}
}

// 统一设备名（修正历史命名差异），缺省时按下标循环取占位名
function normalizeDeviceName(name, index) {
  if (name === '客厅相册') return '客厅相框'
  if (name === '书房厅相册') return '书房相框'
  return name || DEVICE_NAMES[index % DEVICE_NAMES.length]
}

// 取有照片（已用内存 > 0）的设备名列表，用于给占位照片分配归属设备
function getActiveDeviceNames(devices) {
  return (devices || [])
    .filter(device => Number(device.usedMemory || 0) > 0)
    .map((device, index) => normalizeDeviceName(device.name, index))
}

// 补全单张照片的展示字段（标题、缩略图类型、大小等）
function normalizePhoto(photo, index) {
  return Object.assign({}, photo, {
    id: photo.id || `photo_${index}`,
    title: photo.title || `照片 ${index + 1}`,
    deviceName: normalizeDeviceName(photo.deviceName, index),
    thumbType: photo.thumbType || THUMB_TYPES[index % THUMB_TYPES.length],
    size: photo.size || 2.5
  })
}

// 组装图库展示列表：真实照片在前，再用占位照片补足到 TOTAL_PLACEHOLDER_COUNT。
// 占位照片 id 以 'ui_photo_' 开头、带 generated 标记，删除时只软隐藏、不调真实接口。
function buildDisplayPhotos(sourcePhotos, devices) {
  const activeDeviceNames = getActiveDeviceNames(devices)
  // 只保留仍在设备上的照片并补全展示字段
  const normalized = sourcePhotos
    .filter(photo => photo.onDevice !== false)
    .map(normalizePhoto)
  const photos = normalized.slice()

  // 没有任何有照片的设备时，不生成占位（避免空设备也显示满屏假照片）
  if (!activeDeviceNames.length) {
    return photos
  }

  // 从真实照片数量开始补占位，缩略图与归属设备按下标循环分配
  for (let index = normalized.length; index < TOTAL_PLACEHOLDER_COUNT; index += 1) {
    photos.push({
      id: `ui_photo_${index + 1}`,
      title: `设备照片 ${index + 1}`,
      url: '',
      deviceName: activeDeviceNames[index % activeDeviceNames.length],
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

  // 加载图库：合并真实+占位照片，并过滤掉本地已软删除的项
  async loadPhotos() {
    const [sourcePhotos, devices] = await Promise.all([
      api.getAlbumPhotos(),
      api.getDevices()
    ])
    const hiddenMap = readHiddenMap()
    const photos = buildDisplayPhotos(sourcePhotos, devices).filter(item => !hiddenMap[item.id])

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

  // 按设备名筛选照片（'全部'不筛选），切换筛选时清空已选
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

  // 全选/取消全选：仅作用于当前筛选结果。已全选则取消，否则全选
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

  // 删除选中照片：所有项都加入本地隐藏表（软删除），其中真实照片再调后端删除
  async confirmDeleteSelected() {
    const ids = Object.keys(this.data.selectedMap)

    if (!ids.length) {
      this.hideDeleteDialog()
      return
    }

    // 占位照片（ui_photo_ 前缀）只在前端隐藏，真实照片才需要请求后端
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
    // 没有选中设备时给一个兜底设备（demo 数据），保证投屏流程可走通
    const device = app.globalData.selectedDevice || {
      id: 'd_living_001',
      name: '房间相册',
      connected: true,
      totalMemory: 100,
      usedMemory: 68
    }

    // 把选中照片转换为预览页期望的图片结构，经 Storage 传入预览页
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
