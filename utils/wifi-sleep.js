// WiFi 版休眠设置的纯逻辑（2026-10-27，docs/wifi/V1.4对接实现报告反馈.md 第二节、V1.4 更新说明第四节）。
// 页面 subpackages/device/wifi-sleep 只管交互，回显 ↔ 表单 ↔ 提交参数的换算与校验都在这里，便于单测。
//   · mode 0 关闭；1 一次性（beginTime / endTime：yyyy-MM-dd HH:mm）；2 周期（sleepTime / wakeTime：HH:mm，可跨午夜）；
//   · 时间一律本地时间，不转 UTC（服务端转）。

const MODE_OFF = 0
const MODE_ONCE = 1
const MODE_DAILY = 2

function pad(n) {
  return String(n).padStart(2, '0')
}

function dateText(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function isTime(value) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || ''))
}

function isDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))
}

// 'yyyy-MM-dd HH:mm' → { date, time }
function splitDateTime(value) {
  const match = /^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})/.exec(String(value || ''))
  return match ? { date: match[1], time: match[2] } : null
}

// 一次性休眠的默认值：今晚 22:00 → 明早 07:00
function defaultOnce(now) {
  const today = now || new Date()
  const tomorrow = new Date(today.getTime() + 24 * 3600 * 1000)
  return { beginDate: dateText(today), beginTime: '22:00', endDate: dateText(tomorrow), endTime: '07:00' }
}

// GET /api/device/sleep → 表单 { mode, sleepTime, wakeTime, beginDate, beginTime, endDate, endTime }
function formFromSleep(plan, now) {
  const p = plan || {}
  const once = defaultOnce(now)
  const form = Object.assign({ mode: MODE_OFF, sleepTime: '22:00', wakeTime: '07:00' }, once)
  if (!p.configured) {
    return form
  }
  const mode = Number(p.mode)
  form.mode = mode === MODE_ONCE || mode === MODE_DAILY ? mode : MODE_OFF
  if (isTime(p.sleepTime)) form.sleepTime = p.sleepTime
  if (isTime(p.wakeTime)) form.wakeTime = p.wakeTime
  const begin = splitDateTime(p.beginTime)
  const end = splitDateTime(p.endTime)
  if (begin) {
    form.beginDate = begin.date
    form.beginTime = begin.time
  }
  if (end) {
    form.endDate = end.date
    form.endTime = end.time
  }
  return form
}

// 当前计划的一行说明（页面顶部「当前设置」）
function summary(plan) {
  const p = plan || {}
  if (!p.configured) {
    return '未开启休眠'
  }
  const mode = Number(p.mode)
  if (mode === MODE_DAILY) {
    const cross = isTime(p.sleepTime) && isTime(p.wakeTime) && p.wakeTime < p.sleepTime
    return `周期休眠：每天 ${p.sleepTime || '--'} ~ ${cross ? '次日 ' : ''}${p.wakeTime || '--'}`
  }
  if (mode === MODE_ONCE) {
    return `一次性休眠：${p.beginTime || '--'} ~ ${p.endTime || '--'}`
  }
  return '已关闭休眠'
}

// 表单 → POST /api/device/sleep 的 body。返回 { payload } 或 { error }（给用户看的文案）
function buildPayload(deviceNo, form, now) {
  const f = form || {}
  const mode = Number(f.mode)
  if (mode === MODE_DAILY) {
    if (!isTime(f.sleepTime) || !isTime(f.wakeTime)) {
      return { error: '请选择休眠时间和唤醒时间' }
    }
    if (f.sleepTime === f.wakeTime) {
      return { error: '休眠时间和唤醒时间不能相同' }
    }
    return { payload: { deviceNo, mode, sleepTime: f.sleepTime, wakeTime: f.wakeTime } }
  }
  if (mode === MODE_ONCE) {
    if (!isDate(f.beginDate) || !isTime(f.beginTime) || !isDate(f.endDate) || !isTime(f.endTime)) {
      return { error: '请选择开始和结束的日期与时间' }
    }
    const beginTime = `${f.beginDate} ${f.beginTime}`
    const endTime = `${f.endDate} ${f.endTime}`
    if (beginTime >= endTime) {
      return { error: '开始时间必须早于结束时间' }
    }
    const current = now || new Date()
    if (endTime <= `${dateText(current)} ${pad(current.getHours())}:${pad(current.getMinutes())}`) {
      return { error: '结束时间已过，请重新选择' }
    }
    return { payload: { deviceNo, mode, beginTime, endTime } }
  }
  return { payload: { deviceNo, mode: MODE_OFF } }
}

module.exports = {
  MODE_OFF,
  MODE_ONCE,
  MODE_DAILY,
  dateText,
  isTime,
  splitDateTime,
  defaultOnce,
  formFromSleep,
  summary,
  buildPayload
}
