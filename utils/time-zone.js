// 轮播设置的时区（2026-11-05，docs/wifi/前端对接文档20261105.md 第二节；20261105-1 第 2 条 / 3.4 改展示）。
// 服务端按 timeZone 计算间隔 / 固定 / 纪念日的触发时刻，间隔与固定共用一个值。
//   · 只传 IANA 名（Asia/Shanghai 等），不传 UTC+8 这类固定偏移（有夏令时的地区会算错），也不传展示文案（「中国 / 北京」会回 4000）；
//   · 默认取手机时区：优先系统 / Intl 给的 IANA 名；取不到按当前 UTC 偏移落到候选里同偏移的第一个，
//     候选里也没有就用 Etc/GMT±N（同样是合法 IANA 名，只是没有夏令时）；
//   · 展示（20261105-1 起）：按语种显示「国家 / 城市」一段文字（如「中国 / 北京」「美国 / 纽约」），不再带 UTC+8、
//     下拉列表每行也只有这一段；展示文案与提交值是两套数据（NAMES 只管显示，提交永远是 id）。
//     不在候选里的时区（如回显的 Asia/Kolkata、兜底的 Etc/GMT-5）没有译名，原样显示 IANA 名。

const language = require('./language')

// 语种：utils/language 的四种（zh-Hans / zh-Hant / en / ja），取不到按简体中文
const LANGS = ['zh-Hans', 'zh-Hant', 'en', 'ja']

// 分组名（按语种）
const GROUP_NAMES = {
  china: ['中国', '中國', 'China', '中国'],
  asia: ['亚洲', '亞洲', 'Asia', 'アジア'],
  europe: ['欧洲', '歐洲', 'Europe', 'ヨーロッパ'],
  america: ['美洲', '美洲', 'Americas', 'アメリカ大陸'],
  oceania: ['大洋洲', '大洋洲', 'Oceania', 'オセアニア'],
  current: ['当前', '目前', 'Current', '現在']
}

// 候选（对接文档 2.3）。names 按 LANGS 顺序给「国家 / 城市」；offset 为标准时间偏移（分钟，东正西负），只在 Intl 算不出时兜底
const GROUPS = [
  {
    key: 'china',
    zones: [
      { id: 'Asia/Shanghai', names: ['中国 / 北京', '中國 / 北京', 'China / Beijing', '中国 / 北京'], offset: 480 },
      { id: 'Asia/Hong_Kong', names: ['中国 / 香港', '中國 / 香港', 'China / Hong Kong', '中国 / 香港'], offset: 480 },
      { id: 'Asia/Macau', names: ['中国 / 澳门', '中國 / 澳門', 'China / Macau', '中国 / マカオ'], offset: 480 },
      { id: 'Asia/Taipei', names: ['中国 / 台北', '中國 / 臺北', 'China / Taipei', '中国 / 台北'], offset: 480 }
    ]
  },
  {
    key: 'asia',
    zones: [
      { id: 'Asia/Tokyo', names: ['日本 / 东京', '日本 / 東京', 'Japan / Tokyo', '日本 / 東京'], offset: 540 },
      { id: 'Asia/Seoul', names: ['韩国 / 首尔', '韓國 / 首爾', 'South Korea / Seoul', '韓国 / ソウル'], offset: 540 },
      { id: 'Asia/Singapore', names: ['新加坡', '新加坡', 'Singapore', 'シンガポール'], offset: 480 },
      { id: 'Asia/Bangkok', names: ['泰国 / 曼谷', '泰國 / 曼谷', 'Thailand / Bangkok', 'タイ / バンコク'], offset: 420 },
      { id: 'Asia/Dubai', names: ['阿联酋 / 迪拜', '阿聯酋 / 杜拜', 'UAE / Dubai', 'アラブ首長国連邦 / ドバイ'], offset: 240 }
    ]
  },
  {
    key: 'europe',
    zones: [
      { id: 'Europe/London', names: ['英国 / 伦敦', '英國 / 倫敦', 'UK / London', 'イギリス / ロンドン'], offset: 0 },
      { id: 'Europe/Paris', names: ['法国 / 巴黎', '法國 / 巴黎', 'France / Paris', 'フランス / パリ'], offset: 60 },
      { id: 'Europe/Berlin', names: ['德国 / 柏林', '德國 / 柏林', 'Germany / Berlin', 'ドイツ / ベルリン'], offset: 60 },
      { id: 'Europe/Moscow', names: ['俄罗斯 / 莫斯科', '俄羅斯 / 莫斯科', 'Russia / Moscow', 'ロシア / モスクワ'], offset: 180 }
    ]
  },
  {
    key: 'america',
    zones: [
      { id: 'America/New_York', names: ['美国 / 纽约', '美國 / 紐約', 'USA / New York', 'アメリカ / ニューヨーク'], offset: -300 },
      { id: 'America/Chicago', names: ['美国 / 芝加哥', '美國 / 芝加哥', 'USA / Chicago', 'アメリカ / シカゴ'], offset: -360 },
      { id: 'America/Denver', names: ['美国 / 丹佛', '美國 / 丹佛', 'USA / Denver', 'アメリカ / デンバー'], offset: -420 },
      { id: 'America/Los_Angeles', names: ['美国 / 洛杉矶', '美國 / 洛杉磯', 'USA / Los Angeles', 'アメリカ / ロサンゼルス'], offset: -480 }
    ]
  },
  {
    key: 'oceania',
    zones: [
      { id: 'Australia/Sydney', names: ['澳大利亚 / 悉尼', '澳洲 / 雪梨', 'Australia / Sydney', 'オーストラリア / シドニー'], offset: 600 },
      { id: 'Australia/Perth', names: ['澳大利亚 / 珀斯', '澳洲 / 伯斯', 'Australia / Perth', 'オーストラリア / パース'], offset: 480 },
      { id: 'Pacific/Auckland', names: ['新西兰 / 奥克兰', '紐西蘭 / 奧克蘭', 'New Zealand / Auckland', 'ニュージーランド / オークランド'], offset: 720 }
    ]
  }
]

const DEFAULT_ZONE = 'Asia/Shanghai'

const ZONES = []
GROUPS.forEach(group => {
  group.zones.forEach(zone => {
    ZONES.push(Object.assign({ group: group.key }, zone))
  })
})

// 当前语种在 LANGS 里的下标；lang 不传取用户在「语种设置」里选的（没选过跟随系统）
function langIndex(lang) {
  let value = lang
  if (!value) {
    try {
      value = language.getSelectedLanguage()
    } catch (error) {
      value = ''
    }
  }
  const index = LANGS.indexOf(value)
  return index > -1 ? index : 0
}

function groupName(key, lang) {
  const names = GROUP_NAMES[key]
  return names ? names[langIndex(lang)] : String(key || '')
}

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

// 展示文案：候选里的按语种给「国家 / 城市」（不带 UTC 偏移）；不在候选里的原样显示 IANA 名
function label(id, lang) {
  const name = String(id || '')
  const zone = findZone(name)
  return zone ? zone.names[langIndex(lang)] : name
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

// 选择列表：分组 + 搜索。每行只有一段展示文案（按语种）；搜索认 IANA 名与四种语种的译名、分组名，不区分大小写。
// current 不在候选里时放到最前面「当前」一组，保证回显的值能看到、能选回。
function options(keyword, current, lang) {
  const word = String(keyword || '').trim().toLowerCase()
  const rows = []
  const push = (groupKey, id) => {
    rows.push({ id, group: groupName(groupKey, lang), label: label(id, lang) })
  }
  if (current && !findZone(current)) {
    const matched = !word || String(current).toLowerCase().indexOf(word) > -1
    if (matched) {
      push('current', current)
    }
  }
  ZONES.forEach(zone => {
    const text = [zone.id].concat(zone.names, GROUP_NAMES[zone.group] || []).join(' ').toLowerCase()
    if (!word || text.indexOf(word) > -1) {
      push(zone.group, zone.id)
    }
  })
  // 同组只在第一行显示组名
  return rows.map((row, index) => Object.assign(row, { showGroup: index === 0 || rows[index - 1].group !== row.group }))
}

module.exports = {
  LANGS,
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
