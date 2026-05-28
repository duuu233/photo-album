const api = require('../../../utils/api')
const system = require('../../../utils/system')

const THUMB_TYPES = {
  success: ['landscape', 'cat', 'pets', 'sunset'],
  fail: ['dog', 'white-dog']
}

function normalizeRecord(item, index, groupIndex) {
  const status = item.status === 'success' ? 'success' : 'fail'
  const thumbs = THUMB_TYPES[status]

  return Object.assign({}, item, {
    status,
    statusText: status === 'success' ? '投屏成功' : '投屏失败',
    message: item.message || (status === 'success' ? '投屏成功' : '设备连接中断'),
    createdAt: item.createdAt || '2026-05-19 12:20',
    thumbType: thumbs[groupIndex % thumbs.length],
    sortIndex: index
  })
}

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

  async loadRecords() {
    const sourceRecords = await api.getProjectionRecords()
    const groupCounts = {
      success: 0,
      fail: 0
    }
    const records = sourceRecords.map((item, index) => {
      const status = item.status === 'success' ? 'success' : 'fail'
      const normalized = normalizeRecord(item, index, groupCounts[status])
      groupCounts[status] += 1
      return normalized
    })
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
    wx.showToast({
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
