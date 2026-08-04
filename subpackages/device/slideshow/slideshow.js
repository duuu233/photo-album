const api = require('../../../utils/api')
const toast = require('../../../utils/toast')
const system = require('../../../utils/system')
const deviceBle = require('../../../utils/device-ble')
const activeDevice = require('../../../utils/active-device')

const app = getApp()

// 从没读到过间隔时的兜底（秒）。后端 carouselInterval 单位是分钟、固件 0x10 收的是秒，
// 页面内一律按秒传递，只有这里才允许出现「小时」。
const DEFAULT_INTERVAL_SECONDS = 2 * 3600

Page({
  data: {
    statusBarHeight: 20,
    safeBottom: 0,
    id: '',
    device: null,
    carouselOn: false, // 是否已开启轮播：默认未开启；未开启时下方轮播方式不可选
    intervalOptions: [1, 2, 4, 8, 24],
    intervalIndex: 1,
    loading: true,
    loadError: false
  },

  onLoad(options) {
    this.setSystemMetrics()
    this.setData({
      id: options.id || ''
    })
  },

  onShow() {
    this.loadDevice()
  },

  setSystemMetrics() {
    this.setData(system.getLayoutMetrics())
  },

  goBack() {
    const pages = getCurrentPages()

    if (pages.length > 1) {
      wx.navigateBack()
      return
    }

    wx.navigateTo({
      url: `/subpackages/device/detail/detail?id=${this.data.id}`
    })
  },

  // 加载设备并把当前轮播间隔小时数映射为选择器下标（缺省落到第 1 项）
  // 接口失败时不再让 device 悬空：标记 loadError 走统一空态，提供「重新加载」入口
  async loadDevice() {
    if (!this.data.device) {
      this.setData({ loading: true, loadError: false })
    }

    let device
    try {
      device = await api.getDeviceDetail(this.data.id)
    } catch (error) {
      this.setData({
        loading: false,
        loadError: true
      })
      return
    }

    const selected = app.globalData.selectedDevice

    const isSelected = !!selected && activeDevice.devicesMatch(device, selected)
    if (isSelected) {
      device = Object.assign({}, device, {
        deviceId: device.deviceId || selected.deviceId,
        bleDeviceId: device.bleDeviceId || selected.bleDeviceId || selected.deviceId,
        // 复用连接时读到的真实播放设置（连接设备时已 setSelectedDevice 写入真实 playMode/间隔）
        playbackMode: selected.playbackMode || device.playbackMode,
        intervalSeconds: selected.intervalSeconds || device.intervalSeconds,
        intervalHours: selected.intervalHours || device.intervalHours
      })
    }
    // 详情接口可能不回完整硬件 ID，绑定刚完成时 userProductId 形态也可能不同；
    // 继承全局选中设备的稳定身份后再找 live session，避免明明连接 A 却误报“请先连接设备”。
    device = activeDevice.inheritStableIdentity(device, isSelected ? selected : null)

    const liveId = activeDevice.findConnectedDeviceId(device)
    device = Object.assign({}, device, {
      deviceId: liveId,
      bleDeviceId: liveId,
      connected: !!liveId
    })

    const intervalIndex = this.data.intervalOptions.indexOf(device ? device.intervalHours : 2)
    this.setData({
      device,
      carouselOn: this.computeCarouselOn(device),
      intervalIndex: intervalIndex > -1 ? intervalIndex : 1,
      loading: false,
      loadError: false
    })
  },

  // 是否已开启轮播：默认未开启。仅当设备已连接(真实蓝牙会话)且当前模式为顺序/随机时才视为已开启；
  // 未连接 / 手动模式 / 用户明确关过轮播(carouselEnabled=false) 都算未开启，
  // 与详情页 getPlaybackLabel 的「未启用」判定保持一致，避免详情页显示未启用、进来开关却是橙色。
  computeCarouselOn(device) {
    if (!activeDevice.isDeviceConnected(device)) {
      return false
    }
    if (device.carouselEnabled === false) {
      return false
    }
    return device.playbackMode === 'order' || device.playbackMode === 'random'
  },

  // 当前设备是否已建立真实蓝牙会话
  isDeviceConnected() {
    return activeDevice.isDeviceConnected(this.data.device)
  },

  // 开启/关闭轮播。开启前必须已连接设备：未连接则提示先连接并把开关还原为未开启。
  async toggleCarousel(e) {
    const turningOn = !!e.detail.value
    const device = this.data.device

    if (turningOn && !this.isDeviceConnected()) {
      toast.warn({ title: '请先连接电子纸设备', icon: 'none' })
      this.setData({ carouselOn: false }) // 还原开关：连接前不允许开启
      return
    }

    // 开启时沿用设备当前的顺序/随机模式，无则默认顺序；关闭走手动模式
    const mode = turningOn
      ? (device && device.playbackMode && device.playbackMode !== 'manual' ? device.playbackMode : 'order')
      : 'manual'
    // 只改模式；间隔以后端 carouselInterval（分钟→秒）为准，后端缺字段才回退设备读回值。
    const ok = await this.applyPlayback(
      mode,
      api.resolveCarouselIntervalSeconds(
        device,
        device && device.intervalSeconds
      ),
      turningOn
    )
    // 成功按目标态显示；失败还原到操作前的态
    this.setData({ carouselOn: ok ? turningOn : !turningOn })
  },

  // 切换轮播间隔：picker 返回下标，intervalOptions 是小时，转成秒后保存
  async changeInterval(e) {
    if (!this.data.carouselOn) {
      return
    }
    const intervalHours = this.data.intervalOptions[Number(e.detail.value)]
    await this.applyPlayback(
      this.data.device.playbackMode || 'order',
      Math.round(Number(intervalHours) * 3600),
      true
    )
  },

  // 切换播放模式（顺序/随机）。未开启轮播时不可选择，直接忽略。
  async changePlayback(e) {
    if (!this.data.carouselOn) {
      return
    }
    // 同 toggleCarousel：只改模式，轮播间隔以后端 carouselInterval 为准。
    await this.applyPlayback(
      e.currentTarget.dataset.mode,
      api.resolveCarouselIntervalSeconds(
        this.data.device,
        this.data.device.intervalSeconds
      ),
      true
    )
  },

  // 下发播放设置到设备。成功返回 true，失败/未连接返回 false（供开关判断是否还原）。
  // intervalSeconds 单位为秒（后端 carouselInterval 的分钟已在 api.js 换算），传空才回落默认 2 小时。
  async applyPlayback(mode, intervalSeconds, carouselEnabled) {
    const device = this.data.device
    if (!device) {
      return false
    }
    // 操作前先确保已连接：断联则自动重连(扫描+连接)，连不上再提示「请先连接设备」。
    const deviceId = await activeDevice.ensureConnectedForAction(device)
    if (!deviceId) {
      return false
    }

    const seconds = Math.max(
      1,
      Math.round(Number(intervalSeconds) || DEFAULT_INTERVAL_SECONDS)
    )

    wx.showLoading({ title: '保存中', mask: true })
    try {
      await deviceBle.setPlayback(deviceId, mode, seconds)
      const updated = Object.assign({}, device, {
        deviceId,
        bleDeviceId: deviceId,
        connected: true,
        playbackMode: mode,
        intervalSeconds: seconds,
        intervalHours: seconds / 3600,
        carouselEnabled
      })
      const intervalIndex = this.data.intervalOptions.indexOf(seconds / 3600)

      if (app.globalData.selectedDevice && app.globalData.selectedDevice.id === updated.id) {
        app.setSelectedDevice(updated)
      }

      this.setData({
        device: updated,
        intervalIndex: intervalIndex > -1 ? intervalIndex : this.data.intervalIndex
      })
      // 轮播设置保存成功不再弹提示（界面已刷新即为反馈）；仅保存失败时提示。
      return true
    } catch (error) {
      toast.warn({
        title: error.message || '保存失败',
        icon: 'none'
      })
      return false
    } finally {
      wx.hideLoading()
    }
  }
})
