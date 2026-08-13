// 蓝牙通知的全局单一分发器（2026-08-13 第二轮，续修「OTA 后指令失效/连不上」）。
//
// 为什么要有这一层：device-ble(FF00) 与 ota-ble(FF10) 此前各自往 wx.onBLECharacteristicValueChange /
// wx.onBLEConnectionStateChange 上挂一份监听，蓝牙栈硬复位后各自「off(自己的引用) 再 on」重挂。
// 这套做法把宝押在了两个没有保证的行为上：
//   ① wx.onBLE* 在所有机型上都是「累加注册」；
//   ② wx.offBLE*(fn) 在所有机型上都能按引用精确移除那一个。
// 真机上任何一条不成立，重挂就会出事，且两种错法产生的都是本轮要治的症状本身：
//   · off(fn) 实际移除了**全部**监听（部分实现忽略入参）→ 后重挂的模块把先重挂的那份又清掉了，
//     device-ble 的 FF00 通知从此没人接收 → 连接能建立、0x01 却永远「应答超时」→
//     「升级成功后设备连不上/指令失效」，直到重启小程序（重新走一遍首次注册）才恢复；
//   · on 是「替换语义」→ 同上，只剩最后注册的那个模块能收到通知；
//   · off(fn) 没移除成功而 on 又累加 → 每帧派发两遍，解帧缓冲灌两份，同样全部指令超时。
//
// 这里改成：wx 层面**只注册一个分发器**（本模块的 dispatchValue/dispatchState，引用永远稳定），
// 两个业务模块把自己的处理函数按 key 挂到分发器名下。复位后的重挂变成
// 「off **不带参数**（各基础库口径一致的“移除全部”）→ 重新 on 这一个分发器」——
// 上面三种机型差异下，结局都是**恰好一份**注册。
//
// ⚠️ off 不带参数会把 wx 层的同名监听全部移除。全项目 wx.onBLE* 只有 device-ble/ota-ble 两处
//（都已迁到本分发器名下），新增直接注册点前必须先迁进来，否则会在复位时被这里清掉。

// 按 key 登记的业务处理函数：'device-ble' / 'ota-ble'。同 key 重复登记按「替换」处理——
// 单测 freshRequire 出新模块实例时，旧实例的处理函数（还闭包着旧会话账本）必须被顶掉。
const valueTargets = {}
const stateTargets = {}

// 已把分发器注册到哪个 wx 对象上。真机上 wx 恒为同一个对象、只会注册一次；
// 单测里每个用例换一个全新的 global.wx，据此识别并自动在新对象上重新注册。
let boundWx = null

function currentWx() {
  return typeof wx !== 'undefined' && wx ? wx : null
}

// 引用永远稳定的两个分发器：off/on 轮回多少次，wx 层见到的都是同一个函数
function dispatchValue(res) {
  Object.keys(valueTargets).forEach(key => {
    try {
      valueTargets[key](res)
    } catch (error) {
      // 单个模块的处理异常不能影响另一个模块收通知
    }
  })
}

function dispatchState(res) {
  Object.keys(stateTargets).forEach(key => {
    try {
      stateTargets[key](res)
    } catch (error) {
      // 同上
    }
  })
}

function ensureBound() {
  const w = currentWx()
  if (!w || boundWx === w) {
    return
  }
  boundWx = w
  if (w.onBLECharacteristicValueChange) {
    w.onBLECharacteristicValueChange(dispatchValue)
  }
  if (w.onBLEConnectionStateChange) {
    w.onBLEConnectionStateChange(dispatchState)
  }
}

// 业务模块登记处理函数。handlers: { onValueChange?, onStateChange? }。幂等：同 key 覆盖。
function subscribe(key, handlers) {
  if (handlers && typeof handlers.onValueChange === 'function') {
    valueTargets[key] = handlers.onValueChange
  }
  if (handlers && typeof handlers.onStateChange === 'function') {
    stateTargets[key] = handlers.onStateChange
  }
  ensureBound()
}

// 蓝牙栈硬复位后的重挂：off 不带参数（移除全部）→ 重新 on 分发器。
// off 接口不可用的老基础库上什么都不做（保持原注册），返回 false —— 与旧行为一致：
// 那些机型上 closeBluetoothAdapter 若不清回调则原注册仍有效，清了也没有更好的补救。
function rebind() {
  const w = currentWx()
  if (!w || !w.offBLECharacteristicValueChange || !w.offBLEConnectionStateChange) {
    return false
  }
  w.offBLECharacteristicValueChange()
  w.offBLEConnectionStateChange()
  boundWx = null
  ensureBound()
  return true
}

module.exports = {
  subscribe,
  ensureBound,
  rebind
}
