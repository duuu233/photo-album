const api = require('../../../utils/api')
const media = require('../../../utils/media')
const system = require('../../../utils/system')
const deviceBle = require('../../../utils/device-ble')
const protocol = require('../../../utils/frame-protocol')
const activeDevice = require('../../../utils/active-device')
const toast = require('../../../utils/toast')

const app = getApp()

const TOTAL_PLACEHOLDER_COUNT = 0
// 筛选项按照片里出现的设备名动态生成（见 buildDeviceFilters），不再有「全部」
const DEFAULT_FILTERS = []
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

// 由当前照片里出现的设备名生成筛选项（去重，无「全部」）。
// 直接取自照片的 deviceName，保证每个筛选项都能筛出照片，也不会因设备改名导致筛选与照片对不上。
function buildDeviceFilters(photos) {
  const filters = []

  ;(photos || []).forEach(photo => {
    const name = photo.deviceName
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
    currentFilter: '',
    showFilterMenu: false,
    sourcePhotos: [],
    photos: [],
    filteredPhotos: [],
    selectedMap: {},
    selectedCount: 0,
    totalCount: TOTAL_PLACEHOLDER_COUNT,
    showDeleteConfirm: false,
    deleteClosing: false, // 删除确认弹窗是否正在播放退场动画
    loading: true // 首屏接口返回前为 true，避免空态先闪一下
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
    // 首屏渲染即 loading=true，等接口返回再决定展示照片网格还是空态，避免空态先闪一下
    let result
    try {
      result = await Promise.all([
        api.getAlbumPhotos(),
        api.getDevices()
      ])
    } catch (error) {
      // 接口失败时 api 层已 toast 提示，这里仅结束 loading，落到空态
      this.setData({ loading: false })
      return
    }
    const sourcePhotos = result[0]
    const devices = result[1]
    // 列表以后端返回为准：删除已实际删掉设备(0x12)+后端记录，不再叠加本地软隐藏
    //（旧的软隐藏是永久的，会把后端仍返回的图一直藏起来，导致「接口有 N 条却只显示 1 条」）
    const photos = buildDisplayPhotos(sourcePhotos, devices)

    // 按照片里的设备名动态生成筛选项；当前筛选若已不在列表里（设备的照片被删光）则回退到第一项
    const filters = buildDeviceFilters(photos)
    const currentFilter = filters.some(item => item.value === this.data.currentFilter)
      ? this.data.currentFilter
      : (filters[0] ? filters[0].value : '')

    this.setData({
      filters,
      currentFilter,
      sourcePhotos,
      photos,
      totalCount: photos.length,
      selectedMap: {},
      selectedCount: 0,
      showDeleteConfirm: false,
      loading: false
    })
    this.applyFilter(currentFilter, photos)
  },

  // 按设备名筛选照片（无「全部」选项）；filter 为空（无照片/无设备）时回退展示全部，切换筛选时清空已选
  applyFilter(filter, photos = this.data.photos) {
    const filteredPhotos = filter ? photos.filter(item => item.deviceName === filter) : photos

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

  // 取消选择：清空所有已选，底部操作栏随之收起
  cancelSelect() {
    this.setData({
      selectedMap: {},
      selectedCount: 0
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

  // 删除前的连接校验：删除要同时删设备(0x12)与后端，二者必须一致，所以必须先连上设备。
  // 已连接返回 device；未连接则提示「无法删除」并返回 null。
  async ensureConnectedDevice() {
    const device = activeDevice.getActiveDevice()
    if (!device || !(device.deviceId || device.bleDeviceId || device.deviceNo || device.name)) {
      toast.warn({
        title: '设备未连接，无法删除',
        icon: 'none'
      })
      return null
    }
    // 断联则自动重连(扫描+连接)，连不上再提示；连上返回带当下有效 deviceId 的设备。
    const deviceId = await activeDevice.ensureConnectedForAction(device)
    if (!deviceId) {
      return null // 提示已由 ensureConnectedForAction 弹出（请先连接设备 / 权限引导）
    }
    return Object.assign({}, device, { deviceId, bleDeviceId: deviceId, connected: true })
  },

  showDeleteDialog() {
    if (!this.data.selectedCount) {
      toast.warn({
        title: '请选择照片',
        icon: 'none'
      })
      return
    }

    // 连接判断/自动重连移到「确认删除」时(confirmDeleteSelected)，避免弹确认框前先干等数秒扫描重连。
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

  // 删除选中照片：先把设备固件上对应槽位删掉(CMD 0x12)，设备删成功后再删后端记录，
  // 保证「列表 / 后端 / 设备」三处一致。设备删除失败则整体中止，避免列表删了但相框里还在。
  async confirmDeleteSelected() {
    const ids = Object.keys(this.data.selectedMap)

    if (!ids.length) {
      this.hideDeleteDialog()
      return
    }

    // 1) 删除前确保已连接：断联则自动重连，连不上才提示（防止弹确认框期间设备断开导致设备/后端不一致）
    const device = await this.ensureConnectedDevice()
    if (!device) {
      this.hideDeleteDialog()
      return
    }

    wx.showLoading({ title: '删除中', mask: true })
    try {
      // 读固件已占用槽位（升序），用同一份快照把每张选中照片解析成对应槽位；
      // 不在本设备上的（解析为 -1）跳过，只删能对上的。
      const info = await deviceBle.readDeviceInfo(device.deviceId)
      const occupied = protocol.maskToIndexes(info.imgMask)
      const slotIndexes = ids
        .map(id => this.resolveDeviceImageIndex(id, device, occupied))
        .filter(index => index >= 0)

      // 2) 一条 0x12 批量删这些槽位（deleteImage 内部把索引数组转成掩码）
      if (slotIndexes.length) {
        await deviceBle.deleteImage(device.deviceId, slotIndexes)
      }
    } catch (error) {
      wx.hideLoading()
      toast.warn({
        title: (error && error.message) || '设备删除失败',
        icon: 'none'
      })
      return // 设备没删成功就不动本地/后端，避免三处不一致
    }
    wx.hideLoading()

    // 3) 设备删除成功后，再删后端记录；删完 loadPhotos 以后端为准刷新（不再做本地软隐藏）
    try {
      await api.deleteAlbumPhotos(ids)
    } catch (error) {
      toast.warn({
        title: (error && error.message) || '删除照片记录失败',
        icon: 'none'
      })
      return
    }

    toast.show({
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
      toast.warn({
        title: '请选择图片',
        icon: 'none'
      })
      return
    }

    if (ids.length > 1) {
      toast.warn({
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
        toast.warn({
          title: '未找到该图片在设备上的位置',
          icon: 'none'
        })
        return
      }

      // CMD=0x24：让固件切换/刷新到指定索引的图片
      await deviceBle.refreshScreen(device.deviceId, index)
      wx.hideLoading()
      toast.show({
        title: '已刷新屏幕',
        icon: 'none'
      })
    } catch (error) {
      wx.hideLoading()
      toast.warn({
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
      toast.warn({
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
      toast.warn({
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
