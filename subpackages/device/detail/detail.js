const api = require('../../../utils/api')
const toast = require('../../../utils/toast')
const system = require('../../../utils/system')
const batteryUtil = require('../../../utils/battery')
const deviceBle = require('../../../utils/device-ble')
const protocol = require('../../../utils/frame-protocol')
const media = require('../../../utils/media')
const bluetooth = require('../../../utils/bluetooth')
const permission = require('../../../utils/permission')

const app = getApp()

// 计算设备存储使用百分比（已用/总量），上限 100，用于进度条展示
function memoryPercent(device) {
  if (!device || !device.totalMemory) {
    return 0
  }
  return Math.min(
    100,
    Math.round((device.usedMemory / device.totalMemory) * 100)
  )
}

function getPlaybackLabel(device) {
  if (
    !device ||
    device.playbackMode === 'manual' ||
    device.carouselEnabled === false
  ) {
    return '已关闭'
  }
  return device.playbackMode === 'random' ? '随机轮播' : '顺序轮播'
}

Page({
  data: {
    statusBarHeight: 20,
    safeBottom: 0,
    id: '',
    device: null,
    memoryPercent: 0,
    batteryIcon: batteryUtil.getBatteryIcon(batteryUtil.DEFAULT_BATTERY),
    deviceCode: '',
    memoryText: '',
    macAddress: '',
    newVersionNo: '--',
    batteryText: '--',
    playbackLabel: '',
    intervalOptions: [1, 2, 4, 8, 24],
    intervalIndex: 1,
    showClearConfirm: false,
    showDeleteConfirm: false,
    clearClosing: false, // 清空确认弹窗是否正在播放退场动画
    deleteClosing: false, // 删除确认弹窗是否正在播放退场动画
    showMediaSheet: false, // 「拍照/相册」选择弹层是否展示
    mediaSheetClosing: false, // 选择弹层是否正在播放退场动画
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
    this.loadDetail()
  },

  noop() {},

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
      url: '/subpackages/device/list/list'
    })
  },

  // 拉取设备详情并派生出页面展示字段（含轮播间隔下标、设备编号、内存文案等）
  // 接口失败时不再让 device 悬空：标记 loadError 走统一空态，提供「重新加载」入口
  async loadDetail() {
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

    if (selected && String(selected.id) === String(device && device.id)) {
      device = Object.assign({}, device, {
        deviceId: device.deviceId || selected.deviceId,
        bleDeviceId:
          device.bleDeviceId || selected.bleDeviceId || selected.deviceId,
        battery:
          typeof device.battery === 'number' ? device.battery : selected.battery
      })
    }

    if (device && device.deviceId && deviceBle.isConnected(device.deviceId)) {
      try {
        const info = await deviceBle.readDeviceInfo(device.deviceId)
        device = Object.assign({}, device, {
          connected: true,
          battery: info.battery,
          usedMemory: info.imgCount,
          totalMemory: info.capacity,
          playbackMode: info.playMode,
          intervalSeconds: info.intervalSeconds,
          intervalHours: info.intervalSeconds
            ? Math.max(1, Math.round(info.intervalSeconds / 3600))
            : device.intervalHours,
          newVersionNo: info.newVersionNo || device.newVersionNo
        })
      } catch (error) {
        // 详情展示不因刷新蓝牙状态失败而中断。
      }
    }
    // 把当前间隔小时数映射到选择器下标，缺省落到第 1 项（2 小时）
    const intervalIndex = this.data.intervalOptions.indexOf(
      device ? device.intervalHours : 2
    )
    // 设备编号取末 6 位数字作为展示码；真实数据缺失时用 -- 占位（不再用假的 123456）
    const digitId =
      device && device.deviceNo
        ? String(device.deviceNo).replace(/\D/g, '').slice(-6)
        : ''
    const hasBattery = device && typeof device.battery === 'number'

    this.setData({
      device,
      memoryPercent: memoryPercent(device),
      batteryIcon: batteryUtil.getBatteryIcon(
        hasBattery ? device.battery : batteryUtil.DEFAULT_BATTERY
      ),
      batteryText: hasBattery ? `${device.battery}%` : '--',
      deviceCode: digitId || '--',
      memoryText:
        device && device.totalMemory
          ? `${device.usedMemory}/${device.totalMemory}`
          : '--',
      macAddress: device && device.macAddress ? device.macAddress : '--',
      newVersionNo: device && device.newVersionNo ? device.newVersionNo : '--',
      playbackLabel: getPlaybackLabel(device),
      intervalIndex: intervalIndex > -1 ? intervalIndex : 1,
      loading: false,
      loadError: false
    })
  },

  // 通过可输入的系统弹窗重命名设备，重命名后若是当前选中设备需同步更新全局
  async renameDevice() {
    if (!this.data.device) {
      return
    }

    wx.showModal({
      title: '编辑设备名称',
      editable: true,
      placeholderText: '请输入设备名称',
      content: this.data.device.name,
      success: async res => {
        if (!res.confirm || !res.content.trim()) {
          return // 取消或输入为空则不处理
        }

        const device = await api.renameDevice(this.data.id, res.content.trim())
        if (
          app.globalData.selectedDevice &&
          app.globalData.selectedDevice.id === device.id
        ) {
          app.setSelectedDevice(device)
        }
        this.setData({
          device,
          memoryPercent: memoryPercent(device)
        })
      }
    })
  },

  async toggleCarousel(e) {
    if (!this.data.device) {
      return
    }

    const currentMode =
      this.data.device.playbackMode === 'manual'
        ? 'order'
        : this.data.device.playbackMode
    await this.applyPlayback(
      e.detail.value ? currentMode || 'order' : 'manual',
      this.data.device.intervalHours,
      e.detail.value
    )
  },

  // 切换播放模式：单选值 '0' 为顺序，其余为随机
  async changePlayback(e) {
    if (!this.data.device) {
      return
    }

    const mode = e.detail.value === '0' ? 'order' : 'random'
    await this.applyPlayback(mode, this.data.device.intervalHours, true)
  },

  // 切换轮播间隔：picker 返回的是 intervalOptions 的下标，需转换为实际小时数
  async changeInterval(e) {
    if (!this.data.device) {
      return
    }

    const intervalHours = this.data.intervalOptions[Number(e.detail.value)]
    await this.applyPlayback(
      this.data.device.playbackMode || 'order',
      intervalHours,
      this.data.device.carouselEnabled !== false
    )
  },

  async applyPlayback(mode, intervalHours, carouselEnabled) {
    const device = this.data.device
    if (!device || !device.deviceId) {
      toast.show({
        title: '请先连接设备',
        icon: 'none'
      })
      return
    }

    const hours = Number(intervalHours) || 2
    const intervalSeconds = Math.max(1, Math.round(hours * 3600))

    wx.showLoading({ title: '保存中', mask: true })
    try {
      await deviceBle.setPlayback(device.deviceId, mode, intervalSeconds)
      const updated = Object.assign({}, device, {
        connected: true,
        playbackMode: mode,
        intervalSeconds,
        intervalHours: hours,
        carouselEnabled
      })
      const intervalIndex = this.data.intervalOptions.indexOf(hours)

      if (
        app.globalData.selectedDevice &&
        app.globalData.selectedDevice.id === updated.id
      ) {
        app.setSelectedDevice(updated)
      }

      this.setData({
        device: updated,
        playbackLabel: getPlaybackLabel(updated),
        intervalIndex:
          intervalIndex > -1 ? intervalIndex : this.data.intervalIndex
      })
      toast.show({ title: '已保存', icon: 'none' })
    } catch (error) {
      toast.show({
        title: error.message || '保存失败',
        icon: 'none'
      })
    } finally {
      wx.hideLoading()
    }
  },

  // 顶部「投屏」：要求设备已连接，弹出「拍照/相册」二选一，由用户选择投屏方式（与首页一致）。
  startProjection() {
    const device = this.data.device
    if (!device) {
      return
    }
    const bleId = device.deviceId || device.bleDeviceId
    if (!(bleId && deviceBle.isConnected(bleId))) {
      toast.show({ title: '请先连接设备', icon: 'none' })
      return
    }

    // 设为当前选中设备，预览/结果页据此连接并图传
    app.setSelectedDevice(device)
    this.setData({ showMediaSheet: true, mediaSheetClosing: false })
  },

  // 关闭「拍照/相册」选择弹层（带退场动画，与删除/清空确认弹窗一致）
  hideMediaSheet() {
    if (this.data.mediaSheetClosing) {
      return
    }
    this.setData({ mediaSheetClosing: true })
    setTimeout(() => {
      this.setData({ showMediaSheet: false, mediaSheetClosing: false })
    }, 220)
  },

  // 选「拍照」：调起相机拍一张后进入投屏
  chooseCamera() {
    this.pickAndProject(() => media.chooseFromCamera())
  },

  // 选「相册」：从相册选图后进入投屏
  chooseAlbum() {
    this.pickAndProject(() => media.chooseFromAlbum())
  },

  // 选图（拍照/相册）后跳投屏预览：用户取消选择不报错；选到图先关弹层再带数据跳转，
  // 避免弹层 flag 残留导致从预览返回详情页时弹层又冒出来。
  async pickAndProject(pickImages) {
    const device = this.data.device
    if (!device) {
      return
    }

    let images
    try {
      images = await pickImages()
    } catch (error) {
      if (error && error.errMsg && error.errMsg.indexOf('cancel') > -1) {
        return // 用户取消选择不算错误，保留弹层让其重新选择
      }
      toast.show({ title: '选择照片失败', icon: 'none' })
      return
    }
    if (!images || !images.length) {
      return
    }

    this.setData({ showMediaSheet: false, mediaSheetClosing: false })
    wx.setStorageSync('pendingProjection', { device, images })
    wx.navigateTo({
      url: '/subpackages/projection/preview/preview'
    })
  },

  // 顶部「连接 / 断开」：已连接则断开；未连接则重扫匹配本设备并连接（BLE deviceId 每次扫描会话才有效）。
  async toggleConnection() {
    const device = this.data.device
    if (!device) {
      return
    }

    if (device.connected) {
      if (device.deviceId) {
        deviceBle.disconnect(device.deviceId)
      }
      const updated = Object.assign({}, device, { connected: false })
      if (
        app.globalData.selectedDevice &&
        app.globalData.selectedDevice.id === updated.id
      ) {
        app.setSelectedDevice(updated)
      }
      this.setData({ device: updated })
      toast.show({ title: '已断开', icon: 'none' })
      return
    }

    wx.showLoading({ title: '搜索设备中', mask: true })
    try {
      const location = await permission.getCurrentLocation()
      if (!location) {
        throw new Error('请先授权定位后再连接')
      }
      await bluetooth.openAdapter()
      const found = await bluetooth.discoverDevices({ timeout: 6000 })
      const target = this.matchScannedDevice(found, device)
      if (!target) {
        throw new Error('未搜索到该设备，请确认设备已开机并在附近')
      }

      wx.showLoading({ title: '连接设备中', mask: true })
      await deviceBle.ensureConnection(target.deviceId)
      const info = await deviceBle.readDeviceInfo(target.deviceId)
      const updated = Object.assign({}, device, {
        deviceId: target.deviceId,
        bleDeviceId: target.deviceId,
        connected: true,
        battery: info.battery,
        usedMemory: info.imgCount,
        totalMemory: info.capacity,
        playbackMode: info.playMode,
        intervalSeconds: info.intervalSeconds,
        intervalHours: info.intervalSeconds
          ? Math.max(1, Math.round(info.intervalSeconds / 3600))
          : device.intervalHours,
        newVersionNo: info.newVersionNo || device.newVersionNo
      })
      app.setSelectedDevice(updated)

      const hasBattery = typeof updated.battery === 'number'
      this.setData({
        device: updated,
        memoryPercent: memoryPercent(updated),
        batteryIcon: batteryUtil.getBatteryIcon(
          hasBattery ? updated.battery : batteryUtil.DEFAULT_BATTERY
        ),
        batteryText: hasBattery ? `${updated.battery}%` : '--',
        memoryText: updated.totalMemory
          ? `${updated.usedMemory}/${updated.totalMemory}`
          : '--',
        playbackLabel: getPlaybackLabel(updated),
        newVersionNo: updated.newVersionNo || '--'
      })
      toast.show({ title: '已连接', icon: 'none' })
    } catch (error) {
      if (error && error.code === 'PERMISSION_DENIED') {
        bluetooth.showPermissionGuide()
      } else {
        toast.show({
          title: (error && error.message) || '连接失败',
          icon: 'none'
        })
      }
    } finally {
      wx.hideLoading()
    }
  },

  // 把后端设备(序列号/名称)与扫描结果匹配，返回带「本次会话有效 deviceId」的那条（序列号优先，名称兜底）。
  matchScannedDevice(found, device) {
    const list = found || []
    const serial = String(
      (device && (device.deviceNo || device.productDeviceId)) || ''
    ).trim()
    if (serial) {
      const bySerial = list.find(
        item => String(item.deviceNo || '').trim() === serial
      )
      if (bySerial) {
        return bySerial
      }
    }
    const name = String((device && device.name) || '').trim()
    if (name) {
      const byName = list.find(item => String(item.name || '').trim() === name)
      if (byName) {
        return byName
      }
    }
    return null
  },

  goSlideshow() {
    wx.navigateTo({
      url: `/subpackages/device/slideshow/slideshow?id=${this.data.id}`
    })
  },

  goOtaUpgrade() {
    wx.navigateTo({
      url: `/subpackages/device/ota/ota?id=${this.data.id}`
    })
  },

  // 长按「OTA升级」进入本地固件测试流程：用代码包内的测试 .bin 走真实 DFU（设备已连接）
  // 或干跑校验（未连接）。先把当前设备设为全局选中，OTA 页据此拿到 bleDeviceId。
  goOtaTest() {
    if (this.data.device) {
      app.setSelectedDevice(this.data.device)
    }
    wx.showModal({
      title: '本地固件测试',
      content:
        '将使用代码包内的测试固件进入 OTA 流程：设备已连接则执行真实蓝牙 DFU 升级，未连接则仅做干跑校验（不写设备）。是否继续？',
      confirmText: '进入测试',
      confirmColor: '#ff6a20',
      success: res => {
        if (res.confirm) {
          wx.navigateTo({
            url: `/subpackages/device/ota/ota?id=${this.data.id}&test=1`
          })
        }
      }
    })
  },

  showClearConfirm() {
    this.setData({
      showClearConfirm: true
    })
  },

  // 先播放退场动画再卸载，避免弹窗瞬间消失
  hideClearConfirm() {
    if (this.data.clearClosing) {
      return
    }
    this.setData({ clearClosing: true })
    setTimeout(() => {
      this.setData({ showClearConfirm: false, clearClosing: false })
    }, 220)
  },

  clearCopies() {
    this.showClearConfirm()
  },

  async confirmClearCopies() {
    if (!this.data.device) {
      return
    }

    if (!this.data.device.deviceId) {
      toast.show({
        title: '请先连接设备',
        icon: 'none'
      })
      return
    }

    wx.showLoading({ title: '清空中', mask: true })
    try {
      await deviceBle.ensureConnection(this.data.device.deviceId)
      const info = await deviceBle.readDeviceInfo(this.data.device.deviceId)
      const indexes = protocol.maskToIndexes(info.imgMask)

      if (indexes.length) {
        await deviceBle.deleteImage(this.data.device.deviceId, indexes)
      }

      await api.clearDevicePhotoCopies(this.data.id)
    } catch (error) {
      toast.show({
        title: error.message || '清空失败',
        icon: 'none'
      })
      wx.hideLoading()
      return
    }
    wx.hideLoading()
    this.hideClearConfirm() // 带退场动画关闭确认弹窗
    toast.show({
      title: '已清空',
      icon: 'none'
    })
    this.loadDetail()
  },

  showDeleteConfirm() {
    this.setData({
      showDeleteConfirm: true
    })
  },

  hideDeleteConfirm() {
    if (this.data.deleteClosing) {
      return
    }
    this.setData({ deleteClosing: true })
    setTimeout(() => {
      this.setData({ showDeleteConfirm: false, deleteClosing: false })
    }, 220)
  },

  // 删除设备：若删除的是当前选中设备，需清空全局选中状态
  async confirmDeleteDevice() {
    if (!this.data.device) {
      return
    }

    await api.deleteDevice(this.data.id)
    if (
      app.globalData.selectedDevice &&
      app.globalData.selectedDevice.id === this.data.id
    ) {
      app.setSelectedDevice(null)
    }
    toast.show({
      title: '已删除',
      icon: 'none'
    })
    setTimeout(() => wx.navigateBack(), 500)
  },

  formatDevice() {
    if (!this.data.device) {
      return
    }

    wx.showModal({
      title: '格式化设备',
      content: '格式化会删除设备上的照片数据，请确认是否继续。',
      confirmText: '格式化',
      confirmColor: '#c7372f',
      success: async res => {
        if (!res.confirm) {
          return
        }

        await api.formatDevice(this.data.id)
        toast.show({
          title: '格式化完成',
          icon: 'none'
        })
        this.loadDetail()
      }
    })
  }
})
