const api = require('../../../utils/api')

Page({
  data: {
    records: [],
    filteredRecords: [],
    filter: 'success',
    counts: {
      success: 0,
      fail: 0
    }
  },

  onShow() {
    this.loadRecords()
  },

  async loadRecords() {
    const records = await api.getProjectionRecords()
    const counts = records.reduce((result, item) => {
      if (item.status === 'success') {
        result.success += 1
      } else {
        result.fail += 1
      }
      return result
    }, {
      success: 0,
      fail: 0
    })

    this.setData({
      records,
      counts
    })
    this.applyFilter(this.data.filter, records)
  },

  applyFilter(filter, records) {
    this.setData({
      filter,
      filteredRecords: records.filter(item => item.status === filter)
    })
  },

  switchFilter(e) {
    this.applyFilter(e.currentTarget.dataset.filter, this.data.records)
  },

  deleteRecord(e) {
    const id = e.currentTarget.dataset.id

    wx.showModal({
      title: '删除记录',
      content: '仅删除投屏记录，不影响相册照片。',
      confirmText: '删除',
      confirmColor: '#c7372f',
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
