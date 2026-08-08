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

  data: {
    // AI 对话已正式开放。保留开关只用于后续灰度/应急下线，不再依赖调试台暗门。
    aiEntryEnabled: true,
    // 官方图库（2026-08-06 接入）。同上，开关只用于灰度/应急下线。
    // ⚠️ 图库数据目前由 `utils/gallery-api.js` 的 mock 提供，后端接口就位前不要对外灰度放量。
    galleryEntryEnabled: true
  },

  methods: {
    switchToHome() {
      if (this.data.active === 'home') {
        return
      }

      wx.switchTab({
        url: '/pages/home/home'
      })
    },

    // AI 对话不是 tab 页（分包页面），中间按钮 navigateTo 进入，返回即回当前 tab
    goAi() {
      if (this.data.active === 'ai') {
        return
      }
      wx.navigateTo({
        url: '/subpackages/ai/chat/chat'
      })
    },

    // 官方图库同 AI：分包页面，navigateTo 进入，不改变原生 TabBar 路由
    goGallery() {
      if (this.data.active === 'gallery') {
        return
      }
      wx.navigateTo({
        url: '/subpackages/gallery/list/list'
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
