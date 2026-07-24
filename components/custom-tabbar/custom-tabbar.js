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
    // AI生图入口开关：当前需求为「暂时屏蔽入口，后续再开放」。false 时隐藏中间 AI 按钮
    // （wx:else 空占位保住三栏布局），后续开放时置 true 即恢复。屏蔽期可走调试台底部暗门临时进入。
    aiEntryEnabled: false
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
