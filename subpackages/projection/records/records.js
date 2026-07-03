const api = require('../../../utils/api')
const system = require('../../../utils/system')
const toast = require('../../../utils/toast')
const activeDevice = require('../../../utils/active-device')

Page({
  data: {
    statusBarHeight: 20,
    safeBottom: 0,
    records: [],
    filteredRecords: [],
    filter: 'success',
    loading: true
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
    // 首屏渲染即 loading=true，等接口返回再决定展示列表还是空态，避免空态先闪一下。
    // 切换标签/二次进入时已有内容，不再回到 loading，沿用旧内容直到新数据到位。
    try {
      const records = await api.getProjectionRecords({
        deviceUploadState: this.filterToUploadState(filter)
      })
      this.setData({
        filter,
        records,
        // 后端已按状态过滤；再按 status 兜底过滤一层，兼容后端忽略该参数的情况
        filteredRecords: records.filter(item => item.status === filter),
        loading: false
      })
    } catch (error) {
      // 接口失败时 api 层已 toast 提示，这里仅结束 loading，落到空态
      this.setData({ loading: false })
    }
  },

  switchFilter(e) {
    const filter = e.currentTarget.dataset.filter
    if (filter === this.data.filter) {
      return
    }
    this.loadRecords(filter)
  },

  // 再次/重新投屏：用记录里的服务器图片地址重新走一遍正常投屏链路。
  // 就算当前没连接设备，也先扫描+连接设备，连上后再跳投屏预览页，由结果页从服务器拉取文件并 BLE 图传。
  async retryProjection(e) {
    const id = e.currentTarget.dataset.id
    const record =
      this.data.filteredRecords.find(item => item.id === id) ||
      this.data.records.find(item => item.id === id)
    if (!record) {
      return
    }

    // 记录归一化时 thumbUrl 已按 img → thumbUrl → url 兜底取到服务器图片地址
    const imageUrl = record.thumbUrl || record.img || record.url
    if (!imageUrl) {
      toast.warn({ title: '该记录没有可投屏的图片', icon: 'none' })
      return
    }

    // 先确保与当前设备建立蓝牙连接（未连接会自动扫描+连接；无设备/连不上会弹窗引导去首页）。
    // 满足「就算没连接设备，点投屏也要先连设备再投屏」。
    let device
    try {
      device = await activeDevice.ensureActiveDeviceConnection()
    } catch (error) {
      return // 提示已由 ensureActiveDeviceConnection 弹出
    }

    // 复用正常投屏链路：把该图片(服务器地址)与设备写入 Storage，跳投屏预览页；
    // 用户确认后由结果页从服务器下载转换后的帧数据并 BLE 图传到设备。
    wx.setStorageSync('pendingProjection', {
      device,
      images: [{ url: imageUrl }]
    })
    wx.navigateTo({
      url: '/subpackages/projection/preview/preview'
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
