const toast = require('../../../utils/toast')
const language = require('../../../utils/language')

Page({
  data: {
    statusBarHeight: 20,
    safeBottom: 0,
    selected: 'zh-Hans',
    languages: [
      { label: '简体中文', value: 'zh-Hans' },
      { label: '繁体中文', value: 'zh-Hant' },
      { label: 'English', value: 'en' },
      { label: '日本語', value: 'ja' }
    ]
  },

  onLoad() {
    this.setSystemMetrics()
    // 回显当前生效语种（用户选过的优先，否则跟随系统），
    // 之前固定显示简体中文，和实际请求用的语种对不上。
    this.setData({ selected: language.getSelectedLanguage() })
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
    // 之前这里只弹「已保存」，选择从没落盘 —— 后端 language 参数始终按系统语言走。
    // 现在落盘到 utils/language，请求层（header + query 的 language）立刻生效，
    // 常见问题等按语种返回的内容会在下次进入时按新语种拉取。
    language.setSelectedLanguage(this.data.selected)
    toast.show({
      title: '已保存',
      icon: 'none'
    })
  },

  goBack() {
    wx.navigateBack()
  }
})
