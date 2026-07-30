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
const connCache = require('./device-conn-cache')
const batteryUtil = require('./battery')
const deviceIdUtil = require('./device-id')
const identityStore = require('./device-identity')

// 连接前的信号闸（2026-07-20，治「信号正常档经常连不上」）：
// 扫描命中目标时若 RSSI 弱于此值，不立刻发起连接，先等一个短窗口看有没有更强的一帧。
// -70dBm 取在原始 RSSI 的 -67~-78dBm 区间靠前位置：≥-70dBm 立即连，
// 更弱时才进入等待。搜索列表的信号文案已保守下调一级，但不影响这里的原始 RSSI 策略。
const WEAK_SIGNAL_RSSI = -70
// 弱信号等待上限(ms)：期间来一帧达标的就立刻连；等满了也照常连，绝不因信号弱阻断用户。
// 1.5s 是「值得等一等」与「用户觉得卡住了」的折中——广播间隔通常 100~500ms，够收十几帧。
const WEAK_SIGNAL_WAIT_MS = 1500
// 「扫描 → 连接」整轮的重试次数（2026-07-20 第二轮，治残留的 connect time out）。
// 与 device-ble 内层重试分工：内层只解决「同一 deviceId 上的瞬时失败」，本层解决
// 「deviceId 已失效 / 设备不再广播」——后者换多少次内层重试都是 connect time out，必须重扫。
// 2 轮：最坏 ≈「扫描 + 5s + 0.4s + 8s」×2 ≈ 30s，与上一轮的 26s 同量级，但覆盖的失败类型多一类。
const SCAN_CONNECT_ROUNDS = 2

// 直连快路径的短超时（2026-07-21，治「复连必先扫描、慢」）：命中本机缓存(后端稳定ID→上次微信deviceId)
// 就赌一把直连旧 deviceId，赌不中(设备重启/换机/离线/安卓地址轮换)在此时限内快速失败、回落完整扫描。
// 取 3s：一次 createBLEConnection 正常 1~2s 内就建起，超过多半是连不上；短到「赌不中也不明显拖慢」、
// 长到「本来能连、只是慢一点的别误杀」。回落无损（最坏白花这 3s，仍能连上），故偏保守。
const DIRECT_CONNECT_TIMEOUT_MS = 3000

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
  const serials = deviceSerials(device)
  if (!serials.length) {
    return ''
  }
  const connections = deviceBle.getActiveConnections()
  const directId = device.deviceId || device.bleDeviceId
  if (directId && deviceBle.isConnected(directId)) {
    const directConnection = connections.find(conn => conn.deviceId === directId)
    // 不能只因 BLE 临时句柄相等就认领会话：
    // 页面数据或旧直连缓存可能曾把 B 的句柄写到 A 上，必须让会话里 0x01 读到的完整 ID 再确认一次。
    if (
      directConnection &&
      sameScreen(device, directConnection.screenType) &&
      sessionMatchesSerials(directConnection.serials, serials)
    ) {
      return directId
    }
  }
  const hit = connections.find(conn =>
    // 先按型号/尺寸过一道闸：会话广播 screenType 与设备记录尺寸对不上（不同型号）直接跳过，防串台
    sameScreen(device, conn.screenType) &&
    sessionMatchesSerials(conn.serials, serials)
  )
  return hit ? hit.deviceId : ''
}

// 这条活动会话与设备记录是否指同一台：双方都必须带 0x01 的完整 6 字节 ID并精确相等。
// 广播短 ID 只负责扫描候选，不能认领活动会话。
function sessionMatchesSerials(sessionSerials, deviceSerials) {
  const left = uniqueSerials(sessionSerials).filter(deviceIdUtil.isComplete)
  const right = uniqueSerials(deviceSerials).filter(deviceIdUtil.isComplete)
  if (!left.length || !right.length) {
    return false
  }
  return left.some(serial => right.indexOf(serial) > -1)
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
// 每条会话只认领一行：逐行独立判断还不够。当前会话必须登记 0x01 的完整 6 字节 ID；
// 再按匹配强度选唯一一行，防止历史页面缓存把同一个 BLE 句柄复制给多条记录。
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
      // deviceId/bleDeviceId 只表示“当前已核实属于本记录的活动 BLE 会话”。
      // 未认领到会话时必须清空：旧页面数据可能曾把 B 的句柄写进 A，继续保留会让下游
      // 仅按 isConnected(handle) 判断的代码绕过设备身份校验。
      deviceId: liveId,
      bleDeviceId: liveId,
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

function uniqueSerials(values) {
  return (values || []).map(normalizeSerial).filter((serial, index, list) =>
    !!serial && list.indexOf(serial) === index
  )
}

// 从页面对象/接口记录/0x01 实时信息中取完整设备 ID。
// 不读取 device.deviceId：该字段在页面层专门保存微信 BLE 临时句柄。
function stableDeviceId(device) {
  const candidates = [
    device && device.productDeviceId,
    device && device.deviceNo,
    device && device.firmwareDeviceId,
    device && device.backendDeviceId
  ]
  for (let i = 0; i < candidates.length; i++) {
    const value = deviceIdUtil.canonical(candidates[i])
    if (value) {
      return value
    }
  }
  return ''
}

function deviceSerials(device) {
  return uniqueSerials([
    device && device.deviceNo,
    device && device.productDeviceId,
    device && device.firmwareDeviceId,
    device && device.backendDeviceId
  ]).filter(deviceIdUtil.isComplete)
}

// 页面重新拉接口时可能只返回部分字段：保持当前记录为主，依次从 fallback、身份登记表继承同一设备的完整 ID。
//
// 为什么不能只靠 fallback（历来传的都是 app.globalData.selectedDevice）：设备详情接口不返回设备 ID，
// 而 selectedDevice 是「当前选中的那一台」——首页滑轮播卡、在列表里连了别的设备都会改写它。
// 一旦它不是本记录这台，继承就落空，页面拿着没有完整 ID 的记录去连接，会被身份闸报
// 「当前设备记录缺少完整的6字节设备ID，请删除后重新绑定」，把一台好设备说成要重新绑定。
// 身份登记表(device-identity)按 userProductId 记住每台设备的完整 ID，与「当前选中谁」无关，
// 补上的正是这一段。顺序固定：记录自身 > fallback > 登记表，任何时候都以记录自己带的为准。
function inheritStableIdentity(device, fallback) {
  const target = Object.assign({}, device || {})
  // 登记键只认本记录自己的主键，绝不退到 fallback 的：一旦调用方传进来的 fallback 不是同一台，
  // 用它的主键去登记就是把这台的完整 ID 写到另一台名下，正是这张表要防的串台。
  // 无主键的记录（扫描结果等）不参与登记表，只走「记录自身 > fallback」。
  const key = identityStore.keyOf(target)
  const completeId =
    stableDeviceId(target) || stableDeviceId(fallback) || identityStore.recall(key)
  if (!completeId) {
    return target
  }
  identityStore.remember(key, completeId) // 顺手登记，供下次进详情/换选中设备后继续认得这台
  return Object.assign(target, {
    productDeviceId: completeId,
    deviceNo: completeId,
    firmwareDeviceId:
      deviceIdUtil.canonical(target.firmwareDeviceId) || completeId
  })
}

// 连接成功后的统一身份回写：首页、列表、详情都通过它生成相同结构。
// ID 优先取本次 0x01，复用会话时取会话已登记的完整 ID，最后才沿用页面记录。
function applyConnectedIdentity(device, bleDeviceId, info) {
  const connection = deviceBle
    .getActiveConnections()
    .find(item => item.deviceId === bleDeviceId)
  const sessionCompleteId = ((connection && connection.serials) || [])
    .map(deviceIdUtil.canonical)
    .find(Boolean)
  const completeId =
    deviceIdUtil.canonical(info && info.deviceId) ||
    sessionCompleteId ||
    stableDeviceId(device)
  const updated = Object.assign({}, device || {}, {
    deviceId: bleDeviceId,
    bleDeviceId,
    connected: true
  })
  if (!completeId) {
    return updated
  }
  // 0x01 校验通过的完整 ID 是最权威的一手来源，登记下来：即便后端详情接口不返回设备 ID，
  // 之后进这台设备的详情也能取回身份（不再要求它恰好是当前选中设备）。
  identityStore.remember(identityStore.keyOf(updated), completeId)
  return Object.assign(updated, {
    productDeviceId: completeId,
    deviceNo: completeId,
    firmwareDeviceId: completeId
  })
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

// 两组设备 ID 的裁决：优先比较双方都具备的最长 ID。
// 例如候选侧同时有「广播 4 字节 + 0x01 完整 6 字节」时，完整 ID 冲突不能再被相同的短 ID 覆盖。
function serialSetsMatch(leftValues, rightValues) {
  const left = uniqueSerials(leftValues)
  const right = uniqueSerials(rightValues)
  if (!left.length || !right.length) {
    return false
  }
  const commonLengths = left
    .map(serial => serial.length)
    .filter((length, index, list) =>
      list.indexOf(length) === index &&
      right.some(serial => serial.length === length)
    )
  if (commonLengths.length) {
    const strongestLength = Math.max.apply(null, commonLengths)
    const strongestRight = right.filter(serial => serial.length === strongestLength)
    return left.some(serial =>
      serial.length === strongestLength && strongestRight.indexOf(serial) > -1
    )
  }
  return left.some(a => right.some(b => serialsMatch(a, b)))
}

function devicesMatch(left, right) {
  if (!left || !right) {
    return false
  }
  // 两条后端用户设备记录都有稳定主键时，主键不同就是两条记录；绑定接口刚返回、尚未回查到
  // userProductId 的临时对象仍允许按完整硬件 ID 与接口记录合并。
  if (left.userProductId && right.userProductId) {
    return String(left.userProductId) === String(right.userProductId)
  }
  // 一侧来自后端记录、另一侧可能是绑定后尚未回查的临时对象：若临时对象的 id 已经就是
  // userProductId，仍可精确合并；否则不能只凭相同的广播短 ID 合并。
  if (
    left.userProductId &&
    right.id &&
    String(left.userProductId) === String(right.id)
  ) {
    return true
  }
  if (
    right.userProductId &&
    left.id &&
    String(right.userProductId) === String(left.id)
  ) {
    return true
  }
  if (left.id && right.id && String(left.id) === String(right.id)) {
    return true
  }
  const leftSerials = deviceSerials(left)
  const rightSerials = deviceSerials(right)
  const leftComplete = leftSerials.filter(serial => serial.length >= 12)
  const rightComplete = rightSerials.filter(serial => serial.length >= 12)
  if (leftComplete.length && rightComplete.length) {
    return leftComplete.some(serial => rightComplete.indexOf(serial) > -1)
  }
  // 只要有一侧是明确的后端记录，就不允许用 4 字节广播短 ID 猜测另一侧身份。
  // 同批次同尺寸设备可能共享该短 ID，猜中会把 selectedDevice 的 BLE 句柄复制给多条记录。
  if (left.userProductId || right.userProductId) {
    return false
  }
  return serialSetsMatch(leftSerials, rightSerials)
}

// 连接建立后用 0x01 返回的完整 Device_ID 做最终身份确认。
// 前后两侧都必须是完整 6 字节 ID 并精确相等；广播 4 字节短 ID 不具备身份确认资格。
function deviceInfoMatches(device, info) {
  const expected = deviceSerials(device)
  if (!expected.length) {
    return false
  }
  const actual = normalizeSerial(info && info.deviceId)
  return deviceIdUtil.isComplete(actual) && expected.indexOf(actual) > -1
}

function identityMismatchError(device, actualDeviceId) {
  const error = new Error('设备-连接到的设备与所选设备ID不一致，请确认目标设备已开机并重试')
  error.code = 'DEVICE_ID_MISMATCH'
  error.expectedDeviceIds = deviceSerials(device)
  error.actualDeviceId = normalizeSerial(actualDeviceId)
  return error
}

async function readAndVerifyDeviceIdentity(device, deviceId) {
  const info = await deviceBle.readTransferInfo(deviceId)
  if (!deviceInfoMatches(device, info)) {
    const error = identityMismatchError(device, info && info.deviceId)
    console.warn('[设备连接] 完整设备ID校验不通过，排除当前候选', {
      expectedDeviceIds: error.expectedDeviceIds,
      actualDeviceId: error.actualDeviceId,
      bleDeviceId: deviceId
    })
    throw error
  }
  return info
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
    .filter(deviceIdUtil.isComplete)
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
    // 两边若都有完整 ID，以完整 ID 为准；短广播 ID 不得覆盖完整 ID 冲突。
    const sameBySerial = devicesMatch(device, selected)
    if (sameById || sameBySerial) {
      app.setSelectedDevice(
        applyConnectedIdentity(
          inheritStableIdentity(selected, device),
          deviceId
        )
      )
    }
  } catch (error) {
    // 同步失败不影响连接结果
  }
}

// 直连缓存键：后端唯一且固定的设备ID（normalizeDevice 落在 productDeviceId，兜底 deviceNo）。
// 用它当键而非 BLE deviceId——BLE deviceId 每次扫描会变，后端设备ID 一台一号、永不变。
function directConnectKey(device) {
  return deviceIdUtil.canonical(
    device && (device.productDeviceId || device.deviceNo)
  )
}

// 短超时探测直连：命中缓存就直接连旧 deviceId，不走扫描。resolve(true)=连接已建立；
// resolve(false)=超时/连不上（已顺手 close 释放半连接，避免占着单连接设备让紧随的回落扫描「未搜索到」）。
// 只探测「够不够得着」，永不 reject——快路径的失败一律静默回落，不该把异常抛给上层。
function probeDirectConnect(deviceId, timeout) {
  return new Promise(resolve => {
    if (!deviceId || !wx.createBLEConnection) {
      resolve(false)
      return
    }
    wx.createBLEConnection({
      deviceId,
      timeout,
      success() {
        resolve(true)
      },
      fail() {
        if (wx.closeBLEConnection) {
          wx.closeBLEConnection({ deviceId, complete() { resolve(false) } })
        } else {
          resolve(false)
        }
      }
    })
  })
}

// 冷连接前的乐观直连快路径（2026-07-21）：命中本机缓存就短超时直连旧 deviceId，成功即跳过「定位 + 扫描」整段。
// 赌不中（设备重启/换机/离线/安卓地址轮换）则静默回落到完整扫描，最坏只白花 DIRECT_CONNECT_TIMEOUT_MS。
// 不动 device-ble 底层：探测用自己的短超时 createBLEConnection；连上后交给 ensureConnection 复用这条已开连接
// （其内层 createBLEConnection 见「已连接」直接当成功，照常发现服务/特征、开通知、登记会话）。
// 返回已完成身份校验的 { deviceId, info }；未命中/失败返回 null。快路径失败不阻断，静默回落扫描。
async function tryDirectConnect(device, onConnectStart, rejectedDeviceIds) {
  const cacheKey = directConnectKey(device)
  const cachedId = connCache.get(cacheKey)
  if (!cachedId) {
    return null
  }
  try {
    await bluetooth.openAdapter()
    const reachable = await probeDirectConnect(cachedId, DIRECT_CONNECT_TIMEOUT_MS)
    if (!reachable) {
      return null
    }
    // 探测已连上，切「连接中」文案再补齐服务/特征（探测阶段沿用调用方原文案，回落扫描时才不至于文案错乱）
    if (typeof onConnectStart === 'function') {
      onConnectStart()
    }
    // 不把「期望设备 ID」预先登记到会话，否则缓存若已串台，会把 A 的 ID 人为写进 B 的会话。
    await deviceBle.ensureConnection(cachedId)
    const info = await readAndVerifyDeviceIdentity(device, cachedId)
    // 校验通过后再补屏型元数据；readTransferInfo 已登记固件返回的真实完整 ID。
    await deviceBle.ensureConnection(cachedId, { screenType: info.screenType })
    return { deviceId: cachedId, info }
  } catch (error) {
    // 连上了但补服务/特征失败、或 openAdapter 抛错等：清掉可能残留的半连接，回落完整扫描（别占着设备）
    try {
      deviceBle.disconnect(cachedId)
    } catch (ignored) {
      // 无可断开的连接，忽略
    }
    if (error && error.code === 'DEVICE_ID_MISMATCH') {
      // 旧版本可能已把 B 的微信句柄写在 A 的稳定 ID 下，发现后立即清除，避免以后持续串连。
      connCache.remove(cacheKey)
      if (rejectedDeviceIds) {
        rejectedDeviceIds[cachedId] = true
      }
    }
    return null
  }
}

// 完整扫描并连接一台已绑定设备的主链（定位 → openAdapter → 扫描 → 匹配 → ensureConnection）。
// home/设备列表/设备详情的「连接蓝牙」按钮与操作前自动重连(ensureDeviceConnected)全共用这一份，
// 改一处即全生效（此前四处各抄一遍，改一处漏三处）。返回连上的 target（含本次会话有效 deviceId 与广播 deviceNo）。
// 扫不到抛「未搜索到该设备」；定位/权限/蓝牙错误按原样抛（error.code 如 PERMISSION_DENIED 保留）。
// match(found, device)：扫描结果匹配器；默认规则只用完整 ID 对广播短 ID 做候选筛选，不按名称兜底。
// onConnectStart：可选。扫到目标、正式 ensureConnection 前回调一次，供调用方把 loading 从「搜索中」切到「连接中」。
// 本函数不弹/不关 loading（由各调用方按自己的场景管理）。
async function scanMatchConnect(device, match, onConnectStart) {
  const rejectedDeviceIds = {}
  // 快路径：命中本机直连缓存就短超时直连旧 deviceId，成功即跳过定位+扫描（2026-07-21）。
  // 失败无损回落到下面的完整扫描——快路径不抛错，不改变原有失败语义。
  const directTarget = await tryDirectConnect(device, onConnectStart, rejectedDeviceIds)
  if (directTarget) {
    return {
      deviceId: directTarget.deviceId,
      deviceNo: directTarget.info.deviceId,
      screenType: directTarget.info.screenType,
      info: directTarget.info
    }
  }

  const location = await permission.getCurrentLocation()
  if (!location) {
    throw new Error('请先授权定位后再连接')
  }
  await bluetooth.openAdapter()

  let lastConnectError = null
  for (let round = 0; round < SCAN_CONNECT_ROUNDS; round++) {
    let target
    try {
      target = await scanForTarget(device, match, rejectedDeviceIds)
    } catch (scanError) {
      // 重扫轮扫不到了：上一轮的连接错误更贴近真相（设备多半是被我们那次失败的连接占住了），
      // 报「未搜索到该设备」会把用户引到「设备是不是没开机」的错误方向去。
      throw lastConnectError || scanError
    }
    if (typeof onConnectStart === 'function') {
      onConnectStart()
    }
    // 等硬件扫描真正停下来再发起连接：扫描与连接抢射频，弱信号下是连接失败的主因之一。
    // 其他订阅者还在扫时内部直接返回（不掐断别人），此时保持原有行为。
    await bluetooth.whenScanStopped()
    try {
      // 把扫描广播里的 Device_ID + 屏幕类型登记到会话，后续页面据此交叉匹配认出这条连接，并按型号/尺寸校验防串台
      await deviceBle.ensureConnection(target.deviceId, {
        deviceNo: target.deviceNo,
        screenType: target.screenType
      })
      // 广播短 ID + 尺寸只负责筛候选；真正认领前必须读 0x01，用完整 ID 确认物理设备。
      const info = await readAndVerifyDeviceIdentity(device, target.deviceId)
      // 只有完整身份校验通过，才允许写直连缓存。否则会把 B 的句柄永久挂到 A 的稳定 ID 下。
      connCache.put(directConnectKey(device), target.deviceId)
      return Object.assign({}, target, { info })
    } catch (error) {
      lastConnectError = error
      if (error && error.code === 'DEVICE_ID_MISMATCH' && target && target.deviceId) {
        rejectedDeviceIds[target.deviceId] = true
        connCache.remove(directConnectKey(device))
        deviceBle.disconnect(target.deviceId)
      }
      if (round === SCAN_CONNECT_ROUNDS - 1) {
        throw error
      }
      // 还有轮次：重新扫描再连。这一层专治内层重试无能为力的那类失败——
      // deviceId 是「本次扫描会话」的临时值，设备重启/安卓随机地址轮换后就失效了，
      // 拿着失效的 deviceId 连多少次都是 connect time out。重扫既能拿到新鲜 deviceId，
      // 又顺带确认设备是否还在广播（不在广播就走上面的 scanError 分支如实报错）。
    }
  }
  throw lastConnectError || new Error('连接失败')
}

// 扫描一轮并返回匹配到的目标（含本次会话有效 deviceId）。扫不到抛「未搜索到该设备」。
async function scanForTarget(device, match, rejectedDeviceIds) {
  const eligible = list =>
    (list || []).filter(item => !(rejectedDeviceIds && rejectedDeviceIds[item.deviceId]))
  // until：扫到目标设备(match 命中)就立刻停扫返回，不苦等满窗口——正式连接不再比调试台直连慢一截
  //
  // 12 秒（原 6 秒）：相框被 GATT 占着时不广播，断开后要好几秒才恢复广播。单连接落地后
  // 「切换设备」必然是「断开上一台 → 立刻扫连这一台」，6 秒窗口经常等不到设备现身就判
  // 未搜索到，用户表现为「要点两次才连上」。App 侧已踩过并修（ble_controller.dart 同名注释），
  // 这里对齐。有 until 命中即停兜底，设备已在广播时依然是扫到即走（通常 <1s），
  // 加长窗口只影响设备确实还没现身的场景。
  // 弱信号不抢第一帧（2026-07-20）：命中即停扫会在「刚擦边收到第一帧」时就发起连接，
  // 而那一帧往往是整个窗口里信号最差的时刻，连接成功率最低——现场表现通常是高 RSSI 一点就连上、
  // -67~-78dBm 区间经常连不上。信号够强(或读不到 RSSI)时行为完全不变：扫到即走。
  // 信号弱时给一个短暂的等待窗，期间只要来一帧达标的就立刻连（抓住好时机），
  // 等满 WEAK_SIGNAL_WAIT_MS 仍不达标也照常连——绝不因为信号弱就不让用户连。
  let weakSinceAt = 0
  const found = await bluetooth.discoverDevices({
    timeout: 12000,
    until: list => {
      const hit = match(eligible(list), device)
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
  const target = match(eligible(found), device)
  if (!target) {
    throw new Error('未搜索到该设备，请确认设备已开机并在附近')
  }
  return target
}

// 确保这台设备已连接，未连接则自动重连(定位→openAdapter→扫描匹配→连接)。
// 返回连上的当下有效 deviceId；连不上抛错(error.code 保留，如 PERMISSION_DENIED)。
// 已连接：直接返回，不弹 loading。未连接：默认弹「连接设备中」loading（options.showLoading:false 可关）。
async function ensureDeviceConnected(device, options = {}) {
  if (!deviceSerials(device).length) {
    deviceIdUtil.requireComplete(
      device && (device.productDeviceId || device.deviceNo),
      '设备-当前设备记录缺少完整的6字节设备ID，请删除后重新绑定'
    )
  }
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
// options.match(found, device)：可选扫描结果匹配器；稳定设备身份始终要求完整 6 字节 ID。
// options.verifyReuse：复用活动会话前是否先 readDeviceInfo 活性校验（列表/详情 true；首页省略即 false）。
async function connectBoundDevice(device, options = {}) {
  if (!deviceSerials(device).length) {
    deviceIdUtil.requireComplete(
      device && (device.productDeviceId || device.deviceNo),
      '设备-当前设备记录缺少完整的6字节设备ID，请删除后重新绑定'
    )
  }
  const match = typeof options.match === 'function' ? options.match : matchScannedDevice

  // 1) 先认活动会话：会话还活着就直接复用，绝不重扫（设备单连接、被自己占线时不广播，重扫必「未搜索到」）
  const existingId = findConnectedDeviceId(device)
  if (existingId) {
    if (!options.verifyReuse) {
      // 首页虽不做 0x01 活性校验，电量仍按 15 秒缓存策略平滑刷新。
      const batteryState = await batteryUtil.readLatestBattery(existingId, {
        fallback: device
      })
      return {
        deviceId: existingId,
        info: { battery: batteryState.battery },
        reused: true
      }
    }
    // 复用前读一次设备信息作活性校验：读得动才是真活着；读不动=后台断开未上报的死会话，清掉走完整扫描重连。
    // 活性校验始终真实发 0x01；deviceInfo 已取消 15s 结果复用。
    wx.showLoading({ title: '连接设备中', mask: true })
    try {
      const info = await deviceBle.readDeviceInfo(existingId)
      if (!deviceInfoMatches(device, info)) {
        throw identityMismatchError(device, info && info.deviceId)
      }
      const batteryState = await batteryUtil.readLatestBattery(existingId, {
        fallback: device
      })
      info.battery = batteryState.battery
      deviceInfo.put(existingId, info) // 登记最近一次真实结果；后续 read 仍会重新读取，不做 15s 复用
      return { deviceId: existingId, info, reused: true }
    } catch (error) {
      // 「同指令正在等待应答」(CMD_PENDING) 恰恰说明会话活着且正忙（如详情页 onShow 的 0x01 在途）——
      // 按活会话直接复用；误当死会话断开的话，设备恢复广播需要时间，紧接的重扫大概率「未搜索到」。
      if (error && error.code === 'CMD_PENDING') {
        const batteryState = await batteryUtil.readLatestBattery(existingId, {
          fallback: device
        })
        return {
          deviceId: existingId,
          info: { battery: batteryState.battery },
          reused: true
        }
      }
      if (error && error.code === 'DEVICE_ID_MISMATCH') {
        connCache.remove(directConnectKey(device))
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
    // scanMatchConnect 已用 0x01 完成完整 ID 校验，避免重复读 0x01；这里只补固件版本。
    const info = Object.assign({}, target.info || await readAndVerifyDeviceIdentity(device, target.deviceId))
    try {
      info.firmwareVersion = await deviceBle.getSwVersion(target.deviceId)
    } catch (error) {
      info.firmwareVersion = ''
    }
    const batteryState = await batteryUtil.readLatestBattery(target.deviceId, {
      fallback: device
    })
    info.battery = batteryState.battery
    deviceInfo.put(target.deviceId, info) // 登记最近一次真实结果；不参与后续电量展示
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
    toast.warn({ title: friendlyConnectMessage((error && error.message) || ''), icon: 'none' })
  }
}

// 连接超时对用户毫无信息量：「设备-createBLEConnection:fail connect time out」既看不懂也不知道该做什么，
// 而它恰恰是弱信号下最常见的失败。换成可操作的说法，并保留「设备-」来源前缀（见 toast 前缀约定）。
// 只替换这一类；其余原因（未搜索到/权限/蓝牙未开…）照旧如实展示，不要笼统化。
// 注意：只改展示，不动 error 本身——console 里仍是原始报错，排查时看得到真实原因。
function friendlyConnectMessage(message) {
  const text = String(message || '')
  if (/connect\s*time\s*out|createBLEConnection/i.test(text)) {
    return '设备-连接超时，请靠近设备后重试'
  }
  return text || '连接失败'
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
    return applyConnectedIdentity(device, deviceId)
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
  serialSetsMatch,
  stableDeviceId,
  inheritStableIdentity,
  applyConnectedIdentity,
  devicesMatch,
  deviceInfoMatches,
  sameScreen,
  matchScannedDevice,
  ensureDeviceConnected,
  connectBoundDevice,
  showConnectError,
  ensureConnectedForAction,
  ensureActiveDeviceConnection,
  promptSwitchDevice
}
