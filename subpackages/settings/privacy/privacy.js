const fold = require('../../../utils/fold-adapt')
const content = require('./privacy-content')

// 折叠屏/分屏适配：Page 配置外面包一层 fold.adapt（方案见 utils/fold-adapt.js 与
// styles/fold-adapt.wxss）。只叠加「形态变化后重测状态栏/安全区」等钩子，页面原有配置一字不改。
Page(fold.adapt({
  data: {
    statusBarHeight: 20,
    // 正文来自法务给的整篇 HTML（见 privacy-content.js 文件头），页面只负责渲染。
    // wx:key 需要稳定值，区块本身没有 id，进 data 前按下标补一个。
    docMeta: content.meta,
    blocks: content.blocks.map((item, index) =>
      Object.assign({ key: 'b' + index }, item)
    )
  },

  onLoad() {
    try {
      const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
      this.setData({ statusBarHeight: info.statusBarHeight || 20 })
    } catch (error) {
      this.setData({ statusBarHeight: 20 })
    }
  },

  goBack() {
    wx.navigateBack()
  }
}))
