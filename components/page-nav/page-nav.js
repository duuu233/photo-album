Component({
  externalClasses: ['custom-class'],

  properties: {
    title: {
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
    customBack: {
      type: Boolean,
      value: false
    },
    immersive: {
      type: Boolean,
      value: false
    }
  },

  data: {
    statusBarHeight: 20,
    navHeight: 64,
    rowTop: 6,
    rowHeight: 32,
    capsuleSpace: 96
  },

  lifetimes: {
    attached() {
      try {
        const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
        const statusBarHeight = info.statusBarHeight || 20
        const menu = wx.getMenuButtonBoundingClientRect ? wx.getMenuButtonBoundingClientRect() : null
        const hasMenu = menu && menu.width && menu.height && menu.top
        const rowTop = hasMenu ? Math.max(0, menu.top - statusBarHeight) : 6
        const rowHeight = hasMenu ? menu.height : 32
        const capsuleSpace = hasMenu ? Math.max(72, (info.windowWidth || 375) - menu.left) : 96

        this.setData({
          statusBarHeight,
          navHeight: statusBarHeight + rowTop * 2 + rowHeight,
          rowTop,
          rowHeight,
          capsuleSpace
        })
      } catch (error) {
        this.setData({
          statusBarHeight: 20,
          navHeight: 64,
          rowTop: 6,
          rowHeight: 32,
          capsuleSpace: 96
        })
      }
    }
  },

  methods: {
    handleBack() {
      if (this.data.customBack) {
        this.triggerEvent('backtap')
        return
      }

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
