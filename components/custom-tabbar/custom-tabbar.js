const aiLastSession = require('../../utils/ai-last-session')

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

    // AI 对话不是 tab 页（分包页面），中间按钮 navigateTo 进入，返回即回当前 tab。
    //
    // 2026-08-13 需求 5：再次点进来要**接着上次那一页**——上次是在某条会话里返回的就回那条会话，
    // 上次停在 AI 默认页返回的就还是默认页。记录由聊天页自己写、只活在本次运行里
    //（为什么不落 storage 见 utils/ai-last-session.js）。带 sessionId 进去时聊天页会直接载入
    // 那条会话的历史（chat.onLoad 的 options.sessionId 分支，与会话列表点进去是同一条路）。
    goAi() {
      if (this.data.active === 'ai') {
        return
      }
      const last = aiLastSession.get()
      const query = last.sessionId
        ? `?sessionId=${last.sessionId}&title=${encodeURIComponent(last.title || '')}`
        : ''
      wx.navigateTo({
        url: `/subpackages/ai/chat/chat${query}`
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
