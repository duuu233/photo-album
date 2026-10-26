// 信号格（2026-10-26）：仿 iPhone 状态栏的 4 根由低到高的竖条，按 level 点亮（绿色）——满格 4、最弱 1、未知 0（全灰）。
// level 由 utils/signal.js rssiToLevel 算好传进来；size: small（跟 22rpx 小字同行）/ normal（列表行尾）。
Component({
  properties: {
    level: {
      type: Number,
      value: 0
    },
    size: {
      type: String,
      value: 'normal'
    }
  }
})
