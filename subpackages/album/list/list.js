const api = require('../../../utils/api')
const media = require('../../../utils/media')
const system = require('../../../utils/system')
const deviceBle = require('../../../utils/device-ble')
const protocol = require('../../../utils/frame-protocol')
const activeDevice = require('../../../utils/active-device')

const app = getApp()

const TOTAL_PLACEHOLDER_COUNT = 0
const HIDDEN_KEY = 'albumHiddenPhotoIds' // 本地“软删除”记录的缓存键（被删除照片的 id 集合）
// 筛选项改为按真实设备动态生成（见 buildDeviceFilters），这里只保留默认的「全部」
const DEFAULT_FILTERS = [{ label: '全部', value: '全部' }]
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

function buildDisplayPhotos(sourcePhotos, devices) {
  // 只保留仍在设备上的真实照片并补全展示字段。
  return sourcePhotos
    .filter(photo => photo.onDevice !== false)
    .map(normalizePhoto)
}

// 由真实设备列表生成筛选项：「全部」+ 各设备名（去重，与照片 deviceName 用同一套归一规则，保证可筛中）
function buildDeviceFilters(devices) {
  const filters = [{ label: '全部', value: '全部' }]

  ;(devices || []).forEach((device, index) => {
    const name = normalizeDeviceName(device.name, index)
    if (name && !filters.some(item => item.value === name)) {
      filters.push({ label: name, value: name })
    }
  })

  return filters
}

Page({
  data: {
    statusBarHeight: 20,
    safeBottom: 0,
    filters: DEFAULT_FILTERS,
    currentFilter: '全部',
    showFilterMenu: false,
    sourcePhotos: [],
    photos: [],
    filteredPhotos: [],
    selectedMap: {},
    selectedCount: 0,
    totalCount: TOTAL_PLACEHOLDER_COUNT,
    showDeleteConfirm: false,
    deleteClosing: false // 删除确认弹窗是否正在播放退场动画
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

    // 按真实设备动态生成筛选项；当前筛选若已不在新设备列表中（设备被删/改名）则回退到「全部」
    const filters = buildDeviceFilters(devices)
    const currentFilter = filters.some(item => item.value === this.data.currentFilter)
      ? this.data.currentFilter
      : '全部'

    this.setData({
      filters,
      currentFilter,
      sourcePhotos,
      photos,
      totalCount: photos.length,
      selectedMap: {},
      selectedCount: 0,
      showDeleteConfirm: false
    })
    this.applyFilter(currentFilter, photos)
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

  // 先播放退场动画再卸载，避免弹窗瞬间消失
  hideDeleteDialog() {
    if (this.data.deleteClosing) {
      return
    }
    this.setData({ deleteClosing: true })
    setTimeout(() => {
      this.setData({ showDeleteConfirm: false, deleteClosing: false })
    }, 220)
  },

  // 删除选中照片：先本地隐藏，随后调用后端删除真实照片记录
  async confirmDeleteSelected() {
    const ids = Object.keys(this.data.selectedMap)

    if (!ids.length) {
      this.hideDeleteDialog()
      return
    }

    const realIds = ids
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
      icon: 'none'
    })
    this.loadPhotos()
  },

  // 刷新屏幕：图库照片大多已存在于固件，只需找到其在设备上的槽位索引，让相框切到这张图。
  // 仅支持单选——多选/全选是为了批量删除，单选才走刷新屏幕逻辑。
  async refreshScreen() {
    const ids = Object.keys(this.data.selectedMap)

    if (!ids.length) {
      wx.showToast({
        title: '请选择图片',
        icon: 'none'
      })
      return
    }

    if (ids.length > 1) {
      wx.showToast({
        title: '刷新屏幕只能选中一张图片',
        icon: 'none'
      })
      return
    }

    const photoId = ids[0]

    // 统一与「当前选中设备(首页轮播选中的那台)」建立蓝牙连接；连不上会弹窗引导去首页切换/绑定设备
    let device
    try {
      device = await activeDevice.ensureActiveDeviceConnection()
    } catch (error) {
      return // 提示已由 ensureActiveDeviceConnection 弹出
    }

    wx.showLoading({ title: '刷新中', mask: true })
    try {
      // 读固件当前已占用的图片槽位（升序），按所选照片在本设备照片中的位置取对应槽位
      const info = await deviceBle.readDeviceInfo(device.deviceId)
      const occupied = protocol.maskToIndexes(info.imgMask)
      const index = this.resolveDeviceImageIndex(photoId, device, occupied)

      if (index < 0) {
        wx.hideLoading()
        wx.showToast({
          title: '未找到该图片在设备上的位置',
          icon: 'none'
        })
        return
      }

      // CMD=0x24：让固件切换/刷新到指定索引的图片
      await deviceBle.refreshScreen(device.deviceId, index)
      wx.hideLoading()
      wx.showToast({
        title: '已刷新屏幕',
        icon: 'none'
      })
    } catch (error) {
      wx.hideLoading()
      wx.showToast({
        title: (error && error.message) || '刷新失败',
        icon: 'none'
      })
    }
  },

  // 选中照片 → 固件图片槽位索引：
  // 取该设备「在设备上」的照片按当前顺序排列，选中照片排第 N 个，
  // 就对应固件已占用槽位（升序）里的第 N 个；读不到掩码时回退到位置本身。
  resolveDeviceImageIndex(photoId, device, occupied) {
    const onDevicePhotos = this.data.photos.filter(item => item.onDevice !== false)
    const deviceKey = String((device && (device.userProductId || device.id)) || '')
    const deviceName = device ? normalizeDeviceName(device.name, 0) : ''

    // 选中设备的照片：优先按后端 userProductId 匹配，再按设备名；都匹配不到则退化为全部（多为单设备）
    let devicePhotos = onDevicePhotos.filter(item => {
      if (deviceKey && String(item.deviceId || '') === deviceKey) {
        return true
      }
      return deviceName && item.deviceName === deviceName
    })
    if (!devicePhotos.length) {
      devicePhotos = onDevicePhotos
    }

    const pos = devicePhotos.findIndex(item => item.id === photoId)
    if (pos < 0) {
      return -1
    }

    if (occupied && occupied.length) {
      return pos < occupied.length ? occupied[pos] : -1
    }
    return pos
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
