const api = require('../../../utils/api')

Page({
  data: {
    records: []
  },

  onShow() {
    this.loadRecords()
  },

  async loadRecords() {
    const records = await api.getProjectionRecords()
    this.setData({
      records
    })
  },

  deleteRecord(e) {
    const id = e.currentTarget.dataset.id

    wx.showModal({
      title: '删除记录',
      content: '仅删除投屏记录，不影响相册照片。',
      confirmText: '删除',
      confirmColor: '#c72e2e',
      success: async res => {
        if (!res.confirm) {
          return
        }

        await api.deleteProjectionRecord(id)
        this.loadRecords()
      }
    })
  }
})
