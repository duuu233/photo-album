const api = require('../../utils/api')
const media = require('../../utils/media')
const batteryUtil = require('../../utils/battery')

const app = getApp()

// 首页是一个“场景状态机”：同一个页面通过切换 scene 来展示未绑定/已绑定/搜索设备/帮助等不同 UI。
// 所有弹层、空态都由当前 scene 派生（见 sceneState），切换界面只需调用 setScene。
const SCENES = {
  UNBOUND: 'unbound',
  UNBOUND_BIND_NOW: 'unboundBindNow',
  UNBOUND_RECONNECT: 'unboundReconnect',
  OFFLINE: 'offline',
  BOUND: 'bound',
  MEDIA_SHEET: 'mediaSheet',
  BINDING_SCANNING: 'bindingScanning',
  BINDING_NO_DEVICE: 'bindingNoDevice',
  DEVICE_FOUND: 'deviceFound',
  SCAN_HELP: 'scanHelp'
}

// 场景别名表：允许通过页面 query（英文 key 或设计稿中文名）直接定位到某个场景，便于设计走查/调试
const SCENE_ALIASES = {
  unbound: SCENES.UNBOUND,
  '首页-未绑定设备': SCENES.UNBOUND,
  unboundBindNow: SCENES.UNBOUND_BIND_NOW,
  '首页-未绑定设备-立即绑定': SCENES.UNBOUND_BIND_NOW,
  unboundReconnect: SCENES.UNBOUND_RECONNECT,
  '首页-未绑定设备-重新连接': SCENES.UNBOUND_RECONNECT,
  offline: SCENES.OFFLINE,
  offlineMode: SCENES.OFFLINE,
  '首页-离线断网模式': SCENES.OFFLINE,
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
  battery: 30,
  batteryIcon: batteryUtil.getBatteryIcon(30)
}

const NEARBY_DEVICES = [
  {
    id: 'living',
    name: '客厅相框',
    icon: '/assets/images/device-list-icon01.png',
    selected: true
  },
  {
    id: 'bedroom',
    name: '卧室相框',
    icon: '/assets/images/device-list-icon02.png',
    selected: false
  },
  {
    id: 'study',
    name: '书房相框',
    icon: '/assets/images/device-list-icon03.png',
    selected: false
  }
]

// 把电量限制在 0~100 的整数范围内，非法值兜底 30
function clampBattery(value) {
  const number = Number(value)
  if (Number.isNaN(number)) {
    return 30
  }
  return Math.max(0, Math.min(100, Math.round(number)))
}

// 把传入的场景标识（可能是别名）解析为标准场景，无法识别时回到未绑定首页
function normalizeScene(scene) {
  return SCENE_ALIASES[scene] || SCENES.UNBOUND
}

function getHomeBgImage(scene) {
  const useBg02 =
    scene === SCENES.UNBOUND ||
    scene === SCENES.UNBOUND_BIND_NOW ||
    scene === SCENES.UNBOUND_RECONNECT ||
    scene === SCENES.OFFLINE ||
    scene === SCENES.BOUND ||
    scene === SCENES.MEDIA_SHEET

  return `/assets/images/${useBg02 ? 'bg02' : 'bg01'}.png`
}

function isBindingScene(scene) {
  return (
    scene === SCENES.BINDING_SCANNING ||
    scene === SCENES.BINDING_NO_DEVICE ||
    scene === SCENES.DEVICE_FOUND ||
    scene === SCENES.SCAN_HELP
  )
}

function getNavigationTitle(scene) {
  return isBindingScene(scene) ? '绑定设备' : '首页'
}

function isNetworkError(error) {
  if (!error) {
    return false
  }

  const message = `${error.message || ''} ${error.errMsg || ''}`.toLowerCase()
  return (
    error.code === 'NETWORK_ERROR' ||
    message.indexOf('network') > -1 ||
    message.indexOf('timeout') > -1 ||
    message.indexOf('request:fail') > -1 ||
    message.indexOf('网络') > -1
  )
}

// 将接口返回的设备裁剪为首页展示所需字段（connected 默认 true）
function normalizeDevice(device) {
  if (!device) {
    return null
  }
  const battery = clampBattery(device.battery || 30)
  return {
    id: device.id || DEFAULT_DEVICE.id,
    name: device.displayName || '房间相册',
    connected: device.connected !== false,
    battery,
    batteryIcon: batteryUtil.getBatteryIcon(battery)
  }
}

// 由当前 scene 派生出 WXML 用到的一组布尔/文案标记，集中在此避免模板里写复杂判断。
// setScene 时会把这些标记一起 setData，模板直接用 isBoundHome、showPromptSheet 等控制显隐。
function sceneState(scene) {
  const isBoundHome = scene === SCENES.BOUND || scene === SCENES.MEDIA_SHEET
  const isOfflineMode = scene === SCENES.OFFLINE
  const isUnboundHome =
    scene === SCENES.UNBOUND ||
    scene === SCENES.UNBOUND_BIND_NOW ||
    scene === SCENES.UNBOUND_RECONNECT ||
    isOfflineMode
  const showPromptSheet =
    scene === SCENES.UNBOUND_BIND_NOW || scene === SCENES.UNBOUND_RECONNECT
  const isBindingScanning = scene === SCENES.BINDING_SCANNING
  const isBindingNoDevice = scene === SCENES.BINDING_NO_DEVICE
  const isBindingFound = scene === SCENES.DEVICE_FOUND
  const isScanHelp = scene === SCENES.SCAN_HELP
  const showNavBack = isBindingScene(scene)

  return {
    isHomeScene: isBoundHome || isUnboundHome,
    isBoundHome,
    isUnboundHome,
    hasHomeOverlay:
      showPromptSheet || isOfflineMode || scene === SCENES.MEDIA_SHEET,
    showPromptSheet,
    isMediaSheet: scene === SCENES.MEDIA_SHEET,
    isOfflineMode,
    isBindingScanning,
    isBindingNoDevice,
    isBindingFound,
    isScanHelp,
    showNavBack,
    homeBgImage: getHomeBgImage(scene),
    promptTitle:
      scene === SCENES.UNBOUND_RECONNECT ? '设备连接失败' : '暂未绑定设备',
    promptDesc:
      scene === SCENES.UNBOUND_RECONNECT
        ? '当前设备未连接，APP需先连接设备后再投屏'
        : '当前暂无可投屏设备，请先绑定相框设备',
    promptButton: scene === SCENES.UNBOUND_RECONNECT ? '重新连接' : '立即绑定'
  }
}

Page({
  data: {
    scene: SCENES.UNBOUND,
    statusBarHeight: 20,
    safeBottom: 0,
    navTitle: getNavigationTitle(SCENES.UNBOUND),
    avatarUrl: '/assets/images/mine-header.png',
    currentDevice: DEFAULT_DEVICE,
    deviceList: [DEFAULT_DEVICE],
    currentDeviceIndex: 0,
    hasDevice: false,
    batteryWidth: DEFAULT_DEVICE.battery,
    nearbyDevices: NEARBY_DEVICES,
    sceneFromQuery: false,
    networkOffline: false,
    ...sceneState(SCENES.UNBOUND)
  },

  onLoad(options = {}) {
    this.scanTimer = null // 模拟扫描的定时器句柄，离开页面时需清除
    this.networkStatusHandler = this.handleNetworkStatusChange.bind(this)
    this.setSystemMetrics()

    // 若带 scene 参数进入（设计走查/调试），直接定位到指定场景并跳过自动加载
    if (options.scene) {
      this.setScene(normalizeScene(decodeURIComponent(options.scene)), {
        sceneFromQuery: true
      })
    }

    if (wx.onNetworkStatusChange) {
      wx.onNetworkStatusChange(this.networkStatusHandler)
    }

    if (!options.scene) {
      this.checkNetworkStatus()
    }
  },

  onShow() {
    // 使用自定义底部导航，隐藏原生 tabBar
    if (wx.hideTabBar) {
      wx.hideTabBar({
        animation: false
      })
    }

    // 仅在非“指定场景”进入时才按真实设备状态刷新首页，避免覆盖调试场景
    if (!this.data.sceneFromQuery) {
      if (this.data.networkOffline) {
        this.checkNetworkStatus()
        return
      }

      this.loadHomeState()
    }
  },

  onUnload() {
    this.clearScanTimer()

    if (wx.offNetworkStatusChange && this.networkStatusHandler) {
      wx.offNetworkStatusChange(this.networkStatusHandler)
    }
  },

  setSystemMetrics() {
    try {
      const info = wx.getWindowInfo
        ? wx.getWindowInfo()
        : wx.getSystemInfoSync()
      const bottomInset = Math.max(
        0,
        (info.screenHeight || 0) -
          (info.safeArea ? info.safeArea.bottom : info.windowHeight || 0)
      )

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

  // 拉取设备列表确定首页处于已绑定还是未绑定场景；失败则兜底为未绑定
  async loadHomeState() {
    try {
      await app.ensureLogin()
      const devices = await api.getDevices()
      const cached = app.globalData.selectedDevice
      // 优先沿用上次选中的设备，没有则取列表第一个
      const selected =
        devices.find(item => cached && item.id === cached.id) || devices[0]
      const currentDevice = normalizeDevice(selected)

      if (selected) {
        app.setSelectedDevice(selected)
      }

      // 轮播展示全部已绑定设备；找出当前选中设备在列表中的位置作为初始页
      const deviceList = devices.map(normalizeDevice).filter(Boolean)
      const list = deviceList.length ? deviceList : [DEFAULT_DEVICE]
      const currentDeviceIndex = Math.max(
        0,
        list.findIndex(item => currentDevice && item.id === currentDevice.id)
      )

      this.setData({
        currentDevice: currentDevice || DEFAULT_DEVICE,
        deviceList: list,
        currentDeviceIndex,
        batteryWidth: currentDevice
          ? currentDevice.battery
          : DEFAULT_DEVICE.battery,
        hasDevice: !!currentDevice
      })

      this.setScene(currentDevice ? SCENES.BOUND : SCENES.UNBOUND, {
        hasDevice: !!currentDevice
      })
    } catch (error) {
      if (isNetworkError(error)) {
        this.showOfflineMode()
        return
      }

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

  checkNetworkStatus() {
    if (!wx.getNetworkType) {
      return
    }

    wx.getNetworkType({
      success: res => {
        if (res.networkType === 'none') {
          this.showOfflineMode()
          return
        }

        if (this.data.networkOffline) {
          this.setData({
            networkOffline: false
          })

          if (!this.data.sceneFromQuery) {
            this.loadHomeState()
          }
        }
      }
    })
  },

  handleNetworkStatusChange(res) {
    if (!res.isConnected || res.networkType === 'none') {
      this.showOfflineMode()
      return
    }

    const wasOffline =
      this.data.networkOffline || this.data.scene === SCENES.OFFLINE
    this.setData({
      networkOffline: false
    })

    if (wasOffline && !this.data.sceneFromQuery) {
      this.loadHomeState()
    }
  },

  // 切换场景的统一入口：写入 scene、派生标记，并维护 hasDevice。
  // hasDevice 取值优先级：extra 显式传入 > 已有值 > 该场景隐含的已绑定状态。
  setScene(scene, extra = {}) {
    const previewHasDevice =
      scene === SCENES.BOUND || scene === SCENES.MEDIA_SHEET
    const nextHasDevice = Object.prototype.hasOwnProperty.call(
      extra,
      'hasDevice'
    )
      ? extra.hasDevice
      : this.data.hasDevice || previewHasDevice

    this.setData({
      scene,
      navTitle: getNavigationTitle(scene),
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

  showOfflineMode() {
    this.clearScanTimer()
    this.setScene(SCENES.OFFLINE, {
      hasDevice: this.data.hasDevice,
      networkOffline: true
    })
  },

  closeHomeSheet() {
    this.setScene(this.data.hasDevice ? SCENES.BOUND : SCENES.UNBOUND)
  },

  closeOfflineMode() {
    this.setScene(this.data.hasDevice ? SCENES.BOUND : SCENES.UNBOUND)
  },

  confirmPrompt() {
    this.startBindingScan()
  },

  // 模拟蓝牙搜索：进入“搜索中”场景，1.2s 后切到“已发现设备”并默认选中第一个
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
    const selected =
      this.data.nearbyDevices.find(item => item.selected) ||
      this.data.nearbyDevices[0]
    const currentDevice = {
      id: selected.id,
      name: selected.name,
      connected: true,
      battery: 30,
      batteryIcon: batteryUtil.getBatteryIcon(30)
    }

    this.setData({
      currentDevice,
      deviceList: [currentDevice],
      currentDeviceIndex: 0,
      batteryWidth: currentDevice.battery,
      hasDevice: true
    })
    this.setScene(SCENES.BOUND)
  },

  // 轮播切换：同步当前设备与电量，供拍照/投屏等逻辑沿用 currentDevice
  onDeviceChange(event) {
    const index = event.detail.current
    const device = this.data.deviceList[index] || this.data.currentDevice

    if (device && device.id) {
      app.setSelectedDevice(device)
    }

    this.setData({
      currentDeviceIndex: index,
      currentDevice: device,
      batteryWidth: device.battery
    })
  },

  // 点击拍照入口：未绑定设备时先引导绑定，否则弹出拍照/相册选择层
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
      // 用户主动取消选择不算错误，静默返回
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

  // 选好照片后跳转投屏预览页：通过 Storage 传递待投屏的设备与图片（避免超长 URL 参数）
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
