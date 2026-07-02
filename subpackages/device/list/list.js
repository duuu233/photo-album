const api = require('../../../utils/api')
const toast = require('../../../utils/toast')
const system = require('../../../utils/system')
const batteryUtil = require('../../../utils/battery')
const deviceBle = require('../../../utils/device-ble')
const bluetooth = require('../../../utils/bluetooth')
const permission = require('../../../utils/permission')

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
  },

  onShow() {
    // 不再在本页自动扫描重连：已建立的连接是 device-ble 里的全局会话，切到本页/返回都不会断，
    // loadDevices 用 deviceBle.isConnected 实时显示连接态即可。需要新连接时走列表项的「连接」按钮，
    // 或首页点拍照/相册时按需连接当前选中设备。
    this.loadDevices()
  },

  // 加载设备列表，并为每项附加展示用字段（内存百分比、删除提示）
  // 首屏渲染即 loading=true（见 data），等接口返回再决定展示列表还是空态，避免空态先闪一下；
  // 二次进入（如绑定后返回）已有内容，沿用旧列表直到新数据到位，不再回到 loading。
  async loadDevices() {
    let sourceDevices
    try {
      sourceDevices = await api.getDevices()
    } catch (error) {
      // 接口失败时 api 层已 toast 提示，这里仅结束 loading，落到空态
      this.setData({ loading: false })
      return
    }
    const selected = app.globalData.selectedDevice

    // 同一台相框可能被重复绑定出多条记录：按稳定的硬件序列号(Device_ID)去重，只保留一条，
    // 避免「设备页反复出现同一设备」。同序列号优先保留当前选中(正在用/已连接)的那条。
    const uniqueDevices = this.dedupeDevices(sourceDevices, selected)
    const selectedSerial = this.deviceSerial(selected)

    const devices = uniqueDevices.map(item => {
      // 选中设备的 BLE deviceId（连接用、后端不存）要回填到对应记录，连接状态才显示得对。
      // 用 id 或序列号匹配：绑定/重连后选中设备与列表项可能不同源，只靠 id 会漏配、错显示成「未连接」。
      const isSelected = !!selected && (
        String(selected.id) === String(item.id) ||
        (!!selectedSerial && this.deviceSerial(item) === selectedSerial)
      )
      const merged = !isSelected
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

  // 设备硬件序列号(Device_ID)：跨扫描会话稳定，用于去重 / 匹配同一台物理设备。
  // 归一化（去分隔符 + 大写）以兼容后端与蓝牙广播两侧可能的格式差异。
  deviceSerial(device) {
    return String((device && (device.deviceNo || device.productDeviceId)) || '')
      .replace(/[:\-\s]/g, '')
      .toUpperCase()
  },

  // 按硬件序列号去重：同一台设备的多条绑定记录只保留一条。
  // 同序列号默认保留先出现的；若其中有当前选中设备，则换成选中的那条（保住连接显示）。
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
        toast.warn({
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
    const device = this.data.devices.find(item => item.id === id)

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

        // 删除的是当前已连接的设备：解绑成功后顺手断开 BLE，释放被占用的单连接。
        // 否则设备会一直被这条会话占着、不再广播，删除后既搜不到也无法重新绑定连接。
        const selected = app.globalData.selectedDevice
        const bleId = (device && (device.deviceId || device.bleDeviceId)) ||
          (selected && String(selected.id) === String(id) ? (selected.deviceId || selected.bleDeviceId) : '')
        if (bleId && deviceBle.isConnected(bleId)) {
          deviceBle.disconnect(bleId)
        }

        if (selected && String(selected.id) === String(id)) {
          app.setSelectedDevice(null)
        }
        this.loadDevices()
      }
    })
  }
})
