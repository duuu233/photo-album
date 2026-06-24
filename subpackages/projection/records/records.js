const api = require('../../../utils/api')
const system = require('../../../utils/system')
const toast = require('../../../utils/toast')

Page({
  data: {
    statusBarHeight: 20,
    safeBottom: 0,
    records: [],
    filteredRecords: [],
    filter: 'success',
    counts: {
      success: 0,
      fail: 0
    }
  },

  onLoad() {
    this.setSystemMetrics()
  },

  onShow() {
    this.loadRecords()
  },

  setSystemMetrics() {
    this.setData(system.getLayoutMetrics())
  },

  goBack() {
    const pages = getCurrentPages()

    if (pages.length > 1) {
      wx.navigateBack()
      return
    }

    wx.switchTab({
      url: '/pages/mine/mine'
    })
  },

  // 加载投屏记录：数据已在 api 层归一化，这里只按成功/失败统计供顶部标签使用
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

  retryProjection() {
    toast.show({
      title: '请重新选择照片投屏',
      icon: 'none'
    })
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
