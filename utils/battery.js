// 电量统一收口层：实时读取 + 合法性校验 + 图标/文案。
//
// 2026-07-27 产品口径：业务页面每次需要展示电量时，都真实发送 0x04 GET_BATTERY；
// 不再使用 device-info 的 15s 读取缓存，也不再用 selectedDevice 里跨页/落盘的旧电量。
// 读取失败直接显示「--」，这样继续观察到的数值变化就来自同一条 0x04 设备应答链路，便于判断设备端波动。
//
// 同一 deviceId 的并发展示请求只共享「正在进行的那一次」真实读取，完成后立即释放；
// 这是防 CMD_PENDING 的在途去重，不是按时间复用结果。
//
// 历史包袱（已废除）：首页曾用常量 30、本模块曾用 DEFAULT_BATTERY=100 给未知电量兜底。
// 两个假值都会被写回缓存并横向扩散到别的页面，是「来回切页面电量一直在变」的直接成因。
const deviceBle = require('./device-ble')

// 现有的一组电量图标档位（对应 BatteryLevel/battery-{n}.png）
const BATTERY_LEVELS = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]

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

// 写入侧：把本次 BLE 读到的电量打上时间戳，供当前页面 setData 使用。
// 读不到时返回 battery=null、batteryAt=null，**主动覆盖掉更早的陈旧值**——
// 不要把上一次的旧值留在那里继续冒充新值。
function stampBattery(value) {
  const battery = normalizeBattery(value)
  return {
    battery,
    batteryAt: battery === null ? null : Date.now()
  }
}

// 读取侧：只认当前页面真实读取后带时间戳写入的数据；页面进入时会先清旧值再发 0x04。
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

// 每次调用都会真实发送 0x04；唯一例外是同一设备同一时刻已有 0x04 在途，此时共享该 Promise，
// 避免设备返回 CMD_PENDING。成功/失败都打印统一日志，真机上可据此直接核对设备每次返回的原始值。
function readLatestBattery(deviceId) {
  const id = String(deviceId || '')
  if (!id) {
    return Promise.resolve(stampBattery(null))
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
          rawBattery
        })
      } else {
        console.info('[设备电量][0x04] 实时读取成功', {
          deviceId: id,
          rawBattery,
          battery: result.battery
        })
      }
      delete inflightReads[id]
      return result
    },
    error => {
      delete inflightReads[id]
      console.warn('[设备电量][0x04] 实时读取失败', {
        deviceId: id,
        error: (error && error.message) || error
      })
      return stampBattery(null)
    }
  )
  return inflightReads[id]
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
  UNKNOWN_BATTERY_TEXT,
  normalizeBattery,
  stampBattery,
  readLatestBattery,
  resolveBattery,
  batteryText,
  getBatteryIcon,
  batteryIconOf
}
