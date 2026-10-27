// WiFi 版轮播设置的纯逻辑（2026-10-27，docs/wifi/XT相框通讯协议_V1.4_更新说明.md 第一节 1.5、第五节）。
// 页面 subpackages/device/wifi-slideshow 只管交互，表单 ↔ 接口字段的换算、选图顺序都在这里，便于单测。
//
// 接口：GET /api/device/strategy 回显，POST /api/device/strategy 保存（utils/iot-api getStrategy / setStrategy）。
//   · updateType 2 = 间隔（beginTime / endTime HH:mm + timingTime 秒），1 = 固定时间（updateDays 1~365 + updateTimeList HH:mm[]）；
//   · mode 1 顺序 / 2 随机；idle 0 轮播后休眠 / 1 不休眠；
//   · imgUrls：「我的上传」里选中照片的 imgBle，按选择顺序，最多 200；不传 = 轮播全部相册；
//     **不能传空数组**（服务端回 4000）：一张都没选时不让保存（2026-10-27 实现报告反馈六）；
//     按相册顺序全选时不带 imgUrls（= 全部相册，之后新上传的照片也会进轮播）。
//   · 回显 imgUrls：null = 没选过（全部相册，页面上全选）；[] = 选过但照片都删了（提示重新选择）。

const UPDATE_INTERVAL = 2
const UPDATE_FIXED = 1
const MAX_IMG_URLS = 200
const MAX_TIME_POINTS = 24
// 间隔可选档位（分钟）；服务端按分钟取整，最小 1 分钟
const INTERVAL_OPTIONS = [1, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440]
const DEFAULT_FORM = {
  updateType: UPDATE_INTERVAL,
  beginTime: '08:00',
  endTime: '22:00',
  intervalMinutes: 60,
  updateDays: 1,
  updateTimeList: ['08:00'],
  mode: 1,
  idle: 1
}

function isTime(value) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || ''))
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

// 最接近的间隔档位下标（回显用：服务端可能存了不在档位里的分钟数）
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

// GET /api/device/strategy → 表单。没配置过（configured=false）用默认值
function formFromStrategy(strategy) {
  const s = strategy || {}
  if (!s.configured) {
    return Object.assign({}, DEFAULT_FORM, { updateTimeList: DEFAULT_FORM.updateTimeList.slice() })
  }
  const updateType = Number(s.updateType) === UPDATE_FIXED ? UPDATE_FIXED : UPDATE_INTERVAL
  const days = Number(s.updateDays)
  const times = normalizeTimes(s.updateTimeList)
  const minutes = Number(s.intervalMinutes) || (Number(s.timingTime) > 0 ? Math.ceil(Number(s.timingTime) / 60) : 0)
  return {
    updateType,
    beginTime: isTime(s.beginTime) ? s.beginTime : DEFAULT_FORM.beginTime,
    endTime: isTime(s.endTime) ? s.endTime : DEFAULT_FORM.endTime,
    intervalMinutes: INTERVAL_OPTIONS[intervalIndexOf(minutes)],
    updateDays: days >= 1 && days <= 365 ? Math.floor(days) : DEFAULT_FORM.updateDays,
    updateTimeList: times.length ? times : DEFAULT_FORM.updateTimeList.slice(),
    mode: Number(s.mode) === 2 ? 2 : 1,
    idle: Number(s.idle) === 0 ? 0 : 1
  }
}

// 回显的 imgUrls 与当前相册对一下：只留相册里还在的、保持原顺序。
// 返回 { selected, hint }：hint 是给用户看的一行说明（已全部失效 / 部分已删除）。
// imgUrls=null（没选过 = 全部相册）按相册顺序全选；查询失败（strategy 为空）不选
function selectionFromStrategy(strategy, albumUrls) {
  const urls = strategy && strategy.imgUrls
  const album = Array.isArray(albumUrls) ? albumUrls : []
  if (!Array.isArray(urls)) {
    return { selected: strategy ? album.slice() : [], hint: '' }
  }
  const selected = []
  urls.forEach(url => {
    if (album.indexOf(url) > -1 && selected.indexOf(url) === -1) {
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

// 全选 / 取消全选：已全选则清空；否则保留已选顺序，把没选的按网格顺序追加（截到上限）
function toggleAll(selected, albumUrls) {
  const album = Array.isArray(albumUrls) ? albumUrls : []
  const list = (selected || []).slice()
  if (album.length && album.every(url => list.indexOf(url) > -1)) {
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

// 表单 + 已选 → POST /api/device/strategy 的 body。返回 { payload } 或 { error }（给用户看的文案）。
// albumUrls 传相册里可选的全部照片（网格顺序），用来判断「全部相册」
function buildPayload(deviceNo, form, selected, albumUrls) {
  const f = form || {}
  const payload = {
    deviceNo,
    updateType: Number(f.updateType) === UPDATE_FIXED ? UPDATE_FIXED : UPDATE_INTERVAL,
    mode: Number(f.mode) === 2 ? 2 : 1,
    idle: Number(f.idle) === 0 ? 0 : 1
  }
  if (payload.updateType === UPDATE_INTERVAL) {
    if (!isTime(f.beginTime) || !isTime(f.endTime)) {
      return { error: '请选择轮播开始和结束时间' }
    }
    const minutes = Number(f.intervalMinutes)
    if (!(minutes >= 1)) {
      return { error: '请选择轮播间隔' }
    }
    payload.beginTime = f.beginTime
    payload.endTime = f.endTime
    payload.timingTime = Math.round(minutes * 60)
  } else {
    const days = Number(f.updateDays)
    if (!(days >= 1 && days <= 365)) {
      return { error: '每隔天数需在 1~365 之间' }
    }
    const times = normalizeTimes(f.updateTimeList)
    if (!times.length) {
      return { error: '请至少添加一个更新时间' }
    }
    payload.updateDays = Math.floor(days)
    payload.updateTimeList = times
  }
  const urls = (selected || []).filter(Boolean)
  if (!urls.length) {
    return { error: '请至少选择一张照片' }
  }
  if (!isWholeAlbum(urls, albumUrls)) {
    payload.imgUrls = urls.slice(0, MAX_IMG_URLS)
  }
  return { payload }
}

// 保存后立即播放的那张：选了照片取第一张选中的；全部相册取相册顺序第一张（实现报告反馈六）
function firstImageUrl(payload, albumUrls) {
  if (payload && Array.isArray(payload.imgUrls) && payload.imgUrls.length) {
    return payload.imgUrls[0]
  }
  return (Array.isArray(albumUrls) && albumUrls[0]) || ''
}

module.exports = {
  UPDATE_INTERVAL,
  UPDATE_FIXED,
  MAX_IMG_URLS,
  MAX_TIME_POINTS,
  INTERVAL_OPTIONS,
  DEFAULT_FORM,
  isTime,
  normalizeTimes,
  intervalIndexOf,
  intervalLabel,
  formFromStrategy,
  selectionFromStrategy,
  toggleSelection,
  toggleAll,
  isWholeAlbum,
  buildPayload,
  firstImageUrl
}
