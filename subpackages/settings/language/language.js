const system = require('../../../utils/system')

Page({
  data: {
    languageInfo: null
  },

  onShow() {
    this.setData({
      languageInfo: system.getSystemLanguageInfo()
    })
  }
})
