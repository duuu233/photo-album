const api = require('../../../utils/api')
const toast = require('../../../utils/toast')
const system = require('../../../utils/system')
const batteryUtil = require('../../../utils/battery')
const deviceBle = require('../../../utils/device-ble')
const bluetooth = require('../../../utils/bluetooth')
const permission = require('../../../utils/permission')
const autoConnect = require('../../../utils/auto-connect')

const app = getApp()

// 计算设备存储使用百分比，用于列表项进度条
function memoryPercent(device) {
  if (!device.totalMemory) {
    return 0
  }
  return Math.min(100, Math.round((device.usedMemory / device.totalMemory) * 100))
}

Page({
  data: {
    statusBarHeight: 20,
    safeBottom: 0,
    devices: [],
    selectedId: '',
    selectMode: false,
    loading: true
  },

  onLoad(options) {
    this.setSystemMetrics()
    // select=1 表示“选择设备”模式（从投屏等场景进入，点选即切换并返回）；否则为普通管理列表
    const selectMode = options.select === '1'
    this.setData({
      selectMode
    })
    // 自动重连成功后重新拉列表，刷新连接显示（保存同一引用便于订阅/退订且不重复）
    this._onAutoConnected = () => this.loadDevices()
  },

  onShow() {
    autoConnect.onChange(this._onAutoConnected)
    this.loadDevices()
    autoConnect.run() // 静默尝试自动连接相框
  },

  onUnload() {
    autoConnect.offChange(this._onAutoConnected)
  },

  // 加载设备列表，并为每项附加展示用字段（内存百分比、删除提示）
  async loadDevices() {
    this.setData({
      loading: true
    })
    const sourceDevices = await api.getDevices()
    const selected = app.globalData.selectedDevice
    const devices = sourceDevices.map(item => {
      const merged = (!selected || String(selected.id) !== String(item.id))
        ? item
        : Object.assign({}, item, {
            deviceId: item.deviceId || selected.deviceId,
            bleDeviceId: item.bleDeviceId || selected.bleDeviceId || selected.deviceId,
            battery: typeof item.battery === 'number' ? item.battery : selected.battery
          })
      // 用 App 当前真实的蓝牙会话状态覆盖后端的 connected：后端并不知道本机的蓝牙连接，
      // 若直接用它，切到别的页面再回到本页重新拉列表时，即使蓝牙仍连着也会被错显示成「未连接」。
      // 改用 deviceBle.isConnected 实时判断（与首页一致），切回来只要会话还在就保持「已连接」。
      const bleId = merged.deviceId || merged.bleDeviceId
      return Object.assign({}, merged, {
        connected: !!(bleId && deviceBle.isConnected(bleId))
      })
    })

    this.setData({
      // 先算内存百分比，再标记“可删除提示”仅显示在最后一个离线设备上（引导用户清理）
      devices: devices.map(item => Object.assign({}, item, {
        memoryPercent: memoryPercent(item),
        batteryIcon: batteryUtil.getBatteryIcon(item.battery),
        // 电量未知（蓝牙未读到）时不展示百分比，避免出现 null%
        batteryText: typeof item.battery === 'number' ? `${item.battery}%` : ''
      })).map((item, index, list) => Object.assign({}, item, {
        canDeleteHint: !item.connected && index === list.length - 1
      })),
      selectedId: selected ? selected.id : '',
      loading: false
    })
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

    wx.switchTab({
      url: '/pages/mine/mine'
    })
  },

  // 点击设备：选择模式下设为当前设备并返回；普通模式下进入设备详情
  selectDevice(e) {
    const id = e.currentTarget.dataset.id
    const device = this.data.devices.find(item => item.id === id)

    if (!device) {
      return
    }

    if (this.data.selectMode) {
      app.setSelectedDevice(device)
      toast.show({
        title: '已切换设备',
        icon: 'none'
      })
      setTimeout(() => wx.navigateBack(), 350)
      return
    }

    wx.navigateTo({
      url: `/subpackages/device/detail/detail?id=${id}`
    })
  },

  goBind() {
    wx.navigateTo({
      url: '/subpackages/device/bind/bind'
    })
  },

  goSlideshow(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({
      url: `/subpackages/device/slideshow/slideshow?id=${id}`
    })
  },

  async toggleConnection(e) {
    const id = e.currentTarget.dataset.id
    const device = this.data.devices.find(item => item.id === id)

    if (!device) {
      return
    }

    if (device.connected) {
      if (device.deviceId) {
        deviceBle.disconnect(device.deviceId)
      }
      this.setData({
        devices: this.data.devices.map(item => item.id === id ? Object.assign({}, item, {
          connected: false
        }) : item)
      })
      toast.show({ title: '已断开', icon: 'none' })
      return
    }

    // 微信 BLE deviceId 是「本次扫描会话」临时分配的，后端只存了序列号，没存它。
    // 所以列表页连接必须先重扫拿到当下有效的 deviceId，再连——直连存下来的 deviceId 必失败。
    wx.showLoading({ title: '搜索设备中', mask: true })
    try {
      const location = await permission.getCurrentLocation()
      if (!location) {
        throw new Error('请先授权定位后再连接')
      }
      await bluetooth.openAdapter()
      const found = await bluetooth.discoverDevices({ timeout: 6000 })

      // 用稳定标识匹配出这台设备：序列号(广播 Device_ID)优先，名称兜底
      const target = this.matchScannedDevice(found, device)
      if (!target) {
        throw new Error('未搜索到该设备，请确认设备已开机并在附近')
      }

      // 用本次扫描到的有效 deviceId 连接并读真实信息
      wx.showLoading({ title: '连接设备中', mask: true })
      await deviceBle.ensureConnection(target.deviceId)
      const info = await deviceBle.readDeviceInfo(target.deviceId)
      const updated = Object.assign({}, device, {
        deviceId: target.deviceId, // 刷新成本次会话有效的 deviceId，供后续断开/图传复用
        bleDeviceId: target.deviceId,
        connected: true,
        battery: info.battery,
        usedMemory: info.imgCount,
        totalMemory: info.capacity,
        playbackMode: info.playMode,
        intervalSeconds: info.intervalSeconds,
        intervalHours: info.intervalSeconds ? Math.max(1, Math.round(info.intervalSeconds / 3600)) : device.intervalHours,
        firmwareVersion: info.firmwareVersion || device.firmwareVersion
      })

      // 连接成功即设为当前选中设备：设备是单连接，「正连着的」就是当前在用的。
      // 这样切到别的页面再回来、或自动重连时，都能据 selectedDevice.deviceId 认出这条活动会话。
      app.setSelectedDevice(updated)

      this.setData({
        devices: this.data.devices.map(item => item.id === id ? Object.assign({}, updated, {
          memoryPercent: memoryPercent(updated),
          batteryIcon: batteryUtil.getBatteryIcon(updated.battery),
          batteryText: typeof updated.battery === 'number' ? `${updated.battery}%` : ''
        }) : item)
      })
      toast.show({ title: '已连接', icon: 'none' })
    } catch (error) {
      // 系统级「附近设备」权限被拒：弹引导去系统设置，而非笼统的「连接失败」
      if (error.code === 'PERMISSION_DENIED') {
        bluetooth.showPermissionGuide()
      } else {
        toast.show({
          title: error.message || '连接失败',
          icon: 'none'
        })
      }
    } finally {
      wx.hideLoading()
    }
  },

  // 把后端来的设备(只有序列号/名称)和扫描结果匹配，返回带「本次会话有效 deviceId」的那条。
  // 序列号(deviceNo，对应扫描侧广播里的 Device_ID)优先精确匹配；取不到再按设备名兜底
  // (discoverDevices 已按 RSSI 降序，同名时拿到的是信号最强的一台)。
  matchScannedDevice(found, device) {
    const list = found || []
    const serial = String(device.deviceNo || device.productDeviceId || '').trim()
    if (serial) {
      const bySerial = list.find(item => String(item.deviceNo || '').trim() === serial)
      if (bySerial) {
        return bySerial
      }
    }
    const name = String(device.name || '').trim()
    if (name) {
      const byName = list.find(item => String(item.name || '').trim() === name)
      if (byName) {
        return byName
      }
    }
    return null
  },

  renameDevice(e) {
    const id = e.currentTarget.dataset.id
    const device = this.data.devices.find(item => item.id === id)

    if (!device) {
      return
    }

    wx.showModal({
      title: '编辑设备名称',
      editable: true,
      placeholderText: '请输入设备名称',
      content: device.name,
      success: async res => {
        if (!res.confirm || !res.content.trim()) {
          return
        }

        const updated = await api.renameDevice(id, res.content.trim())
        if (app.globalData.selectedDevice && app.globalData.selectedDevice.id === updated.id) {
          app.setSelectedDevice(updated)
        }
        this.loadDevices()
      }
    })
  },

  deleteDevice(e) {
    const id = e.currentTarget.dataset.id

    wx.showModal({
      title: '删除设备',
      content: '删除后将解除与该相框设备的绑定。',
      confirmText: '删除',
      confirmColor: '#ff4d4f',
      success: async res => {
        if (!res.confirm) {
          return
        }

        await api.deleteDevice(id)
        if (app.globalData.selectedDevice && app.globalData.selectedDevice.id === id) {
          app.setSelectedDevice(null)
        }
        this.loadDevices()
      }
    })
  }
})
