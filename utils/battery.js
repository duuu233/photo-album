// 电量统一收口层：图标映射 + 新鲜度判定 + 展示文案。
//
// 为什么需要「新鲜度」这一层：
// 电量只有一个真实来源——BLE 指令 0x01(GET_INFO) 的 Battery 字节。**后端不存这个字段**，
// 所以页面上看到的值全部来自「上次 BLE 读到后写进 selectedDevice 的缓存」。而 selectedDevice
// 会 wx.setStorageSync 落盘（见 app.js setSelectedDevice）且永不失效，冷启动后依然在——
// 不加时效的话，首页会把几天前的电量当成当前值展示，还带着百分比和图标，用户完全分辨不出真假。
//
// 因此三侧统一走本模块：
//   · 写入侧 stampBattery()   —— 每次 BLE 读到就打时间戳
//   · 读取侧 resolveBattery() —— 未连接/无时间戳/超时一律返回 null(未知)
//   · 展示侧 batteryText()    —— 未知显示 '--'，绝不用任何假数值冒充
//
// 历史包袱（已废除）：首页曾用常量 30、本模块曾用 DEFAULT_BATTERY=100 给未知电量兜底。
// 两个假值都会被写回缓存并横向扩散到别的页面，是「来回切页面电量一直在变」的直接成因。

// 现有的一组电量图标档位（对应 BatteryLevel/battery-{n}.png）
const BATTERY_LEVELS = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]

// 电量缓存有效期。电量变化慢，10 分钟内的读数仍可信；再久就宁可显示未知，
// 也不要把陈旧值伪装成当前值。这是本方案唯一的产品口径旋钮，要调只改这里。
const BATTERY_TTL_MS = 10 * 60 * 1000

// 未知电量的统一占位文案（与详情页 memory/设备ID 行的 '--' 约定一致）
const UNKNOWN_BATTERY_TEXT = '--'

// 未知电量的图标档位。没有专门的「未知」图标资源，退而取空档：
// 与 '--' 文案搭配读作「没有读数」，比取满档（旧的 DEFAULT_BATTERY=100）谎报满电要好。
// 后续若补了 battery-unknown.png，只改这里。
const UNKNOWN_ICON_LEVEL = 0

// 归一化：合法的 0~100 数值返回整数，其余一律 null(未知)。
// 注意这里**不再有「非法值兜底成某个数字」**——兜底假值正是要根治的问题。
function normalizeBattery(value) {
  if (value === null || value === undefined || value === '') {
    return null
  }
  const number = Number(value)
  if (!Number.isFinite(number)) {
    return null
  }
  return Math.max(0, Math.min(100, Math.round(number)))
}

// 写入侧：把一次 BLE 读到的电量打上时间戳，供 setSelectedDevice / setData 合并。
// 读不到时返回 battery=null、batteryAt=null，**主动覆盖掉更早的陈旧值**——
// 不要把上一次的旧值留在那里继续冒充新值。
function stampBattery(value) {
  const battery = normalizeBattery(value)
  return {
    battery,
    batteryAt: battery === null ? null : Date.now()
  }
}

// 读取侧：从设备记录里取出当前可信的电量，未知返回 null。
// 三道闸：
//   ① 未连接一律未知——断开期间设备仍在耗电，上次读到的值不能代表现在；
//   ② 没有 batteryAt 视为未知——来路不明的历史值（含本次改动前落盘的旧缓存）不予采信；
//   ③ 超过 BATTERY_TTL_MS 视为未知。
function resolveBattery(device) {
  if (!device || !device.connected) {
    return null
  }
  const battery = normalizeBattery(device.battery)
  if (battery === null) {
    return null
  }
  const at = Number(device.batteryAt)
  if (!Number.isFinite(at) || at <= 0) {
    return null
  }
  if (Date.now() - at > BATTERY_TTL_MS) {
    return null
  }
  return battery
}

// 展示侧：'87%' 或 '--'。页面直接把返回值塞进 setData，模板不再自己拼 '%'。
function batteryText(device) {
  const battery = resolveBattery(device)
  return battery === null ? UNKNOWN_BATTERY_TEXT : `${battery}%`
}

// 取离当前电量最近的档位，返回对应的图标路径。传 null/非法值取未知档。
function getBatteryIcon(value) {
  const level = normalizeBattery(value)
  const target = level === null ? UNKNOWN_ICON_LEVEL : level
  const nearest = BATTERY_LEVELS.reduce((prev, curr) =>
    Math.abs(curr - target) < Math.abs(prev - target) ? curr : prev
  )
  return `/assets/images/BatteryLevel/battery-${nearest}.png`
}

// 展示侧配套：直接按设备记录取图标（已应用连接态/时效判定）
function batteryIconOf(device) {
  return getBatteryIcon(resolveBattery(device))
}

module.exports = {
  BATTERY_TTL_MS,
  UNKNOWN_BATTERY_TEXT,
  normalizeBattery,
  stampBattery,
  resolveBattery,
  batteryText,
  getBatteryIcon,
  batteryIconOf
}
