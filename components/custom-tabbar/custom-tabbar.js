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
