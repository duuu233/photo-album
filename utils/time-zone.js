// 轮播设置的时区（2026-11-05，docs/wifi/前端对接文档20261105.md 第二节）。
// 服务端按 timeZone 计算间隔 / 固定 / 纪念日的触发时刻，间隔与固定共用一个值。
//   · 只传 IANA 名（Asia/Shanghai 等），不传 UTC+8 这类固定偏移（有夏令时的地区会算错）；
//   · 默认取手机时区：优先 Intl 给的 IANA 名；取不到按当前 UTC 偏移落到候选里同偏移的第一个，
//     候选里也没有就用 Etc/GMT±N（同样是合法 IANA 名，只是没有夏令时）；
//   · 展示「Asia/Shanghai（UTC+8）」：偏移按当前时刻算（夏令时地区随季节变），算不出用候选表里的标准偏移。

// 建议候选（对接文档 2.3），zh 用于搜索与副标题，offset 为标准时间偏移（分钟，东正西负），只在 Intl 算不出时兜底
const GROUPS = [
  { name: '中国', zones: [{ id: 'Asia/Shanghai', zh: '中国 北京 上海', offset: 480 }] },
  {
    name: '港澳台',
    zones: [
      { id: 'Asia/Hong_Kong', zh: '香港', offset: 480 },
      { id: 'Asia/Macau', zh: '澳门', offset: 480 },
      { id: 'Asia/Taipei', zh: '台北', offset: 480 }
    ]
  },
  {
    name: '亚洲',
    zones: [
      { id: 'Asia/Tokyo', zh: '东京 日本', offset: 540 },
      { id: 'Asia/Seoul', zh: '首尔 韩国', offset: 540 },
      { id: 'Asia/Singapore', zh: '新加坡', offset: 480 },
      { id: 'Asia/Bangkok', zh: '曼谷 泰国', offset: 420 },
      { id: 'Asia/Dubai', zh: '迪拜 阿联酋', offset: 240 }
    ]
  },
  {
    name: '欧洲',
    zones: [
      { id: 'Europe/London', zh: '伦敦 英国', offset: 0 },
      { id: 'Europe/Paris', zh: '巴黎 法国', offset: 60 },
      { id: 'Europe/Berlin', zh: '柏林 德国', offset: 60 },
      { id: 'Europe/Moscow', zh: '莫斯科 俄罗斯', offset: 180 }
    ]
  },
  {
    name: '美洲',
    zones: [
      { id: 'America/New_York', zh: '纽约 美东', offset: -300 },
      { id: 'America/Chicago', zh: '芝加哥 美中', offset: -360 },
      { id: 'America/Denver', zh: '丹佛 美山地', offset: -420 },
      { id: 'America/Los_Angeles', zh: '洛杉矶 美西', offset: -480 }
    ]
  },
  {
    name: '大洋洲',
    zones: [
      { id: 'Australia/Sydney', zh: '悉尼 澳大利亚', offset: 600 },
      { id: 'Australia/Perth', zh: '珀斯 澳大利亚', offset: 480 },
      { id: 'Pacific/Auckland', zh: '奥克兰 新西兰', offset: 720 }
    ]
  }
]

const DEFAULT_ZONE = 'Asia/Shanghai'

const ZONES = []
GROUPS.forEach(group => {
  group.zones.forEach(zone => {
    ZONES.push(Object.assign({ group: group.name }, zone))
  })
})

function findZone(id) {
  return ZONES.filter(zone => zone.id === id)[0] || null
}

// 形如 Area/City（含 Etc/GMT-8、America/Argentina/Buenos_Aires）；UTC+8、GMT+8 这类固定偏移不算
function isIana(value) {
  const text = String(value || '').trim()
  return /^[A-Za-z]+(\/[A-Za-z0-9_+\-]+)+$/.test(text)
}

// 某时区在 date 时刻的 UTC 偏移（分钟，东正西负）；Intl 不可用或不认识这个时区返回 null
function intlOffset(id, date) {
  try {
    if (typeof Intl === 'undefined' || !Intl.DateTimeFormat) {
      return null
    }
    const text = new Intl.DateTimeFormat('en-US', {
      timeZone: id,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    }).format(date)
    const m = /(\d{1,2})\/(\d{1,2})\/(\d{4}),?\s+(\d{1,2}):(\d{2}):(\d{2})/.exec(text)
    if (!m) {
      return null
    }
    const hour = Number(m[4]) % 24 // 个别引擎 h23 仍给 24
    const local = Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2]), hour, Number(m[5]), Number(m[6]))
    const base = Math.floor(date.getTime() / 1000) * 1000
    return Math.round((local - base) / 60000)
  } catch (error) {
    return null
  }
}

// Etc/GMT 的符号与习惯相反：Etc/GMT-8 = UTC+8
function etcOffset(id) {
  const m = /^Etc\/GMT([+-])(\d{1,2})$/.exec(String(id || ''))
  if (!m) {
    return null
  }
  return (m[1] === '-' ? 1 : -1) * Number(m[2]) * 60
}

function offsetOf(id, date) {
  const now = date || new Date()
  const fromIntl = intlOffset(id, now)
  if (fromIntl !== null) {
    return fromIntl
  }
  const etc = etcOffset(id)
  if (etc !== null) {
    return etc
  }
  const zone = findZone(id)
  return zone ? zone.offset : null
}

function offsetText(minutes) {
  if (minutes === null || minutes === undefined || !Number.isFinite(Number(minutes))) {
    return ''
  }
  const value = Number(minutes)
  const sign = value < 0 ? '-' : '+'
  const abs = Math.abs(value)
  const hours = Math.floor(abs / 60)
  const rest = abs % 60
  return `UTC${sign}${hours}${rest ? ':' + String(rest).padStart(2, '0') : ''}`
}

// 「Asia/Shanghai（UTC+8）」；偏移算不出只显示名字
function label(id, date) {
  const name = String(id || '')
  const offset = offsetText(offsetOf(name, date))
  return offset ? `${name}（${offset}）` : name
}

// 手机时区。env 便于单测：{ systemInfo, intlZone, offsetMinutes }
function detect(env) {
  const e = env || {}
  let fromSystem = e.systemInfo
  if (fromSystem === undefined) {
    try {
      fromSystem = (typeof wx !== 'undefined' && wx.getSystemInfoSync && wx.getSystemInfoSync().timezone) || ''
    } catch (error) {
      fromSystem = ''
    }
  }
  if (isIana(fromSystem)) {
    return String(fromSystem).trim()
  }
  let fromIntl = e.intlZone
  if (fromIntl === undefined) {
    try {
      fromIntl = (typeof Intl !== 'undefined' && Intl.DateTimeFormat().resolvedOptions().timeZone) || ''
    } catch (error) {
      fromIntl = ''
    }
  }
  if (isIana(fromIntl) && !/^Etc\//.test(fromIntl)) {
    return String(fromIntl).trim()
  }
  // 兜底：当前 UTC 偏移（getTimezoneOffset 是西正东负，取反）
  const offset = e.offsetMinutes !== undefined ? Number(e.offsetMinutes) : -new Date().getTimezoneOffset()
  if (offset === 480) {
    return DEFAULT_ZONE
  }
  const now = new Date()
  const same = ZONES.filter(zone => offsetOf(zone.id, now) === offset)[0]
  if (same) {
    return same.id
  }
  if (Number.isFinite(offset) && offset % 60 === 0 && Math.abs(offset) <= 14 * 60) {
    const hours = offset / 60
    return hours === 0 ? 'Etc/GMT' : `Etc/GMT${hours > 0 ? '-' : '+'}${Math.abs(hours)}`
  }
  return DEFAULT_ZONE
}

// 选择列表：分组 + 搜索（名字、中文城市、分组名都能搜，不区分大小写）。
// current 不在候选里时放到最前面「当前」一组，保证回显的值能看到、能选回。
function options(keyword, current, date) {
  const now = date || new Date()
  const word = String(keyword || '').trim().toLowerCase()
  const rows = []
  const push = (group, zone) => {
    rows.push({ id: zone.id, group, zh: zone.zh || '', label: label(zone.id, now) })
  }
  if (current && !findZone(current)) {
    const matched = !word || String(current).toLowerCase().indexOf(word) > -1
    if (matched) {
      push('当前', { id: current, zh: '' })
    }
  }
  ZONES.forEach(zone => {
    const text = `${zone.id} ${zone.zh} ${zone.group}`.toLowerCase()
    if (!word || text.indexOf(word) > -1) {
      push(zone.group, zone)
    }
  })
  // 同组只在第一行显示组名
  return rows.map((row, index) => Object.assign(row, { showGroup: index === 0 || rows[index - 1].group !== row.group }))
}

module.exports = {
  GROUPS,
  ZONES,
  DEFAULT_ZONE,
  isIana,
  offsetOf,
  offsetText,
  label,
  detect,
  options
}
