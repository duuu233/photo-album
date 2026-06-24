const api = require('../../../utils/api')
const system = require('../../../utils/system')
const toast = require('../../../utils/toast')

Page({
  data: {
    statusBarHeight: 20,
    safeBottom: 0,
    records: [],
    filteredRecords: [],
    filter: 'success'
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

  // 成功/失败标签 → 设备上传状态参数：成功=1，失败=0
  filterToUploadState(filter) {
    return filter === 'success' ? 1 : 0
  },

  // 按当前标签向后端请求对应状态的投屏记录（成功 deviceUploadState=1 / 失败=0），
  // 不再一次性拉全部再本地筛。数据已在 api 层归一化。
  async loadRecords(filter = this.data.filter) {
    const records = await api.getProjectionRecords({
      deviceUploadState: this.filterToUploadState(filter)
    })
    this.setData({
      filter,
      records,
      // 后端已按状态过滤；再按 status 兜底过滤一层，兼容后端忽略该参数的情况
      filteredRecords: records.filter(item => item.status === filter)
    })
  },

  switchFilter(e) {
    const filter = e.currentTarget.dataset.filter
    if (filter === this.data.filter) {
      return
    }
    this.loadRecords(filter)
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
