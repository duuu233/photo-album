const protocol = require('./frame-protocol')
const api = require('./api')

// 保存当前的“发现设备”监听回调引用，停止搜索时用它来精确解绑（off 需要传入同一函数引用）
let foundHandler = null

// 仅保留目标相框：按广播名（name / localName）做白名单筛选，其余蓝牙设备一律不进搜索结果。
// 白名单不再写死，而是取自产品列表接口(/Client/Product/getProductList)里每个产品的 broadcastId 字段，
// 后端新增/调整支持的机型时无需改前端。拉取失败（未登录/网络异常）时退回内置广播名兜底，保证仍能搜到设备。
//   兜底：3.7 寸 EF6-370 / 5.89 寸 EF6-589
// 屏幕类型/电量若广播包带了厂商数据就顺带解析出来（frame-protocol.parseAdvertising）。
const FALLBACK_BROADCAST_IDS = ['EF6-370', 'EF6-589']

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

// openBluetoothAdapter 失败原因归一化：区分「蓝牙没开」「系统权限没给」「其它」，
// 给「系统权限没给」打上 PERMISSION_DENIED 标记，让页面层弹出系统设置引导。
// 注意：permission not grant / system permission denied(errno:3) 指的是「微信本体」缺少
// 系统级「附近设备」权限(安卓12+/鸿蒙把蓝牙扫描权限独立出来)，小程序没有蓝牙 scope，
// 无法弹窗申请，只能引导用户去系统设置手动开。
function describeAdapterError(error) {
  const errMsg = ((error && error.errMsg) || '').toLowerCase()
  const errCode = error && error.errCode

  // 10001：系统蓝牙不可用，绝大多数是没开手机蓝牙开关
  if (errCode === 10001 || errMsg.indexOf('not available') > -1) {
    return { code: 'UNAVAILABLE', message: '请先打开手机蓝牙开关' }
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

// 停止搜索并清理监听，避免后台持续扫描耗电与回调泄漏
function stopDiscovery() {
  if (wx.stopBluetoothDevicesDiscovery) {
    wx.stopBluetoothDevicesDiscovery({})
  }

  if (foundHandler && wx.offBluetoothDeviceFound) {
    wx.offBluetoothDeviceFound(foundHandler)
  }

  foundHandler = null
}

// 是否正在扫描附近设备（foundHandler 非空即扫描中）。
// 自动重连据此避让用户的手动扫描，避免两路 startBluetoothDevicesDiscovery 并发互相干扰。
function isDiscovering() {
  return !!foundHandler
}

// 把蓝牙信号强度(RSSI，单位 dBm，越接近 0 越强)翻译成用户能看懂的文字档位。
// 裸数字对用户没有意义，绑定列表里只展示「极强 / 强 / 正常 / 偏弱 / 弱」。
// RSSI 缺省(0)或非法(>=0)时返回空串，由页面兜底成「--」。
function rssiToSignalText(rssi) {
  const value = Number(rssi)
  if (!value || value >= 0) {
    return '' // 未知信号
  }
  if (value >= -55) {
    return '极强'
  }
  if (value >= -67) {
    return '强'
  }
  if (value >= -78) {
    return '正常'
  }
  if (value >= -88) {
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
    model: ad.model || '',
    screen: ad.screen || '',
    screenType: ad.screenType || 0,
    battery: ad.battery,
    RSSI: device.RSSI || 0,
    // 信号强度文字档位（极强/强/正常/偏弱/弱），供列表展示，避免给用户看裸 RSSI 数字
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

  return new Promise((resolve, reject) => {
    if (!canUseBluetooth()) {
      reject(new Error('当前环境不支持蓝牙搜索'))
      return
    }

    const foundMap = {} // 以 deviceId 为键去重，同一设备多次广播只保留最新一条
    const signatures = {} // 各设备上次回调用的展示签名(名称|电量|屏型)：只在展示信息变化时才增量回调，避免 RSSI 抖动刷屏
    let settled = false // 保证只 resolve/reject 一次
    let timer = null

    // 当前已搜到的设备，按信号强度降序（离得近的排前面）
    const sortedList = () =>
      Object.keys(foundMap).map(id => foundMap[id]).sort((a, b) => b.RSSI - a.RSSI)

    const finish = () => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      stopDiscovery()
      resolve(sortedList())
    }

    // 每次发现设备的回调：累积到 foundMap，搜索期间不整体等待——有新设备/展示信息变化就 onUpdate 增量回吐。
    // 新设备必须广播名命中白名单（产品列表的 broadcastId）才收录；已收录的目标设备后续广播包继续刷新
    // （电量/名称/信号常在后续包才带全），避免因某个包暂时缺 localName 而漏更新。
    foundHandler = res => {
      const devices = res.devices || []
      let changed = false
      devices.forEach(device => {
        if (!device.deviceId) {
          return
        }
        // allowAll(调试) 时不做白名单筛选，收录所有设备；正式入口仍只收命中 broadcastId 的目标相框
        if (!allowAll && !foundMap[device.deviceId] && !isAllowedFrame(device, allowedIds)) {
          return
        }
        const normalized = normalizeDevice(device)
        const sig = `${normalized.name}|${normalized.battery}|${normalized.screenType}`
        // 新设备，或名称/电量/屏型变化才算「有变化」；纯 RSSI 波动不触发回调（否则会高频刷屏）
        if (!foundMap[device.deviceId] || signatures[device.deviceId] !== sig) {
          changed = true
        }
        foundMap[device.deviceId] = normalized // RSSI 始终更新，保证最终列表排序准确
        signatures[device.deviceId] = sig
      })
      if (settled) {
        return
      }
      const list = sortedList()
      if (changed && onUpdate) {
        try {
          onUpdate(list) // 搜到一个显示一个：立即把当前列表回吐给页面增量渲染
        } catch (error) {
          // 页面回调自身异常不能中断扫描
        }
      }
      // 目标已扫到就提前收网、不等满 timeout：把「连接前扫描」从雷打不动 6s 压到扫到即走(通常 <1s)。
      // 放在 onUpdate 之后，页面最后一次增量渲染照常；until 自身异常按「未命中」处理，退回等满 timeout。
      if (until) {
        let done = false
        try {
          done = !!until(list)
        } catch (error) {
          done = false
        }
        if (done) {
          finish()
        }
      }
    }

    // 注意：必须先注册监听再开始搜索，否则可能漏掉最早广播的设备
    wx.onBluetoothDeviceFound(foundHandler)
    wx.startBluetoothDevicesDiscovery({
      // 允许重复上报：设备名/电量常在后续广播包才带上，开重复上报可持续刷新展示信息
      allowDuplicatesKey: true,
      interval: 0,
      success() {
        // 搜索成功开启后，等待 timeout 到点再汇总 resolve（增量结果已在 onUpdate 里实时给过页面）
        timer = setTimeout(finish, timeout)
      },
      fail(error) {
        clearTimeout(timer)
        stopDiscovery()
        reject(new Error(error.errMsg || '蓝牙搜索失败'))
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
  isDiscovering,
  showPermissionGuide,
  showEmptyResultGuide
}
