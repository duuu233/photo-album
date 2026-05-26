const api = require('../../utils/api')
const media = require('../../utils/media')

const app = getApp()

const SCENES = {
  UNBOUND: 'unbound',
  UNBOUND_BIND_NOW: 'unboundBindNow',
  UNBOUND_RECONNECT: 'unboundReconnect',
  BOUND: 'bound',
  MEDIA_SHEET: 'mediaSheet',
  BINDING_SCANNING: 'bindingScanning',
  BINDING_NO_DEVICE: 'bindingNoDevice',
  DEVICE_FOUND: 'deviceFound',
  SCAN_HELP: 'scanHelp'
}

const SCENE_ALIASES = {
  unbound: SCENES.UNBOUND,
  '首页-未绑定设备': SCENES.UNBOUND,
  unboundBindNow: SCENES.UNBOUND_BIND_NOW,
  '首页-未绑定设备-立即绑定': SCENES.UNBOUND_BIND_NOW,
  unboundReconnect: SCENES.UNBOUND_RECONNECT,
  '首页-未绑定设备-重新连接': SCENES.UNBOUND_RECONNECT,
  bound: SCENES.BOUND,
  '首页-已绑定设备': SCENES.BOUND,
  mediaSheet: SCENES.MEDIA_SHEET,
  '首页-已绑定设备-拍照or相册': SCENES.MEDIA_SHEET,
  bindingScanning: SCENES.BINDING_SCANNING,
  '首页-绑定设备-正在搜索附近设备': SCENES.BINDING_SCANNING,
  bindingNoDevice: SCENES.BINDING_NO_DEVICE,
  '首页-绑定设备-未发现设备': SCENES.BINDING_NO_DEVICE,
  deviceFound: SCENES.DEVICE_FOUND,
  '首页-绑定设备-已搜索到设备': SCENES.DEVICE_FOUND,
  scanHelp: SCENES.SCAN_HELP,
  '首页-绑定设备-扫描不到怎么办': SCENES.SCAN_HELP,
  '首页-绑定设备-扫描不到怎么办？': SCENES.SCAN_HELP
}

const DEFAULT_DEVICE = {
  id: 'frame_room',
  name: '房间相册',
  connected: true,
  battery: 30
}

const NEARBY_DEVICES = [
  {
    id: 'living',
    name: '客厅相框',
    color: 'orange',
    selected: true
  },
  {
    id: 'bedroom',
    name: '卧室相框',
    color: 'green',
    selected: false
  },
  {
    id: 'study',
    name: '书房相框',
    color: 'blue',
    selected: false
  }
]

function clampBattery(value) {
  const number = Number(value)
  if (Number.isNaN(number)) {
    return 30
  }
  return Math.max(0, Math.min(100, Math.round(number)))
}

function normalizeScene(scene) {
  return SCENE_ALIASES[scene] || SCENES.UNBOUND
}

function normalizeDevice(device) {
  if (!device) {
    return null
  }
  const battery = clampBattery(device.battery || 30)
  return {
    id: device.id || DEFAULT_DEVICE.id,
    name: device.displayName || '房间相册',
    connected: device.connected !== false,
    battery
  }
}

function sceneState(scene) {
  const isBoundHome = scene === SCENES.BOUND || scene === SCENES.MEDIA_SHEET
  const isUnboundHome = scene === SCENES.UNBOUND || scene === SCENES.UNBOUND_BIND_NOW || scene === SCENES.UNBOUND_RECONNECT
  const showPromptSheet = scene === SCENES.UNBOUND_BIND_NOW || scene === SCENES.UNBOUND_RECONNECT
  const isBindingScanning = scene === SCENES.BINDING_SCANNING
  const isBindingNoDevice = scene === SCENES.BINDING_NO_DEVICE
  const isBindingFound = scene === SCENES.DEVICE_FOUND
  const isScanHelp = scene === SCENES.SCAN_HELP

  return {
    isHomeScene: isBoundHome || isUnboundHome,
    isBoundHome,
    isUnboundHome,
    hasHomeOverlay: showPromptSheet || scene === SCENES.MEDIA_SHEET,
    showPromptSheet,
    isMediaSheet: scene === SCENES.MEDIA_SHEET,
    isBindingScanning,
    isBindingNoDevice,
    isBindingFound,
    isScanHelp,
    promptTitle: scene === SCENES.UNBOUND_RECONNECT ? '设备连接失败' : '暂未绑定设备',
    promptDesc: scene === SCENES.UNBOUND_RECONNECT ? '当前设备未连接，APP需先连接设备后再投屏' : '当前暂无可投屏设备，请先绑定相框设备',
    promptButton: scene === SCENES.UNBOUND_RECONNECT ? '重新连接' : '立即绑定'
  }
}

Page({
  data: {
    scene: SCENES.UNBOUND,
    statusBarHeight: 20,
    safeBottom: 0,
    avatarUrl: '',
    currentDevice: DEFAULT_DEVICE,
    hasDevice: false,
    batteryWidth: DEFAULT_DEVICE.battery,
    nearbyDevices: NEARBY_DEVICES,
    sceneFromQuery: false,
    ...sceneState(SCENES.UNBOUND)
  },

  onLoad(options = {}) {
    this.scanTimer = null
    this.setSystemMetrics()

    if (options.scene) {
      this.setScene(normalizeScene(decodeURIComponent(options.scene)), {
        sceneFromQuery: true
      })
    }
  },

  onShow() {
    if (wx.hideTabBar) {
      wx.hideTabBar({
        animation: false
      })
    }

    if (!this.data.sceneFromQuery) {
      this.loadHomeState()
    }
  },

  onUnload() {
    this.clearScanTimer()
  },

  setSystemMetrics() {
    try {
      const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
      const bottomInset = Math.max(0, (info.screenHeight || 0) - (info.safeArea ? info.safeArea.bottom : info.windowHeight || 0))

      this.setData({
        statusBarHeight: info.statusBarHeight || 20,
        safeBottom: bottomInset
      })
    } catch (error) {
      this.setData({
        statusBarHeight: 20,
        safeBottom: 0
      })
    }
  },

  async loadHomeState() {
    try {
      await app.ensureLogin()
      const devices = await api.getDevices()
      const cached = app.globalData.selectedDevice
      const selected = devices.find(item => cached && item.id === cached.id) || devices[0]
      const currentDevice = normalizeDevice(selected)

      if (selected) {
        app.setSelectedDevice(selected)
      }

      this.setData({
        currentDevice: currentDevice || DEFAULT_DEVICE,
        batteryWidth: currentDevice ? currentDevice.battery : DEFAULT_DEVICE.battery,
        hasDevice: !!currentDevice
      })

      this.setScene(currentDevice ? SCENES.BOUND : SCENES.UNBOUND, {
        hasDevice: !!currentDevice
      })
    } catch (error) {
      this.setData({
        currentDevice: DEFAULT_DEVICE,
        batteryWidth: DEFAULT_DEVICE.battery,
        hasDevice: false
      })
      this.setScene(SCENES.UNBOUND, {
        hasDevice: false
      })
    }
  },

  setScene(scene, extra = {}) {
    const previewHasDevice = scene === SCENES.BOUND || scene === SCENES.MEDIA_SHEET
    const nextHasDevice = Object.prototype.hasOwnProperty.call(extra, 'hasDevice') ? extra.hasDevice : this.data.hasDevice || previewHasDevice

    this.setData({
      scene,
      ...sceneState(scene),
      hasDevice: nextHasDevice,
      ...extra
    })
  },

  clearScanTimer() {
    if (this.scanTimer) {
      clearTimeout(this.scanTimer)
      this.scanTimer = null
    }
  },

  showBindNowSheet() {
    this.setScene(SCENES.UNBOUND_BIND_NOW)
  },

  showReconnectSheet() {
    this.setScene(SCENES.UNBOUND_RECONNECT)
  },

  closeHomeSheet() {
    this.setScene(this.data.hasDevice ? SCENES.BOUND : SCENES.UNBOUND)
  },

  confirmPrompt() {
    this.startBindingScan()
  },

  startBindingScan() {
    this.clearScanTimer()
    this.setScene(SCENES.BINDING_SCANNING)

    this.scanTimer = setTimeout(() => {
      this.scanTimer = null
      this.setData({
        nearbyDevices: NEARBY_DEVICES.map((item, index) => ({
          ...item,
          selected: index === 0
        }))
      })
      this.setScene(SCENES.DEVICE_FOUND)
    }, 1200)
  },

  rescanDevices() {
    this.startBindingScan()
  },

  cancelScan() {
    this.clearScanTimer()
    this.setScene(this.data.hasDevice ? SCENES.BOUND : SCENES.UNBOUND)
  },

  backFromBinding() {
    this.clearScanTimer()
    this.setScene(this.data.hasDevice ? SCENES.BOUND : SCENES.UNBOUND)
  },

  showScanHelp() {
    this.clearScanTimer()
    this.setScene(SCENES.SCAN_HELP)
  },

  closeScanHelp() {
    this.setScene(SCENES.BINDING_NO_DEVICE)
  },

  selectNearbyDevice(event) {
    const id = event.currentTarget.dataset.id
    this.setData({
      nearbyDevices: this.data.nearbyDevices.map(item => ({
        ...item,
        selected: item.id === id
      }))
    })
  },

  finishBind() {
    const selected = this.data.nearbyDevices.find(item => item.selected) || this.data.nearbyDevices[0]
    const currentDevice = {
      id: selected.id,
      name: selected.name,
      connected: true,
      battery: 30
    }

    this.setData({
      currentDevice,
      batteryWidth: currentDevice.battery,
      hasDevice: true
    })
    this.setScene(SCENES.BOUND)
  },

  tapCameraEntry() {
    if (!this.data.isBoundHome) {
      this.showBindNowSheet()
      return
    }
    this.setScene(SCENES.MEDIA_SHEET)
  },

  tapAlbumEntry() {
    if (!this.data.isBoundHome) {
      this.showBindNowSheet()
      return
    }
    this.setScene(SCENES.MEDIA_SHEET)
  },

  async chooseCamera() {
    try {
      await app.ensureLogin()
      const images = await media.chooseFromCamera()
      this.openPreview(images)
    } catch (error) {
      if (error && error.errMsg && error.errMsg.indexOf('cancel') > -1) {
        return
      }
      wx.showToast({
        title: '拍照失败',
        icon: 'none'
      })
    }
  },

  async chooseAlbum() {
    try {
      await app.ensureLogin()
      const images = await media.chooseFromAlbum()
      this.openPreview(images)
    } catch (error) {
      if (error && error.errMsg && error.errMsg.indexOf('cancel') > -1) {
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

    if (!this.data.hasDevice) {
      this.showBindNowSheet()
      return
    }

    wx.setStorageSync('pendingProjection', {
      device: this.data.currentDevice,
      images
    })
    wx.navigateTo({
      url: '/subpackages/projection/preview/preview'
    })
  },

  goMine() {
    wx.switchTab({
      url: '/pages/mine/mine'
    })
  },

  noop() {}
})
