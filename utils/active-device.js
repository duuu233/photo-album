// 「当前选中设备」统一入口 + 「操作前确保设备已连接」。
// 首页 device-swiper 当前展示/选中的那台设备即全局当前设备(app.globalData.selectedDevice，由 home.js 维护)。
// 所有需要与固件交互的操作(设置轮播 / 一键删除 / 删除照片 / 刷新屏幕 / 进入固件升级等)都应先经此确保已连接：
//   已连接 -> 直接用；断联 -> 「自动重连」(扫描匹配→连接)，连不上再提示。
// 为何断联要重扫再连：微信 BLE deviceId 是「本次扫描会话」临时分配的，后端只存序列号，
//   直接拿旧 deviceId ensureConnection 多半失败，必须先重扫拿到当下有效 deviceId 再连。
const deviceBle = require('./device-ble')
const deviceInfo = require('./device-info')
const bluetooth = require('./bluetooth')
const permission = require('./permission')
const toast = require('./toast')
const protocol = require('./frame-protocol')

// 连接前的信号闸（2026-07-20，治「信号正常档经常连不上」）：
// 扫描命中目标时若 RSSI 弱于此值，不立刻发起连接，先等一个短窗口看有没有更强的一帧。
// -70dBm 取在「强(≥-67)」与「正常(-67~-78)」的交界略偏弱处：强/极强一律立即连（行为不变），
// 只有正常档偏弱的那一段才进入等待。档位定义见 bluetooth.rssiToSignalText。
const WEAK_SIGNAL_RSSI = -70
// 弱信号等待上限(ms)：期间来一帧达标的就立刻连；等满了也照常连，绝不因信号弱阻断用户。
// 1.5s 是「值得等一等」与「用户觉得卡住了」的折中——广播间隔通常 100~500ms，够收十几帧。
const WEAK_SIGNAL_WAIT_MS = 1500

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
    sessionMatchesSerials(conn.serials, serials)
  )
  return hit ? hit.deviceId : ''
}

// 这条活动会话与这条设备记录是否指同一台：把「会话登记的序列号」与「设备记录的序列号」两两比对，
// 按可靠度分三级裁决（而非旧的「任意一对 serialsMatch 命中即算」）：
//   ① 有一对完全相等 -> 是（最可靠，直接放行）
//   ② 否则只要有一对「长度相同却不相等」-> 否，一票否决
//   ③ 都没有 -> 退回 serialsMatch 的锚定子串匹配（4 字节广播 vs 6 字节固件/后端）
// ②是防串台的关键：会话上同时登记着广播 4 字节和固件 0x01 读到的 6 字节（attachSessionSerial 两处调用），
// 旧的 .some() 只要任意一对命中就算数——同批次相框广播前 4 字节常相同，于是「6 字节明明对不上」
// 却被「4 字节前缀偶合」救回来，B 的会话被认成 A 的连接。表现有二：A 那行跟着显示「已连接」，
// 更危险的是投屏/一键清空会把指令发到 B。同长度比较是权威的，一旦它说不是，就不许再降级挽回。
function sessionMatchesSerials(sessionSerials, deviceSerials) {
  // 两侧都归一化（幂等）：长度比较是本函数的裁决依据，带分隔符的原始串会让长度失真
  const left = (sessionSerials || []).map(normalizeSerial).filter(Boolean)
  const right = (deviceSerials || []).map(normalizeSerial).filter(Boolean)
  if (!left.length || !right.length) {
    return false
  }
  let exact = false
  let sameLengthConflict = false
  let anchored = false
  // 先全量比完再裁决，避免受两侧数组顺序影响（设备记录的 deviceNo/productDeviceId 可能一条 4 字节一条 6 字节）
  left.forEach(a => {
    right.forEach(b => {
      if (a === b) {
        exact = true
      } else if (a.length === b.length) {
        sameLengthConflict = true
      } else if (serialsMatch(a, b)) {
        anchored = true
      }
    })
  })
  if (exact) {
    return true
  }
  return sameLengthConflict ? false : anchored
}

// 是否已有可用连接：deviceId 直连命中，或序列号交叉匹配到活动会话
function isDeviceConnected(device) {
  return !!findConnectedDeviceId(device)
}

// 按当下真实 BLE 会话，把一组设备记录的连接态整体重算一遍：命中的回填本次会话有效 deviceId，
// 其余一律落回「未连接」。返回新数组（不改原对象），调用方直接 setData。
//
// 为什么必须整组重算、而不是只改被点的那一台：单连接下 ensureConnection 在建新连接前会先释放旧会话
// （device-ble.disconnectOthers），但旧设备**那一行的 connected 没有任何人去改**——
// 于是「连了 B，A 还显示已连接」，且 A 那行照旧给出「投屏/断开」按钮，点下去操作的是已经不存在的会话。
// 单连接的不变式是「最多只有一台已连接」，这里就是把它落到 UI 上的唯一入口。
// App 侧对应 state.dart 的 reconcileConnectionFlags 与「连接成功后 item.connected = identical(item, device)」。
// 每条会话只认领一行：逐行独立判断还不够。会话未必登记得到 6 字节固件序列号
// （ensureDeviceConnected 的自动重连路径只走 scanMatchConnect，不读 0x01，会话上只有广播 4 字节），
// 此时两台同批次设备（前 4 字节相同）会双双锚定命中同一条会话 —— 又回到「A、B 都显示已连接」。
// 所以按匹配强度打分取最强的那一行，其余即便也"像"，也一律判未连接。
function reconcileConnectionFlags(devices) {
  const list = devices || []
  const conns = deviceBle.getActiveConnections()
  const claims = {} // 会话 deviceId -> 目前得分最高的那一行
  list.forEach((device, index) => {
    const liveId = findConnectedDeviceId(device)
    if (!liveId) {
      return
    }
    const score = connectionMatchScore(device, conns.find(conn => conn.deviceId === liveId))
    const prev = claims[liveId]
    if (!prev || score > prev.score) {
      claims[liveId] = { index, score }
    }
  })
  const winners = {} // 行下标 -> 该行认领到的会话 deviceId
  Object.keys(claims).forEach(liveId => {
    winners[claims[liveId].index] = liveId
  })
  return list.map((device, index) => {
    const liveId = winners[index] || ''
    return Object.assign({}, device, {
      deviceId: liveId || device.deviceId,
      bleDeviceId: liveId || device.bleDeviceId,
      connected: !!liveId
    })
  })
}

// 这一行与这条会话的匹配强度：deviceId 直连(3) > 序列号精确相等(2) > 锚定子串(1)。
// 只用于「多行同时命中同一条会话」时择一，不参与「是否匹配」的判定（那是 findConnectedDeviceId 的事）。
function connectionMatchScore(device, conn) {
  const directId = device.deviceId || device.bleDeviceId
  if (conn && directId && directId === conn.deviceId) {
    return 3
  }
  const serials = [device.deviceNo, device.productDeviceId]
    .map(normalizeSerial)
    .filter(Boolean)
  const sessionSerials = ((conn && conn.serials) || []).map(normalizeSerial).filter(Boolean)
  if (sessionSerials.some(a => serials.some(b => a === b))) {
    return 2
  }
  return 1
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
  // until：扫到目标设备(match 命中)就立刻停扫返回，不苦等满窗口——正式连接不再比调试台直连慢一截
  //
  // 12 秒（原 6 秒）：相框被 GATT 占着时不广播，断开后要好几秒才恢复广播。单连接落地后
  // 「切换设备」必然是「断开上一台 → 立刻扫连这一台」，6 秒窗口经常等不到设备现身就判
  // 未搜索到，用户表现为「要点两次才连上」。App 侧已踩过并修（ble_controller.dart 同名注释），
  // 这里对齐。有 until 命中即停兜底，设备已在广播时依然是扫到即走（通常 <1s），
  // 加长窗口只影响设备确实还没现身的场景。
  // 弱信号不抢第一帧（2026-07-20）：命中即停扫会在「刚擦边收到第一帧」时就发起连接，
  // 而那一帧往往是整个窗口里信号最差的时刻，连接成功率最低——这正是「极强档一点就连上、
  // 正常档(-67~-78dBm)经常连不上」的形状。信号够强(或读不到 RSSI)时行为完全不变：扫到即走。
  // 信号弱时给一个短暂的等待窗，期间只要来一帧达标的就立刻连（抓住好时机），
  // 等满 WEAK_SIGNAL_WAIT_MS 仍不达标也照常连——绝不因为信号弱就不让用户连。
  let weakSinceAt = 0
  const found = await bluetooth.discoverDevices({
    timeout: 12000,
    until: list => {
      const hit = match(list, device)
      if (!hit) {
        return false
      }
      const rssi = Number(hit.RSSI) || 0
      // rssi 为 0/非法 = 该机型没上报信号强度，无从判断，按原行为立即连
      if (!rssi || rssi >= WEAK_SIGNAL_RSSI) {
        return true
      }
      if (!weakSinceAt) {
        weakSinceAt = Date.now()
        return false
      }
      return Date.now() - weakSinceAt >= WEAK_SIGNAL_WAIT_MS
    }
  })
  const target = match(found, device)
  if (!target) {
    throw new Error('未搜索到该设备，请确认设备已开机并在附近')
  }
  if (typeof onConnectStart === 'function') {
    onConnectStart()
  }
  // 等硬件扫描真正停下来再发起连接：扫描与连接抢射频，弱信号下是连接失败的主因之一。
  // 其他订阅者还在扫时内部直接返回（不掐断别人），此时保持原有行为。
  await bluetooth.whenScanStopped()
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
      // 不做活性校验，但全局缓存里若正好有这条连接 15s 内的 0x01 结果就顺手带回去：
      // 零成本（peekFresh 不碰 BLE），首页因此也能拿到真实电量，不必回退到更早的缓存值。
      // 必须用 peekFresh 而非 peek——调用方会把这里的 info 当作「本次读到的」去打时间戳，
      // 给个旧值会让时间戳说谎（见 device-info.js 的方法注释）。
      return {
        deviceId: existingId,
        info: deviceInfo.peekFresh(existingId),
        reused: true
      }
    }
    // 复用前读一次设备信息作活性校验：读得动才是真活着；读不动=后台断开未上报的死会话，清掉走完整扫描重连。
    // 这里**故意不吃节流缓存**——校验的意义就在于真的发一次指令，命中缓存会把死会话误判成活的。
    wx.showLoading({ title: '连接设备中', mask: true })
    try {
      const info = await deviceBle.readDeviceInfo(existingId)
      deviceInfo.put(existingId, info) // 真读到的结果登记进全局缓存，紧随的页面加载直接复用
      return { deviceId: existingId, info, reused: true }
    } catch (error) {
      // 「同指令正在等待应答」(CMD_PENDING) 恰恰说明会话活着且正忙（如详情页 onShow 的 0x01 在途）——
      // 按活会话直接复用；误当死会话断开的话，设备恢复广播需要时间，紧接的重扫大概率「未搜索到」。
      if (error && error.code === 'CMD_PENDING') {
        return { deviceId: existingId, info: null, reused: true }
      }
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
    deviceInfo.put(target.deviceId, info) // 登记进全局缓存，紧随的页面加载不必再读一次
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
// 提示规则：与三处「连接蓝牙」按钮共用 showConnectError——权限被拒弹系统设置引导，其余如实展示原因。
async function ensureConnectedForAction(device) {
  if (!device || !(device.deviceId || device.bleDeviceId || device.deviceNo || device.name)) {
    toast.warn({ title: '请先连接设备', icon: 'none' })
    return ''
  }
  try {
    return await ensureDeviceConnected(device)
  } catch (error) {
    // 如实展示失败原因（未搜到/超时/权限…）：用户此刻正是在等自动连接，笼统的「请先连接设备」
    // 与其行为矛盾且不可操作；scanMatchConnect 生成的具体原因不该被吞掉。
    showConnectError(error)
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
  reconcileConnectionFlags,
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
