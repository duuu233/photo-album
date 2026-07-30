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
    aiEntryEnabled: true
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
