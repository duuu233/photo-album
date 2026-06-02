// 电量图标统一映射层：把后端返回的电量百分比（0~100）映射到
// assets/images/BatteryLevel 下对应的图标（每 10% 一档）。
// 后续对接真实接口时，只要保证 device.battery 为 0~100 的数值，
// 调用 getBatteryIcon(device.battery) 即可拿到匹配的图标路径，无需改动页面其它逻辑。

// 现有的一组电量图标档位（对应 BatteryLevel/battery-{n}.png）
const BATTERY_LEVELS = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]

// 接口未返回电量时的默认展示值（接通真实数据后会被覆盖）
const DEFAULT_BATTERY = 100

// 把任意电量值规整为 0~100 的整数，非法值回落到默认值
function clampBattery(value) {
  const number = Number(value)
  if (Number.isNaN(number)) {
    return DEFAULT_BATTERY
  }
  return Math.max(0, Math.min(100, Math.round(number)))
}

// 取离当前电量最近的档位，返回对应的图标路径
function getBatteryIcon(value) {
  const level = clampBattery(value)
  const nearest = BATTERY_LEVELS.reduce((prev, curr) =>
    Math.abs(curr - level) < Math.abs(prev - level) ? curr : prev
  )
  return `/assets/images/BatteryLevel/battery-${nearest}.png`
}

module.exports = {
  DEFAULT_BATTERY,
  clampBattery,
  getBatteryIcon
}
