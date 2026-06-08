const api = require('../../../utils/api')
const system = require('../../../utils/system')
const batteryUtil = require('../../../utils/battery')

const app = getApp()

// 计算设备存储使用百分比（已用/总量），上限 100，用于进度条展示
function memoryPercent(device) {
  if (!device || !device.totalMemory) {
    return 0
  }
  return Math.min(100, Math.round((device.usedMemory / device.totalMemory) * 100))
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
    firmwareVersion: '--',
    batteryText: '--',
    playbackLabel: '',
    intervalOptions: [1, 2, 4, 8, 24],
    intervalIndex: 1,
    showClearConfirm: false,
    showDeleteConfirm: false
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
  async loadDetail() {
    const device = await api.getDeviceDetail(this.data.id)
    // 把当前间隔小时数映射到选择器下标，缺省落到第 1 项（2 小时）
    const intervalIndex = this.data.intervalOptions.indexOf(device ? device.intervalHours : 2)
    // 设备编号取末 6 位数字作为展示码；真实数据缺失时用 -- 占位（不再用假的 123456）
    const digitId = device && device.deviceNo ? String(device.deviceNo).replace(/\D/g, '').slice(-6) : ''
    const hasBattery = device && typeof device.battery === 'number'

    this.setData({
      device,
      memoryPercent: memoryPercent(device),
      batteryIcon: batteryUtil.getBatteryIcon(hasBattery ? device.battery : batteryUtil.DEFAULT_BATTERY),
      batteryText: hasBattery ? `${device.battery}%` : '--',
      deviceCode: digitId || '--',
      memoryText: device && device.totalMemory ? `${device.usedMemory}/${device.totalMemory}` : '--',
      macAddress: device && device.macAddress ? device.macAddress : '--',
      firmwareVersion: device && device.firmwareVersion ? device.firmwareVersion : '--',
      playbackLabel: device && device.playbackMode === 'random' ? '随机轮播' : '顺序轮播',
      intervalIndex: intervalIndex > -1 ? intervalIndex : 1
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
        if (app.globalData.selectedDevice && app.globalData.selectedDevice.id === device.id) {
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

    const device = await api.updateDevicePlayback(this.data.id, {
      carouselEnabled: e.detail.value
    })
    this.setData({
      device
    })
  },

  // 切换播放模式：单选值 '0' 为顺序，其余为随机
  async changePlayback(e) {
    if (!this.data.device) {
      return
    }

    const mode = e.detail.value === '0' ? 'order' : 'random'
    const device = await api.updateDevicePlayback(this.data.id, {
      playbackMode: mode
    })
    this.setData({
      device
    })
  },

  // 切换轮播间隔：picker 返回的是 intervalOptions 的下标，需转换为实际小时数
  async changeInterval(e) {
    if (!this.data.device) {
      return
    }

    const intervalHours = this.data.intervalOptions[Number(e.detail.value)]
    const device = await api.updateDevicePlayback(this.data.id, {
      intervalHours
    })
    this.setData({
      device,
      intervalIndex: Number(e.detail.value)
    })
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

  showClearConfirm() {
    this.setData({
      showClearConfirm: true
    })
  },

  hideClearConfirm() {
    this.setData({
      showClearConfirm: false
    })
  },

  clearCopies() {
    this.showClearConfirm()
  },

  async confirmClearCopies() {
    if (!this.data.device) {
      return
    }

    await api.clearDevicePhotoCopies(this.data.id)
    this.setData({
      showClearConfirm: false
    })
    wx.showToast({
      title: '已清空',
      icon: 'success'
    })
    this.loadDetail()
  },

  showDeleteConfirm() {
    this.setData({
      showDeleteConfirm: true
    })
  },

  hideDeleteConfirm() {
    this.setData({
      showDeleteConfirm: false
    })
  },

  // 删除设备：若删除的是当前选中设备，需清空全局选中状态
  async confirmDeleteDevice() {
    if (!this.data.device) {
      return
    }

    await api.deleteDevice(this.data.id)
    if (app.globalData.selectedDevice && app.globalData.selectedDevice.id === this.data.id) {
      app.setSelectedDevice(null)
    }
    wx.showToast({
      title: '已删除',
      icon: 'success'
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
        wx.showToast({
          title: '格式化完成',
          icon: 'success'
        })
        this.loadDetail()
      }
    })
  }
})
