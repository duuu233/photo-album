// 「当前选中设备」统一入口 + 「操作前确保设备已连接」。
// 首页 device-swiper 当前展示/选中的那台设备即全局当前设备(app.globalData.selectedDevice，由 home.js 维护)。
// 所有需要与固件交互的操作(设置轮播 / 一键删除 / 删除照片 / 刷新屏幕 / 进入固件升级等)都应先经此确保已连接：
//   已连接 -> 直接用；断联 -> 「自动重连」(扫描匹配→连接)，连不上再提示。
// 为何断联要重扫再连：微信 BLE deviceId 是「本次扫描会话」临时分配的，后端只存序列号，
//   直接拿旧 deviceId ensureConnection 多半失败，必须先重扫拿到当下有效 deviceId 再连。
const deviceBle = require('./device-ble')
const bluetooth = require('./bluetooth')
const permission = require('./permission')
const toast = require('./toast')
const protocol = require('./frame-protocol')

// 弹窗引导去首页切换设备 / 绑定新设备
function promptSwitchDevice(content) {
  wx.showModal({
    title: '设备未连接',
    content: content || '无法连接当前设备，请前往首页切换设备或绑定新设备',
    confirmText: '去首页',
    cancelText: '取消',
    success(res) {
      if (res.confirm) {
        wx.switchTab({ url: '/pages/home/home' })
      }
    }
  })
}

// 当前选中设备（可能为 null）
function getActiveDevice() {
  const app = getApp()
  return (app && app.globalData && app.globalData.selectedDevice) || null
}

// 找出这台设备当下的活动会话 deviceId：先按记录里的 BLE deviceId 直连命中；
// 命中不了再用「设备ID×广播ID」交叉匹配——拿设备记录的稳定序列号(deviceNo/productDeviceId，即后端设备ID)
// 与各活动会话登记的序列号(扫描广播 Device_ID/固件 0x01 Device_ID)容错比对(serialsMatch)。
// 场景：切页面后从接口重拉的设备记录不带 BLE deviceId，直连判断必然「未连接」；但会话其实还活着，
// 此时若当作断联去重扫，设备(单连接)被自己占线不广播，必然「未搜索到该设备」。交叉匹配能认出这条会话。
// 返回活动会话的 deviceId；没有匹配返回 ''。
function findConnectedDeviceId(device) {
  if (!device) {
    return ''
  }
  const directId = device.deviceId || device.bleDeviceId
  if (directId && deviceBle.isConnected(directId)) {
    return directId
  }
  const serials = [device.deviceNo, device.productDeviceId]
    .map(normalizeSerial)
    .filter(Boolean)
  if (!serials.length) {
    return ''
  }
  const hit = deviceBle.getActiveConnections().find(conn =>
    // 先按型号/尺寸过一道闸：会话广播 screenType 与设备记录尺寸对不上（不同型号）直接跳过，防串台
    sameScreen(device, conn.screenType) &&
    (conn.serials || []).some(serial =>
      serials.some(mine => serialsMatch(serial, mine))
    )
  )
  return hit ? hit.deviceId : ''
}

// 是否已有可用连接：deviceId 直连命中，或序列号交叉匹配到活动会话
function isDeviceConnected(device) {
  return !!findConnectedDeviceId(device)
}

// 硬件序列号归一化：去分隔符 + 大写，兼容后端与蓝牙广播两侧可能的格式差异
function normalizeSerial(value) {
  return String(value == null ? '' : value).replace(/[:\-\s]/g, '').toUpperCase()
}

// 两个序列号是否指同一台物理设备：归一化后精确相等，或互为子串（要求 ≥8 hex/4 字节，避免误并）。
// 广播里的 Device_ID 只有 4 字节、连上读 0x01 得到的是 6 字节，后端存的可能是其中任意一种，
// 精确相等在「广播 4 字节 vs 后端 6 字节」时必然对不上（bind.js 绑定判重已用同规则治理过同类问题）。
function serialsMatch(a, b) {
  const left = normalizeSerial(a)
  const right = normalizeSerial(b)
  if (!left || !right) {
    return false
  }
  // 1) 完全相等：最可靠（后端 6 字节 deviceId vs 固件 0x01 读出的 6 字节，或广播 4 字节 vs 广播 4 字节）
  if (left === right) {
    return true
  }
  // 2) 长度相同却不相等 → 一定是两台不同设备（含双方都是完整 6 字节的常见情形），直接否。
  //    这样即便两台设备序列号高度相似也不会误并。
  if (left.length === right.length) {
    return false
  }
  // 3) 长度不同：广播 4 字节(8 hex) vs 固件/后端 6 字节(12 hex)。只认「短的是长的前缀或后缀」的锚定匹配，
  //    不再用任意位置 indexOf —— 否则两台设备序列号中段偶然重叠 4 字节就被误判成同一台（EF6-370 串到 EF6-589 的根因之一）。
  const shorter = left.length < right.length ? left : right
  const longer = left.length < right.length ? right : left
  if (shorter.length < 8) {
    // 短于 4 字节不足以判定同一台，避免误并
    return false
  }
  return (
    longer.indexOf(shorter) === 0 ||
    longer.lastIndexOf(shorter) === longer.length - shorter.length
  )
}

// 屏幕型号(尺寸)一致性校验：设备记录的 width/height（后端按物理型号下发，用户改名也不变）
// 与活动会话广播登记的 screenType 对应尺寸(SCREEN_TYPES)。两侧都拿得到且尺寸不一致 → 判为不同型号设备，
// 交叉匹配一票否决，杜绝「序列号 4/6 字节偶合」把 3.7寸(480×720) 误连到 5.89寸(680×960)。
// 任一侧信息缺失（老会话没登记 screenType / 设备记录没尺寸）→ 不阻断，回退到纯序列号匹配，保持兼容。
function sameScreen(device, screenType) {
  if (!screenType) {
    return true
  }
  const spec = protocol.SCREEN_TYPES[screenType]
  if (!spec || !spec.width || !spec.height) {
    return true
  }
  const dw = Number(device && device.width) || 0
  const dh = Number(device && device.height) || 0
  if (!dw || !dh) {
    return true
  }
  // 容忍横竖屏方向差异：宽高成对相等即可
  return (
    (dw === spec.width && dh === spec.height) ||
    (dw === spec.height && dh === spec.width)
  )
}

// 从扫描结果里匹配出这台已绑定设备当下有效的 deviceId：只认稳定的硬件序列号
//（设备列表接口返回的 deviceId，归一化后是 deviceNo/productDeviceId），用 serialsMatch 容错比对。
// 连接已绑定设备不按名称匹配——设备名以用户为维度、可随意改，广播名却始终是产品名，
// 按名匹配在改名后必然「搜不到设备/连接不上」；名称匹配只属于「绑定新设备」流程（bind.js，尚无序列号可比）。
function matchScannedDevice(found, device) {
  const list = found || []
  const serials = [
    device && device.deviceNo,
    device && device.productDeviceId
  ]
    .map(normalizeSerial)
    .filter(Boolean)
  if (!serials.length) {
    return null
  }
  return (
    list.find(item =>
      // 扫描项广播 screenType 与设备记录尺寸对不上（不同型号）直接跳过，防扫描重连时误配到别的型号设备
      sameScreen(device, item && item.screenType) &&
      serials.some(serial => serialsMatch(item && item.deviceNo, serial))
    ) || null
  )
}

// 重连成功后，若这台正是全局选中设备，用当下有效 deviceId 刷新它（deviceId 每次扫描会变）。
function syncActiveDeviceId(device, deviceId) {
  try {
    const app = getApp()
    const selected = app && app.globalData && app.globalData.selectedDevice
    if (!selected || typeof app.setSelectedDevice !== 'function') {
      return
    }
    const sameById = device && device.id && selected.id && String(device.id) === String(selected.id)
    // 序列号用容错比对（广播 4 字节 vs 后端 6 字节互为子串也算同一台），与 matchScannedDevice 同规则
    const sameBySerial =
      !!device &&
      serialsMatch(
        device.deviceNo || device.productDeviceId,
        selected.deviceNo || selected.productDeviceId
      )
    if (sameById || sameBySerial) {
      app.setSelectedDevice(Object.assign({}, selected, { deviceId, bleDeviceId: deviceId, connected: true }))
    }
  } catch (error) {
    // 同步失败不影响连接结果
  }
}

// 完整扫描并连接一台已绑定设备的主链（定位 → openAdapter → 扫描 → 匹配 → ensureConnection）。
// home/设备列表/设备详情的「连接蓝牙」按钮与操作前自动重连(ensureDeviceConnected)全共用这一份，
// 改一处即全生效（此前四处各抄一遍，改一处漏三处）。返回连上的 target（含本次会话有效 deviceId 与广播 deviceNo）。
// 扫不到抛「未搜索到该设备」；定位/权限/蓝牙错误按原样抛（error.code 如 PERMISSION_DENIED 保留）。
// match(found, device)：扫描结果匹配器——首页/自动重连用纯序列号 matchScannedDevice，列表/详情传入带名称兜底的。
// onConnectStart：可选。扫到目标、正式 ensureConnection 前回调一次，供调用方把 loading 从「搜索中」切到「连接中」。
// 本函数不弹/不关 loading（由各调用方按自己的场景管理）。
async function scanMatchConnect(device, match, onConnectStart) {
  const location = await permission.getCurrentLocation()
  if (!location) {
    throw new Error('请先授权定位后再连接')
  }
  await bluetooth.openAdapter()
  // until：扫到目标设备(match 命中)就立刻停扫返回，不苦等满 6s——正式连接不再比调试台直连慢一截
  const found = await bluetooth.discoverDevices({
    timeout: 6000,
    until: list => !!match(list, device)
  })
  const target = match(found, device)
  if (!target) {
    throw new Error('未搜索到该设备，请确认设备已开机并在附近')
  }
  if (typeof onConnectStart === 'function') {
    onConnectStart()
  }
  // 把扫描广播里的 Device_ID + 屏幕类型登记到会话，后续页面据此交叉匹配认出这条连接，并按型号/尺寸校验防串台
  await deviceBle.ensureConnection(target.deviceId, {
    deviceNo: target.deviceNo,
    screenType: target.screenType
  })
  return target
}

// 确保这台设备已连接，未连接则自动重连(定位→openAdapter→扫描匹配→连接)。
// 返回连上的当下有效 deviceId；连不上抛错(error.code 保留，如 PERMISSION_DENIED)。
// 已连接：直接返回，不弹 loading。未连接：默认弹「连接设备中」loading（options.showLoading:false 可关）。
async function ensureDeviceConnected(device, options = {}) {
  // 先认活动会话（deviceId 直连 + 序列号交叉匹配）：会话还活着就直接复用，绝不重扫——
  // 设备是单连接，被自己占线时不广播，重扫必然「未搜索到该设备」还白等 6 秒
  const existingId = findConnectedDeviceId(device)
  if (existingId) {
    syncActiveDeviceId(device, existingId) // 把当下有效 deviceId 回写选中设备，后续直连命中
    return existingId
  }
  const showLoading = options.showLoading !== false
  if (showLoading) {
    wx.showLoading({ title: '连接设备中', mask: true })
  }
  try {
    // 自动重连不读设备信息、loading 全程「连接设备中」，故不传 onConnectStart
    const target = await scanMatchConnect(device, matchScannedDevice)
    syncActiveDeviceId(device, target.deviceId)
    return target.deviceId
  } finally {
    if (showLoading) {
      wx.hideLoading()
    }
  }
}

// 页面「连接蓝牙」按钮的共用连接核心（home/设备列表/设备详情共用）：
//   复用活动会话(可选读信息活性校验) → 扫描(until 命中即返回) → 匹配 → 连接 → 读设备信息。
// 页面只负责把返回值回填到各自的卡片 UI，不必再各抄一遍扫描连接主链。
// 返回 { deviceId, info, reused }：
//   - reused=true：复用了已存在的活动会话；未开 verifyReuse 时 info 为 null（没读设备信息）。
//   - reused=false：新扫描连接；info 为 readDeviceInfo 结果。
// 失败抛错（error.code 保留 PERMISSION_DENIED），调用方 catch 后用 showConnectError 统一提示。
// options.match(found, device)：可选。扫描结果匹配器；默认 matchScannedDevice（纯序列号，首页用）。
//   设备列表/详情传入带「名称兜底」的匹配器（老记录没序列号时按名连）。
// options.verifyReuse：复用活动会话前是否先 readDeviceInfo 活性校验（列表/详情 true；首页省略即 false）。
async function connectBoundDevice(device, options = {}) {
  const match = typeof options.match === 'function' ? options.match : matchScannedDevice

  // 1) 先认活动会话：会话还活着就直接复用，绝不重扫（设备单连接、被自己占线时不广播，重扫必「未搜索到」）
  const existingId = findConnectedDeviceId(device)
  if (existingId) {
    if (!options.verifyReuse) {
      return { deviceId: existingId, info: null, reused: true }
    }
    // 复用前读一次设备信息作活性校验：读得动才是真活着；读不动=后台断开未上报的死会话，清掉走完整扫描重连
    wx.showLoading({ title: '连接设备中', mask: true })
    try {
      const info = await deviceBle.readDeviceInfo(existingId)
      return { deviceId: existingId, info, reused: true }
    } catch (error) {
      deviceBle.disconnect(existingId)
    } finally {
      wx.hideLoading()
    }
  }

  // 2) 完整扫描连接：搜索阶段「搜索设备中」，扫到目标后切「连接设备中」，再读一次真实设备信息
  wx.showLoading({ title: '搜索设备中', mask: true })
  try {
    const target = await scanMatchConnect(device, match, () =>
      wx.showLoading({ title: '连接设备中', mask: true })
    )
    const info = await deviceBle.readDeviceInfo(target.deviceId)
    return { deviceId: target.deviceId, info, reused: false }
  } finally {
    wx.hideLoading()
  }
}

// 连接失败的标准 UI 提示（与 connectBoundDevice 配套）：系统级「附近设备」权限被拒 → 弹系统设置引导；
// 其余原因 → toast 原始报错（带来源前缀，如「设备-…timeout」）。三处「连接蓝牙」按钮 catch 统一复用它。
function showConnectError(error) {
  if (error && error.code === 'PERMISSION_DENIED') {
    bluetooth.showPermissionGuide()
  } else {
    toast.warn({ title: (error && error.message) || '连接失败', icon: 'none' })
  }
}

// 操作前确保已连接（未连接自动重连）。成功返回有效 deviceId；失败按标准 UI 提示并返回 ''（调用方据此 return）。
// 提示规则：系统级「附近设备」权限被拒 → 弹系统设置引导；其它失败 → toast「请先连接设备」。
async function ensureConnectedForAction(device) {
  if (!device || !(device.deviceId || device.bleDeviceId || device.deviceNo || device.name)) {
    toast.warn({ title: '请先连接设备', icon: 'none' })
    return ''
  }
  try {
    return await ensureDeviceConnected(device)
  } catch (error) {
    if (error && error.code === 'PERMISSION_DENIED') {
      bluetooth.showPermissionGuide()
    } else {
      toast.warn({ title: '请先连接设备', icon: 'none' })
    }
    return ''
  }
}

// 确保与「当前选中设备」建立连接（未连接自动重连）。
//   成功 -> 返回 device(带当下有效 deviceId)；
//   无选中设备 / 连接失败 -> 弹窗引导去首页，并抛出错误（调用方 catch 到后直接 return 即可）。
async function ensureActiveDeviceConnection() {
  const device = getActiveDevice()

  if (!device || !(device.deviceId || device.bleDeviceId || device.deviceNo || device.name)) {
    promptSwitchDevice('当前没有可用设备，请前往首页选择或绑定相框设备')
    throw new Error('NO_ACTIVE_DEVICE')
  }

  if (isDeviceConnected(device)) {
    return device
  }

  try {
    const deviceId = await ensureDeviceConnected(device)
    return Object.assign({}, device, { deviceId, bleDeviceId: deviceId, connected: true })
  } catch (error) {
    promptSwitchDevice('无法连接当前设备，请前往首页切换设备或绑定新设备')
    throw error
  }
}

module.exports = {
  getActiveDevice,
  isDeviceConnected,
  findConnectedDeviceId,
  serialsMatch,
  sameScreen,
  matchScannedDevice,
  ensureDeviceConnected,
  connectBoundDevice,
  showConnectError,
  ensureConnectedForAction,
  ensureActiveDeviceConnection,
  promptSwitchDevice
}
