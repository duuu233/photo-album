const api = require('../../../utils/api')
const iotApi = require('../../../utils/iot-api')
const toast = require('../../../utils/toast')
const system = require('../../../utils/system')
const fold = require('../../../utils/fold-adapt')
const wifiStatus = require('../../../utils/wifi-status')
const strategy = require('../../../utils/wifi-strategy')
const timeZone = require('../../../utils/time-zone')

// WiFi 版轮播设置（2026-10-27 起；2026-11-05 按 docs/wifi/前端对接文档20261105.md 改为服务端按配置定时推图）。
// 入口：我的设备 WiFi 卡、WiFi 设备详情的「轮播设置」。蓝牙版仍走 slideshow 页，互不影响。
//   · 回显：IoT GET /api/device/strategy（只要权限，离线也能查），含 timeZone、nextRefreshAt（「下次刷新」只读一行）、
//     weekday / weekend / anniversaries 高级卡片；
//   · 普通视图沿用原页面：轮播方式（间隔 / 固定，切换不清空另一方）、时区（默认手机时区，可搜索选择）、
//     间隔（开始 / 结束，结束可选 24:00；间隔 10 分钟起）/ 固定（每 N 天 + 时间点）、顺序 / 随机、选图；
//     「轮播后休眠」已去掉（idle 废弃）；
//   · 高级设置：同页展开 / 收起，进页一律收起、不持久化；工作日 / 周末（启用开关）、纪念日（可多条、日期不可重复、当天独占），
//     每张卡片独立的时间、图片组、顺序，时间参数跟随上面的轮播方式；工作日 / 周末启用时基础配置旁出提示（三档，纯文字）；
//     未保存的编辑只在本页有效，任何重新拉取（进页、重新加载、保存成功后）一律以服务端为准；
//   · 选图：「我的上传」里这台设备的照片（老服务投屏成功记录，只取带 imgBle 的；有完整设备 ID 时带 deviceId 按设备查），
//     按选择顺序提交；基础配置回显 imgUrls=null 时全选、按相册顺序全选时不带 imgUrls（= 全部相册）；
//     卡片在弹层里选，图片组一律明确提交；最多 100 张；开启轮播必须至少选一张（基础配置与每张启用的卡片）；
//   · 保存：IoT POST /api/device/strategy，要求设备在线（4041 时补查是休眠 / 关机 / 离线给对应提示）；
//     下发后设备会立刻自动刷屏，**不再额外 /api/device/play 投第一张**（2026-11-05 确认）；保存成功后重新拉一次配置；
//   · 正在轮播时可「暂停轮播」（POST /api/device/strategy/stop）。
// 2026-11-05 修订版 docs/wifi/前端对接文档20261105-1.md：
//   · 基础配置做成「简单模式」卡片（启用开关，默认启用并展开；关闭不提交基础字段），简单模式 / 高级卡片任一启用才能保存，否则按钮置灰；
//   · 选图统一成底部弹层（简单模式与高级卡片同一个）：从下往上滑入、每行 3 张（同「我的上传」样式），按页 21 张、滑到底再显示下一页；
//   · 时区按语种显示「中国 / 北京」，不带 UTC 偏移；状态区「设置时间：」「下次刷新：MM-dd HH:mm · 卡片类型」；
//   · 固定模式每 N 天 1~30（存量 > 30 提示调整）；纪念日只选月 / 日，2 月最多 28 日。
// 换算、校验、卡片与选图顺序见 utils/wifi-strategy.js，时区见 utils/time-zone.js。
const DAY_OPTIONS = Array.from({ length: strategy.MAX_UPDATE_DAYS }, (item, index) => (index ? `每 ${index + 1} 天` : '每天'))
// 选图：投屏记录按页取，每页 21 张（3 列 × 7 行，同「我的上传」）；弹层里一页一页往下显示
const PHOTO_PAGE_SIZE = 21
// 进页把这台设备的可轮播照片按页取完（回显校验、全选、「全部相册」判断都要整本相册）；最多取这么多页兜底
const MAX_PHOTO_PAGES = 30
// 弹层退场动画时长（app.wxss .pop-closing-sheet 0.24s）
const SHEET_CLOSE_MS = 240

function plainDeviceNo(value) {
  return String(value || '').replace(/[:\-\s]/g, '').toUpperCase()
}

function errorText(error, fallback) {
  return String((error && error.message) || fallback).replace(/^接口\(IoT\)-/, '')
}

function todayMonthDay() {
  const now = new Date()
  return `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

// 选图列表（投屏记录接口）是否带 deviceId 及原因（2026-11-03，同「我的上传」规则）：
// 设备详情有完整 6 字节设备 ID（productDeviceId）就带，后端按设备查；没有 / 不完整就不带，仍按用户查。
const RECORDS_LOG_TAG = '★★★【轮播选图·deviceId】'

function recordsDeviceId(device) {
  const d = device || {}
  if (d.productDeviceId) {
    return { deviceId: d.productDeviceId, reason: '设备有完整 6 字节设备 ID，后端按设备查（这台设备上所有人上传的都能查到）' }
  }
  if (d.deviceIdentityInvalid) {
    return { deviceId: undefined, reason: `设备 ID「${d.rawProductDeviceId}」不是完整 6 字节 ID（历史短 ID），不带，仍按用户查` }
  }
  return { deviceId: undefined, reason: '设备详情没有设备 ID，不带，仍按用户查' }
}

// 选图网格：tile 带上它在已选里的序号（1 起，0 = 未选）；选满后未选的置灰（disabled）
function decorateTiles(tiles, selected) {
  const full = strategy.isFull(selected)
  return tiles.map(tile => {
    const order = selected.indexOf(tile.url) + 1
    return Object.assign({}, tile, { order, disabled: full && !order })
  })
}

function cardTitle(card) {
  if (!card) {
    return ''
  }
  if (card.kind === strategy.CARD_ANNIVERSARY) {
    return `纪念日 ${strategy.monthDayLabel(card.monthDay)}`
  }
  return card.kind === strategy.CARD_WEEKEND ? '周末' : '工作日'
}

// 把这台设备的投屏成功记录按页取完（每页 PHOTO_PAGE_SIZE）；任一页失败整体失败（返回 Promise reject）
async function loadAllRecords(query) {
  const records = []
  for (let pageIndex = 1; pageIndex <= MAX_PHOTO_PAGES; pageIndex += 1) {
    const page = await api.getProjectionRecordsPage(Object.assign({}, query, { pageIndex, pageSize: PHOTO_PAGE_SIZE }))
    const rows = (page && page.records) || []
    rows.forEach(record => records.push(record))
    if (!page || !page.hasMore || !rows.length) {
      return records
    }
  }
  console.warn(`${RECORDS_LOG_TAG} 已取满 ${MAX_PHOTO_PAGES} 页（每页 ${PHOTO_PAGE_SIZE}），后面的不再取`)
  return records
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
    updatedAt: '', // 「设置时间：yyyy-MM-dd HH:mm」
    nextRefresh: '', // 「下次刷新：MM-dd HH:mm · 卡片类型」冒号后的部分；空 = 整行不显示
    form: strategy.DEFAULT_FORM,
    timeZoneLabel: '',
    intervalLabels: strategy.INTERVAL_OPTIONS.map(strategy.intervalLabel),
    intervalIndex: strategy.intervalIndexOf(strategy.DEFAULT_FORM.intervalMinutes),
    endTimeColumns: strategy.END_TIME_COLUMNS,
    endTimeIndex: strategy.endTimeIndex(strategy.DEFAULT_FORM.endTime),
    dayOptions: DAY_OPTIONS,
    newTime: '12:00',
    daysHint: '', // 存量每 N 天 > 30 的提示
    canSave: true, // 简单模式或任一高级卡片启用；否则保存按钮置灰
    photoCount: 0, // 可轮播的照片总数（「我的上传」里这台设备带 imgBle 的）
    selectedCount: 0,
    maxCount: strategy.MAX_IMG_URLS,
    selectionHint: '',
    photosError: false,
    // 高级设置：进页一律收起，展开只在本页有效
    advancedOpen: false,
    advanced: strategy.decorateAdvanced(null),
    advancedCount: 0,
    baseHint: '',
    zoneSheet: { show: false, closing: false, keyword: '', list: [] },
    // 选图弹层（简单模式与高级卡片共用）：tiles 只放已显示的几页，limit 为已显示张数（每次 +21）
    photoSheet: { show: false, closing: false, title: '', tiles: [], limit: PHOTO_PAGE_SIZE, total: 0, count: 0, allSelected: false },
    saving: false,
    stopping: false
  },

  onLoad(options) {
    this.setData(Object.assign(system.getLayoutMetrics(), { id: (options && options.id) || '' }))
    this.selected = []
    this.advanced = strategy.advancedFromStrategy(null, [])
    this.load()
  },

  onUnload() {
    this.unloaded = true
  },

  deviceNo() {
    const device = this.data.device || {}
    return plainDeviceNo(device.productDeviceId || device.deviceNo)
  },

  albumUrls() {
    return (this.tiles || []).map(tile => tile.url)
  },

  // 设备 → 轮播配置 + 相册照片（两者并发）；设备记录取不到算加载失败，配置 / 相册各自失败分别兜底
  async load() {
    this.setData({ loading: true, loadError: false, advancedOpen: false })
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
    const recordsQuery = recordsDeviceId(device)
    const userProductId = device.userProductId || device.id || this.data.id
    if (recordsQuery.deviceId) {
      console.log(`${RECORDS_LOG_TAG} 已传 deviceId=${recordsQuery.deviceId}，userProductId=${userProductId} —— 原因：${recordsQuery.reason}`)
    } else {
      console.warn(`${RECORDS_LOG_TAG} 未传 deviceId，userProductId=${userProductId} —— 原因：${recordsQuery.reason}`)
    }
    const [config, records] = await Promise.all([
      iotApi.getStrategy(deviceNo, { showError: false }).catch(error => {
        console.warn('[WiFi轮播] 查询轮播配置失败', error && error.code, error && error.message)
        return null
      }),
      loadAllRecords({
        deviceUploadState: 1,
        userProductId,
        // 同「我的上传」页（2026-11-03）：有设备完整 ID 就带，后端按设备查；取不到不带，仍按用户查
        deviceId: recordsQuery.deviceId
      }).catch(error => {
        console.warn(`${RECORDS_LOG_TAG} 接口失败（${recordsQuery.deviceId ? '按设备查' : '按用户查'}）`, error && error.message)
        return null
      })
    ])
    if (this.unloaded) {
      return
    }
    // 只有带 imgBle 的记录能进轮播（设备拉的就是它）；同一个 imgBle 只留第一条
    const tiles = []
    ;(records || []).forEach(record => {
      const url = String((record && record.imgBle) || '')
      if (record && record.status === 'success' && url && !tiles.some(tile => tile.url === url)) {
        tiles.push({ id: String(record.id), url, thumb: record.imgThumb || record.thumbUrl || '', img: record.img || record.thumbUrl || '' })
      }
    })
    this.tiles = tiles
    if (records) {
      console.log(`${RECORDS_LOG_TAG} 返回 ${records.length} 条记录（${recordsQuery.deviceId ? '按设备查' : '按用户查'}），可轮播（投屏成功且带 imgBle、去重后）${tiles.length} 张`)
    }
    this.applyConfig(config)
    this.setData({ loading: false, photosError: records === null, photoCount: tiles.length })
  },

  // 服务端配置 → 页面（进页与保存成功后共用）：未保存的草稿一律丢弃，以服务端为准。查询失败（null）用默认值并提示
  applyConfig(config) {
    console.log('[WiFi轮播] 当前配置', JSON.stringify(config))
    const urls = this.albumUrls()
    const picked = strategy.selectionFromStrategy(config, urls)
    this.selected = picked.selected
    this.advanced = strategy.advancedFromStrategy(config, urls)
    const form = strategy.formFromStrategy(config, timeZone.detect())
    this.setData({
      configured: !!(config && config.configured),
      running: !!(config && config.running),
      updatedAt: strategy.updatedAtText(config && config.updatedAt),
      nextRefresh: strategy.nextRefreshLine(config),
      intervalIndex: strategy.intervalIndexOf(form.intervalMinutes),
      endTimeIndex: strategy.endTimeIndex(form.endTime),
      selectionHint: config ? picked.hint : '轮播配置查询失败，以下为默认设置'
    })
    this.setForm(form, true)
    this.renderSelection()
    this.renderAdvanced()
  },

  retryLoad() {
    this.load()
  },

  renderSelection() {
    this.setData({ selectedCount: this.selected.length })
  },

  renderAdvanced() {
    this.setData({
      advanced: strategy.decorateAdvanced(this.advanced),
      advancedCount: strategy.advancedCount(this.advanced),
      baseHint: strategy.baseHint(this.advanced),
      canSave: strategy.hasAnyConfig(this.data.form, this.advanced)
    })
  },

  // replace=true 时整体替换（回显），否则合并
  setForm(patch, replace) {
    const form = replace ? Object.assign({}, patch) : Object.assign({}, this.data.form, patch)
    this.setData({
      form,
      timeZoneLabel: timeZone.label(form.timeZone),
      daysHint: strategy.daysOverHint(form),
      canSave: strategy.hasAnyConfig(form, this.advanced)
    })
  },

  // 简单模式启用开关：关闭后基础字段不提交，此时至少要启用一张高级卡片
  toggleSimple(e) {
    this.setForm({ simpleEnabled: !!e.detail.value })
  },

  chooseUpdateType(e) {
    this.setForm({ updateType: Number(e.currentTarget.dataset.value) })
  },

  chooseMode(e) {
    this.setForm({ mode: Number(e.currentTarget.dataset.value) })
  },

  changeBeginTime(e) {
    this.setForm({ beginTime: e.detail.value })
  },

  // 结束时间：两列（时 00~24 / 分），选 24 时一律 24:00
  changeEndTime(e) {
    const endTime = strategy.endTimeFromIndex(e.detail.value)
    this.setData({ endTimeIndex: strategy.endTimeIndex(endTime) })
    this.setForm({ endTime })
  },

  changeInterval(e) {
    const index = Number(e.detail.value)
    this.setData({ intervalIndex: index })
    this.setForm({ intervalMinutes: strategy.INTERVAL_OPTIONS[index] })
  },

  changeDays(e) {
    this.setForm({ updateDays: Number(e.detail.value) + 1 })
  },

  // 往时间点列表里加一个：重复 / 超上限给提示，返回新列表或 null
  appendTime(list, value) {
    const current = list || []
    if (current.indexOf(value) > -1) {
      toast.show({ title: '这个时间点已添加', icon: 'none' })
      return null
    }
    if (current.length >= strategy.MAX_TIME_POINTS) {
      toast.show({ title: `最多添加 ${strategy.MAX_TIME_POINTS} 个时间点`, icon: 'none' })
      return null
    }
    return strategy.normalizeTimes(current.concat(value))
  },

  addTime(e) {
    const value = e.detail.value
    const next = this.appendTime(this.data.form.updateTimeList, value)
    if (next) {
      this.setData({ newTime: value })
      this.setForm({ updateTimeList: next })
    }
  },

  removeTime(e) {
    const value = e.currentTarget.dataset.value
    this.setForm({ updateTimeList: (this.data.form.updateTimeList || []).filter(item => item !== value) })
  },

  // ── 时区 ─────────────────────────────────────────

  openZoneSheet() {
    this.setData({ zoneSheet: { show: true, closing: false, keyword: '', list: timeZone.options('', this.data.form.timeZone) } })
  },

  searchZone(e) {
    const keyword = (e.detail && e.detail.value) || ''
    this.setData({ 'zoneSheet.keyword': keyword, 'zoneSheet.list': timeZone.options(keyword, this.data.form.timeZone) })
  },

  pickZone(e) {
    const id = e.currentTarget.dataset.id
    if (id) {
      this.setForm({ timeZone: id })
    }
    this.closeZoneSheet()
  },

  closeZoneSheet() {
    this.closeSheet('zoneSheet')
  },

  // 底部弹层退场：先播下滑动画（.pop-closing-sheet），再卸载
  closeSheet(key, done) {
    if (!this.data[key].show || this.data[key].closing) {
      return
    }
    this.setData({ [`${key}.closing`]: true })
    setTimeout(() => {
      // 退场期间又被打开（open 会把 closing 置回 false）就不收了
      if (this.unloaded || !this.data[key].closing) {
        return
      }
      this.setData({ [`${key}.show`]: false, [`${key}.closing`]: false })
      if (done) {
        done()
      }
    }, SHEET_CLOSE_MS)
  },

  // ── 高级设置 ─────────────────────────────────────────

  toggleAdvanced() {
    this.setData({ advancedOpen: !this.data.advancedOpen })
  },

  // data-card：weekday / weekend / anniversary（带 data-index）
  getCard(dataset) {
    const d = dataset || {}
    if (d.card === strategy.CARD_ANNIVERSARY) {
      return (this.advanced.anniversaries || [])[Number(d.index)] || null
    }
    return d.card === strategy.CARD_WEEKDAY || d.card === strategy.CARD_WEEKEND ? this.advanced[d.card] : null
  },

  patchCard(dataset, patch) {
    const d = dataset || {}
    if (!this.getCard(d)) {
      return
    }
    if (d.card === strategy.CARD_ANNIVERSARY) {
      const list = (this.advanced.anniversaries || []).slice()
      const index = Number(d.index)
      list[index] = Object.assign({}, list[index], patch)
      this.advanced = Object.assign({}, this.advanced, { anniversaries: list })
    } else {
      this.advanced = Object.assign({}, this.advanced, { [d.card]: Object.assign({}, this.advanced[d.card], patch) })
    }
    this.renderAdvanced()
  },

  toggleCardEnabled(e) {
    this.patchCard(e.currentTarget.dataset, { enabled: !!e.detail.value })
  },

  changeCardBegin(e) {
    this.patchCard(e.currentTarget.dataset, { beginTime: e.detail.value })
  },

  changeCardEnd(e) {
    this.patchCard(e.currentTarget.dataset, { endTime: strategy.endTimeFromIndex(e.detail.value) })
  },

  changeCardInterval(e) {
    this.patchCard(e.currentTarget.dataset, { intervalMinutes: strategy.INTERVAL_OPTIONS[Number(e.detail.value)] })
  },

  addCardTime(e) {
    const card = this.getCard(e.currentTarget.dataset)
    const next = card && this.appendTime(card.updateTimeList, e.detail.value)
    if (next) {
      this.patchCard(e.currentTarget.dataset, { updateTimeList: next })
    }
  },

  removeCardTime(e) {
    const card = this.getCard(e.currentTarget.dataset)
    const value = e.currentTarget.dataset.value
    if (card) {
      this.patchCard(e.currentTarget.dataset, { updateTimeList: (card.updateTimeList || []).filter(item => item !== value) })
    }
  },

  chooseCardMode(e) {
    this.patchCard(e.currentTarget.dataset, { mode: Number(e.currentTarget.dataset.value) })
  },

  // 纪念日日期选择器（月 / 日两列，不选年）：滑动月份时日这一列换成该月的合法天数（2 月 28 天，4 / 6 / 9 / 11 月 30 天）
  changeAnnivColumn(e) {
    const detail = e.detail || {}
    if (Number(detail.column) !== 0) {
      return
    }
    const index = Number(e.currentTarget.dataset.index)
    const card = (this.data.advanced.anniversaries || [])[index]
    if (!card) {
      return
    }
    const month = Number(detail.value) + 1
    const columns = strategy.monthDayColumns(month)
    const day = Math.min(card.monthDayIndex[1], columns[1].length - 1)
    this.setData({
      [`advanced.anniversaries[${index}].monthDayColumns`]: columns,
      [`advanced.anniversaries[${index}].monthDayIndex`]: [month - 1, day]
    })
  },

  // 取消选择：日这一列恢复成当前日期所在月份
  cancelAnnivDate() {
    this.renderAdvanced()
  },

  // 纪念日日期：选择器给 [月, 日] 下标，换成 MM-dd；与其他纪念日重复时拦下
  changeAnnivDate(e) {
    const monthDay = strategy.monthDayFromIndex(e.detail.value)
    const index = Number(e.currentTarget.dataset.index)
    if (!strategy.isMonthDay(monthDay)) {
      this.renderAdvanced()
      return
    }
    const taken = (this.advanced.anniversaries || []).some((card, i) => i !== index && card.monthDay === monthDay)
    if (taken) {
      toast.show({ title: '这个日期已添加纪念日', icon: 'none' })
      this.renderAdvanced()
      return
    }
    this.patchCard(e.currentTarget.dataset, { monthDay })
  },

  addAnniversary() {
    const list = this.advanced.anniversaries || []
    const monthDay = strategy.nextFreeMonthDay(list.map(card => card.monthDay), todayMonthDay())
    if (!monthDay) {
      return
    }
    this.advanced = Object.assign({}, this.advanced, { anniversaries: list.concat(strategy.defaultCard(strategy.CARD_ANNIVERSARY, monthDay)) })
    this.renderAdvanced()
  },

  removeAnniversary(e) {
    const index = Number(e.currentTarget.dataset.index)
    const card = (this.advanced.anniversaries || [])[index]
    if (!card) {
      return
    }
    wx.showModal({
      title: '删除纪念日',
      content: `删除「${strategy.monthDayLabel(card.monthDay)}」的纪念日轮播？保存后生效`,
      confirmText: '删除',
      confirmColor: '#ff6a20',
      success: res => {
        if (res.confirm && !this.unloaded) {
          this.advanced = Object.assign({}, this.advanced, {
            anniversaries: (this.advanced.anniversaries || []).filter((item, i) => i !== index)
          })
          this.renderAdvanced()
        }
      }
    })
  },

  // ── 选图弹层（简单模式与高级卡片共用）─────────────────────────────────────────

  // 简单模式的「轮播照片」
  openBasePhotos() {
    this.openPhotoSheet({ card: 'base' }, this.selected, '简单模式 · 轮播照片')
  },

  openCardPhotos(e) {
    const dataset = e.currentTarget.dataset
    const card = this.getCard(dataset)
    if (card) {
      this.openPhotoSheet({ card: dataset.card, index: dataset.index }, card.selected, `${cardTitle(card)} · 轮播照片`)
    }
  },

  openPhotoSheet(target, selected, title) {
    if (!(this.tiles || []).length) {
      toast.show({ title: this.data.photosError ? '「我的上传」加载失败，请返回重试' : '还没有可轮播的照片，先投屏几张吧', icon: 'none' })
      return
    }
    this.sheetTarget = target
    this.sheetSelected = (selected || []).slice()
    this.setData({
      'photoSheet.show': true,
      'photoSheet.closing': false,
      'photoSheet.title': title,
      'photoSheet.limit': PHOTO_PAGE_SIZE,
      'photoSheet.total': this.tiles.length
    })
    this.renderSheet()
  },

  // 只渲染已显示的几页（每页 21 张）
  renderSheet() {
    const selected = this.sheetSelected || []
    const limit = this.data.photoSheet.limit
    this.setData({
      'photoSheet.tiles': decorateTiles((this.tiles || []).slice(0, limit), selected),
      'photoSheet.count': selected.length,
      'photoSheet.allSelected': strategy.isAllSelected(selected, this.albumUrls())
    })
  },

  // 滑到底显示下一页
  sheetLoadMore() {
    const sheet = this.data.photoSheet
    if (!sheet.show || sheet.limit >= (this.tiles || []).length) {
      return
    }
    this.setData({ 'photoSheet.limit': sheet.limit + PHOTO_PAGE_SIZE })
    this.renderSheet()
  },

  sheetToggleTile(e) {
    const next = strategy.toggleSelection(this.sheetSelected, e.currentTarget.dataset.url)
    if (next.overflow) {
      toast.show({ title: `最多选择 ${strategy.MAX_IMG_URLS} 张，请先取消部分照片`, icon: 'none' })
      return
    }
    this.sheetSelected = next.selected
    this.renderSheet()
  },

  sheetToggleAll() {
    const urls = this.albumUrls()
    this.sheetSelected = strategy.toggleAll(this.sheetSelected, urls)
    if (urls.length > strategy.MAX_IMG_URLS && this.sheetSelected.length) {
      toast.show({ title: `最多选择 ${strategy.MAX_IMG_URLS} 张`, icon: 'none' })
    }
    this.renderSheet()
  },

  sheetConfirm() {
    const target = this.sheetTarget
    const selected = (this.sheetSelected || []).slice()
    if (target && target.card === 'base') {
      this.selected = selected
      this.setData({ selectionHint: '' })
      this.renderSelection()
    } else if (target) {
      this.patchCard(target, { selected, hint: '' })
    }
    this.closePhotoSheet()
  },

  closePhotoSheet() {
    this.closeSheet('photoSheet', () => {
      this.sheetTarget = null
    })
  },

  noop() {},

  // ── 保存 / 暂停 ─────────────────────────────────────────

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
    if (!this.data.canSave) {
      toast.show({ title: '至少配置一项', icon: 'none' })
      return
    }
    const built = strategy.buildPayload(this.deviceNo(), this.data.form, this.selected, this.albumUrls(), this.advanced)
    if (built.error) {
      toast.show({ title: built.error, icon: 'none' })
      return
    }
    console.log('[WiFi轮播] 保存', JSON.stringify(built.payload))
    this.setData({ saving: true })
    // 保存前判断设备状态（2026-10-29）：本地模式 / 离线 / 休眠 / 关机直接提示，不发请求；查不到交给接口裁决
    const blocked = await wifiStatus.queryBlockedTip(this.data.device)
    if (this.unloaded) {
      return
    }
    if (blocked) {
      this.setData({ saving: false })
      toast.show({ title: blocked, icon: 'none' })
      return
    }
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
    // 下发轮播后设备会立刻自动刷屏，不再额外投第一张（2026-11-05）
    const saved = !this.data.form.simpleEnabled ? '已保存' : (built.payload.imgUrls ? `已保存，轮播所选 ${built.payload.imgUrls.length} 张` : '已保存，轮播全部照片')
    this.setData({ running: true, configured: true, selectionHint: '' })
    toast.show({ title: `${saved}，屏幕即将刷新`, icon: 'none' })
    await this.reloadConfig()
    if (!this.unloaded) {
      this.setData({ saving: false })
    }
  },

  // 保存成功后重新拉一次：时区、下次刷新时间、卡片都以服务端回传为准；拉不到保留本地
  async reloadConfig() {
    let config = null
    try {
      config = await iotApi.getStrategy(this.deviceNo(), { showError: false })
    } catch (error) {
      console.warn('[WiFi轮播] 保存后查询配置失败', error && error.code, error && error.message)
      return
    }
    if (config && !this.unloaded) {
      this.applyConfig(config)
    }
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
      this.setData({ stopping: false, running: false, nextRefresh: '' })
      toast.show({ title: '已暂停轮播', icon: 'none' })
    }
  }
}))
