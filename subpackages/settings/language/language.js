const toast = require('../../../utils/toast')

Page({
  data: {
    statusBarHeight: 20,
    safeBottom: 0,
    selected: 'zh-Hans',
    languages: [
      { label: '简体中文', value: 'zh-Hans' },
      { label: '繁体中文', value: 'zh-Hant' },
      { label: 'English', value: 'en' },
      { label: '日本语', value: 'ja' }
    ]
  },

  onLoad() {
    this.setSystemMetrics()
  },

  setSystemMetrics() {
    try {
      const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
      const safeBottom = Math.max(0, (info.screenHeight || 0) - (info.safeArea ? info.safeArea.bottom : info.windowHeight || 0))
      this.setData({
        statusBarHeight: info.statusBarHeight || 20,
        safeBottom
      })
    } catch (error) {
      this.setData({
        statusBarHeight: 20,
        safeBottom: 0
      })
    }
  },

  selectLanguage(event) {
    this.setData({
      selected: event.currentTarget.dataset.value
    })
  },

  saveLanguage() {
    toast.show({
      title: '已保存',
      icon: 'none'
    })
  },

  goBack() {
    wx.navigateBack()
  }
})
