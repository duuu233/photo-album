const api = require('../../../utils/api')

const app = getApp()

Page({
  deleteAccount() {
    wx.showModal({
      title: '注销账号',
      content: '注销会清除本地模拟账号、设备、相册和投屏记录。真实项目需后端确认注销状态。',
      confirmText: '注销',
      confirmColor: '#c72e2e',
      success: async res => {
        if (!res.confirm) {
          return
        }

        await api.deleteAccount()
        app.clearSession()
        wx.reLaunch({
          url: '/pages/home/home'
        })
      }
    })
  }
})
