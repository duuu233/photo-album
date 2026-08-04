const api = require('../../../utils/api')
const system = require('../../../utils/system')
const toast = require('../../../utils/toast')
const activeDevice = require('../../../utils/active-device')
const deviceIdUtil = require('../../../utils/device-id')

Page({
  data: {
    statusBarHeight: 20,
    safeBottom: 0,
    // 完整记录列表存实例字段 this.records（模板只渲染 filteredRecords，全量列表仅 retryProjection
    // 查找用），不进 data 省一份 setData 序列化传输
    filteredRecords: [],
    filter: 'success',
    deviceFilters: [],
    currentDeviceFilter: '',
    currentDeviceFilterLabel: '',
    showDeviceFilter: false,
    loading: true,
    loadError: false // 接口失败标记：走「加载失败+重新加载」，不再伪装成「暂无记录」
  },

  onLoad() {
    this.setSystemMetrics()
  },

  async onShow() {
    await this.loadDeviceFilters()
    this.loadRecords()
  },

  onUnload() {
    // 页面销毁后作废在途请求，避免慢接口回包继续向已卸载页面 setData。
    this.loadSeq = (this.loadSeq || 0) + 1
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

  async loadDeviceFilters() {
    let devices = []
    try {
      devices = await api.getDevices()
    } catch (error) {
      devices = []
    }
    const filters = (devices || [])
      .map((device, index) => {
        const value = String(device.userProductId || device.id || '')
        const serial = String(device.deviceNo || device.productDeviceId || '')
          .replace(/[:\-\s]/g, '')
        return {
          value,
          label: device.name || `设备${index + 1}`,
          serialTail: serial ? serial.slice(-4) : '',
          connected: !!activeDevice.findConnectedDeviceId(device)
        }
      })
      .filter(item => item.value)
      .sort((a, b) => Number(b.connected) - Number(a.connected))

    // 同名设备补序列号尾号，避免下拉里无法区分。
    const counts = {}
    filters.forEach(item => {
      counts[item.label] = (counts[item.label] || 0) + 1
    })
    filters.forEach((item, index) => {
      if (counts[item.label] > 1) {
        item.label = `${item.label} (${item.serialTail || index + 1})`
      }
    })

    const old = String(this.data.currentDeviceFilter || '')
    const current =
      filters.find(item => item.value === old) ||
      filters.find(item => item.connected) ||
      filters[0] ||
      null
    this.setData({
      deviceFilters: filters,
      currentDeviceFilter: current ? current.value : '',
      currentDeviceFilterLabel: current ? current.label : '',
      showDeviceFilter: false
    })
  },

  toggleDeviceFilter() {
    if (this.data.deviceFilters.length) {
      this.setData({ showDeviceFilter: !this.data.showDeviceFilter })
    }
  },

  selectDeviceFilter(e) {
    const value = String(e.currentTarget.dataset.value || '')
    const item = this.data.deviceFilters.find(filter => filter.value === value)
    if (!item || value === this.data.currentDeviceFilter) {
      this.setData({ showDeviceFilter: false })
      return
    }
    this.setData({
      currentDeviceFilter: value,
      currentDeviceFilterLabel: item.label,
      showDeviceFilter: false
    })
    this.loadRecords(this.data.filter, value)
  },

  // 按当前标签向后端请求对应状态的投屏记录（成功 deviceUploadState=1 / 失败=0），
  // 不再一次性拉全部再本地筛。数据已在 api 层归一化。
  async loadRecords(
    filter = this.data.filter,
    userProductId = this.data.currentDeviceFilter
  ) {
    // 点击 tab 时先同步切换选中态，再把列表区域换成局部 loading；不能继续展示上一个
    // tab 的记录，也不能等慢接口回包后才移动 tab 指示器。
    const seq = (this.loadSeq || 0) + 1
    this.loadSeq = seq
    this.records = []
    this.setData({
      filter,
      filteredRecords: [],
      loading: true,
      loadError: false
    })

    try {
      const records = await api.getProjectionRecords({
        deviceUploadState: this.filterToUploadState(filter),
        userProductId: userProductId || undefined
      })
      // 用户可能在慢请求期间又切了 tab：只允许最新一轮回写，防止旧响应倒灌。
      if (
        seq !== this.loadSeq ||
        filter !== this.data.filter ||
        userProductId !== this.data.currentDeviceFilter
      ) {
        return
      }
      this.records = records
      this.setData({
        // 后端已按状态过滤；再按 status 兜底过滤一层，兼容后端忽略该参数的情况
        filteredRecords: records.filter(item => item.status === filter),
        loading: false,
        loadError: false
      })
    } catch (error) {
      if (
        seq !== this.loadSeq ||
        filter !== this.data.filter ||
        userProductId !== this.data.currentDeviceFilter
      ) {
        return
      }
      // 接口失败时 api 层已 toast 提示；标记 loadError 展示「加载失败+重新加载」——
      // 落到「暂无记录」会让用户误以为记录被清空，且没有任何重试手段。
      this.setData({ loading: false, loadError: true })
    }
  },

  retryLoad() {
    this.loadRecords()
  },

  switchFilter(e) {
    const filter = e.currentTarget.dataset.filter
    if (filter === this.data.filter) {
      return
    }
    this.loadRecords(filter)
  },

  // 再次/重新投屏（2026-07-23 起与正常投屏完全同链路）：用记录里的服务器图片地址进预览页，
  // 之后与用户手选图片流程一致——点「开始投屏」时由结果页走 seekink 抖动接口出帧 + 图传 + 建记录。
  // 旧「imgBle(.bin) 直传」链路已删除：后端不再生成/返回 .bin，记录里没有可直传的设备帧了。
  // 就算当前没连接设备，也先扫描+连接设备，连上后再跳投屏预览页。
  // 在途锁：前置要跑 1-2 个网络请求+扫描连接，弱网下点了没反应会诱发连点，
  // 并发两条「查设备→连接→跳转」会双跳转报错（home.js 记录过同类 routeDone 崩点）。
  async retryProjection(e) {
    if (this._retrying) {
      return
    }
    this._retrying = true
    try {
      await this.doRetryProjection(e)
    } finally {
      this._retrying = false
    }
  },

  async doRetryProjection(e) {
    const id = e.currentTarget.dataset.id
    const record =
      this.data.filteredRecords.find(item => item.id === id) ||
      (this.records || []).find(item => item.id === id)
    if (!record) {
      return
    }

    // 记录归一化时 thumbUrl 已按 img → thumbUrl → url 兜底取到服务器图片地址
    const imageUrl = record.thumbUrl || record.img || record.url
    if (!imageUrl) {
      toast.warn({ title: '该记录没有可投屏的图片', icon: 'none' })
      return
    }

    // 自动寻找并连接「该记录对应的设备」（而非全局选中设备）：先按记录定位到这台设备，
    // 再自动扫描+连接它（未连接会按序列号扫描匹配再连；连不上/无权限有 toast 提示）。
    // 满足「点再次/重新投屏就自动找到并连上该记录的设备」，无需先去首页选设备。
    // 查设备列表是静默请求，补一个「准备中」loading 让点击即时有反馈（后续连接阶段有自己的 loading）
    wx.showLoading({ title: '准备中', mask: true })
    let targetDevice = null
    try {
      targetDevice = await this.resolveRecordDevice(record)
    } finally {
      wx.hideLoading()
    }
    if (
      !targetDevice ||
      !(
        targetDevice.deviceId ||
        targetDevice.bleDeviceId ||
        targetDevice.deviceNo ||
        targetDevice.productDeviceId ||
        targetDevice.name
      )
    ) {
      toast.warn({ title: '未找到该记录对应的电子纸设备，请前往首页确认电子纸设备', icon: 'none' })
      return
    }
    const connectedId = await activeDevice.ensureConnectedForAction(targetDevice)
    if (!connectedId) {
      return // 连不上，提示已由 ensureConnectedForAction 弹出（请先连接设备 / 权限引导）
    }
    const device = Object.assign({}, targetDevice, {
      deviceId: connectedId,
      bleDeviceId: connectedId,
      connected: true
    })

    // 预览/重转码用图优先取「图库里同一张照片的原图」（按 uProductImgId 关联）：
    // 记录里的 img 是后端按设备尺寸转换/压缩后的图，比例可能与原图不一致（预览会显得被拉伸），
    // 而图库 img 与首次投屏同源，能保证「投屏」与「再次投屏」进预览页显示一致；
    // 记录缺 uProductImgId / 照片已从图库删除 / 图库拉取失败时，退回记录里的图（保持可用）。
    wx.showLoading({ title: '准备中', mask: true })
    let originalUrl = ''
    try {
      originalUrl = await this.resolveAlbumOriginalUrl(record)
    } finally {
      wx.hideLoading()
    }
    console.log(
      `[再次投屏] 预览图源：${originalUrl ? '图库原图' : '记录img(未匹配到图库原图)'} ${originalUrl || imageUrl}`
    )

    // 复用正常投屏链路：把该图片(服务器地址)与设备写入 Storage，跳投屏预览页——
    // payload 形态与首页手选图片完全一致（只有 url），结果页会照常「抖动接口出帧 +
    // setUserProductUpload 建新记录 + editUserProductImgRecord 记账」，本次投屏即一条新记录。
    wx.setStorageSync('pendingProjection', {
      device,
      images: [
        {
          url: originalUrl || imageUrl
        }
      ]
    })
    wx.navigateTo({
      url: '/subpackages/projection/preview/preview'
    })
  },

  // 定位「该条记录对应的设备」：优先按 userProductId 精确匹配，其次按完整 6 字节设备 ID 精确匹配。
  // 两者都缺失/不匹配时返回 null，禁止退回全局选中设备，避免把记录再次投屏到另一台设备。
  // 返回带序列号的设备对象(供 ensureConnectedForAction 扫描匹配连接)或 null。
  async resolveRecordDevice(record) {
    let devices = []
    try {
      devices = await api.getDevices()
    } catch (error) {
      devices = []
    }

    const upid = record && record.userProductId
    if (upid) {
      const byId = devices.find(
        item =>
          String(item.userProductId) === String(upid) ||
          String(item.id) === String(upid)
      )
      if (byId) {
        return byId
      }
    }

    const serial = deviceIdUtil.canonical(
      record && (record.productDeviceId || record.deviceNo)
    )
    if (serial) {
      const bySerial = devices.find(
        item =>
          deviceIdUtil.canonical(item.deviceNo || item.productDeviceId) === serial
      )
      if (bySerial) {
        return bySerial
      }
    }

    return null
  },

  // 按记录的 uProductImgId 到图库找同一张照片的原图地址；找不到/失败返回 ''，调用方回退记录图。
  // 不抛错：这只是「显示一致性」的增强，不能因图库接口失败挡住再次投屏。
  async resolveAlbumOriginalUrl(record) {
    const imgId = record && (record.uProductImgId || record.uproductImgId)
    if (!imgId) {
      return ''
    }
    try {
      const photos = await api.getAlbumPhotos()
      const matched = photos.find(
        item => String(item.uProductImgId) === String(imgId)
      )
      return (matched && matched.url) || ''
    } catch (error) {
      return ''
    }
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

        try {
          await api.deleteProjectionRecord(id)
        } catch (error) {
          return // 失败已由接口层统一提示（api 层删除时有 mask loading 防连点）
        }
        this.loadRecords()
      }
    })
  }
})
