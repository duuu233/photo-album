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
    // 右侧入口的图标路径。传了它就画图标（优先级高于 rightText），空串＝仍按文字走。
    rightIcon: {
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
    capsuleSpace: 96,
    centerMaxWidth: 160
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

        const navHeight = statusBarHeight + rowTop * 2 + rowHeight
        this.setData({
          statusBarHeight,
          navHeight,
          rowTop,
          rowHeight,
          capsuleSpace,
          centerMaxWidth: this.computeCenterMaxWidth(info.windowWidth, capsuleSpace)
        })
        // 把实测导航高度回抛给页面：需要「窗口高度 − 导航高度」算滚动区的页面（首页折叠屏适配）
        // 直接用这份值，不再各自复算一遍状态栏 + 胶囊，避免两处算法漂移。不监听的页面无副作用。
        this.triggerEvent('measure', { navHeight, statusBarHeight })
      } catch (error) {
        this.setData({
          statusBarHeight: 20,
          navHeight: 64,
          rowTop: 6,
          rowHeight: 32,
          capsuleSpace: 96,
          centerMaxWidth: 160
        })
        this.triggerEvent('measure', { navHeight: 64, statusBarHeight: 20 })
      }
    }
  },

  methods: {
    /**
     * 居中内容（.nav-center）的最大宽度，px。
     *
     * 居中元素左右各留 (屏宽 − 自身宽)/2，所以「不碰胶囊」的条件是
     * 自身宽 ≤ 屏宽 − 2×胶囊占用宽 − 2×间距。右边让开胶囊的同时左边也自动让开了返回键
     * （返回键占的宽度比胶囊小）。
     *
     * 为什么在 JS 里算而不是写 calc()：胶囊宽度是 px 变量、页面里的尺寸是 rpx，
     * 混进 calc 在部分基础库上会整条失效（.nav-center 的 left 当年就为此写死 110rpx）。
     *
     * ⚠️ 必须放在 methods 里：`Component()` 只认它那几个固定字段，
     * 写在顶层的函数不会挂到组件实例上，`this.computeCenterMaxWidth` 会是 undefined。
     */
    computeCenterMaxWidth(windowWidth, capsuleSpace) {
      const GAP = 10 // 与胶囊之间至少留 10px，视觉上「有间距」而不是贴着
      const width = (windowWidth || 375) - capsuleSpace * 2 - GAP * 2
      // 下限 120：极窄屏 / 异常胶囊数据下也别把下拉压成一条缝，宁可挨近一点。
      return Math.max(120, Math.round(width))
    },

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
