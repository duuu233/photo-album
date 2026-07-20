// 设备信息(0x01)全局缓存：读取节流 + 在途去重 + 写后置脏。
//
// 为什么要提到全局：
// 0x01(GET_INFO) 是「电量/已存张数/容量/播放模式/屏幕类型」的唯一真实来源，首页、设备列表、
// 设备详情、图库都要用。此前节流只做在**详情页私有字段**上(_lastBleInfo/_lastBleInfoAt)，
// 切到别的页面就失效；而别处读 0x01 的地方（连接收尾、一键清空后、图库删除/刷屏后）各读各的——
// 用户反复切页面会连续多次占用 BLE 链路。空闲连接间隔(100ms)下一次 0x01 要数百 ms，
// 且期间设备对其它指令回忙(0x0B)，代价不低。收到这里之后全局只有一份缓存、一套节流。
//
// 与 utils/battery.js 的分工（两个 TTL 回答不同问题，都需要，别合并）：
//   · 本模块 FRESH_TTL_MS(15s)        —— 「要不要再去读设备」，防反复切页面猛读；
//   · battery.js BATTERY_TTL_MS(10min) —— 「缓存的值还能不能拿来展示」，防陈旧值冒充当前值。
// 首页/设备列表按设计不主动读 BLE（onShow 必须快），只 peek 缓存，所以第二道闸不可省。

const deviceBle = require('./device-ble')

// 读取节流窗口：同一连接 15s 内复用上次结果，不再碰 BLE。
// 沿用详情页原有口径——实测「每次 onShow 都读」会让页面切换闪一下才稳定。
const FRESH_TTL_MS = 15 * 1000

let cachedDeviceId = ''
let cachedInfo = null
let cachedAt = 0

// 在途读取：同一 deviceId 的并发请求共享同一个 Promise。
// 不做去重的话，onShow 与「操作后刷新」并发触发时，第二路会撞上设备的
// 「同指令正在等待应答」(CMD_PENDING)而失败——详情页注释里早就记过这个坑。
let inflight = null
let inflightDeviceId = ''

// 缓存对该 deviceId 是否仍然有效（不含节流窗口判定）。
// 断链即作废：链路一断，缓存里的信息就不再代表设备现状。这道判定放在这里而不是去 7 个
// deviceBle.disconnect 调用点各清一次——那正是「各页面各自维护」的老毛病。
// isConnected 是同步只读方法，调用零成本。
function isValidFor(deviceId) {
  if (!deviceId || cachedDeviceId !== deviceId || !cachedInfo) {
    return false
  }
  if (!deviceBle.isConnected(deviceId)) {
    clear()
    return false
  }
  return true
}

// 缓存是否命中且在节流窗口内
function isFresh(deviceId) {
  return isValidFor(deviceId) && cachedAt > 0 && Date.now() - cachedAt < FRESH_TTL_MS
}

// 登记一次真实读取的结果
function put(deviceId, info) {
  cachedDeviceId = deviceId
  cachedInfo = info
  cachedAt = Date.now()
  return info
}

// 只看缓存、绝不触发 BLE 读。给「onShow 必须快」的首页/设备列表用。
// 返回 { info, at } 或 null；这里**不判 FRESH_TTL**——本模块只负责「有没有」，
// 「够不够新到能展示」由调用方按各自口径判断（电量走 battery.js 的展示有效期）。
function peek(deviceId) {
  if (!isValidFor(deviceId)) {
    return null
  }
  return { info: cachedInfo, at: cachedAt }
}

// 只取**节流窗口内**的缓存，拿不到返回 null，同样绝不触发 BLE 读。
// 与 peek 的区别：peek 不管新旧（调用方另按自己的口径判），本方法保证「≤FRESH_TTL_MS 的新值」。
// 给「想顺手带上实时信息、但拿到旧值会造成误导」的场景用——典型是 connectBoundDevice：
// 它的返回值会被调用方当作「本次读到的」去打时间戳，给个旧值会让时间戳说谎。
function peekFresh(deviceId) {
  return isFresh(deviceId) ? cachedInfo : null
}

// 取设备信息：节流窗口内直接给缓存，否则真读一次 0x01。
// options.force：跳过节流强制重读（写操作后要立刻看到新值时用）。
function read(deviceId, options) {
  const force = !!(options && options.force)

  if (!force && isFresh(deviceId)) {
    return Promise.resolve(cachedInfo)
  }
  if (inflight && inflightDeviceId === deviceId) {
    return inflight
  }

  inflightDeviceId = deviceId
  // 不用 Promise.prototype.finally：低版本基础库不一定有，两个分支各清一次更稳
  inflight = deviceBle.readDeviceInfo(deviceId).then(
    info => {
      inflight = null
      inflightDeviceId = ''
      return put(deviceId, info)
    },
    error => {
      inflight = null
      inflightDeviceId = ''
      throw error
    }
  )
  return inflight
}

// 作废缓存：写类操作（改播放模式/清空/删图/刷屏）改变了设备状态后调，下次 read 必然重读。
// 直接把时间戳清零而不是另设 dirty 标记——效果等价且少一个状态。
function invalidate() {
  cachedAt = 0
}

// 彻底清空：连 info 一起丢。断链时由 isValidFor 自动调用，调用方通常不必手动调。
function clear() {
  cachedDeviceId = ''
  cachedInfo = null
  cachedAt = 0
}

module.exports = {
  FRESH_TTL_MS,
  isFresh,
  peek,
  peekFresh,
  put,
  read,
  invalidate,
  clear
}
