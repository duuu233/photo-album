// 电量统一收口层：15 秒结果缓存 + 在途去重 + 合法性校验 + 图标/文案。
//
// 2026-07-27 最终产品口径：页面先展示最近一次有效电量，不在刷新前清空成「--」；
// 15 秒内复用同一设备最近一次 0x04 结果，过期后后台读取，成功再平滑替换。
// 读取失败保留旧值，避免「旧值 → -- → 真值」闪烁；没有任何历史有效值时才显示「--」。
//
// 历史包袱（已废除）：首页曾用常量 30、本模块曾用 DEFAULT_BATTERY=100 给未知电量兜底。
// 两个假值都会被写回缓存并横向扩散到别的页面，是「来回切页面电量一直在变」的直接成因。
const deviceBle = require('./device-ble')

// 现有的一组电量图标档位（对应 BatteryLevel/battery-{n}.png）
const BATTERY_LEVELS = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]

// 同一设备 15 秒内不重复发送 0x04。电量变化慢，这个窗口足以消除页面切换造成的
// 连续读和数值抖动，同时又不会长期冻结电量。
const BATTERY_CACHE_TTL_MS = 15 * 1000

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
  if (!Number.isFinite(number) || number < 0 || number > 100) {
    return null
  }
  return Math.round(number)
}

// 写入侧：把一次 BLE 读到的电量打上时间戳，供当前页面和 selectedDevice 缓存使用。
function stampBattery(value) {
  const battery = normalizeBattery(value)
  return {
    battery,
    batteryAt: battery === null ? null : Date.now()
  }
}

// 展示侧不按 15 秒窗口主动隐藏旧值：TTL 只决定是否重新发 BLE。
// 页面刷新时旧值继续可见，后台真读成功后再替换，失败也不会闪成「--」。
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
  return battery
}

const inflightReads = {}
const cachedReads = {}

function cacheState(deviceId, state) {
  const id = String(deviceId || '')
  const battery = state && normalizeBattery(state.battery)
  const at = Number(state && state.batteryAt)
  if (!id || battery === null || !Number.isFinite(at) || at <= 0) {
    return null
  }
  const previous = cachedReads[id]
  if (previous && previous.batteryAt > at) {
    return previous
  }
  const cached = { battery, batteryAt: at }
  cachedReads[id] = cached
  return cached
}

function cachedState(deviceId, fallback) {
  const id = String(deviceId || '')
  const fromFallback = fallback && cacheState(id, fallback)
  return fromFallback || cachedReads[id] || null
}

// 默认 15 秒内复用缓存；超窗后真读 0x04。同一设备并发请求共享在途 Promise。
// options.fallback 可传页面当前设备，用于把 selectedDevice/页面里的最近值注入本模块缓存；
// options.force=true 仅供明确要求立即刷新（如诊断）时跳过 TTL，但仍保留失败回退。
function readLatestBattery(deviceId, options) {
  const id = String(deviceId || '')
  if (!id) {
    return Promise.resolve(stampBattery(null))
  }
  const fallback = cachedState(id, options && options.fallback)
  const force = !!(options && options.force)
  if (
    !force &&
    fallback &&
    Date.now() - fallback.batteryAt <= BATTERY_CACHE_TTL_MS
  ) {
    console.info('[设备电量][0x04] 命中15秒缓存', {
      deviceId: id,
      battery: fallback.battery
    })
    return Promise.resolve(fallback)
  }
  if (inflightReads[id]) {
    return inflightReads[id]
  }

  inflightReads[id] = deviceBle.readBattery(id).then(
    rawBattery => {
      const result = stampBattery(rawBattery)
      if (result.battery === null) {
        console.warn('[设备电量][0x04] 设备返回非法电量', {
          deviceId: id,
          rawBattery,
          fallbackBattery: fallback && fallback.battery
        })
      } else {
        cacheState(id, result)
        console.info('[设备电量][0x04] 刷新成功', {
          deviceId: id,
          rawBattery,
          battery: result.battery
        })
      }
      delete inflightReads[id]
      return result.battery === null && fallback ? fallback : result
    },
    error => {
      delete inflightReads[id]
      console.warn('[设备电量][0x04] 实时读取失败', {
        deviceId: id,
        error: (error && error.message) || error,
        fallbackBattery: fallback && fallback.battery
      })
      return fallback || stampBattery(null)
    }
  )
  return inflightReads[id]
}

// 丢掉这台设备的电量缓存与在途读取（2026-08-11）。
// 用于「设备刚被重启」这类缓存必然失真的时刻——典型是 OTA 升级结束：设备约 100ms 后复位，
// 15 秒 TTL 内的旧电量会被继续展示，而链路其实已经断了。
function forget(deviceId) {
  const id = String(deviceId || '')
  if (!id) {
    return
  }
  delete cachedReads[id]
  delete inflightReads[id]
}

// 单测隔离用；业务代码不调用。
function clearCacheForTest() {
  Object.keys(cachedReads).forEach(key => delete cachedReads[key])
  Object.keys(inflightReads).forEach(key => delete inflightReads[key])
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
  BATTERY_CACHE_TTL_MS,
  UNKNOWN_BATTERY_TEXT,
  normalizeBattery,
  stampBattery,
  readLatestBattery,
  resolveBattery,
  batteryText,
  getBatteryIcon,
  batteryIconOf,
  forget,
  clearCacheForTest
}
