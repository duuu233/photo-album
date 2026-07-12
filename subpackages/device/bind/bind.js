const api = require('../../../utils/api')
const toast = require('../../../utils/toast')
const permission = require('../../../utils/permission')
const bluetooth = require('../../../utils/bluetooth')
const deviceBle = require('../../../utils/device-ble')
const activeDevice = require('../../../utils/active-device')
const system = require('../../../utils/system')

const app = getApp()

Page({
  data: {
    statusBarHeight: 20,
    safeBottom: 0,
    scanning: false, // 是否正在扫描附近设备
    devices: [],
    selectedId: '', // 当前选中待绑定设备的 id（单选）
    binding: false, // 是否正在绑定，避免重复点击「立即绑定」造成重复绑定
    location: null,
    showHelp: false,
    helpClosing: false // 「扫描帮助」弹层是否正在播放退场动画
  },

  onLoad() {
    this.setData(system.getLayoutMetrics())
    this.scan()
  },

  goBack() {
    const pages = getCurrentPages()

    if (pages.length > 1) {
      wx.navigateBack()
      return
    }

    wx.switchTab({
      url: '/pages/home/home'
    })
  },

  onUnload() {
    bluetooth.stopDiscovery() // 离开页面务必停止扫描，释放蓝牙资源
  },

  noop() {},

  // 搜索附近设备：定位授权 → 开蓝牙 → 扫描；开发者工具无真机蓝牙时降级到模拟数据
  async scan() {
    if (this.data.scanning) {
      return // 防止重复触发扫描
    }

    // 扫描序号：取消搜索时自增使在途的这次扫描结果失效，
    // 因为 discoverDevices 仍会在 8s 超时后 resolve，不能让它再回写界面
    this.scanSeq = (this.scanSeq || 0) + 1
    const seq = this.scanSeq

    this.setData({
      scanning: true,
      devices: [],
      selectedId: '', // 每次重新搜索清空选中，让本次搜到的信号最强设备被默认选中
      showHelp: false
    })

    try {
      // 微信要求搜索蓝牙前需有定位权限
      const location = await permission.getCurrentLocation()
      if (!location) {
        toast.warn({
          title: '请先授权定位',
          icon: 'none'
        })
        return
      }

      this.setData({
        location
      })

      await bluetooth.openAdapter()

      // 只扫真实相框（广播名以 EF6 开头或带合法厂商数据），不再用模拟设备兜底。
      // onUpdate：搜到一台就渲染一台（边搜边显示），不必等满超时；窗口加长到 12s，
      // 让「同时存在 2 台及以上设备」时每台都有足够广播机会被搜到，避免只搜到一台。
      const devices = await bluetooth.discoverDevices({
        timeout: 12000,
        onUpdate: list => this.applyScanResult(seq, list)
      })

      if (seq !== this.scanSeq) {
        return // 本次扫描已被取消，丢弃结果
      }

      // 超时到点的最终列表：增量已实时渲染过，这里兜底对齐一次并处理空态
      this.applyScanResult(seq, devices)

      // 鸿蒙兼容兜底：一台没搜到时给鸿蒙用户单独排查引导(非鸿蒙保留原空态 UI)
      if (!devices.length) {
        bluetooth.showEmptyResultGuide()
      }
    } catch (error) {
      if (seq !== this.scanSeq) {
        return // 已取消，不再提示错误
      }
      // 系统级「附近设备」权限被拒：弹引导去系统设置，而非一句模糊的 toast
      if (error.code === 'PERMISSION_DENIED') {
        bluetooth.showPermissionGuide()
      } else {
        toast.warn({
          title: error.message || '设备搜索失败',
          icon: 'none'
        })
      }
    } finally {
      if (seq === this.scanSeq) {
        this.setData({
          scanning: false
        })
      }
    }
  },

  // 把一次扫描结果（增量或最终）渲染到列表。作废的扫描直接丢弃；首次出现设备时默认选中信号最强那台，
  // 之后保留已有/用户的选择，避免增量刷新时选中项来回跳。
  applyScanResult(seq, list) {
    if (seq !== this.scanSeq) {
      return // 本次扫描已取消，丢弃增量结果
    }
    const devices = list || []
    this.setData({
      devices,
      selectedId:
        this.data.selectedId || (devices.length ? devices[0].id || devices[0].deviceId : '')
    })
  },

  // 取消正在进行的搜索：停止蓝牙扫描并让在途的 scan 结果失效，然后退出绑定流程
  cancelScan() {
    this.scanSeq = (this.scanSeq || 0) + 1 // 使在途扫描结果失效
    bluetooth.stopDiscovery()
    this.setData({
      scanning: false
    })
    this.goBack()
  },

  // 打开硬件联调调试台：开发对接阶段在这里逐个点按钮试每条 BLE 指令、看收发的 16 进制数据。
  // 可从某个已扫描到的设备直接带 deviceId 进去（免去再扫一次）；不带则在调试台里自行搜索连接。
  openDebug(e) {
    const id = e && e.currentTarget && e.currentTarget.dataset.id
    const device = id
      ? this.data.devices.find(item => item.id === id || item.deviceId === id)
      : null
    const query = device
      ? `?id=${device.deviceId}&name=${encodeURIComponent(device.name || '')}`
      : ''
    wx.navigateTo({
      url: `/subpackages/device/debug/debug${query}`
    })
  },

  openHelp() {
    this.setData({
      showHelp: true
    })
  },

  // 先播放退场动画再卸载，避免弹层瞬间消失
  closeHelp() {
    if (this.data.helpClosing) {
      return
    }
    this.setData({ helpClosing: true })
    setTimeout(() => {
      this.setData({ showHelp: false, helpClosing: false })
    }, 240)
  },

  // 点选某台设备：仅更新选中态，绑定动作交给底部「立即绑定」
  selectDevice(e) {
    this.setData({
      selectedId: e.currentTarget.dataset.id
    })
  },

  // 设备硬件序列号(Device_ID)：跨扫描会话稳定，用于判断「这台是否已绑定」。
  // 归一化（去分隔符 + 大写）以兼容后端与蓝牙广播两侧可能的格式差异。
  deviceSerial(value) {
    return String(value == null ? '' : value).replace(/[:\-\s]/g, '').toUpperCase()
  },

  // 查当前用户是否已绑定这台设备（按硬件 Device_ID 匹配），命中则返回那条已绑定记录。
  // 匹配不到 / 两次拉列表都失败才返回 null —— 一律按新设备正常绑定，绝不因这步出错而挡住绑定。
  //
  // 「已绑定设备再搜索后有概率变成新设备」的两个元凶都在这里治理：
  //   ① 拉已绑定列表偶发网络失败时旧代码直接 return null → 判成新设备 → 重复绑定。改为重试一次。
  //   ② 序列号有两种表示：连上读 0x01 得到的是 6 字节 Device_ID，扫描广播里的只有 4 字节，
  //      归一化后长度不同、精确相等匹配不上 → 判成新设备。改为「精确相等 或 互为子串(≥4字节)」匹配。
  async findBoundDevice(scanDevice, info) {
    // 候选序列号：优先用连上读到的 Device_ID(6字节)，再并入扫描广播里的 deviceNo/productDeviceId(4字节)
    const candidates = [info && info.deviceId, scanDevice.deviceNo, scanDevice.productDeviceId]
      .map(value => this.deviceSerial(value))
      .filter(Boolean)
    if (!candidates.length) {
      return null
    }

    // 拉已绑定列表判重：网络抖动会让这步偶发失败，一旦失败旧代码就按「新设备」绑定 → 重复绑定。
    // 这里重试一次，尽量拿到真实列表再判重；两次都失败才不阻断绑定。
    let devices = null
    for (let attempt = 0; attempt < 2 && devices === null; attempt++) {
      try {
        devices = await api.getDevices()
      } catch (error) {
        console.warn(
          '[绑定判重] 拉设备列表失败' + (attempt < 1 ? '，0.5s 后重试一次' : '（放弃，按新设备处理）'),
          (error && error.message) || error
        )
        if (attempt < 1) {
          await new Promise(resolve => setTimeout(resolve, 500))
        }
      }
    }
    if (!devices) {
      return null // 两次都失败：不阻断绑定，按新设备处理
    }

    const matched =
      devices.find(item => {
        const serial = this.deviceSerial(
          item.deviceNo || item.productDeviceId || item.deviceId
        )
        if (!serial) {
          return false
        }
        // 型号/尺寸对不上(不同型号设备)直接排除：防广播 4 字节与后端 6 字节偶合，把新设备(如 3.7寸)
        // 误判成已绑定的别台(如 5.89寸)而不新建绑定。屏型以固件读到的为准，取不到再用广播的。
        if (!activeDevice.sameScreen(item, (info && info.screenType) || scanDevice.screenType)) {
          return false
        }
        return candidates.some(
          candidate =>
            candidate === serial ||
            // 广播 4 字节 vs 连接 6 字节：一个是另一个的子串即视为同一台(要求 ≥8 hex/4 字节，避免误并)
            (serial.length >= 8 &&
              candidate.length >= 8 &&
              (serial.indexOf(candidate) > -1 || candidate.indexOf(serial) > -1))
        )
      }) || null

    console.log('[绑定判重]', {
      candidates,
      matchedId: matched && matched.id,
      matchedSerial:
        matched &&
        this.deviceSerial(
          matched.deviceNo || matched.productDeviceId || matched.deviceId
        )
    })
    return matched
  },

  // 底部「立即绑定」：绑定当前选中的设备
  confirmBind() {
    if (this.data.binding) {
      return // 绑定进行中，忽略重复点击，避免重复绑定
    }
    if (!this.data.selectedId) {
      toast.warn({
        title: '请选择要绑定的设备',
        icon: 'none'
      })
      return
    }
    this.bindById(this.data.selectedId)
  },

  // 绑定指定设备：真机设备先连接读取真实信息（电量/播放/屏幕/固件），再保存并设为当前选中设备
  async bindById(id) {
    const scanDevice = this.data.devices.find(
      item => item.id === id || item.deviceId === id
    )

    if (!scanDevice) {
      return
    }

    this.setData({ binding: true })

    let info = null
    // 绑定成功后是否保留这条 BLE 连接：保留则返回首页直接显示「已连接」，免去用户再手动点连接
    let bleConnected = false
    // 真实蓝牙设备：连接并读取设备信息；连接失败则中止绑定（不再有模拟兜底）
    if (scanDevice.realBluetooth && scanDevice.deviceId) {
      wx.showLoading({ title: '连接设备中', mask: true })
      try {
        info = await deviceBle.readDeviceInfo(scanDevice.deviceId)
        bleConnected = true // ensureConnection 已建立可复用会话，绑定成功后将沿用它
        try {
          const conn = await deviceBle.getConnectionInterval(
            scanDevice.deviceId
          )
          info.connectionIntervalUnits = conn.units
          info.connectionIntervalMs = conn.ms
        } catch (error) {
          console.warn('获取连接间隔失败', error)
          // 连接间隔是 v1.4 新增能力，读取失败不影响基础绑定。
        }
      } catch (error) {
        console.warn('连接设备/读取设备信息失败', error)
        // 连接/读取失败：断开以释放被占用的单连接、让设备能重新广播，再提示并中止绑定
        deviceBle.disconnect(scanDevice.deviceId)
        wx.hideLoading()
        toast.warn({
          title: error.message || '设备连接失败',
          icon: 'none'
        })
        this.setData({ binding: false })
        return
      }
      wx.hideLoading()
      // 连接并读取设备信息成功：不再弹「连接成功」提示，直接继续绑定流程；仅连接失败时提示。
    }

    // 避免同一台设备被重复绑定（设备页会因此出现多条同款记录）：用刚连上读到的硬件 Device_ID
    // 去已绑定列表里找，命中就复用那条、不再新建，并沿用刚建立的连接（绑定成功 = 已连接）。
    const existed = await this.findBoundDevice(scanDevice, info)
    if (existed) {
      const reused = Object.assign({}, existed, {
        deviceId: scanDevice.deviceId, // 本次会话有效的 BLE deviceId，供后续断开/图传复用
        bleDeviceId: scanDevice.deviceId,
        battery: info && typeof info.battery === 'number' ? info.battery : existed.battery
      })
      app.setSelectedDevice(reused)
      // 设备已绑定并已为你连接：不再弹提示，直接返回上一页复用这条连接；仅失败时提示。
      // 保持 binding=true 直到返回上一页，避免窗口内被重复点击触发二次操作
      setTimeout(() => wx.navigateBack(), 500)
      return
    }

    // 合并：扫描得到的蓝牙标识 + 连接后读到的真实设备信息（保留蓝牙 deviceId 供后续重连）
    const payload = Object.assign({}, scanDevice, info || {}, {
      deviceId: scanDevice.deviceId,
      deviceNo: (info && info.deviceId) || scanDevice.deviceNo,
      name: scanDevice.name
    })

    let device
    try {
      device = await api.bindDevice(payload)
    } catch (error) {
      // 绑定失败仍停留在本页：已连过就断开，避免占着设备的单连接妨碍重试
      if (bleConnected) {
        deviceBle.disconnect(scanDevice.deviceId)
      }
      // bindDevice 在 productId 解析不到时会抛错（后端必传），这里把原因提示给用户
      toast.warn({
        title: error.message || '绑定失败',
        icon: 'none'
      })
      this.setData({ binding: false })
      return
    }

    // 绑定接口(addUserProduct)的返回不含可靠的 userProductId（后端多半只回状态/裸 id），
    // 于是 normalizeDevice 里选中设备的 id 落到了扫描得到的 BLE deviceId 而非后端 userProductId。
    // 后果：详情页按 userProductId 认「这是当前选中设备」失败，且详情接口不回硬件序列号、无从交叉匹配，
    // 明明连着却显示「未连接」（列表页因列表接口带序列号、靠交叉匹配侥幸显示正确，掩盖了这个问题）。
    // 绑定成功后回查设备列表，用硬件序列号找到这条新记录，把它真实的 userProductId 回填给选中设备，
    // 让各页都能按稳定的 userProductId 认出它（与 flutter 端 addUserProduct 后 refreshDevices 同理）。
    // 回查失败(如网络抖动)不阻断绑定：退回原有行为，设备仍已连接。
    const persisted = await this.findBoundDevice(scanDevice, info)
    if (persisted && persisted.id) {
      device = Object.assign({}, device, {
        id: String(persisted.id),
        userProductId: persisted.userProductId || persisted.id
      })
    }
    app.setSelectedDevice(device)

    toast.show({
      title: '绑定成功',
      icon: 'none'
    })
    // 绑定成功后不再断开上面建立的连接：返回首页即显示「已连接」，无需用户手动点连接。
    // 同时保持 binding=true 直到返回上一页，避免 500ms 窗口内被重复点击触发二次绑定
    setTimeout(() => {
      wx.navigateBack()
    }, 500)
  }
})
