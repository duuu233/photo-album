const api = require('../../../utils/api')
const toast = require('../../../utils/toast')
const system = require('../../../utils/system')
const batteryUtil = require('../../../utils/battery')
const deviceBle = require('../../../utils/device-ble')
const media = require('../../../utils/media')
const activeDevice = require('../../../utils/active-device')
const deviceName = require('../../../utils/device-name')

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
    loading: true,
    loadError: false, // 接口失败标记：走「加载失败+重新加载」，不再伪装成「暂无设备」
    showMediaSheet: false, // 「拍照/相册」选择弹层是否展示（点某台设备的「投屏」后弹出）
    mediaSheetClosing: false // 选择弹层是否正在播放退场动画
  },

  noop() {},

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
    // 保留列表结构，但 onShow 一开始就撤掉上次读数，接口期间不展示缓存电量。
    this.clearDisplayedBattery()
    let sourceDevices
    try {
      sourceDevices = await api.getDevices()
    } catch (error) {
      // 接口失败时 api 层已 toast 提示；已有列表内容就沿用旧内容（静默失败），
      // 首次加载失败才标记 loadError 展示「加载失败+重新加载」——落到「暂无设备」
      // 会让用户误以为设备被解绑了，且没有任何重试手段
      this.setData({ loading: false, loadError: !this.data.devices.length })
      await this.refreshConnectedBattery()
      return
    }
    const selected = app.globalData.selectedDevice

    // 同一台相框可能被重复绑定出多条记录：按稳定的硬件序列号(Device_ID)去重，只保留一条，
    // 避免「设备页反复出现同一设备」。同序列号优先保留当前选中(正在用/已连接)的那条。
    const uniqueDevices = this.dedupeDevices(sourceDevices, selected)
    const devices = uniqueDevices.map(item => {
      // 选中设备的 BLE deviceId（连接用、后端不存）要回填到对应记录，连接状态才显示得对。
      // 用 id 或序列号匹配：绑定/重连后选中设备与列表项可能不同源，只靠 id 会漏配、错显示成「未连接」。
      // 后端记录主键/完整设备 ID 优先，避免同尺寸设备因广播短 ID 相同而合并状态。
      const isSelected = !!selected && activeDevice.devicesMatch(item, selected)
      const merged = !isSelected
        ? Object.assign({}, item, { battery: null, batteryAt: null })
        : Object.assign(
            {},
            item,
            {
              deviceId: item.deviceId || selected.deviceId,
              bleDeviceId: item.bleDeviceId || selected.bleDeviceId || selected.deviceId,
              // 列表每次展示都先清旧值，收尾再对活动会话真实发送一次 0x04。
              battery: null,
              batteryAt: null
            }
          )
      // 用 App 当前真实的蓝牙会话状态覆盖后端的 connected：后端并不知道本机的蓝牙连接。
      // 判连接用「deviceId 直连 + 设备ID×广播ID 序列号交叉匹配」（findConnectedDeviceId）：
      // 接口重拉的记录常不带 BLE deviceId，只按 deviceId 判断会把还连着的设备错显示成「未连接」；
      // 交叉匹配命中后把当下有效 deviceId 回填给列表项，断开/投屏按钮才有正确的 deviceId 可用。
      const liveId = activeDevice.findConnectedDeviceId(merged)
      return Object.assign({}, merged, {
        deviceId: liveId || merged.deviceId,
        bleDeviceId: liveId || merged.bleDeviceId,
        connected: !!liveId
      })
    })

    this.setData({
      // 先算内存百分比，再标记“可删除提示”仅显示在最后一个离线设备上（引导用户清理）
      devices: devices.map(item => Object.assign({}, item, {
        memoryPercent: memoryPercent(item),
        // 电量文案/图标先置未知，下面 refreshConnectedBattery 的本次 0x04 返回后再更新。
        batteryIcon: batteryUtil.batteryIconOf(item),
        batteryText: batteryUtil.batteryText(item)
      })).map((item, index, list) => Object.assign({}, item, {
        canDeleteHint: !item.connected && index === list.length - 1
      })),
      selectedId: selected ? selected.id : '',
      loading: false,
      loadError: false
    })
    await this.refreshConnectedBattery()
  },

  clearDisplayedBattery() {
    const devices = (this.data.devices || []).map(item => {
      const cleared = Object.assign({}, item, batteryUtil.stampBattery(null))
      return Object.assign(cleared, {
        batteryIcon: batteryUtil.batteryIconOf(cleared),
        batteryText: batteryUtil.batteryText(cleared)
      })
    })
    this.setData({ devices })
  },

  async refreshConnectedBattery() {
    const target = (this.data.devices || []).find(item => item && item.connected)
    const deviceId = target && activeDevice.findConnectedDeviceId(target)
    if (!target || !deviceId) {
      return
    }
    const token = (this._batteryReadToken || 0) + 1
    this._batteryReadToken = token
    const batteryState = await batteryUtil.readLatestBattery(deviceId)
    if (this._batteryReadToken !== token) {
      return
    }

    const devices = (this.data.devices || []).map(item => {
      if (
        !item ||
        !(item.deviceId === deviceId || activeDevice.devicesMatch(item, target))
      ) {
        return item
      }
      const updated = Object.assign({}, item, batteryState)
      return Object.assign(updated, {
        batteryIcon: batteryUtil.batteryIconOf(updated),
        batteryText: batteryUtil.batteryText(updated)
      })
    })
    this.setData({ devices })
  },

  // 失败态「重新加载」：先回到 loading 转圈（即时反馈），再走一遍正常加载
  retryLoad() {
    this.setData({ loading: true, loadError: false })
    this.loadDevices()
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

  // 某台设备的「投屏」：交互与设备详情页的「投屏」完全一致——先确保这台设备已连接
  // （未连接则自动扫描匹配并连接，连不上按标准规则提示），
  // 再弹出「拍照/相册」二选一，由用户选择投屏方式后进入投屏预览页。
  async startProjection(e) {
    const id = e.currentTarget.dataset.id
    let device = this.data.devices.find(item => item.id === id)
    if (!device) {
      return
    }
    const bleId = device.deviceId || device.bleDeviceId
    if (!(bleId && deviceBle.isConnected(bleId))) {
      device = await this.connectDevice(device)
      if (!device) {
        return // 连接失败，提示已由 connectDevice 弹出
      }
    }

    // 设为当前选中设备，预览/结果页据此连接并图传；记住本次投屏的设备供选图后使用
    app.setSelectedDevice(device)
    this._projectionDevice = device
    this.setData({ showMediaSheet: true, mediaSheetClosing: false })
  },

  // 关闭「拍照/相册」选择弹层（带退场动画，与详情页一致）
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

  // 选图（拍照/相册）后跳投屏预览：用户取消选择不报错；选到图先关弹层再带数据跳转。
  async pickAndProject(pickImages) {
    const device = this._projectionDevice
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
      toast.warn({ title: '选择照片失败', icon: 'none' })
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
      // 与连接路径同样走整组重算：连接态只认真实会话，不再逐行手写 true/false
      this.setData({
        devices: activeDevice.reconcileConnectionFlags(this.data.devices)
      })
      // 断开成功不再弹提示（按钮/卡片已切「未连接」态即为反馈）；仅失败时提示。
      return
    }

    await this.connectDevice(device)
  },

  // 扫描匹配并连接这台设备（「连接」按钮与「投屏」按钮共用）：
  // 主链在 active-device.connectBoundDevice：先认活动会话复用 → 命中本机直连缓存则短超时直连旧 deviceId
  //（2026-07-21，跳过扫描）→ 否则完整扫描拿当下有效 deviceId 再连。直连失败一律无损回落扫描，
  // 所以「直连不中也不会连不上」，只是慢一点。成功返回带有效 deviceId/实时信息的设备对象并刷新列表 UI；失败提示后返回 null。
  async connectDevice(device) {
    try {
      // 扫描+匹配+连接主链已收敛到 active-device.connectBoundDevice（首页/列表/详情共用一份，改一处全生效）。
      // 列表页传入带「名称兜底」的匹配器(老记录没序列号时按名连)，并对复用的活动会话先读设备信息做活性校验。
      const res = await activeDevice.connectBoundDevice(device, {
        match: (found, dev) => this.matchScannedDevice(found, dev),
        verifyReuse: true
      })
      const updated = this.applyConnectedDevice(device, res.deviceId, res.info)
      // 连接成功不再弹提示（卡片切「已连接」态即为反馈，投屏流程也直接继续）；仅连接失败时提示。
      return updated
    } catch (error) {
      // 系统级「附近设备」权限被拒：弹引导去系统设置，而非笼统的「连接失败」
      activeDevice.showConnectError(error)
      return null
    }
  },

  // 连接成功后的统一收尾（新连接与复用活动会话共用）：合并设备实时信息 → 设为全局选中设备 → 刷新列表项。
  // info 的电量已由 connectBoundDevice 统一通过 0x04 实时读取；读取失败为 null，不回退旧值。
  applyConnectedDevice(device, deviceId, info) {
    const updated = Object.assign(
      {},
      device,
      {
        deviceId, // 刷新成本次会话有效的 deviceId，供后续断开/图传复用
        bleDeviceId: deviceId,
        connected: true
      },
      info
        ? Object.assign(
            {
              usedMemory:
                info.imgCount === undefined ? device.usedMemory : info.imgCount,
              totalMemory:
                info.capacity === undefined ? device.totalMemory : info.capacity,
              playbackMode:
                info.playMode === undefined ? device.playbackMode : info.playMode,
              intervalSeconds:
                info.intervalSeconds === undefined
                  ? device.intervalSeconds
                  : info.intervalSeconds,
              intervalHours: info.intervalSeconds
                ? Math.max(1, Math.round(info.intervalSeconds / 3600))
                : device.intervalHours,
              firmwareVersion: info.firmwareVersion || device.firmwareVersion
            },
            // 连接成功展示的电量来自本次 0x04。
            batteryUtil.stampBattery(info.battery)
          )
        : batteryUtil.stampBattery(null)
    )

    // 连接成功即设为当前选中设备：设备是单连接，「正连着的」就是当前在用的。
    // 这样切到别的页面再回来、或自动重连时，都能据 selectedDevice.deviceId 认出这条活动会话。
    app.setSelectedDevice(updated)

    // 整张列表按真实会话重算连接态，而不是只刷被点的这一行：单连接下连 B 会先释放 A 的会话
    // （device-ble.disconnectOthers），只改 B 那行的话 A 会一直挂着「已连接」和「投屏/断开」按钮。
    this.setData({
      devices: activeDevice
        .reconcileConnectionFlags(
          this.data.devices.map(item => item.id === device.id ? updated : item)
        )
        .map(item => Object.assign({}, item, {
          memoryPercent: memoryPercent(item),
          batteryIcon: batteryUtil.batteryIconOf(item),
          batteryText: batteryUtil.batteryText(item)
        }))
    })
    return updated
  },

  // 把后端来的设备(只有序列号/名称)和扫描结果匹配，返回带「本次会话有效 deviceId」的那条。
  // 序列号用 active-device.serialsMatch 容错比对（归一化+互为子串）：广播 Device_ID 只有 4 字节、
  // 后端存 6 字节，之前的精确相等必然对不上，实际一直靠名称兜底碰巧连上（默认设备名=产品广播名）；
  // 用户一改名两条路全断，表现为「改名后点连接提示未搜索到该设备」。
  // 名称兜底只留给没有序列号的老记录：有序列号却没匹配上即视为设备不在附近，不再按名连接——
  // 同型号广播名相同，按名兜底可能连到别人的相框。
  matchScannedDevice(found, device) {
    const bySerial = activeDevice.matchScannedDevice(found, device)
    if (bySerial) {
      return bySerial
    }
    if (this.deviceSerial(device)) {
      return null
    }
    const name = String((device && device.name) || '').trim()
    if (!name) {
      return null
    }
    return (found || []).find(item => String(item.name || '').trim() === name) || null
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
      placeholderText: `请输入设备名称（1-${deviceName.DEVICE_NAME_MAX_LEN}个字符）`,
      content: device.name,
      success: async res => {
        if (!res.confirm) {
          return
        }

        // 弹窗自身无法限制输入长度，只能在确定后校验；不合法则提示并放弃本次保存
        const checked = deviceName.validateDeviceName(res.content)
        if (!checked.ok) {
          toast.warn(checked.message)
          return
        }

        const newName = checked.name
        await api.renameDevice(id, newName)
        // 改名只做后端存储：全局选中设备只合并新名字，保留 deviceId 等连接字段。
        // 不能用接口精简返回整体替换——会丢 deviceId 造成假断联且重扫搜不到（设备被会话占线不广播）。
        const selected = app.globalData.selectedDevice
        if (selected && String(selected.id) === String(id)) {
          app.setSelectedDevice(
            Object.assign({}, selected, { name: newName, productName: newName })
          )
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
      content: '删除设备后，设备上的照片将保留，如不再使用此设备，建议先清空所有照片',
      cancelText: '再想想',
      confirmText: '确认',
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
