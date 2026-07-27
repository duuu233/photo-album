const api = require('../../utils/api')
const toast = require('../../utils/toast')
const media = require('../../utils/media')
const batteryUtil = require('../../utils/battery')
const deviceBle = require('../../utils/device-ble')
const activeDevice = require('../../utils/active-device')

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
const DEFAULT_AVATAR = '/assets/images/mine-header.jpg'

// 未绑定设备时的占位卡片。电量置未知：这是一张假设备卡，给它一个像模像样的 30% 会和真实设备
// 的电量混为一谈——历史上正是这个 30 通过 normalizeDevice 的兜底泄漏成了所有真实设备的默认电量。
const DEFAULT_DEVICE = {
  id: 'frame_room',
  name: '房间相册',
  connected: true,
  battery: null,
  batteryAt: null,
  batteryText: batteryUtil.UNKNOWN_BATTERY_TEXT,
  batteryIcon: batteryUtil.getBatteryIcon(null)
}

const NEARBY_DEVICES = [
  {
    id: 'living',
    name: '客厅相框',
    icon: '/assets/images/mine-icon03.png',
    selected: true
  },
  {
    id: 'bedroom',
    name: '卧室相框',
    icon: '/assets/images/mine-icon02.png',
    selected: false
  },
  {
    id: 'study',
    name: '书房相框',
    icon: '/assets/images/mine-icon01.png',
    selected: false
  }
]

// 电量的归一化/新鲜度/文案统一由 utils/battery.js 承担，本页不再自备兜底逻辑
// （原本这里有个「非法值兜底 30」的 clampBattery，是首页显示假电量的源头）。

// 把传入的场景标识（可能是别名）解析为标准场景，无法识别时回到未绑定首页
function normalizeScene(scene) {
  return SCENE_ALIASES[scene] || SCENES.UNBOUND
}

// 首页大背景图统一用 OSS 线上图，不再按场景区分本地 bg01/bg02
function getHomeBgImage() {
  return 'https://oss.boltfox.cn/prodFile/202607071032177373571.png'
}

// 首页前景图：与大背景图一起做「加载完成再展示首页」的门控，未加载完先展示 loading
function getHomeFgImage() {
  return 'https://oss.boltfox.cn/prodFile/202607072104114724571.png'
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
  // 活动会话按「设备ID×广播ID」交叉匹配认领：接口重拉的记录不带 BLE deviceId，只按 deviceId 直连判断
  // 会把还连着的设备错显示成「未连接」（假断联）；交叉匹配命中后顺带把当下有效 deviceId 回填给记录
  const liveId = activeDevice.findConnectedDeviceId(device)
  const completeDeviceId = activeDevice.stableDeviceId(device)
  const normalized = {
    id: device.id || DEFAULT_DEVICE.id,
    deviceId: liveId || device.deviceId || '', // 真实蓝牙 deviceId：投屏页据此连接设备并图传
    bleDeviceId: liveId || device.bleDeviceId || device.deviceId || '',
    // 硬件序列号(Device_ID)：跨扫描会话稳定，按需连接时据此匹配扫描结果，须随设备一路带下去
    productDeviceId: completeDeviceId,
    deviceNo: completeDeviceId,
    firmwareDeviceId: completeDeviceId,
    name: device.name || device.displayName || '相框',
    // 「已连接」按真实蓝牙会话显示（即连即传，无活动会话即未连接），不再恒为 true
    connected: !!liveId,
    // 屏幕分辨率：投屏预览页裁剪按此 width/height 锁定比例，透传给下游（接口就绪后即生效）
    width: device.width,
    height: device.height,
    // 先沿用最近一次有效电量；15 秒窗口外由 loadHomeState 收尾后台刷新，
    // 不在刷新前清空，避免「-- → 真值」闪烁。
    battery: batteryUtil.normalizeBattery(device.battery),
    batteryAt: device.batteryAt || null
  }
  // connected 已就位，才能算出电量文案/图标（未连接一律未知）
  return Object.assign(normalized, {
    batteryText: batteryUtil.batteryText(normalized),
    batteryIcon: batteryUtil.batteryIconOf(normalized)
  })
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
    homeBgImage: getHomeBgImage(),
    homeFgImage: getHomeFgImage(),
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
  data: Object.assign({
    scene: SCENES.UNBOUND,
    statusBarHeight: 20,
    safeBottom: 0,
    navTitle: getNavigationTitle(SCENES.UNBOUND),
    avatarUrl: DEFAULT_AVATAR,
    currentDevice: DEFAULT_DEVICE,
    deviceList: [DEFAULT_DEVICE],
    currentDeviceIndex: 0,
    hasDevice: false,
    nearbyDevices: NEARBY_DEVICES,
    sceneFromQuery: false,
    networkOffline: false,
    sheetClosing: false, // 底部弹层是否正在播放退场动画
    // 首屏拉设备列表（判断已绑定/未绑定）前为 true，先展示 loading，
    // 等 loadHomeState 走到 setScene 落定场景再关闭，避免「未绑定」空态先闪一下再变「已绑定」。
    pageLoading: true,
    // 大背景图 + 前景图都加载完成后置 true。现在只驱动 OSS 背景图的淡入（本地占位图已打底），
    // 不再作为首页展示的门控——此前弱网下首页要白等远程图最多 6s
    bgReady: false
  }, sceneState(SCENES.UNBOUND)),

  onLoad(options = {}) {
    this.scanTimer = null // 模拟扫描的定时器句柄，离开页面时需清除
    // 背景/前景图加载标记：两张都 load(或 error) 后 bgReady=true 触发 OSS 背景淡入；
    // 兜底 6s 防止事件不触发时一直停在占位图（已不再门控首页内容展示）
    this.homeAssetLoaded = { bg: false, fg: false }
    this.bgReadyTimer = setTimeout(() => {
      this.bgReadyTimer = null
      if (!this.data.bgReady) {
        this.setData({ bgReady: true })
      }
    }, 6000)
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

      // 不再进首页就自动扫描重连：连接改为点设备卡片的「连接蓝牙」按钮按需连接当前选中设备
      // （见 connectCurrentDevice）；点「拍照/相册」只校验是否已连接。loadHomeState 仍用真实蓝牙会话显示「已连接」。
      this.loadHomeState()
    }
  },

  // 登录后拉取真实头像，没有头像时回退默认图；未登录则只展示默认图。
  // 头像几乎不变：优先用会话内已有的 globalData.userInfo（登录/个人资料页保存都会同步它），
  // 仅会话内还没拉到过用户信息时才请求一次——此前每次切 tab/返回首页都白拉一遍 getUserProfile。
  async loadUserAvatar() {
    if (!app.globalData.token && !wx.getStorageSync('token')) {
      this.setData({
        avatarUrl: DEFAULT_AVATAR
      })
      return
    }

    const cachedUser = app.globalData.userInfo
    if (cachedUser && cachedUser.avatarUrl) {
      if (this.data.avatarUrl !== cachedUser.avatarUrl) {
        this.setData({ avatarUrl: cachedUser.avatarUrl })
      }
      return
    }
    // 拉过一次但用户确实没设头像：本次会话不再反复拉（失败时不置位，下次 onShow 重试）
    if (this._avatarFetched) {
      return
    }

    try {
      const userInfo = await api.getUserProfile()
      this._avatarFetched = true
      // 同步回全局，其它页面（个人资料等）也能复用，不必再各拉一遍
      if (userInfo && (app.globalData.userInfo || userInfo.avatarUrl)) {
        app.globalData.userInfo = Object.assign({}, app.globalData.userInfo, userInfo)
      }
      this.setData({
        avatarUrl: userInfo.avatarUrl || DEFAULT_AVATAR
      })
    } catch (error) {
      // 拉取失败保持当前/默认头像，不打断首页
    }
  },

  onUnload() {
    this.clearScanTimer()
    if (this.bgReadyTimer) {
      clearTimeout(this.bgReadyTimer)
      this.bgReadyTimer = null
    }

    if (wx.offNetworkStatusChange && this.networkStatusHandler) {
      wx.offNetworkStatusChange(this.networkStatusHandler)
    }
  },

  // 背景图/前景图任一 load 完成的回调：两张都就绪后放行首页（关闭 loading 门控）。
  onHomeAssetLoaded(e) {
    const key = (e && e.currentTarget && e.currentTarget.dataset.asset) || ''
    if (!this.homeAssetLoaded) {
      this.homeAssetLoaded = { bg: false, fg: false }
    }
    if (key) {
      this.homeAssetLoaded[key] = true
    }
    if (
      this.homeAssetLoaded.bg &&
      this.homeAssetLoaded.fg &&
      !this.data.bgReady
    ) {
      if (this.bgReadyTimer) {
        clearTimeout(this.bgReadyTimer)
        this.bgReadyTimer = null
      }
      this.setData({ bgReady: true })
    }
  },

  // 背景图/前景图加载失败：也按「已就绪」放行，避免网络异常时首页一直卡在 loading。
  onHomeAssetError(e) {
    this.onHomeAssetLoaded(e)
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
        hasDevice: false
      })
      this.setScene(SCENES.UNBOUND, {
        hasDevice: false
      })
      return
    }

    try {
      // 登录页过渡 loading 期间预取的设备列表（一次性消费）：登录成功进首页即整页渲染，
      // 不再重复等一次接口；无预取（正常进入/下拉刷新等）照旧实时拉取
      const prefetched = app.globalData.prefetchedDevices
      app.globalData.prefetchedDevices = null
      const devices = prefetched || await api.getDevices()
      const cached = app.globalData.selectedDevice

      // 同一台相框可能被重复绑定出多条记录：按硬件序列号去重，避免轮播重复出现同一台
      const uniqueDevices = this.dedupeDevices(devices, cached)
      // 后端不存 BLE deviceId，只有 selectedDevice(自动重连/手动连上时写入)带着它。把它回填到
      // 列表里对应的那台（id 或序列号匹配），连接状态才判得对——否则即便蓝牙仍连着，列表项因缺
      // deviceId 也会被 normalizeDevice 错判成「未连接」（之前轮播卡片就是这么一直显示未连接的）。
      const mergedDevices = uniqueDevices.map(item => {
        // 后端记录主键不同或完整 6 字节设备 ID 不同就不得合并；广播短 ID 不参与状态合并。
        const sameAsCached = !!cached && activeDevice.devicesMatch(item, cached)
        if (!sameAsCached) {
          return item
        }
        return activeDevice.inheritStableIdentity(
          Object.assign({}, item, {
            deviceId: item.deviceId || cached.deviceId,
            bleDeviceId: item.bleDeviceId || cached.bleDeviceId || cached.deviceId,
            battery:
              batteryUtil.normalizeBattery(item.battery) === null
                ? cached.battery
                : item.battery,
            batteryAt: item.batteryAt || cached.batteryAt || null
          }),
          cached
        )
      })

      // 整组裁决保证一条活动会话最多只归属一张设备卡，并清除未通过完整身份校验的旧 BLE 句柄。
      const normalizedList = activeDevice.reconcileConnectionFlags(
        mergedDevices.map(normalizeDevice).filter(Boolean)
      ).map(item => Object.assign({}, item, {
        batteryText: batteryUtil.batteryText(item),
        batteryIcon: batteryUtil.batteryIconOf(item)
      }))
      const hasRealDevice = normalizedList.length > 0
      const list = hasRealDevice ? normalizedList : [DEFAULT_DEVICE]

      // 轮播优先把「已连接」设备放到可视区域：初始页定位到已连接设备；没有已连接的，
      // 再沿用上次选中的设备，最后兜底第一台。
      const cachedId = cached ? String(cached.id) : ''
      const connectedIndex = list.findIndex(item => item.connected)
      const cachedIndex = list.findIndex(item =>
        (cachedId && String(item.id) === cachedId) ||
        activeDevice.devicesMatch(item, cached)
      )
      const currentDeviceIndex = connectedIndex >= 0 ? connectedIndex : Math.max(0, cachedIndex)
      const currentDevice = list[currentDeviceIndex] || DEFAULT_DEVICE

      // 把当前展示设备设为选中设备（带真实 deviceId），供投屏/拍照沿用，避免可视卡片与投屏目标不一致
      if (hasRealDevice && currentDevice && currentDevice.id) {
        app.setSelectedDevice(mergedDevices[currentDeviceIndex] || currentDevice)
      }

      this.setData({
        currentDevice,
        deviceList: list,
        currentDeviceIndex,
        hasDevice: hasRealDevice
      })

      this.setScene(hasRealDevice ? SCENES.BOUND : SCENES.UNBOUND, {
        hasDevice: hasRealDevice
      })
      // 页面先展示缓存；15 秒内直接复用，超窗再后台读 0x04，失败保留旧值。
      await this.refreshConnectedBattery()
    } catch (error) {
      if (isNetworkError(error)) {
        this.showOfflineMode()
        return
      }

      this.setData({
        currentDevice: DEFAULT_DEVICE,
        hasDevice: false
      })
      this.setScene(SCENES.UNBOUND, {
        hasDevice: false
      })
    }
  },

  async refreshConnectedBattery() {
    const list = this.data.deviceList || []
    const target = list.find(item => item && item.connected)
    const deviceId = target && activeDevice.findConnectedDeviceId(target)
    if (!target || !deviceId) {
      return
    }
    const token = (this._batteryReadToken || 0) + 1
    this._batteryReadToken = token
    const batteryState = await batteryUtil.readLatestBattery(deviceId, {
      fallback: target
    })
    if (this._batteryReadToken !== token) {
      return
    }

    const latestList = (this.data.deviceList || []).slice()
    const index = latestList.findIndex(item =>
      item && (
        item.deviceId === deviceId ||
        activeDevice.devicesMatch(item, target)
      )
    )
    if (index < 0) {
      return
    }
    const updated = Object.assign({}, latestList[index], batteryState)
    Object.assign(updated, {
      batteryText: batteryUtil.batteryText(updated),
      batteryIcon: batteryUtil.batteryIconOf(updated)
    })
    latestList[index] = updated
    this.setData({
      deviceList: latestList,
      currentDevice:
        index === this.data.currentDeviceIndex
          ? updated
          : this.data.currentDevice
    })
    if (
      app.globalData.selectedDevice &&
      activeDevice.devicesMatch(updated, app.globalData.selectedDevice)
    ) {
      app.setSelectedDevice(
        Object.assign({}, app.globalData.selectedDevice, updated)
      )
    }
  },

  // 设备硬件序列号(Device_ID)：跨扫描会话稳定，用于去重 / 匹配同一台物理设备。
  // 归一化（去分隔符 + 大写）以兼容后端与蓝牙广播两侧可能的格式差异。
  deviceSerial(device) {
    return String((device && (device.deviceNo || device.productDeviceId)) || '')
      .replace(/[:\-\s]/g, '')
      .toUpperCase()
  },

  // 按硬件序列号去重：同一台设备的多条绑定记录只保留一条；同序列号优先保留当前选中那条。
  // 没有序列号的记录用 id 兜底单独成键，避免把不同设备误并到一起。
  dedupeDevices(devices, selected) {
    const selectedId = selected ? String(selected.id) : ''
    const map = new Map()
    const order = []
    ;(devices || []).forEach(device => {
      const serial = this.deviceSerial(device)
      const key = serial ? `sn:${serial}` : `id:${device.id}`
      if (!map.has(key)) {
        map.set(key, device)
        order.push(key)
      } else if (selectedId && String(device.id) === selectedId) {
        map.set(key, device)
      }
    })
    return order.map(key => map.get(key))
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

    this.setData(
      Object.assign(
        {
          scene,
          navTitle: getNavigationTitle(scene)
        },
        sceneState(scene),
        {
          hasDevice: nextHasDevice,
          // 场景已落定即关闭首屏 loading（含游客/已绑定/未绑定/离线/调试场景），不再展示 loading 占位
          pageLoading: false
        },
        extra
      )
    )
  },

  clearScanTimer() {
    if (this.scanTimer) {
      clearTimeout(this.scanTimer)
      this.scanTimer = null
    }
  },

  showBindNowSheet() {
    if (!app.requireLogin()) {
      return
    }
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

  // 关闭底部弹层统一入口：先标记 sheetClosing 播放退场动画，延时后再切场景卸载弹层，避免瞬间消失
  closeSheetWithAnim(targetScene) {
    if (this.data.sheetClosing) {
      return
    }
    this.setData({ sheetClosing: true })
    setTimeout(() => {
      this.setData({ sheetClosing: false })
      this.setScene(targetScene)
    }, 240)
  },

  closeHomeSheet() {
    this.closeSheetWithAnim(this.data.hasDevice ? SCENES.BOUND : SCENES.UNBOUND)
  },

  closeOfflineMode() {
    this.closeSheetWithAnim(this.data.hasDevice ? SCENES.BOUND : SCENES.UNBOUND)
  },

  confirmPrompt() {
    this.startBindingScan()
  },

  startBindingScan() {
    if (!app.requireLogin()) {
      return
    }
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
    this.closeSheetWithAnim(SCENES.BINDING_NO_DEVICE)
  },

  selectNearbyDevice(event) {
    const id = event.currentTarget.dataset.id
    this.setData({
      nearbyDevices: this.data.nearbyDevices.map(item =>
        Object.assign({}, item, {
          selected: item.id === id
        })
      )
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
      currentDevice: device
    })
  },

  // 点击设备轮播卡片：进入设备列表页。
  // 轮播卡片面积大易被快速连点，连点会触发两次 navigateTo，
  // 第二次路由找不到首次正在切换的 webview 即报 “routeDone with a webviewId X is not found”，
  // 故加锁：路由完成（complete）前忽略后续点击。
  goDeviceList() {
    if (this.navigatingDeviceList) {
      return
    }
    this.navigatingDeviceList = true
    wx.navigateTo({
      url: '/subpackages/device/list/list',
      complete: () => {
        this.navigatingDeviceList = false
      }
    })
  },

  // 点击「拍照」入口：登录/绑定/连接校验通过后，直接调起相机（不再弹「拍照/相册」二选一层）。
  async tapCameraEntry() {
    if (!(await this.ensureCanProject())) {
      return
    }
    this.chooseCamera()
  },

  // 点击「相册」入口：校验通过后直接调起相册选择（不再弹「拍照/相册」二选一层）。
  async tapAlbumEntry() {
    if (!(await this.ensureCanProject())) {
      return
    }
    this.chooseAlbum()
  },

  // 拍照/相册前的统一校验：未登录先跳登录；未绑定先引导绑定；当前选中设备未连接则先自动扫描连接
  // （与设备卡片「连接蓝牙」按钮同一套流程，连不上由 connectCurrentDevice 按标准规则提示）。
  // 任一不满足返回 false，调用方不再继续。
  async ensureCanProject() {
    if (!app.requireLogin()) {
      return false
    }
    if (!this.data.isBoundHome) {
      this.showBindNowSheet()
      return false
    }
    if (!this.isCurrentDeviceConnected()) {
      return this.connectCurrentDevice()
    }
    return true
  },

  // 当前展示选中的设备是否已建立真实蓝牙会话（拍照/相册前据此判断是否需要先连接）。
  // deviceId 直连 + 序列号交叉匹配：切页面后 selectedDevice 可能丢 deviceId，但会话还活着就算已连接
  isCurrentDeviceConnected() {
    const selected = app.globalData.selectedDevice || this.data.currentDevice
    return !!activeDevice.findConnectedDeviceId(selected)
  },

  // 设备卡片「连接蓝牙」按钮（投屏入口未连接时也走这里）：扫描匹配当前展示选中的设备并连接，
  // 连上后把卡片标记「已连接」，返回 true；连不上(权限/蓝牙/扫描不到/连接失败)只提示不切场景，返回 false。
  // 与列表页一致——BLE deviceId 是本次扫描会话临时分配的，后端只存序列号，必须先重扫拿到有效 deviceId 再连。
  async connectCurrentDevice() {
    if (!app.requireLogin()) {
      return false
    }
    const selected = app.globalData.selectedDevice || this.data.currentDevice
    try {
      // 扫描+匹配+连接主链已收敛到 active-device.connectBoundDevice（首页/列表/详情共用一份，改一处全生效）。
      // 首页沿用默认匹配器(纯序列号，不按名称——同型号广播名相同易连错别人的相框)、复用活动会话不做活性校验。
      const res = await activeDevice.connectBoundDevice(selected)
      this.markCurrentDeviceConnected(res.deviceId, res.info)
      // 连接成功不再弹提示（卡片已切「已连接」态即为反馈）；仅连接失败时提示。
      return true
    } catch (error) {
      // 系统级「附近设备」权限被拒：引导去系统设置；其余原因 toast 提示，停留在已绑定首页
      activeDevice.showConnectError(error)
      return false
    }
  },

  // 把首页当前展示的设备标记为「已连接」，回填本次会话有效的 deviceId（及可选的实时信息），
  // 并设为全局选中设备(保留 deviceNo 等后端字段)，供投屏页复用同一条 BLE 会话。
  markCurrentDeviceConnected(deviceId, info) {
    const index = this.data.currentDeviceIndex
    const list = this.data.deviceList.slice()
    const current = list[index] || this.data.currentDevice
    if (!current) {
      return
    }
    // 连接成功优先采用本次/15 秒缓存电量；读失败时保留卡片最近一次有效值。
    const batteryState =
      info && batteryUtil.normalizeBattery(info.battery) !== null
        ? batteryUtil.stampBattery(info.battery)
        : null
    const updated = activeDevice.applyConnectedIdentity(
      Object.assign({}, current, batteryState),
      deviceId,
      info
    )
    Object.assign(updated, {
      batteryText: batteryUtil.batteryText(updated),
      batteryIcon: batteryUtil.batteryIconOf(updated)
    })
    list[index] = updated
    // 整个轮播列表按真实会话重算连接态，而不是只刷当前这一张卡：单连接下连 B 会先释放 A 的会话
    // （device-ble.disconnectOthers），只改当前卡的话，轮播滑回 A 时它仍显示「已连接」。
    // 电量文案/图标依赖 connected（未连接一律 '--'），所以必须在重算之后再算一遍。
    const reconciled = activeDevice.reconcileConnectionFlags(list).map(item =>
      Object.assign({}, item, {
        batteryText: batteryUtil.batteryText(item),
        batteryIcon: batteryUtil.batteryIconOf(item)
      })
    )
    this.setData({
      deviceList: reconciled,
      currentDevice: reconciled[index] || updated,
      currentDeviceIndex: index
    })
    // 合并到选中设备：以 selectedDevice 为底(带 deviceNo/序列号)，叠加最新连接态与 deviceId
    app.setSelectedDevice(Object.assign({}, app.globalData.selectedDevice || {}, updated, {
      bleDeviceId: deviceId
    }))
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
      toast.warn({
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
      toast.warn({
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
      toast.show({
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
      toast.warn({
        title: '头像更新失败',
        icon: 'none'
      })
    }
  },

  noop() {}
})
