// WiFi 版轮播设置的纯逻辑。页面 subpackages/device/wifi-slideshow 只管交互，表单 ↔ 接口字段的换算、选图顺序、
// 高级卡片都在这里，便于单测。
//
// 2026-11-05 起按 docs/wifi/前端对接文档20261105.md（轮播服务端化）：服务端按配置定时推图，设备不再自己按 strategy 拉图。
//   · 时区 timeZone 必传（IANA 名，间隔 / 固定共用，见 utils/time-zone.js）；
//   · 间隔 timingTime 600~86400 秒，档位 10 分钟起（去掉 1 / 5 分钟）；beginTime / endTime 不传默认 00:00~24:00，endTime 允许 24:00，
//     beginTime > endTime 视为跨天；
//   · 固定 updateDays 1~365 + updateTimeList HH:mm[]（至少 1 个）；mode 1 顺序 / 2 随机；
//   · idle 已废弃（不再传，页面去掉「轮播后休眠」）；
//   · 间隔 / 固定二选一，切换不清空另一方：两组参数都带上（当前模式的校验过，另一方合法才带），服务端只取当前模式那组；
//   · 高级设置：weekday / weekend（各 0~1 张，enabled 开关）+ anniversaries（0~N 张，monthDay MM-dd 不可重复），
//     每张卡片独立的时间设置、图片组、顺序；每天只有一种卡片生效（纪念日 > 周末 / 工作日 > 基础配置），不做跨卡片时间重叠校验；
//   · 保存后不再额外 /api/device/play 投第一张（2026-11-05 确认：下发轮播后设备会立刻自动刷屏）。
//
// 2026-11-05 修订版 docs/wifi/前端对接文档20261105-1.md（与上一版冲突以它为准）：
//   · 基础配置做成「简单模式」卡片，带启用开关（默认启用）。关闭 = 不提交基础字段：间隔的 timingTime / beginTime / endTime、
//     固定的 updateDays / updateTimeList，以及基础的 mode / imgUrls；回显时当前模式的基础字段为空（intervalMinutes / updateDays
//     为 null、updateTimeList 空）即视为关闭；
//   · 保存条件：简单模式启用，或至少一张高级卡片启用（工作日 / 周末 enabled、任一纪念日），否则「至少配置一项」、保存按钮置灰；
//   · 固定模式每 N 天 1~30（原 1~365）；updateDays 只在 updateTimeList 非空时才带。存量配置 > 30 的照样回显，提示调整、不让保存；
//   · 纪念日只选月日，2 月最多 28 日（服务端拒绝 02-29），4 / 6 / 9 / 11 月 30 日；
//   · 「下次刷新：MM-dd HH:mm · 卡片类型」（nextRefreshCardType：base 按间隔「每 N 分钟 / 小时」或固定「每天 / 每 N 天」，
//     对应字段为 null 不带后缀；weekday / weekend / anniversary 为「工作日 / 周末 / 纪念日」）；nextRefreshAt 为 null 整行不显示。
//
// 选图（沿用 2026-10-27 起的规则）：
//   · imgUrls：「我的上传」里选中照片的 imgBle，按选择顺序，最多 100；不传 = 轮播全部相册；**不能传空数组**（服务端回 4000）；
//   · 开启轮播必须至少选一张（2026-11-05 确认）：基础配置与每张启用的卡片都要选，一张没选不让保存；
//   · 基础配置按相册顺序全选时不带 imgUrls（= 全部相册，之后新上传的也进轮播）；卡片的图片组一律按所选明确提交；
//   · 回显 imgUrls：null = 简单模式保存过时是「全部相册」（页面上全选；相册超过 100 张只选前 100 张），没配置过 / 简单模式没保存时默认不选（2026-11-06）；[] = 选过但照片都删了（提示重新选择）。
const timeZone = require('./time-zone')

const UPDATE_INTERVAL = 2
const UPDATE_FIXED = 1
const MAX_IMG_URLS = 100
const MAX_UPDATE_DAYS = 30
const MAX_TIME_POINTS = 24
const MIN_TIMING_SECONDS = 600
const MAX_TIMING_SECONDS = 86400
// 间隔可选档位（分钟），对接文档 5.1 建议候选：10 分钟起，最大 24 小时
const INTERVAL_OPTIONS = [10, 15, 30, 60, 120, 180, 360, 720, 1440]
const DAY_START = '00:00'
const DAY_END = '24:00'
const DEFAULT_FORM = {
  updateType: UPDATE_INTERVAL,
  simpleEnabled: true, // 简单模式（基础配置）启用开关，默认启用并展开
  timeZone: '',
  beginTime: DAY_START,
  endTime: DAY_END,
  intervalMinutes: 60,
  updateDays: 1,
  updateTimeList: ['08:00'],
  mode: 1
}

const CARD_WEEKDAY = 'weekday'
const CARD_WEEKEND = 'weekend'
const CARD_ANNIVERSARY = 'anniversary'
const CARD_NAME = { weekday: '工作日', weekend: '周末' }

// 结束时间选择器两列：时 00~24、分 00~59（选 24 时分钟只能是 00）
const END_HOURS = Array.from({ length: 25 }, (v, i) => String(i).padStart(2, '0'))
const END_MINUTES = Array.from({ length: 60 }, (v, i) => String(i).padStart(2, '0'))
const END_TIME_COLUMNS = [END_HOURS, END_MINUTES]

function isTime(value) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || ''))
}

// 窗口结束额外允许 24:00
function isEndTime(value) {
  return isTime(value) || String(value || '') === DAY_END
}

// 时间点去重、去非法、按时刻排序
function normalizeTimes(list) {
  const out = []
  ;(Array.isArray(list) ? list : []).forEach(item => {
    const value = String(item || '').trim()
    if (isTime(value) && out.indexOf(value) === -1) {
      out.push(value)
    }
  })
  return out.sort()
}

// 结束时间 ↔ 选择器下标 [时, 分]
function endTimeIndex(value) {
  const text = isEndTime(value) ? String(value) : DAY_END
  return [Number(text.slice(0, 2)), Number(text.slice(3, 5))]
}

function endTimeFromIndex(index) {
  const hour = Math.min(24, Math.max(0, Number(index && index[0]) || 0))
  const minute = hour === 24 ? 0 : Math.min(59, Math.max(0, Number(index && index[1]) || 0))
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

// 最接近的间隔档位下标（回显用：服务端可能存了不在档位里的分钟数，低于 10 分钟的落到 10 分钟）
function intervalIndexOf(minutes) {
  const value = Number(minutes)
  if (!(value > 0)) {
    return INTERVAL_OPTIONS.indexOf(DEFAULT_FORM.intervalMinutes)
  }
  let best = 0
  INTERVAL_OPTIONS.forEach((option, index) => {
    if (Math.abs(option - value) < Math.abs(INTERVAL_OPTIONS[best] - value)) {
      best = index
    }
  })
  return best
}

function intervalLabel(minutes) {
  const value = Number(minutes)
  if (value >= 60 && value % 60 === 0) {
    return `${value / 60} 小时`
  }
  return `${value} 分钟`
}

// 回显的间隔分钟：intervalMinutes 优先，没有就按 timingTime 秒换算；再落到最近档位
function minutesOf(raw) {
  const r = raw || {}
  const minutes = Number(r.intervalMinutes) || (Number(r.timingTime) > 0 ? Math.ceil(Number(r.timingTime) / 60) : 0)
  return INTERVAL_OPTIONS[intervalIndexOf(minutes)]
}

// 回显：当前模式的基础字段有值才算简单模式启用（关闭时服务端不存基础字段，intervalMinutes / updateDays 回 null）
function hasBaseConfig(raw, updateType) {
  const r = raw || {}
  if (updateType === UPDATE_FIXED) {
    return normalizeTimes(r.updateTimeList).length > 0
  }
  return Number(r.intervalMinutes) > 0 || Number(r.timingTime) > 0
}

// GET /api/device/strategy → 基础配置表单。没配置过（configured=false）用默认值；
// 时区：服务端回传了合法 IANA 名就用它（保存后以服务端为准），否则用 fallbackZone（手机时区）。
// 每 N 天：存量配置可能 > 30（原上限 365），原值回显（页面提示调整，保存时拦下），不悄悄改成别的天数
function formFromStrategy(strategy, fallbackZone) {
  const s = strategy || {}
  const zone = timeZone.isIana(s.timeZone) ? String(s.timeZone) : String(fallbackZone || timeZone.DEFAULT_ZONE)
  if (!s.configured) {
    return Object.assign({}, DEFAULT_FORM, { timeZone: zone, updateTimeList: DEFAULT_FORM.updateTimeList.slice() })
  }
  const updateType = Number(s.updateType) === UPDATE_FIXED ? UPDATE_FIXED : UPDATE_INTERVAL
  const days = Number(s.updateDays)
  const times = normalizeTimes(s.updateTimeList)
  return {
    updateType,
    simpleEnabled: hasBaseConfig(s, updateType),
    timeZone: zone,
    beginTime: isTime(s.beginTime) ? s.beginTime : DAY_START,
    endTime: isEndTime(s.endTime) ? s.endTime : DAY_END,
    intervalMinutes: minutesOf(s),
    updateDays: days >= 1 ? Math.floor(days) : DEFAULT_FORM.updateDays,
    updateTimeList: times.length ? times : DEFAULT_FORM.updateTimeList.slice(),
    mode: Number(s.mode) === 2 ? 2 : 1
  }
}

// 回显的 imgUrls 与当前相册对一下：只留相册里还在的、保持原顺序。返回 { selected, hint }
function pickFromAlbum(urls, album) {
  const selected = []
  urls.forEach(url => {
    if (album.indexOf(url) > -1 && selected.indexOf(url) === -1 && selected.length < MAX_IMG_URLS) {
      selected.push(url)
    }
  })
  if (!urls.length) {
    return { selected, hint: '之前选择的照片已全部删除，请重新选择' }
  }
  if (!selected.length) {
    return { selected, hint: '之前选择的照片已不在「我的上传」中' }
  }
  if (selected.length < urls.length) {
    return { selected, hint: `之前选择的照片有 ${urls.length - selected.length} 张已删除` }
  }
  return { selected, hint: '' }
}

// 没选过（null）= 全部相册：按相册顺序全选，超过上限只选前 MAX_IMG_URLS 张并说明
function wholeAlbum(album) {
  if (album.length > MAX_IMG_URLS) {
    return {
      selected: album.slice(0, MAX_IMG_URLS),
      hint: `当前轮播全部照片；最多选择 ${MAX_IMG_URLS} 张，已选前 ${MAX_IMG_URLS} 张，保存后只轮播所选`
    }
  }
  return { selected: album.slice(), hint: '' }
}

// 基础配置的回显选择。查询失败（strategy 为空）不选。
// imgUrls 为 null 时（2026-11-06 起「默认不选」）：只有简单模式确实保存过（configured 且基础字段在）才是用户选的「全部相册」，
// 按相册顺序全选；没配置过、或只配过高级卡片（简单模式没保存）一律不选，由用户自己挑
function selectionFromStrategy(strategy, albumUrls) {
  const urls = strategy && strategy.imgUrls
  const album = Array.isArray(albumUrls) ? albumUrls : []
  if (!Array.isArray(urls)) {
    const savedWhole = !!(strategy && strategy.configured) &&
      hasBaseConfig(strategy, Number(strategy.updateType) === UPDATE_FIXED ? UPDATE_FIXED : UPDATE_INTERVAL)
    return savedWhole ? wholeAlbum(album) : { selected: [], hint: '' }
  }
  return pickFromAlbum(urls, album)
}

// 卡片的回显选择：卡片对象里没有 imgUrls（null / 缺）按全部相册全选，与基础配置同口径
function selectionFromCard(imgUrls, albumUrls) {
  const album = Array.isArray(albumUrls) ? albumUrls : []
  return Array.isArray(imgUrls) ? pickFromAlbum(imgUrls, album) : wholeAlbum(album)
}

// 点一张：选中追加到末尾（顺序 = 轮播顺序），再点取消。超上限返回 { selected, overflow: true } 不改
function toggleSelection(selected, url) {
  const list = (selected || []).slice()
  const at = list.indexOf(url)
  if (at > -1) {
    list.splice(at, 1)
    return { selected: list, overflow: false }
  }
  if (list.length >= MAX_IMG_URLS) {
    return { selected: list, overflow: true }
  }
  list.push(url)
  return { selected: list, overflow: false }
}

// 已选满上限（未选的置灰、点了只提示）
function isFull(selected) {
  return (selected || []).length >= MAX_IMG_URLS
}

// 全选按钮的状态：相册全选了，或已选满上限（相册超过上限时选不全，此时按钮给「取消全选」）
function isAllSelected(selected, albumUrls) {
  const album = Array.isArray(albumUrls) ? albumUrls : []
  const list = selected || []
  return !!album.length && (isFull(list) || album.every(url => list.indexOf(url) > -1))
}

// 全选 / 取消全选：已全选（或已选满）则清空；否则保留已选顺序，把没选的按网格顺序追加（截到上限）
function toggleAll(selected, albumUrls) {
  const album = Array.isArray(albumUrls) ? albumUrls : []
  const list = (selected || []).slice()
  if (isAllSelected(list, album)) {
    return []
  }
  album.forEach(url => {
    if (list.indexOf(url) === -1 && list.length < MAX_IMG_URLS) {
      list.push(url)
    }
  })
  return list
}

// 是否「按相册顺序全选」：是则不带 imgUrls，保持「全部相册」语义
function isWholeAlbum(selected, albumUrls) {
  const album = Array.isArray(albumUrls) ? albumUrls : []
  const list = selected || []
  return !!album.length && list.length === album.length && album.every((url, index) => list[index] === url)
}

// ── 纪念日日期 ─────────────────────────────────────────

// 2 月最多 28 日（20261105-1 第 7 条：服务端拒绝 02-29，2 月 29 日出生的选 2 月 28 日）
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

function isMonthDay(value) {
  const m = /^(\d{2})-(\d{2})$/.exec(String(value || ''))
  if (!m) {
    return false
  }
  const month = Number(m[1])
  const day = Number(m[2])
  return month >= 1 && month <= 12 && day >= 1 && day <= MONTH_DAYS[month - 1]
}

function monthDayLabel(value) {
  if (!isMonthDay(value)) {
    return ''
  }
  return `${value.slice(0, 2)}月${value.slice(3, 5)}日`
}

// 纪念日日期选择器（两列：月 / 日，不选年）。日这一列随月份变：2 月 28 天，4 / 6 / 9 / 11 月 30 天
const MONTH_LABELS = Array.from({ length: 12 }, (v, i) => `${String(i + 1).padStart(2, '0')}月`)

function dayLabels(month) {
  const count = MONTH_DAYS[Math.min(12, Math.max(1, Number(month) || 1)) - 1]
  return Array.from({ length: count }, (v, i) => `${String(i + 1).padStart(2, '0')}日`)
}

function monthDayColumns(month) {
  return [MONTH_LABELS, dayLabels(month)]
}

// MM-dd ↔ 选择器下标 [月, 日]
function monthDayIndex(value) {
  if (!isMonthDay(value)) {
    return [0, 0]
  }
  return [Number(value.slice(0, 2)) - 1, Number(value.slice(3, 5)) - 1]
}

// 下标 → MM-dd；日超过该月天数时落到月末（先滚到 31 日再切到 2 月的情况）
function monthDayFromIndex(index) {
  const month = Math.min(12, Math.max(1, (Number(index && index[0]) || 0) + 1))
  const day = Math.min(MONTH_DAYS[month - 1], Math.max(1, (Number(index && index[1]) || 0) + 1))
  return `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

// 新增纪念日的默认日期：从 start（MM-dd，默认 01-01）起找第一个没被占用的日子
function nextFreeMonthDay(taken, start) {
  const used = Array.isArray(taken) ? taken : []
  let month = 1
  let day = 1
  if (isMonthDay(start)) {
    month = Number(start.slice(0, 2))
    day = Number(start.slice(3, 5))
  }
  for (let n = 0; n < 366; n += 1) {
    const value = `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    if (used.indexOf(value) === -1) {
      return value
    }
    day += 1
    if (day > MONTH_DAYS[month - 1]) {
      day = 1
      month = month === 12 ? 1 : month + 1
    }
  }
  return ''
}

// ── 高级卡片 ─────────────────────────────────────────

// 卡片表单：两组时间参数都留着（切换模式不清空），selected 为该卡片的图片组（imgBle，按选择顺序）
function defaultCard(kind, monthDay) {
  return {
    kind,
    enabled: kind === CARD_ANNIVERSARY,
    monthDay: kind === CARD_ANNIVERSARY ? String(monthDay || '') : '',
    beginTime: DAY_START,
    endTime: DAY_END,
    intervalMinutes: DEFAULT_FORM.intervalMinutes,
    // 纪念日固定模式默认 ["00:00"]（对接文档 7.2）
    updateTimeList: kind === CARD_ANNIVERSARY ? ['00:00'] : DEFAULT_FORM.updateTimeList.slice(),
    mode: 1,
    selected: [],
    hint: ''
  }
}

// 接口里的卡片对象 → 卡片表单。raw 为空（null / 不传）→ 未启用的默认卡片
function cardFromStrategy(raw, kind, albumUrls) {
  if (!raw || typeof raw !== 'object') {
    return defaultCard(kind)
  }
  const card = defaultCard(kind, raw.monthDay)
  const times = normalizeTimes(raw.updateTimeList)
  const picked = selectionFromCard(raw.imgUrls, albumUrls)
  return Object.assign(card, {
    enabled: kind === CARD_ANNIVERSARY ? true : raw.enabled === true,
    beginTime: isTime(raw.beginTime) ? raw.beginTime : DAY_START,
    endTime: isEndTime(raw.endTime) ? raw.endTime : DAY_END,
    intervalMinutes: minutesOf(raw),
    updateTimeList: times.length ? times : card.updateTimeList,
    mode: Number(raw.mode) === 2 ? 2 : 1,
    selected: picked.selected,
    hint: picked.hint
  })
}

// 回显全部高级卡片；纪念日去掉日期非法 / 重复的，按日期排序
function advancedFromStrategy(strategy, albumUrls) {
  const s = strategy || {}
  const anniversaries = []
  const seen = []
  ;(Array.isArray(s.anniversaries) ? s.anniversaries : []).forEach(raw => {
    const monthDay = raw && String(raw.monthDay || '')
    if (isMonthDay(monthDay) && seen.indexOf(monthDay) === -1) {
      seen.push(monthDay)
      anniversaries.push(cardFromStrategy(raw, CARD_ANNIVERSARY, albumUrls))
    }
  })
  anniversaries.sort((a, b) => (a.monthDay < b.monthDay ? -1 : a.monthDay > b.monthDay ? 1 : 0))
  return {
    weekday: cardFromStrategy(s.weekday, CARD_WEEKDAY, albumUrls),
    weekend: cardFromStrategy(s.weekend, CARD_WEEKEND, albumUrls),
    anniversaries
  }
}

// 页面展示用字段（选择器下标、日期文案、已选张数）
function decorateCard(card) {
  const c = card || {}
  const dayIndex = monthDayIndex(c.monthDay)
  return Object.assign({}, c, {
    intervalIndex: intervalIndexOf(c.intervalMinutes),
    endTimeIndex: endTimeIndex(c.endTime),
    monthDayLabel: monthDayLabel(c.monthDay),
    monthDayIndex: dayIndex,
    monthDayColumns: monthDayColumns(dayIndex[0] + 1),
    selectedCount: (c.selected || []).length
  })
}

function decorateAdvanced(advanced) {
  const a = advanced || {}
  return {
    weekday: decorateCard(a.weekday || defaultCard(CARD_WEEKDAY)),
    weekend: decorateCard(a.weekend || defaultCard(CARD_WEEKEND)),
    anniversaries: (a.anniversaries || []).map(decorateCard)
  }
}

// 「高级设置（N 项）」：启用的工作日 / 周末 + 纪念日条数
function advancedCount(advanced) {
  const a = advanced || {}
  return (a.weekday && a.weekday.enabled ? 1 : 0) + (a.weekend && a.weekend.enabled ? 1 : 0) + (a.anniversaries || []).length
}

// 简单模式旁的提示（对接文档 4.2）：只看工作日 / 周末是否启用，纯文字、不阻断保存。
// 20261105-1 起基础配置叫「简单模式」，文案随之改名
function baseHint(advanced) {
  const a = advanced || {}
  const weekday = !!(a.weekday && a.weekday.enabled)
  const weekend = !!(a.weekend && a.weekend.enabled)
  if (weekday && weekend) {
    return '工作日与周末均已启用，简单模式将不会生效'
  }
  if (weekday) {
    return '工作日已启用独立配置，简单模式在工作日不生效'
  }
  if (weekend) {
    return '周末已启用独立配置，简单模式在周末不生效'
  }
  return ''
}

// 是否有可保存的配置（20261105-1 第 8 条）：简单模式启用，或任一高级卡片启用（工作日 / 周末 enabled、任一纪念日）
function hasAnyConfig(form, advanced) {
  const f = form || {}
  const a = advanced || {}
  return f.simpleEnabled !== false ||
    !!(a.weekday && a.weekday.enabled) ||
    !!(a.weekend && a.weekend.enabled) ||
    (a.anniversaries || []).length > 0
}

// 每 N 天合法范围 1~30
function isUpdateDays(value) {
  const days = Number(value)
  return Number.isInteger(days) && days >= 1 && days <= MAX_UPDATE_DAYS
}

// 存量配置每 N 天 > 30 时的提示（服务端照旧按原值跑，但改任何设置都存不了）：只在简单模式启用时给
function daysOverHint(form) {
  const f = form || {}
  if (f.simpleEnabled === false || !(Number(f.updateDays) > MAX_UPDATE_DAYS)) {
    return ''
  }
  return `当前播放频率为每 ${Number(f.updateDays)} 天，已超过 ${MAX_UPDATE_DAYS} 天上限，请调整后再保存`
}

// ── 保存 ─────────────────────────────────────────

// 间隔参数：合法返回 { value: { beginTime, endTime, timingTime } }，否则 { error }
function intervalGroup(src) {
  const s = src || {}
  if (!isTime(s.beginTime) || !isEndTime(s.endTime)) {
    return { error: '请选择轮播开始和结束时间' }
  }
  if (s.beginTime === s.endTime) {
    return { error: '开始和结束时间不能相同' }
  }
  const seconds = Math.round(Number(s.intervalMinutes) * 60)
  if (!(seconds >= MIN_TIMING_SECONDS && seconds <= MAX_TIMING_SECONDS)) {
    return { error: '轮播间隔需在 10 分钟到 24 小时之间' }
  }
  return { value: { beginTime: s.beginTime, endTime: s.endTime, timingTime: seconds } }
}

// 固定时间点：合法返回 { value: { updateTimeList } }，否则 { error }
function fixedGroup(src) {
  const times = normalizeTimes(src && src.updateTimeList)
  if (!times.length) {
    return { error: '请至少添加一个时间点' }
  }
  return { value: { updateTimeList: times } }
}

// 两组参数都带上：当前模式那组出错直接返回错误，另一方合法才带（切换模式不清空另一方）
function bothGroups(src, updateType) {
  const interval = intervalGroup(src)
  const fixed = fixedGroup(src)
  const current = updateType === UPDATE_FIXED ? fixed : interval
  if (current.error) {
    return { error: current.error }
  }
  return { value: Object.assign({}, interval.value || {}, fixed.value || {}) }
}

function photoError(urls) {
  if (!urls.length) {
    return '请至少选择一张照片'
  }
  if (urls.length > MAX_IMG_URLS) {
    return `最多选择 ${MAX_IMG_URLS} 张，请先取消部分照片`
  }
  return ''
}

// 卡片 → 接口对象。返回 { value }（未配置的工作日 / 周末为 null）或 { error }
function cardPayload(card, updateType) {
  const c = card || {}
  const name = c.kind === CARD_ANNIVERSARY ? `纪念日 ${monthDayLabel(c.monthDay)}`.trim() : CARD_NAME[c.kind] || ''
  const urls = (c.selected || []).filter(Boolean)
  const mode = Number(c.mode) === 2 ? 2 : 1
  if (c.kind !== CARD_ANNIVERSARY && !c.enabled) {
    // 未启用：选过照片的把参数随 enabled=false 带上（下次启用不用重填），没选过照片的按未配置传 null
    if (!urls.length || urls.length > MAX_IMG_URLS) {
      return { value: null }
    }
    const interval = intervalGroup(c)
    const fixed = fixedGroup(c)
    return { value: Object.assign({ enabled: false, mode }, interval.value || {}, fixed.value || {}, { imgUrls: urls.slice() }) }
  }
  if (c.kind === CARD_ANNIVERSARY && !isMonthDay(c.monthDay)) {
    return { error: '请选择纪念日日期' }
  }
  const groups = bothGroups(c, updateType)
  if (groups.error) {
    return { error: `${name}：${groups.error}` }
  }
  const photos = photoError(urls)
  if (photos) {
    return { error: `${name}：${photos}` }
  }
  const value = Object.assign({}, groups.value, { mode, imgUrls: urls.slice() })
  if (c.kind === CARD_ANNIVERSARY) {
    return { value: Object.assign({ monthDay: c.monthDay }, value) }
  }
  return { value: Object.assign({ enabled: true }, value) }
}

// 表单 + 已选 + 高级卡片 → POST /api/device/strategy 的 body。返回 { payload } 或 { error }（给用户看的文案）。
// albumUrls 传相册里可选的全部照片（网格顺序），用来判断「全部相册」；advanced 不传则不带三类卡片字段。
// 简单模式关闭（form.simpleEnabled === false）时基础字段、基础 mode / imgUrls 一律不带，此时至少要启用一张高级卡片
function buildPayload(deviceNo, form, selected, albumUrls, advanced) {
  const f = form || {}
  const updateType = Number(f.updateType) === UPDATE_FIXED ? UPDATE_FIXED : UPDATE_INTERVAL
  if (!timeZone.isIana(f.timeZone)) {
    return { error: '请选择时区' }
  }
  if (!hasAnyConfig(f, advanced)) {
    return { error: '至少配置一项' }
  }
  const payload = {
    deviceNo,
    updateType,
    timeZone: String(f.timeZone)
  }
  if (f.simpleEnabled !== false) {
    const daysOk = isUpdateDays(f.updateDays)
    if (updateType === UPDATE_FIXED && !daysOk) {
      return { error: `每隔天数需在 1~${MAX_UPDATE_DAYS} 之间，请调整播放频率` }
    }
    const groups = bothGroups(f, updateType)
    if (groups.error) {
      return { error: groups.error }
    }
    const value = Object.assign({}, groups.value)
    // updateDays 只跟着 updateTimeList 走（20261105-1 第 8 条）；天数不合法时固定那组整组不带（间隔模式下）
    if (value.updateTimeList && daysOk) {
      value.updateDays = Number(f.updateDays)
    } else {
      delete value.updateTimeList
    }
    const urls = (selected || []).filter(Boolean)
    const photos = photoError(urls)
    if (photos) {
      return { error: photos }
    }
    Object.assign(payload, { mode: Number(f.mode) === 2 ? 2 : 1 }, value)
    if (!isWholeAlbum(urls, albumUrls)) {
      payload.imgUrls = urls.slice()
    }
  }
  if (advanced) {
    const weekday = cardPayload(Object.assign({}, advanced.weekday, { kind: CARD_WEEKDAY }), updateType)
    if (weekday.error) {
      return { error: weekday.error }
    }
    const weekend = cardPayload(Object.assign({}, advanced.weekend, { kind: CARD_WEEKEND }), updateType)
    if (weekend.error) {
      return { error: weekend.error }
    }
    const anniversaries = []
    const seen = []
    const list = advanced.anniversaries || []
    for (let i = 0; i < list.length; i += 1) {
      const card = Object.assign({}, list[i], { kind: CARD_ANNIVERSARY })
      if (seen.indexOf(card.monthDay) > -1) {
        return { error: `纪念日 ${monthDayLabel(card.monthDay)} 重复，请修改日期` }
      }
      seen.push(card.monthDay)
      const built = cardPayload(card, updateType)
      if (built.error) {
        return { error: built.error }
      }
      anniversaries.push(built.value)
    }
    payload.weekday = weekday.value
    payload.weekend = weekend.value
    payload.anniversaries = anniversaries
  }
  return { payload }
}

// 时间文案：yyyy-MM-dd HH:mm:ss → 'MM-dd HH:mm'（short）或 'yyyy-MM-dd HH:mm'；认不出原样返回，空返回 ''
function timeText(value, short) {
  const text = String(value || '').trim()
  if (!text) {
    return ''
  }
  const m = /^(\d{4})-(\d{2}-\d{2})[ T](\d{2}:\d{2})/.exec(text)
  if (!m) {
    return text
  }
  return short ? `${m[2]} ${m[3]}` : `${m[1]}-${m[2]} ${m[3]}`
}

// 「下次刷新」的时间：MM-dd HH:mm（20261105-1 第 5 条示例「11-06 08:00」）
function nextRefreshText(value) {
  return timeText(value, true)
}

// 「设置时间：2026-11-05 21:43」：updatedAt 去掉秒
function updatedAtText(value) {
  return timeText(value, false)
}

// 「下次刷新」后面的卡片类型（20261105-1 第 5 条 / 3.3）。base 按当前轮播方式：
// 间隔取 intervalMinutes「每 N 分钟 / 每 N 小时」，固定取 updateDays「每天 / 每 N 天」；对应字段为 null 不带后缀
function nextRefreshCardText(config) {
  const c = config || {}
  const type = String(c.nextRefreshCardType || '')
  if (type === 'weekday') {
    return '工作日'
  }
  if (type === 'weekend') {
    return '周末'
  }
  if (type === 'anniversary') {
    return '纪念日'
  }
  if (type !== 'base') {
    return ''
  }
  if (Number(c.updateType) === UPDATE_FIXED) {
    if (c.updateDays === null || c.updateDays === undefined || !(Number(c.updateDays) >= 1)) {
      return ''
    }
    const days = Number(c.updateDays)
    return days === 1 ? '每天' : `每 ${days} 天`
  }
  if (c.intervalMinutes === null || c.intervalMinutes === undefined || !(Number(c.intervalMinutes) > 0)) {
    return ''
  }
  const minutes = Number(c.intervalMinutes)
  return minutes >= 60 && minutes % 60 === 0 ? `每 ${minutes / 60} 小时` : `每 ${minutes} 分钟`
}

// 「下次刷新：11-06 08:00 · 工作日」冒号后的部分；nextRefreshAt 为 null 返回 ''（整行不显示）
function nextRefreshLine(config) {
  const c = config || {}
  const time = nextRefreshText(c.nextRefreshAt)
  if (!time) {
    return ''
  }
  const card = nextRefreshCardText(c)
  return card ? `${time} · ${card}` : time
}

// 保存失败的提示：4000（参数错误，含超过 100 张）给明确文案，其余返回 '' 由页面按通用错误处理
function saveErrorText(error, payload) {
  if (!error || Number(error.code) !== 4000) {
    return ''
  }
  const count = payload && Array.isArray(payload.imgUrls) ? payload.imgUrls.length : 0
  if (count >= MAX_IMG_URLS) {
    return `轮播照片最多 ${MAX_IMG_URLS} 张，请先取消部分照片后再保存`
  }
  const server = String(error.serverMessage || '').trim()
  return server ? `保存失败：${server}` : '保存失败：轮播设置有误，请检查后重试'
}

module.exports = {
  UPDATE_INTERVAL,
  UPDATE_FIXED,
  MAX_IMG_URLS,
  MAX_UPDATE_DAYS,
  MAX_TIME_POINTS,
  MIN_TIMING_SECONDS,
  MAX_TIMING_SECONDS,
  INTERVAL_OPTIONS,
  DAY_START,
  DAY_END,
  DEFAULT_FORM,
  CARD_WEEKDAY,
  CARD_WEEKEND,
  CARD_ANNIVERSARY,
  END_TIME_COLUMNS,
  isTime,
  isEndTime,
  normalizeTimes,
  endTimeIndex,
  endTimeFromIndex,
  intervalIndexOf,
  intervalLabel,
  hasBaseConfig,
  formFromStrategy,
  selectionFromStrategy,
  selectionFromCard,
  toggleSelection,
  isFull,
  isAllSelected,
  toggleAll,
  isWholeAlbum,
  isMonthDay,
  monthDayLabel,
  MONTH_DAYS,
  monthDayColumns,
  monthDayIndex,
  monthDayFromIndex,
  nextFreeMonthDay,
  defaultCard,
  cardFromStrategy,
  advancedFromStrategy,
  decorateCard,
  decorateAdvanced,
  advancedCount,
  baseHint,
  hasAnyConfig,
  isUpdateDays,
  daysOverHint,
  intervalGroup,
  fixedGroup,
  cardPayload,
  buildPayload,
  nextRefreshText,
  updatedAtText,
  nextRefreshCardText,
  nextRefreshLine,
  saveErrorText
}
