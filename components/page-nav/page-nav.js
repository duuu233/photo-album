// 通用自定义导航栏组件：标题/副标题、返回按钮、右侧操作；immersive 控制是否沉浸式。
Component({
  externalClasses: ['custom-class'],

  properties: {
    title: {
      type: String,
      value: ''
    },
    subtitle: {
      type: String,
      value: ''
    },
    showBack: {
      type: Boolean,
      value: true
    },
    rightText: {
      type: String,
      value: ''
    },
    immersive: {
      type: Boolean,
      value: false
    }
  },

  methods: {
    // 返回：有上级页面则正常返回，否则兜底回首页（防止栈底无处可退）
    handleBack() {
      const pages = getCurrentPages()

      if (pages.length > 1) {
        wx.navigateBack()
        return
      }

      wx.switchTab({
        url: '/pages/home/home'
      })
    },

    handleRight() {
      this.triggerEvent('righttap')
    }
  }
})
