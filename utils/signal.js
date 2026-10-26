// 信号强度 → 信号格数（2026-10-26，仿 iPhone 信号格：满格 4 格、最弱 1 格、未知 0 格全灰）。
// 门槛与 utils/bluetooth.js 的文字档位同一组（已按产品口径保守下调一级）：
//   ≥ -55dBm 强 → 4 格；≥ -67 正常 → 3 格；≥ -78 偏弱 → 2 格；更弱 → 1 格；缺省(0) / 非法(≥0) → 0 格。
// 蓝牙广播 RSSI（搜索设备列表）和设备扫到的 WiFi RSSI（WiFi 列表）都按这一套显示。
function rssiToLevel(rssi) {
  const value = Number(rssi)
  if (!value || value >= 0) {
    return 0
  }
  if (value >= -55) return 4
  if (value >= -67) return 3
  if (value >= -78) return 2
  return 1
}

module.exports = {
  rssiToLevel
}
