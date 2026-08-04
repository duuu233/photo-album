const api = require('../../../utils/api')
const toast = require('../../../utils/toast')
const permission = require('../../../utils/permission')
const bluetooth = require('../../../utils/bluetooth')
const deviceBle = require('../../../utils/device-ble')
const activeDevice = require('../../../utils/active-device')
const deviceIdUtil = require('../../../utils/device-id')
const deviceName = require('../../../utils/device-name')
const system = require('../../../utils/system')

const app = getApp()
const RECENTLY_BOUND_DEVICE_KEY = 'recentlyBoundDeviceId'

// 扫描窗口（2026-07-29 由 12s 放宽到 20s）。
// 依据：设备广播间隔约 3s，7 台同时在场时 12s 实测经常搜不全（少 1~2 台）——每台设备一个窗口内
// 只有几次现身机会，还要和别台抢同一条广播信道。20s 给每台约 6~7 次机会，基本能扫全。
// 之所以敢把窗口拉这么长，是因为交互已改成「搜到一个显示一个」：用户不用等满窗口——
// 列表边搜边追加，看到自己那台就能直接点「立即绑定」（stopScanForBind 会立刻停扫转入连接）。
// 旧交互下列表要等窗口跑满才整批出现，单方面拉长窗口只会让人干等，这也是这次必须两件事一起改的原因。
const SCAN_TIMEOUT_MS = 20000

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
    helpClosing: false, // 「扫描帮助」弹层是否正在播放退场动画
    renameVisible: false,
    renameValue: '',
    renameSaving: false
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
    // 让在途扫描结果失效：stopDiscovery 只停硬件扫描，在途的 discoverDevices 仍会在自己的 timeout
    // 到点后 resolve 并回调 applyScanResult——窗口拉到 20s 后「人已退出页面、扫描才 resolve」很常见，
    // 不作废就是往已卸载的页面 setData（与 cancelScan 同一处理）。
    this.scanSeq = (this.scanSeq || 0) + 1
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

    // 展示顺序表跟着本次扫描一起重置（见 applyScanResult）
    this.scanOrder = {}
    this.scanOrderNext = 0

    this.setData({
      scanning: true,
      devices: [],
      selectedId: '', // 每次重新搜索清空选中，让本次最先搜到的设备被默认选中
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
      // onUpdate：搜到一台就渲染一台（边搜边显示），不必等满超时；窗口见 SCAN_TIMEOUT_MS。
      const devices = await bluetooth.discoverDevices({
        timeout: SCAN_TIMEOUT_MS,
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
      } else if (error.code === 'MP_BLUETOOTH_DENIED') {
        // 小程序自身的蓝牙授权没开：可用 wx.openSetting 一键修好，给「去设置」引导（2026-08-01）
        bluetooth.showBluetoothSwitchGuide()
      } else {
        toast.warn({
          // 搜索/连接超时统一走中文可操作文案，不把 "operate time out" 这类英文原文抛给用户
          title: activeDevice.friendlyConnectMessage(error.message || '电子纸设备搜索失败'),
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

  // 把一次扫描结果（增量或最终）渲染到列表。作废的扫描直接丢弃；首次出现设备时默认选中第一台，
  // 之后保留已有/用户的选择，避免增量刷新时选中项来回跳。
  //
  // 展示顺序按「首次被搜到的先后」钉死，新设备一律追加到末尾：
  // bluetooth.subscriberList 回吐的是**按 RSSI 降序**的列表，边搜边渲染时信号一抖动整列表就重排，
  // 行与行来回跳，用户指头底下那台可能在按下的瞬间换成了别台（误绑）。首见序号一旦分配就不再变，
  // 列表只增不重排，这才是「下面同步新增已搜出的设备」该有的观感。
  applyScanResult(seq, list) {
    if (seq !== this.scanSeq) {
      return // 本次扫描已取消，丢弃增量结果
    }
    const order = this.scanOrder || (this.scanOrder = {})
    let next = this.scanOrderNext || 0
    const devices = (list || []).map(item => {
      const key = item.deviceId || item.id
      if (order[key] === undefined) {
        order[key] = next++
      }
      // deviceCode：列表里给用户看的「设备ID」，扫描阶段就能拿到（见 displayDeviceCode）
      return Object.assign({}, item, {
        deviceCode: this.displayDeviceCode(item)
      })
    })
    this.scanOrderNext = next
    devices.sort((a, b) => order[a.deviceId || a.id] - order[b.deviceId || b.id])

    this.setData({
      devices,
      selectedId:
        this.data.selectedId || (devices.length ? devices[0].id || devices[0].deviceId : '')
    })
  },

  // 立刻结束搜索但**保留已搜到的列表**（与 cancelScan 不同，后者还会退出本页）。
  // 两个入口：① 用户点「停止搜索」；② 搜索还没结束就点了「立即绑定」——此时必须先停扫再连：
  //   · 扫描与连接抢同一路射频，边扫边连本就是「连不上」的主因之一（见 utils/bluetooth.js whenScanStopped）；
  //   · scanSeq 自增后在途扫描的结果不再回写列表，用户选中的那台不会在连接过程中被新搜到的设备挤动。
  // 在途的 discoverDevices 仍会在自己的 timeout 到点后 resolve，但那时 seq 已对不上，直接被丢弃。
  stopScanForBind() {
    if (!this.data.scanning) {
      return
    }
    this.scanSeq = (this.scanSeq || 0) + 1
    bluetooth.stopDiscovery()
    this.setData({ scanning: false })
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

  // 设备硬件序列号归一化，仅用于本页比较。
  deviceSerial(value) {
    return String(value == null ? '' : value).replace(/[:\-\s]/g, '').toUpperCase()
  },

  // 列表里展示给用户看的「设备ID」：取广播厂商数据里的 Device_ID，带冒号展示，
  // 与「我的设备」「设备详情」同一套格式。
  //
  // 长度随固件走，**不再做任何截断**（2026-08-04）：
  //   · 新固件广播 6 字节 → 显示 AA:BB:CC:DD:EE:FF，与设备详情页完全一致；
  //   · 老固件广播 4 字节 → 显示 AA:BB:CC:DD（包里就只有这些，两个平台都一样）。
  // 原来无脑 `slice(-8)` 砍成 4 字节，新固件上会把完整 ID 白白截掉一半 —— 那正是用户
  // 反馈的「和详情页不一致、看着像被裁剪」。
  //
  // 为什么扫描阶段就要展示：默认设备名 = 产品广播名（EF6-370/EF6-589），同型号设备必然重名，
  // 绑定前这是用户唯一能把两台区分开的标识。展示放宽不等于身份放宽——判重、认领会话、
  // 绑定入库一律仍只认连上后 0x01 读到的完整 ID（见 findBoundDevice / active-device）：
  // 广播是明文、可被伪造重放，0x01 才是从设备真身上读的。
  //
  // 兜底（广播厂商数据没解出来时）：
  //   · 安卓的 BLE deviceId 就是 MAC（12 hex）——设备方口径里它就是那个完整身份，整串显示；
  //   · iOS 给的是与设备无关、换台手机就变的随机 UUID（32 hex），它根本不是设备ID，
  //     以前截成 8 位显示只会让用户以为「设备ID 被裁了」，现在直接不显示（模板隐藏这一行）。
  displayDeviceCode(device) {
    const broadcast = this.deviceSerial(device && device.broadcastDeviceId)
    if (broadcast) {
      return deviceIdUtil.formatBytes(broadcast)
    }
    const handle = this.deviceSerial(device && device.deviceId)
    return /^[0-9A-F]{12}$/.test(handle) ? deviceIdUtil.formatBytes(handle) : ''
  },

  // 查当前用户是否已绑定这台设备（按硬件 Device_ID 匹配），命中则返回那条已绑定记录。
  // 匹配不到 / 两次拉列表都失败才返回 null —— 一律按新设备正常绑定，绝不因这步出错而挡住绑定。
  //
  // 「已绑定设备再搜索后有概率变成新设备」的两个元凶都在这里治理：
  //   ① 拉已绑定列表偶发网络失败时旧代码直接 return null → 判成新设备 → 重复绑定。改为重试一次。
  //   ② 扫描广播只有 4 字节短 ID，不具备稳定身份资格；判重只使用连上后 0x01 返回的完整 6 字节 ID。
  async findBoundDevice(scanDevice, info) {
    // 绑定判重也只认 0x01 返回的完整 6 字节 ID；广播短 ID 不再作为稳定身份兜底。
    const completeId = deviceIdUtil.canonical(info && info.deviceId)
    if (!completeId) {
      return null
    }
    const candidates = [this.deviceSerial(completeId)]

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
        const itemSerials = [item.deviceNo, item.productDeviceId]
          .filter(value => deviceIdUtil.isComplete(value))
          .map(value => this.deviceSerial(value))
          .filter(Boolean)
        if (!itemSerials.length) {
          return false
        }
        // 型号/尺寸对不上(不同型号设备)直接排除：防广播 4 字节与后端 6 字节偶合，把新设备(如 3.7寸)
        // 误判成已绑定的别台(如 5.89寸)而不新建绑定。屏型以固件读到的为准，取不到再用广播的。
        if (!activeDevice.sameScreen(item, (info && info.screenType) || scanDevice.screenType)) {
          return false
        }
        // 候选侧已有 0x01 的完整 ID 时，以完整 ID 为最高优先级；
        // 即使广播短 ID 相同，完整 ID 不同也必须判为两台设备。
        return activeDevice.serialSetsMatch(candidates, itemSerials)
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
  async confirmBind() {
    if (this.data.binding) {
      return // 绑定进行中，忽略重复点击，避免重复绑定
    }
    if (!this.data.selectedId) {
      toast.warn({
        title: '请选择要绑定的电子纸设备',
        icon: 'none'
      })
      return
    }
    // binding 在**任何 await 之前**同步置起：下面要等停扫落地，这段时间按钮照样点得动，
    // 晚一步置起就给连点留了空窗（与 AI 发送那处同款病灶，见 ai/chat guardedSend）。
    this.setData({ binding: true })
    // 搜索中直接点绑定：先停扫，并等射频真正安静下来再连（见 stopScanForBind）。
    // 这一步以前不需要：旧交互下列表只在扫描结束后才出现，点绑定时扫描早停了；
    // 现在「边搜边显示」让用户绝大多数时候是在**扫描中**点绑定的，不等停扫就是拿连接去和
    // 自己的扫描抢射频（弱信号下连不上的主因之一）。whenScanStopped 在别的订阅者还在扫时直接返回。
    this.stopScanForBind()
    await bluetooth.whenScanStopped()
    this.bindById(this.data.selectedId)
  },

  // 绑定指定设备：真机设备先连接读取真实信息（电量/播放/屏幕/固件），再保存并设为当前选中设备
  async bindById(id) {
    const scanDevice = this.data.devices.find(
      item => item.id === id || item.deviceId === id
    )

    if (!scanDevice) {
      // 选中项已不在列表（列表刷新过）：把 confirmBind 提前置起的 binding 放开，别把按钮永久锁死
      this.setData({ binding: false })
      return
    }

    this.setData({ binding: true })

    let info = null
    // 绑定成功后是否保留这条 BLE 连接：保留则返回首页直接显示「已连接」，免去用户再手动点连接
    let bleConnected = false
    // 真实蓝牙设备：连接并读取设备信息；连接失败则中止绑定（不再有模拟兜底）
    if (scanDevice.realBluetooth && scanDevice.deviceId) {
      wx.showLoading({ title: '连接电子纸设备中', mask: true })
      try {
        info = await deviceBle.readDeviceInfo(scanDevice.deviceId)
        // readDeviceInfo 成功不等于身份字段一定有效；未拿到完整 6 字节 ID 时禁止继续绑定。
        info.deviceId = deviceIdUtil.requireComplete(
          info && info.deviceId,
          '电子纸设备-未读取到完整的6字节电子纸设备ID，请重新连接后再试'
        )
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
          // 绑定时的连接超时同样要中文可操作（2026-08-01）：微信原文
          //「createBLEConnection:fail connect time out」用户看不懂，统一成「连接超时，稍后再试」
          title: activeDevice.friendlyConnectMessage(error.message || '电子纸设备连接失败'),
          icon: 'none'
        })
        this.setData({ binding: false })
        return
      }
      wx.hideLoading()
      // 连接并读取设备信息成功：不再弹「连接成功」提示，直接继续绑定流程；仅连接失败时提示。
    }

    // 绑定判重/落库阶段（最多两次 getDevices，弱网可达数秒）也给连续 loading：
    // 此前「连接设备中」消失后这段是零反馈，页面像卡住，用户会以为没点上
    wx.showLoading({ title: '绑定电子纸设备中', mask: true })

    // 避免同一台设备被重复绑定（设备页会因此出现多条同款记录）：用刚连上读到的硬件 Device_ID
    // 去已绑定列表里找，命中就复用那条、不再新建，并沿用刚建立的连接（绑定成功 = 已连接）。
    const existed = await this.findBoundDevice(scanDevice, info)
    if (existed) {
      const reused = Object.assign({}, existed, {
        deviceId: scanDevice.deviceId, // 本次会话有效的 BLE deviceId，供后续断开/图传复用
        bleDeviceId: scanDevice.deviceId,
        productDeviceId: info.deviceId,
        deviceNo: info.deviceId,
        firmwareDeviceId: info.deviceId,
        battery: info && typeof info.battery === 'number' ? info.battery : existed.battery
      })
      wx.hideLoading()
      app.setSelectedDevice(reused)
      // 电子纸设备已绑定并已为您连接：不再弹提示，直接返回上一页复用这条连接；仅失败时提示。
      // 保持 binding=true 直到返回上一页，避免窗口内被重复点击触发二次操作
      setTimeout(() => wx.navigateBack(), 500)
      return
    }

    // 合并：扫描得到的蓝牙标识 + 连接后读到的真实设备信息（保留蓝牙 deviceId 供后续重连）
    const payload = Object.assign({}, scanDevice, info || {}, {
      deviceId: scanDevice.deviceId,
      bleDeviceId: scanDevice.deviceId,
      productDeviceId: info.deviceId,
      deviceNo: info.deviceId,
      firmwareDeviceId: info.deviceId,
      name: scanDevice.name
    })

    let device
    try {
      device = await api.bindDevice(payload)
    } catch (error) {
      wx.hideLoading()
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

    wx.hideLoading()
    // 新绑定完成后先在当前页引导命名。允许点「稍后」跳过（弱强制），确认保存后再按原逻辑返回。
    // 已绑定设备的复用路径不进入这里，避免每次重连都要求改名。
    this._pendingBoundDevice = device
    this.setData({
      renameVisible: true,
      renameValue: device.name || scanDevice.name || '',
      renameSaving: false
    })
  },

  cancelRename() {
    if (this.data.renameSaving) {
      return
    }
    this.setData({ renameVisible: false })
    this.finishNewBinding(this._pendingBoundDevice)
  },

  async confirmRename(e) {
    const device = this._pendingBoundDevice
    const checked = deviceName.validateDeviceName(e.detail.value)
    if (!device || !device.id || !checked.ok) {
      toast.warn({
        title: checked.message || '电子纸设备信息异常，请稍后在电子纸设备页修改',
        icon: 'none'
      })
      return
    }
    this.setData({ renameSaving: true })
    try {
      await api.renameDevice(device.id, checked.name)
      const updated = Object.assign({}, device, {
        name: checked.name,
        productName: checked.name
      })
      this._pendingBoundDevice = updated
      app.setSelectedDevice(updated)
      this.setData({ renameVisible: false })
      this.finishNewBinding(updated)
    } finally {
      this.setData({ renameSaving: false })
    }
  },

  finishNewBinding(device) {
    if (this._bindingFinished) {
      return
    }
    this._bindingFinished = true
    if (device && device.id) {
      wx.setStorageSync(RECENTLY_BOUND_DEVICE_KEY, String(device.id))
    }
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
