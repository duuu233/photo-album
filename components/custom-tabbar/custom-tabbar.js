Component({
  properties: {
    active: {
      type: String,
      value: 'home'
    },
    safeBottom: {
      type: Number,
      value: 0
    },
    dimmed: {
      type: Boolean,
      value: false
    }
  },

  // 2026-08-21：底栏收回两格（首页 / 我的）。原来中间两格是「AI助手」「官方图库」——
  // 它们本就不是 tab 页（各自在分包里，靠 navigateTo 进），现在入口统一收到首页六宫格，
  // 本组件随之删掉 goAi/goGallery 与 aiEntryEnabled/galleryEntryEnabled 两个灰度开关；
  // 「接着上次那一页」的 AI 续聊规则没丢，跟着入口搬到了 pages/home/home.js 的 goAi。
  methods: {
    switchToHome() {
      if (this.data.active === 'home') {
        return
      }

      wx.switchTab({
        url: '/pages/home/home'
      })
    },

    switchToMine() {
      if (this.data.active === 'mine') {
        return
      }

      wx.switchTab({
        url: '/pages/mine/mine'
      })
    }
  }
})
