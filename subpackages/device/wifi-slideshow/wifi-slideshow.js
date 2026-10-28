const api = require('../../../utils/api')
const iotApi = require('../../../utils/iot-api')
const toast = require('../../../utils/toast')
const system = require('../../../utils/system')
const fold = require('../../../utils/fold-adapt')
const wifiStatus = require('../../../utils/wifi-status')
const strategy = require('../../../utils/wifi-strategy')
const wifiProjection = require('../../../utils/wifi-projection')
const dithering = require('../../../utils/dithering')

// WiFi 版轮播设置（2026-10-27，docs/wifi/XT相框通讯协议_V1.4_更新说明.md 1.5 / 第五节）。
// 入口：我的设备 WiFi 卡、WiFi 设备详情的「轮播设置」（取代原「刷新状态」）。蓝牙版仍走 slideshow 页，互不影响。
//   · 回显：IoT GET /api/device/strategy（只要权限，离线也能查）；
//   · 模式：间隔时间（开始 / 结束 HH:mm + 间隔）/ 固定时间（每 N 天 + 若干时间点）；顺序 / 随机；轮播后是否休眠；
//   · 选图：「我的上传」里这台设备的照片（老服务投屏成功记录，只取带 imgBle 的），单选 / 多选 / 全选，
//     按选择顺序作为 imgUrls 提交；回显 imgUrls=null（全部相册）时全选；一张不选不让保存（空数组会回 4000）；
//     按相册顺序全选时不带 imgUrls，保持「全部相册」（之后新上传的也进轮播）；
//     最多 100 张（2026-10-27 追加内容第一节）：显示「已选 X/100」，选满后未选的置灰、点了提示，已选的仍可取消；
//     全选时相册超过 100 张只选前 100 张并提示；超过 100 张服务端回 4000，给明确提示；
//   · 保存：IoT POST /api/device/strategy，要求设备在线（4041 时补查是休眠 / 关机 / 离线给对应提示）；
//     轮播中改选图不用先暂停，直接保存（实现报告反馈六）；
//   · 保存成功后立即投第一张（选中的第一张；全部相册取相册第一张）：下载这张图 → POST /api/device/play refresh=true，
//     屏幕马上切过去，不等下一个轮播周期（服务端保存轮播只下发 strategy_bin、不自动播放）。这一张不写新的相册记录；
//   · 正在轮播时可「暂停轮播」（POST /api/device/strategy/stop）。
// 换算与选图顺序见 utils/wifi-strategy.js。
const DAY_OPTIONS = Array.from({ length: 365 }, (item, index) => `${index + 1}`)

function downloadToLocal(url) {
  return new Promise((resolve, reject) => {
    wx.downloadFile({
      url,
      success: res => (res.statusCode === 200 && res.tempFilePath ? resolve(res.tempFilePath) : reject(new Error('下载失败'))),
      fail: () => reject(new Error('下载失败'))
    })
  })
}

function plainDeviceNo(value) {
  return String(value || '').replace(/[:\-\s]/g, '').toUpperCase()
}

function errorText(error, fallback) {
  return String((error && error.message) || fallback).replace(/^接口\(IoT\)-/, '')
}

// 选图网格：tile 带上它在已选里的序号（1 起，0 = 未选）；选满后未选的置灰（disabled）
function decorateTiles(tiles, selected) {
  const full = strategy.isFull(selected)
  return tiles.map(tile => {
    const order = selected.indexOf(tile.url) + 1
    return Object.assign({}, tile, { order, disabled: full && !order })
  })
}

Page(fold.adapt({
  data: {
    statusBarHeight: 20,
    safeBottom: 0,
    id: '',
    loading: true,
    loadError: false,
    device: null,
    running: false,
    configured: false,
    updatedAt: '',
    form: strategy.DEFAULT_FORM,
    intervalLabels: strategy.INTERVAL_OPTIONS.map(strategy.intervalLabel),
    intervalIndex: strategy.intervalIndexOf(strategy.DEFAULT_FORM.intervalMinutes),
    dayOptions: DAY_OPTIONS,
    newTime: '12:00',
    tiles: [], // [{ id, url(imgBle), thumb, order }]
    selectedCount: 0,
    maxCount: strategy.MAX_IMG_URLS,
    allSelected: false,
    selectionHint: '',
    photosError: false,
    saving: false,
    savingText: '',
    stopping: false
  },

  onLoad(options) {
    this.setData(Object.assign(system.getLayoutMetrics(), { id: (options && options.id) || '' }))
    this.selected = []
    this.load()
  },

  onUnload() {
    this.unloaded = true
  },

  deviceNo() {
    const device = this.data.device || {}
    return plainDeviceNo(device.productDeviceId || device.deviceNo)
  },

  // 设备 → 轮播配置 + 相册照片（两者并发）；设备记录取不到算加载失败，配置 / 相册各自失败分别兜底
  async load() {
    this.setData({ loading: true, loadError: false })
    let device
    try {
      device = await api.getDeviceDetail(this.data.id)
    } catch (error) {
      if (!this.unloaded) {
        this.setData({ loading: false, loadError: true })
      }
      return
    }
    if (this.unloaded) {
      return
    }
    this.setData({ device })
    const deviceNo = this.deviceNo()
    const [config, records] = await Promise.all([
      iotApi.getStrategy(deviceNo, { showError: false }).catch(error => {
        console.warn('[WiFi轮播] 查询轮播配置失败', error && error.code, error && error.message)
        return null
      }),
      api.getProjectionRecords({ deviceUploadState: 1, userProductId: device.userProductId || device.id || this.data.id }).catch(error => {
        console.warn('[WiFi轮播] 拉我的上传失败', error && error.message)
        return null
      })
    ])
    if (this.unloaded) {
      return
    }
    console.log('[WiFi轮播] 当前配置', JSON.stringify(config))
    // 只有带 imgBle 的记录能进轮播（设备拉的就是它）；同一个 imgBle 只留第一条
    const tiles = []
    ;(records || []).forEach(record => {
      const url = String((record && record.imgBle) || '')
      if (record && record.status === 'success' && url && !tiles.some(tile => tile.url === url)) {
        tiles.push({ id: String(record.id), url, thumb: record.imgThumb || record.thumbUrl || '', img: record.img || record.thumbUrl || '' })
      }
    })
    this.tiles = tiles
    const urls = tiles.map(tile => tile.url)
    const picked = strategy.selectionFromStrategy(config, urls)
    this.selected = picked.selected
    const form = strategy.formFromStrategy(config)
    this.setData({
      loading: false,
      configured: !!(config && config.configured),
      running: !!(config && config.running),
      updatedAt: (config && config.updatedAt) || '',
      form,
      intervalIndex: strategy.intervalIndexOf(form.intervalMinutes),
      selectionHint: config ? picked.hint : '轮播配置查询失败，以下为默认设置',
      photosError: records === null
    })
    this.renderSelection()
  },

  retryLoad() {
    this.load()
  },

  renderSelection() {
    const urls = (this.tiles || []).map(tile => tile.url)
    this.setData({
      tiles: decorateTiles(this.tiles || [], this.selected),
      selectedCount: this.selected.length,
      allSelected: strategy.isAllSelected(this.selected, urls)
    })
  },

  setForm(patch) {
    this.setData({ form: Object.assign({}, this.data.form, patch) })
  },

  chooseUpdateType(e) {
    this.setForm({ updateType: Number(e.currentTarget.dataset.value) })
  },

  chooseMode(e) {
    this.setForm({ mode: Number(e.currentTarget.dataset.value) })
  },

  toggleIdle(e) {
    // 开关打开 = 轮播后休眠（idle 0）
    this.setForm({ idle: e.detail.value ? 0 : 1 })
  },

  changeBeginTime(e) {
    this.setForm({ beginTime: e.detail.value })
  },

  changeEndTime(e) {
    this.setForm({ endTime: e.detail.value })
  },

  changeInterval(e) {
    const index = Number(e.detail.value)
    this.setData({ intervalIndex: index })
    this.setForm({ intervalMinutes: strategy.INTERVAL_OPTIONS[index] })
  },

  changeDays(e) {
    this.setForm({ updateDays: Number(e.detail.value) + 1 })
  },

  addTime(e) {
    const value = e.detail.value
    const list = this.data.form.updateTimeList || []
    if (list.indexOf(value) > -1) {
      toast.show({ title: '这个时间点已添加', icon: 'none' })
      return
    }
    if (list.length >= strategy.MAX_TIME_POINTS) {
      toast.show({ title: `最多添加 ${strategy.MAX_TIME_POINTS} 个时间点`, icon: 'none' })
      return
    }
    this.setData({ newTime: value })
    this.setForm({ updateTimeList: strategy.normalizeTimes(list.concat(value)) })
  },

  removeTime(e) {
    const value = e.currentTarget.dataset.value
    this.setForm({ updateTimeList: (this.data.form.updateTimeList || []).filter(item => item !== value) })
  },

  toggleTile(e) {
    const url = e.currentTarget.dataset.url
    const next = strategy.toggleSelection(this.selected, url)
    if (next.overflow) {
      toast.show({ title: `最多选择 ${strategy.MAX_IMG_URLS} 张，请先取消部分照片`, icon: 'none' })
      return
    }
    this.selected = next.selected
    this.renderSelection()
  },

  toggleAll() {
    const urls = (this.tiles || []).map(tile => tile.url)
    if (!urls.length) {
      return
    }
    this.selected = strategy.toggleAll(this.selected, urls)
    if (urls.length > strategy.MAX_IMG_URLS && this.selected.length) {
      toast.show({ title: `最多选择 ${strategy.MAX_IMG_URLS} 张`, icon: 'none' })
    }
    this.renderSelection()
  },

  // 4041：补查在线状态，休眠 / 关机 / 离线给对应提示
  async offlineTip(error) {
    if (!error || Number(error.code) !== 4041) {
      return ''
    }
    try {
      const res = await iotApi.getDeviceOnline(this.deviceNo(), undefined, { showError: false })
      return wifiStatus.blockedTip(wifiStatus.deviceState(res)) || wifiStatus.OFFLINE_TIP
    } catch (queryError) {
      return wifiStatus.OFFLINE_TIP
    }
  },

  async save() {
    if (this.data.saving || !this.data.device) {
      return
    }
    const albumUrls = (this.tiles || []).map(tile => tile.url)
    const built = strategy.buildPayload(this.deviceNo(), this.data.form, this.selected, albumUrls)
    if (built.error) {
      toast.show({ title: built.error, icon: 'none' })
      return
    }
    console.log('[WiFi轮播] 保存', JSON.stringify(built.payload))
    this.setData({ saving: true })
    try {
      await iotApi.setStrategy(built.payload, { showError: false })
    } catch (error) {
      console.warn('[WiFi轮播] 保存失败', error && error.code, error && error.message)
      const tip = strategy.saveErrorText(error, built.payload) || (await this.offlineTip(error)) || errorText(error, '保存失败，请稍后重试')
      if (!this.unloaded) {
        this.setData({ saving: false })
        toast.show({ title: tip, icon: 'none' })
      }
      return
    }
    if (this.unloaded) {
      return
    }
    this.setData({ running: true, configured: true, selectionHint: '' })
    const saved = built.payload.imgUrls ? `已保存，轮播所选 ${built.payload.imgUrls.length} 张` : '已保存，轮播全部照片'
    const played = await this.playFirst(strategy.firstImageUrl(built.payload, albumUrls))
    if (this.unloaded) {
      return
    }
    this.setData({ saving: false })
    toast.show({ title: played === true ? `${saved}，屏幕即将切到第一张` : `${saved}；${played}`, icon: 'none' })
  },

  // 保存后立即投第一张：返回 true 或给用户看的失败原因
  async playFirst(url) {
    const tile = (this.tiles || []).filter(item => item.url === url)[0]
    if (!tile || !tile.img) {
      return '第一张照片缺少原图，等下一个轮播周期再切换'
    }
    this.setData({ savingText: '正在切到第一张…' })
    let outcome
    try {
      const filePath = await downloadToLocal(tile.img)
      const result = await wifiProjection.projectOne({
        deviceNo: this.deviceNo(),
        filePath,
        type: dithering.typeForDevice(this.data.device),
        refresh: true,
        isCancelled: () => this.unloaded
      })
      outcome = result.status === 'SENT' ? true : `切换第一张失败：${result.message || '投屏失败'}`
    } catch (error) {
      outcome = '第一张照片下载失败，等下一个轮播周期再切换'
    }
    if (!this.unloaded) {
      this.setData({ savingText: '' })
    }
    return outcome
  },

  async stop() {
    if (this.data.stopping || !this.data.device) {
      return
    }
    this.setData({ stopping: true })
    try {
      await iotApi.stopStrategy(this.deviceNo(), { showError: false })
    } catch (error) {
      console.warn('[WiFi轮播] 暂停失败', error && error.code, error && error.message)
      const tip = (await this.offlineTip(error)) || errorText(error, '暂停失败，请稍后重试')
      if (!this.unloaded) {
        this.setData({ stopping: false })
        toast.show({ title: tip, icon: 'none' })
      }
      return
    }
    if (!this.unloaded) {
      this.setData({ stopping: false, running: false })
      toast.show({ title: '已暂停轮播', icon: 'none' })
    }
  }
}))
