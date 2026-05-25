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
