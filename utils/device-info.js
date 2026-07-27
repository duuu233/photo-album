// 设备信息(0x01)统一读取层：在途去重 + 最近结果登记。
//
// 为什么要提到全局：
// 0x01(GET_INFO) 提供已存张数/容量/播放模式/屏幕类型等综合信息。此前节流只做在
// **详情页私有字段**上(_lastBleInfo/_lastBleInfoAt)，
// 切到别的页面就失效；而别处读 0x01 的地方（连接收尾、一键清空后、图库删除/刷屏后）各读各的——
// 2026-07-27 起按产品要求取消 15s 读取节流：每次页面需要设备信息都真实读取一次。
// 这里只保留同一 deviceId 的在途 Promise 共享，避免并发请求撞设备 CMD_PENDING；读取完成后不按时间复用。
//
// 电量展示不使用本模块结果：统一由 utils/battery.js 每次发送 0x04 GET_BATTERY，
// 从而排除 0x01 缓存、跨页 selectedDevice 历史值等多来源干扰。

const deviceBle = require('./device-ble')

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

// 登记一次真实读取的结果
function put(deviceId, info) {
  cachedDeviceId = deviceId
  cachedInfo = info
  cachedAt = Date.now()
  return info
}

// 只看最近一次结果、绝不触发 BLE 读；仅保留给诊断场景，业务展示不调用。
function peek(deviceId) {
  if (!isValidFor(deviceId)) {
    return null
  }
  return { info: cachedInfo, at: cachedAt }
}

// 取设备信息：每次调用都真实读一次 0x01；同设备已有请求在途时共享该 Promise。
// options 参数仅为兼容旧调用方保留，force 与普通读取现在行为一致。
function read(deviceId, options) {
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

// 作废最近结果。read 本身始终真读，本方法只防其它诊断代码 peek 到写操作前的信息。
function invalidate() {
  cachedInfo = null
  cachedAt = 0
}

// 彻底清空：连 info 一起丢。断链时由 isValidFor 自动调用，调用方通常不必手动调。
function clear() {
  cachedDeviceId = ''
  cachedInfo = null
  cachedAt = 0
}

module.exports = {
  peek,
  put,
  read,
  invalidate,
  clear
}
