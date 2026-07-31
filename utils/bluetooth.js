const protocol = require('./frame-protocol')
const api = require('./api')

// 共享扫描会话：硬件扫描全局只有一路（activeScan），并发的 discoverDevices 调用作为「订阅者」
// 挂到同一会话上，各自带自己的 onUpdate/until/timeout，各自命中/到点各自 resolve；
// 全部订阅者退订后才真正停硬件扫描。取代旧的模块级单例 foundHandler，修复两类历史问题：
// ① 两路扫描并发时后者覆盖单例——先结束的一路 off 解绑的是对方的回调，自己的永久残留
//    （闭包持有页面实例，随扫描次数累积泄漏）；
// ② 任一路 stopBluetoothDevicesDiscovery 停掉共享硬件扫描，把还在跑的另一路饿死，
//    表现为偶发「未搜索到该设备」。
let activeScan = null

// 最近一次「停硬件扫描」的在途 Promise。stopBluetoothDevicesDiscovery 是异步的，旧代码发完就不管，
// 调用方(scanMatchConnect)拿到扫描结果后立刻发起 createBLEConnection——此时底层扫描往往还没真停，
// 扫描与连接抢射频，弱信号下连接失败率明显上升（强信号能扛过去，「正常」档就扛不住了）。
// 这里把停扫 Promise 化，供 whenScanStopped() 等待，连接前先让射频安静下来。
let stopDiscoveryPromise = null

// 仅保留目标相框：按广播名（name / localName）做白名单筛选，其余蓝牙设备一律不进搜索结果。
// 白名单不再写死，而是取自产品列表接口(/Client/Product/getProductList)里每个产品的 broadcastId 字段，
// 后端新增/调整支持的机型时无需改前端。拉取失败（未登录/网络异常）时退回内置广播名兜底，保证仍能搜到设备。
//   兜底：3.7 寸 EF6-370 / 5.89 寸 EF6-589
// 屏幕类型/电量若广播包带了厂商数据就顺带解析出来（frame-protocol.parseAdvertising）。
const FALLBACK_BROADCAST_IDS = ['EF6-370', 'EF6-589']

// 停扫等待上限(ms)：个别机型 stopBluetoothDevicesDiscovery 不回调，超时即当已停，别把连接无限拖住。
const SCAN_STOP_TIMEOUT_MS = 600
// 停扫落地后的沉淀时间(ms)：回调返回不等于射频立刻空闲，给底层一点时间再发起连接。
const SCAN_SETTLE_MS = 120

// 产品列表 broadcastId 白名单缓存：首次扫描拉取后整次会话复用；失败不缓存，便于下次重试。
let cachedBroadcastIds = null

// 取允许的 broadcastId 白名单：优先用产品列表接口返回的；拉不到/为空则退回内置兜底。
async function loadAllowedBroadcastIds() {
  if (cachedBroadcastIds && cachedBroadcastIds.length) {
    return cachedBroadcastIds
  }
  try {
    const ids = (await api.getProductBroadcastIds())
      .map(id => String(id || '').trim().toUpperCase())
      .filter(Boolean)
    if (ids.length) {
      cachedBroadcastIds = ids
      return cachedBroadcastIds
    }
  } catch (error) {
    // 拉产品列表失败：退回内置广播名，扫描照常进行
  }
  return FALLBACK_BROADCAST_IDS
}

// 广播名是否命中白名单：大小写不敏感，允许带前后缀，故用包含匹配。
// name 与 localName 都查，因为真机有时只在后续广播包里带上 localName。
function isAllowedFrame(device, allowedIds) {
  const name = `${device.name || ''} ${device.localName || ''}`.toUpperCase()
  return (allowedIds || []).some(allowed => allowed && name.indexOf(allowed) > -1)
}

// 检测当前微信运行环境是否具备完整的蓝牙搜索能力
function canUseBluetooth() {
  return Boolean(wx.openBluetoothAdapter && wx.startBluetoothDevicesDiscovery && wx.onBluetoothDeviceFound)
}

// 是否运行在鸿蒙系统(含纯血鸿蒙 HarmonyOS NEXT，如 Mate 系列)。
// 鸿蒙把蓝牙扫描的「附近设备」权限独立管控，且存在「权限全开仍打不开/搜不到」的兼容问题，
// 需要给用户单独的引导文案(关开权限 + 彻底重启微信)。
function isHarmonyOS() {
  try {
    // getDeviceInfo 为新接口，旧基础库降级到 getSystemInfoSync
    const info = (wx.getDeviceInfo ? wx.getDeviceInfo() : wx.getSystemInfoSync()) || {}
    const flag = `${info.system || ''} ${info.platform || ''}`.toLowerCase()
    return flag.indexOf('harmony') > -1 || flag.indexOf('ohos') > -1
  } catch (e) {
    return false
  }
}

// 微信本体的系统级蓝牙权限入口路径(用于引导文案)。鸿蒙与安卓的设置层级不同。
function systemSettingsPath() {
  return isHarmonyOS()
    ? '设置 → 应用和元服务 → 应用管理 → 微信 → 权限'
    : '设置 → 应用 → 微信 → 权限'
}

// 「小程序自己的蓝牙开关没开」的统一文案（2026-08-01 产品拍板）。
// 场景：手机蓝牙是开着的，但微信里这个小程序的「蓝牙」授权被关/未授予（iOS 尤其常见，
// 微信 → 设置 → 小程序 → 蓝牙）。这一类和「手机蓝牙没开」用户分不清，用同一句覆盖两种可能。
const BLUETOOTH_SWITCH_MESSAGE = '请检查并打开手机或小程序蓝牙开关'

// 是否是「小程序蓝牙授权被拒」类错误（区别于微信本体缺系统级「附近设备」权限）。
// 微信在这类失败上回的 errMsg 形态不统一：auth deny / auth denied / authorize:fail /
// unauthorized / require authorization / scope.bluetooth 都出现过，一并识别。
function isMiniProgramBluetoothDenied(errMsg) {
  return (
    errMsg.indexOf('auth deny') > -1 ||
    errMsg.indexOf('auth denied') > -1 ||
    errMsg.indexOf('authorize') > -1 ||
    errMsg.indexOf('unauthorized') > -1 ||
    errMsg.indexOf('scope.bluetooth') > -1
  )
}

// openBluetoothAdapter 失败原因归一化：区分「小程序蓝牙授权没开」「蓝牙没开」「系统权限没给」「其它」。
// - MP_BLUETOOTH_DENIED：小程序自身的蓝牙授权被拒。这是可以用 wx.openSetting 拉起小程序设置页
//   自助修复的一类，单独打标记（2026-08-01 新增，此前会被下面的 permission denied 分支误判成
//   「微信缺少附近设备权限」，把用户引到系统设置里白转一圈）。
// - PERMISSION_DENIED：微信本体缺少系统级「附近设备」权限(安卓12+/鸿蒙把蓝牙扫描权限独立出来)，
//   小程序无法弹窗申请，只能引导用户去系统设置手动开。
function describeAdapterError(error) {
  const errMsg = ((error && error.errMsg) || '').toLowerCase()
  const errCode = error && error.errCode

  // 小程序蓝牙授权被拒：必须排在下面两条之前——微信有时同时带 10001 和 auth deny，
  // 先判 10001 会把它归成「手机蓝牙没开」，用户去开手机蓝牙也修不好。
  if (isMiniProgramBluetoothDenied(errMsg)) {
    return { code: 'MP_BLUETOOTH_DENIED', message: BLUETOOTH_SWITCH_MESSAGE }
  }

  // 10001：系统蓝牙不可用，绝大多数是没开手机蓝牙开关
  if (errCode === 10001 || errMsg.indexOf('not available') > -1) {
    return { code: 'UNAVAILABLE', message: BLUETOOTH_SWITCH_MESSAGE }
  }

  // 系统级权限被拒：permission not grant / system permission denied / errno:3
  if (
    errMsg.indexOf('permission not grant') > -1 ||
    errMsg.indexOf('permission denied') > -1 ||
    (error && error.errno === 3)
  ) {
    return { code: 'PERMISSION_DENIED', message: '微信缺少「附近设备」权限，请在系统设置中开启' }
  }

  return { code: 'UNKNOWN', message: (error && error.errMsg) || '蓝牙初始化失败' }
}

function openAdapter() {
  return new Promise((resolve, reject) => {
    if (!wx.openBluetoothAdapter) {
      reject(new Error('当前微信版本不支持蓝牙能力'))
      return
    }

    wx.openBluetoothAdapter({
      success: resolve,
      fail(error) {
        const detail = describeAdapterError(error)
        const err = new Error(detail.message)
        err.code = detail.code // 供页面层判断是否要弹「去系统设置」引导
        reject(err)
      }
    })
  })
}

// 系统级蓝牙权限引导：小程序无法直接申请微信本体的「附近设备」权限(openSetting 也管不到)，
// 只能弹窗告诉用户去系统设置手动开启；鸿蒙额外提示「关开重启」兜底。
function showPermissionGuide() {
  const harmonyTip = isHarmonyOS()
    ? '\n\n若开关已是开启状态仍报错：请把「附近设备」关闭再打开，并彻底退出微信后重进。'
    : ''
  wx.showModal({
    title: '需要「附近设备」权限',
    content: `请前往：\n${systemSettingsPath()}\n开启「附近设备」与「位置信息」后重试。${harmonyTip}`,
    confirmText: '我知道了',
    showCancel: false
  })
}

// 小程序蓝牙授权被拒的引导（2026-08-01）：这一类和系统级「附近设备」权限不同，
// wx.openSetting 能直接拉起本小程序的设置页，用户一键就能把「蓝牙」打开，故给「去设置」按钮。
// 手机蓝牙本身没开时 openSetting 里看不到蓝牙项，所以文案仍按产品口径两种可能一起提。
function showBluetoothSwitchGuide() {
  wx.showModal({
    title: '蓝牙未开启',
    content: `${BLUETOOTH_SWITCH_MESSAGE}。\n\n若手机蓝牙已开启，请点「去设置」打开本小程序的蓝牙权限。`,
    confirmText: '去设置',
    cancelText: '我知道了',
    success(res) {
      if (res.confirm && wx.openSetting) {
        wx.openSetting({})
      }
    }
  })
}

// 鸿蒙兼容兜底：适配器已打开但一台设备都没搜到时，鸿蒙存在「权限全开仍搜不到」的已知问题，
// 给鸿蒙用户单独的排查引导(关开附近设备 + 重启微信)。非鸿蒙环境返回 false，保留页面原有空态 UI。
function showEmptyResultGuide() {
  if (!isHarmonyOS()) {
    return false
  }
  wx.showModal({
    title: '没有搜索到设备',
    content: `请确认相框已开机并贴近手机。鸿蒙系统如反复搜不到，可在：\n${systemSettingsPath()}\n把「附近设备」关闭再打开，并彻底退出微信后重试。`,
    confirmText: '我知道了',
    showCancel: false
  })
  return true
}

// 结束共享会话：停硬件扫描 + 精确解绑本会话自己的 handler（不会误伤后续新会话）。
// 会话上未结算的订阅者不受影响，仍在各自 timeout 到点后拿「已累计结果」resolve。
function teardownScan(scan) {
  if (scan.stopped) {
    return
  }
  scan.stopped = true
  if (activeScan === scan) {
    activeScan = null
  }
  // 停扫改为可等待：把回调包成 Promise 存起来，连接前 whenScanStopped() 等它落地再连（见文件头 stopDiscoveryPromise）。
  // 仍然「不阻塞本函数」——teardownScan 的调用链是同步的，这里只负责把在途状态记下来。
  if (wx.stopBluetoothDevicesDiscovery) {
    stopDiscoveryPromise = new Promise(resolve => {
      let done = false
      const finish = () => {
        if (!done) {
          done = true
          resolve()
        }
      }
      try {
        wx.stopBluetoothDevicesDiscovery({ success: finish, fail: finish })
      } catch (error) {
        finish()
      }
      // 兜底：个别机型 stopBluetoothDevicesDiscovery 不回调，别让连接被无限拖住
      setTimeout(finish, SCAN_STOP_TIMEOUT_MS)
    })
  }
  if (scan.handler && wx.offBluetoothDeviceFound) {
    wx.offBluetoothDeviceFound(scan.handler)
  }
  scan.handler = null
}

// 等「停扫」真正落地：连接前调用，避免扫描与连接抢射频（弱信号下这是连不上的主因之一）。
// 硬件扫描仍在为其他订阅者运行时直接返回——绝不为了自己连接去掐断别人的扫描（会把对方饿死，见文件头 ②）。
// 停扫落地后再多沉淀 SCAN_SETTLE_MS，给底层留出真正释放射频的时间。
async function whenScanStopped() {
  if (activeScan && !activeScan.stopped) {
    return // 别人还在扫，停不得
  }
  if (stopDiscoveryPromise) {
    await stopDiscoveryPromise
    stopDiscoveryPromise = null
    await new Promise(resolve => setTimeout(resolve, SCAN_SETTLE_MS))
  }
}

// 订阅者视角的设备列表：按各自口径过滤（调试 allowAll 不过滤，正式入口按 broadcastId 白名单），
// 按信号强度降序。白名单按「当前累计到的名称」判——设备名/localName 常在后续广播包才带全，
// 旧实现首包没名字就永远进不了名单（名字包晚到被丢弃），这里后到的名字包一样能让设备入列。
function subscriberList(scan, subscriber) {
  return Object.keys(scan.foundMap)
    .map(id => scan.foundMap[id])
    .filter(device => subscriber.allowAll || isAllowedFrame(device, subscriber.allowedIds))
    .sort((a, b) => b.RSSI - a.RSSI)
}

// 结算一位订阅者（到点/until 命中/被 failScan 拒绝之外的正常路径）：resolve 自己的过滤视图，
// 从会话摘除；最后一位离开时才真正停硬件扫描。
function settleSubscriber(scan, subscriber) {
  if (subscriber.settled) {
    return
  }
  subscriber.settled = true
  clearTimeout(subscriber.timer)
  scan.subscribers = scan.subscribers.filter(item => item !== subscriber)
  subscriber.resolve(subscriberList(scan, subscriber))
  if (!scan.subscribers.length) {
    teardownScan(scan)
  }
}

// 给订阅者派发一次更新：changed（有设备新增/展示信息变化）才回吐 onUpdate；until 每批都判
// （与旧实现一致），命中即提前结算、不等满 timeout。
function notifySubscriber(scan, subscriber, changed) {
  if (subscriber.settled) {
    return
  }
  const list = subscriberList(scan, subscriber)
  if (changed && subscriber.onUpdate && list.length) {
    try {
      subscriber.onUpdate(list) // 搜到一个显示一个：立即把当前列表回吐给页面增量渲染
    } catch (error) {
      // 页面回调自身异常不能中断扫描
    }
  }
  if (subscriber.until) {
    let done = false
    try {
      done = !!subscriber.until(list)
    } catch (error) {
      done = false // until 自身异常按「未命中」处理，退回等满 timeout
    }
    if (done) {
      settleSubscriber(scan, subscriber)
    }
  }
}

// 把一位调用方挂到共享会话：先立即回吐存量结果（后来的订阅者不必等下一个广播包），
// 此后随广播增量更新；自己的 until 命中或 timeout 到点即各自 resolve，互不影响。
function subscribeScan(scan, options) {
  return new Promise((resolve, reject) => {
    const subscriber = {
      allowAll: options.allowAll,
      allowedIds: options.allowedIds,
      onUpdate: options.onUpdate,
      until: options.until,
      settled: false,
      timer: null,
      resolve,
      reject
    }
    scan.subscribers.push(subscriber)
    subscriber.timer = setTimeout(() => settleSubscriber(scan, subscriber), options.timeout)
    notifySubscriber(scan, subscriber, true)
  })
}

// 起扫失败：会话作废，拒绝所有已挂上的订阅者（并发订阅者可能已搭上这趟失败的车）
function failScan(scan, error) {
  teardownScan(scan)
  const pending = scan.subscribers.slice()
  scan.subscribers = []
  pending.forEach(subscriber => {
    if (subscriber.settled) {
      return
    }
    subscriber.settled = true
    clearTimeout(subscriber.timer)
    subscriber.reject(error)
  })
}

// 停止搜索并清理监听，避免后台持续扫描耗电与回调泄漏（页面卸载/手动停止时调用）。
// 语义与旧实现一致：立即停硬件扫描；在途的 discoverDevices 不被打断，仍在各自 timeout
// 到点后 resolve（拿到已累计的结果）；之后新发起的 discoverDevices 会重新起一路硬件扫描。
function stopDiscovery() {
  if (activeScan) {
    teardownScan(activeScan)
    return
  }
  // 无在途会话也兜底停一次硬件扫描（保持旧行为）
  if (wx.stopBluetoothDevicesDiscovery) {
    wx.stopBluetoothDevicesDiscovery({})
  }
}

// 是否正在扫描附近设备。自动重连据此避让用户的手动扫描——如今并发调用会共享同一路扫描，
// 该函数主要供上层做展示/策略判断。
function isDiscovering() {
  return !!(activeScan && !activeScan.stopped)
}

// 把蓝牙信号强度(RSSI，单位 dBm，越接近 0 越强)翻译成用户能看懂的文字档位。
// 现场 RSSI 容易受瞬时尖峰影响，展示口径统一保守下调一级：原「极强」显示为「强」，
// 其余依次下调，最弱档仍封底为「弱」。这里只改文案，不参与连接门槛/重试策略。
// RSSI 缺省(0)或非法(>=0)时返回空串，由页面兜底成「--」。
function rssiToSignalText(rssi) {
  const value = Number(rssi)
  if (!value || value >= 0) {
    return '' // 未知信号
  }
  if (value >= -55) {
    return '强'
  }
  if (value >= -67) {
    return '正常'
  }
  if (value >= -78) {
    return '偏弱'
  }
  return '弱'
}

// 将系统返回的原始蓝牙设备结构裁剪为业务统一字段（取广播服务 UUID 作为设备编号兜底）
function normalizeDevice(device) {
  // 无名设备用 deviceId 末段兜底展示，方便靠信号强度认出自己的设备
  const shortId = String(device.deviceId || '').replace(/[:-]/g, '').slice(-4)
  const name = device.name || device.localName || (shortId ? `设备 ${shortId}` : '未命名设备')
  // 优先用广播包里的厂商数据拿到权威的屏幕类型/电量/设备ID（6.10.7），解析不到再留空
  const ad = protocol.parseAdvertising(device.advertisData) || {}

  return {
    id: device.deviceId,
    deviceId: device.deviceId,
    name,
    // 设备编号优先用广播里的 Device_ID，兜底用蓝牙 deviceId
    deviceNo: ad.deviceId || device.deviceId,
    // 广播厂商数据里的 4 字节 Device_ID（形如 AA:BB:CC:DD），解析不到为空串。
    // 与 deviceNo 的区别：deviceNo 会兜底成微信 BLE 句柄，不能用来判断「到底有没有拿到广播 ID」；
    // 展示层要区分「真有广播ID」和「只有句柄」，故单独留一个不兜底的字段（见 bind.js displayDeviceCode）。
    broadcastDeviceId: ad.deviceId || '',
    model: ad.model || '',
    screen: ad.screen || '',
    screenType: ad.screenType || 0,
    battery: ad.battery,
    RSSI: device.RSSI || 0,
    // 信号强度展示档位（强/正常/偏弱/弱，已按产品口径保守下调一级）
    signalText: rssiToSignalText(device.RSSI),
    localName: device.localName || '',
    advertisServiceUUIDs: device.advertisServiceUUIDs || [],
    realBluetooth: true
  }
}

// 在 timeout 时间内持续收集附近的蓝牙相框，到点后返回去重 + 按 RSSI 降序的设备列表。
// options.onUpdate(devices)：可选。每发现一台新设备、或已收录设备的展示信息(名称/电量/屏型)有变化时，
//   立即回调一份「当前已搜到的列表」，供页面「搜出一个显示一个」增量渲染，不必等满 timeout。
//   最终仍会在 timeout 到点后 resolve 完整列表（与不传 onUpdate 时行为一致，故对现有调用方零影响）。
// options.until(devices)：可选。每次列表有更新时用「当前已搜到的列表」判断是否已达成目标（如已扫到要连的那台），
//   返回真即立刻停扫并 resolve，不再苦等满 timeout —— 把「连接前扫描」从雷打不动 6s 压到扫到即走(通常 <1s)，
//   这正是调试台「按 deviceId 直连」之所以快、而正式入口每次连接都要等满扫描窗口的差距所在。
//   未命中时仍等满 timeout，给设备现身留足时间；不传 until 时行为完全不变（绑定/调试整窗扫描照旧）。
async function discoverDevices(options) {
  const timeout = options && options.timeout ? options.timeout : 8000
  // allowAll：放开广播名白名单，收录附近所有蓝牙设备。仅供硬件调试页排查用
  //（比如设备搜不到时，先看它真实广播名到底命中了产品列表里的哪个 broadcastId）。
  // 绑定/列表等正式入口不传此项，保持只显示目标相框。
  const allowAll = !!(options && options.allowAll)
  const onUpdate = options && typeof options.onUpdate === 'function' ? options.onUpdate : null
  const until = options && typeof options.until === 'function' ? options.until : null
  // 正式入口：先取产品列表的 broadcastId 白名单（带缓存，多为命中缓存无网络开销）；allowAll 不过滤。
  const allowedIds = allowAll ? [] : await loadAllowedBroadcastIds()

  if (!canUseBluetooth()) {
    throw new Error('当前环境不支持蓝牙搜索')
  }

  const subscriberOptions = { timeout, allowAll, allowedIds, onUpdate, until }

  // 已有在途扫描：直接订阅共享会话——绝不并行起第二路硬件扫描，也不会 stop 掉别人的那路
  if (activeScan && !activeScan.stopped) {
    return subscribeScan(activeScan, subscriberOptions)
  }

  const scan = {
    foundMap: {}, // 以 deviceId 为键去重，同一设备多次广播只保留最新一条
    signatures: {}, // 各设备上次的展示签名(名称|电量|屏型)：只在展示信息变化时才增量回调，避免 RSSI 抖动刷屏
    subscribers: [],
    handler: null,
    stopped: false
  }

  // 会话层不做白名单过滤、收录所有上报的设备帧；白名单在各订阅者视角（subscriberList）过滤——
  // 不同订阅者口径不同（调试 allowAll vs 正式白名单），且名字包晚到的设备也能事后被认出。
  scan.handler = res => {
    const devices = res.devices || []
    let changed = false
    devices.forEach(device => {
      if (!device.deviceId) {
        return
      }
      const normalized = normalizeDevice(device)
      const sig = `${normalized.name}|${normalized.battery}|${normalized.screenType}`
      // 新设备，或名称/电量/屏型变化才算「有变化」；纯 RSSI 波动不触发回调（否则会高频刷屏）
      if (!scan.foundMap[device.deviceId] || scan.signatures[device.deviceId] !== sig) {
        changed = true
      }
      scan.foundMap[device.deviceId] = normalized // RSSI 始终更新，保证最终列表排序准确
      scan.signatures[device.deviceId] = sig
    })
    // slice()：until 命中会在遍历中结算并从 subscribers 摘除自己，不能边遍历边改原数组
    scan.subscribers.slice().forEach(subscriber => notifySubscriber(scan, subscriber, changed))
  }

  activeScan = scan

  return new Promise((resolve, reject) => {
    // 注意：必须先注册监听再开始搜索，否则可能漏掉最早广播的设备
    wx.onBluetoothDeviceFound(scan.handler)
    wx.startBluetoothDevicesDiscovery({
      // 允许重复上报：设备名/电量常在后续广播包才带上，开重复上报可持续刷新展示信息
      allowDuplicatesKey: true,
      interval: 0,
      success: () => {
        // 扫描成功开启后，发起者作为第一位订阅者挂上会话（timeout 到点/until 命中各自结算）
        subscribeScan(scan, subscriberOptions).then(resolve, reject)
      },
      fail(error) {
        // 起扫失败与 openBluetoothAdapter 失败是同一批原因（蓝牙关了 / 小程序蓝牙授权被拒 /
        // 系统「附近设备」权限没给），走同一套归一化，别把 "startBluetoothDevicesDiscovery:fail
        // auth deny" 这种英文原文直接抛到 toast 上（2026-08-01）。
        const detail = describeAdapterError(error)
        const scanError = new Error(
          detail.code === 'UNKNOWN' ? error.errMsg || '蓝牙搜索失败' : detail.message
        )
        scanError.code = detail.code
        failScan(scan, scanError)
        reject(scanError)
      }
    })
  })
}

function connectDevice(deviceId) {
  return new Promise((resolve, reject) => {
    if (!deviceId || !wx.createBLEConnection) {
      resolve(false)
      return
    }

    wx.createBLEConnection({
      deviceId,
      timeout: 8000,
      success() {
        resolve(true)
      },
      fail(error) {
        reject(new Error(error.errMsg || '设备连接失败'))
      }
    })
  })
}

module.exports = {
  canUseBluetooth,
  isHarmonyOS,
  openAdapter,
  discoverDevices,
  connectDevice,
  stopDiscovery,
  whenScanStopped,
  isDiscovering,
  showPermissionGuide,
  showBluetoothSwitchGuide,
  showEmptyResultGuide,
  BLUETOOTH_SWITCH_MESSAGE
}
