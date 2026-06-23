const api = require('../../utils/api')
const media = require('../../utils/media')
const batteryUtil = require('../../utils/battery')
const deviceBle = require('../../utils/device-ble')

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

// 未设置头像时的兜底图：与「我的」页保持一致
const DEFAULT_AVATAR = '/assets/images/mine-header.png'

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

// 将接口返回的设备裁剪为首页展示所需字段。connected 取真实蓝牙会话状态，deviceId 透传给投屏页用于连接。
function normalizeDevice(device) {
  if (!device) {
    return null
  }
  const battery = clampBattery(typeof device.battery === 'number' ? device.battery : 30)
  return {
    id: device.id || DEFAULT_DEVICE.id,
    deviceId: device.deviceId || '', // 真实蓝牙 deviceId：投屏页据此连接设备并图传
    name: device.name || device.displayName || '相框',
    // 「已连接」按真实蓝牙会话显示（即连即传，无活动会话即未连接），不再恒为 true
    connected: !!(device.deviceId && deviceBle.isConnected(device.deviceId)),
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
    avatarUrl: DEFAULT_AVATAR,
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
      this.loadUserAvatar()

      if (this.data.networkOffline) {
        this.checkNetworkStatus()
        return
      }

      this.loadHomeState()
    }
  },

  // 登录后拉取真实头像，没有头像时回退默认图；未登录则只展示默认图
  async loadUserAvatar() {
    if (!app.globalData.token && !wx.getStorageSync('token')) {
      this.setData({
        avatarUrl: DEFAULT_AVATAR
      })
      return
    }

    try {
      const userInfo = await api.getUserProfile()
      this.setData({
        avatarUrl: userInfo.avatarUrl || DEFAULT_AVATAR
      })
    } catch (error) {
      // 拉取失败保持当前/默认头像，不打断首页
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
    // 游客模式：未登录不强制跳登录，直接展示「未绑定」首页；登录留到需要的操作时再触发
    if (!app.globalData.token && !wx.getStorageSync('token')) {
      this.setData({
        currentDevice: DEFAULT_DEVICE,
        batteryWidth: DEFAULT_DEVICE.battery,
        hasDevice: false
      })
      this.setScene(SCENES.UNBOUND, {
        hasDevice: false
      })
      return
    }

    try {
      const devices = await api.getDevices()
      const cached = app.globalData.selectedDevice
      // 优先沿用上次选中的设备，没有则取列表第一个
      let selected =
        devices.find(item => cached && item.id === cached.id) || devices[0]

      if (selected && cached && String(selected.id) === String(cached.id)) {
        selected = Object.assign({}, selected, {
          deviceId: selected.deviceId || cached.deviceId,
          bleDeviceId: selected.bleDeviceId || cached.bleDeviceId || cached.deviceId,
          battery: typeof selected.battery === 'number' ? selected.battery : cached.battery
        })
      }
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

  startBindingScan() {
    wx.navigateTo({
      url: '/subpackages/device/bind/bind'
    })
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
    this.startBindingScan()
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

    // 传给投屏页的设备用全量的已选设备（含真实蓝牙 deviceId），投屏页据此真实连接并图传
    wx.setStorageSync('pendingProjection', {
      device: app.globalData.selectedDevice || this.data.currentDevice,
      images
    })
    wx.navigateTo({
      url: '/subpackages/projection/preview/preview'
    })
  },

  // 点击头像：触发微信头像授权（可拍照/从相册选择/用微信头像），选完后上传保存
  async onChooseAvatar(event) {
    const avatarUrl = event.detail && event.detail.avatarUrl
    if (!avatarUrl) {
      return
    }

    // 先本地回显新头像，提升响应感
    this.setData({
      avatarUrl
    })

    try {
      await app.ensureLogin()
      // 上传本地临时头像并保存到后端，返回最新用户资料
      const userInfo = await api.updateUserProfile({ avatarUrl })
      const mergedUser = Object.assign({}, app.globalData.userInfo, userInfo)
      app.globalData.userInfo = mergedUser
      wx.setStorageSync('userInfo', mergedUser)
      this.setData({
        avatarUrl: userInfo.avatarUrl || avatarUrl
      })
      wx.showToast({
        title: '头像已更新',
        icon: 'none'
      })
    } catch (error) {
      // 未登录时 ensureLogin 会跳转登录页，这里静默返回
      if (error && error.code === 'NO_TOKEN') {
        return
      }
      // 保存失败回退到原有头像并提示
      const fallback =
        (app.globalData.userInfo && app.globalData.userInfo.avatarUrl) ||
        DEFAULT_AVATAR
      this.setData({
        avatarUrl: fallback
      })
      wx.showToast({
        title: '头像更新失败',
        icon: 'none'
      })
    }
  },

  noop() {}
})
