// 设备稳定身份登记表：{ 后端设备记录主键(userProductId) -> 完整 6 字节 Device_ID }。
//
// 为什么需要它：后端「设备详情」(getUserProductDetail) 并不返回设备 ID，详情页拿到的记录天生
// 没有完整 6 字节身份，只能从别处继承。此前唯一的来源是 app.globalData.selectedDevice——
// 而它表示的是「当前选中的那一台」：用户在首页滑了轮播卡、或在设备列表里连了另一台，
// 选中设备就不再是详情页这台，继承随即落空。表现为：
//   连接 A 之后再进 C 的详情，C 的记录没有完整 ID → 点「连接/投屏」被
//   ensureDeviceConnected/connectBoundDevice 的身份闸拦下，报
//   「设备-当前设备记录缺少完整的6字节设备ID，请删除后重新绑定」——
//   设备其实好好的，只是没连接，却把用户引向「删除重新绑定」。
//
// 这张表把「这台设备的完整 ID」与「当前选中的是谁」解耦：任何一处拿到过某台设备的完整 ID
// （设备列表接口、连接后 0x01 校验、页面身份继承）都登记下来，之后任何页面只要有
// userProductId 就能取回，不再依赖 selectedDevice 恰好是它。
//
// 只收完整 6 字节 ID（见 utils/device-id.js）：广播 4 字节短 ID、微信 BLE 临时句柄一律不进表，
// 否则会把「只能筛候选的短 ID」升格成身份，正是 EF6-370 串到 EF6-589 那类故障的来源。
//
// 存本机 storage（按手机、按微信账号天然隔离）；退出登录时由 app.clearSession 清空，
// 解绑设备时由调用方 forget，避免换账号后残留旧记录。
const deviceIdUtil = require('./device-id')

const STORAGE_KEY = 'deviceIdentityMap'

// 内存镜像：列表/首页每次刷新都会为每台设备走一遍 remember，全部直接读写 storage 太重。
// null 表示尚未从 storage 载入。
let cache = null

// 单元测试跑在 node 里没有 wx：读写一律降级为纯内存，功能不缺、只是不跨启动保留。
function hasStorage() {
  return typeof wx !== 'undefined' && !!wx.getStorageSync && !!wx.setStorageSync
}

function load() {
  if (cache) {
    return cache
  }
  if (!hasStorage()) {
    cache = {}
    return cache
  }
  try {
    const stored = wx.getStorageSync(STORAGE_KEY)
    cache = stored && typeof stored === 'object' ? stored : {}
  } catch (error) {
    cache = {}
  }
  return cache
}

function persist() {
  if (!hasStorage()) {
    return
  }
  try {
    wx.setStorageSync(STORAGE_KEY, cache || {})
  } catch (error) {
    // 落盘失败不影响本次会话：内存镜像仍然可用，只是下次冷启动要重新登记
  }
}

// 登记键：后端设备记录主键。normalizeDevice 保证 id 与 userProductId 同源
//（id = String(userProductId)），两者取其一即可，跨页面对象结构差异下仍是同一个键。
function keyOf(device) {
  if (!device) {
    return ''
  }
  const value = device.userProductId == null ? device.id : device.userProductId
  return value == null ? '' : String(value)
}

// 取这台设备已登记的完整 ID（AA:BB:CC:DD:EE:FF）；没有返回 ''
function recall(key) {
  const id = key == null ? '' : String(key)
  if (!id) {
    return ''
  }
  return deviceIdUtil.canonical(load()[id])
}

// 登记这台设备的完整 ID（不完整一律忽略；值未变不写盘）
function remember(key, deviceId) {
  const id = key == null ? '' : String(key)
  const completeId = deviceIdUtil.canonical(deviceId)
  if (!id || !completeId) {
    return ''
  }
  const all = load()
  if (all[id] === completeId) {
    return completeId
  }
  all[id] = completeId
  persist()
  return completeId
}

// 批量登记：设备列表接口返回的记录带完整 ID，一次全部记下来，
// 之后进任何一台的详情都不再依赖「它恰好是当前选中设备」。
function rememberMany(devices) {
  ;(devices || []).forEach(device => {
    if (!device) {
      return
    }
    remember(
      keyOf(device),
      device.productDeviceId || device.deviceNo || device.firmwareDeviceId
    )
  })
}

// 解绑设备时清掉，避免后端主键复用时把旧身份带回来
function forget(key) {
  const id = key == null ? '' : String(key)
  if (!id) {
    return
  }
  const all = load()
  if (!(id in all)) {
    return
  }
  delete all[id]
  persist()
}

// 退出登录/注销：整表清空（下一位用户的设备与这批 userProductId 无关）
function clear() {
  cache = {}
  if (!hasStorage()) {
    return
  }
  try {
    wx.removeStorageSync(STORAGE_KEY)
  } catch (error) {
    // 清不掉不影响使用：内存已空，且 recall 只在记录自身缺 ID 时才被采纳
  }
}

module.exports = {
  keyOf,
  recall,
  remember,
  rememberMany,
  forget,
  clear
}
