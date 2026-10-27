// 信号格（2026-10-26）：仿 iPhone 状态栏的 4 根由低到高的竖条，按 level 点亮（绿色）——满格 4、最弱 1、未知 0（全灰）。
// level 由 utils/signal.js rssiToLevel 算好传进来；size: small（跟 22rpx 小字同行）/ normal（列表行尾）；
// tone: wifi 绿色（默认，WiFi 版设备与 WiFi 网络）/ ble 蓝色（蓝牙版设备），与搜索列表的「WiFi版 / 蓝牙版」标签同色。
Component({
  properties: {
    level: {
      type: Number,
      value: 0
    },
    size: {
      type: String,
      value: 'normal'
    },
    tone: {
      type: String,
      value: 'wifi'
    }
  }
})
