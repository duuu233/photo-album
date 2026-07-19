// 语种：全局单一数据源。
//
// 背景（2026-07-19 修复）：此前语种有两套互相打架的实现——
//   1. utils/request.js 自带一份 LANGUAGE_CODE_MAP（en=1/zh-Hans=2/zh-Hant=3/ja=4），
//      按**系统语言**算后端 language 码；
//   2. utils/system.js 另有一份只认 3 种语言（漏了 ja）的映射，用于登录时上报语言。
// 而「语种设置」页只是把选择塞进 data 就弹「已保存」，从没落盘，
// 所以用户选的语种对后端返回什么语种的内容**毫无影响**。
//
// 这里统一成一处：用户选择落盘 → 请求层和业务页都从这里取；没选过才回落到系统语言。

const STORAGE_KEY = 'appLanguage'

// 后端 language 取值以 swagger 为准：0=英语,1=英语,2=简中,3=繁中,4=日文
const LANGUAGE_CODE_MAP = {
  en: 1,
  'zh-Hans': 2,
  'zh-Hant': 3,
  ja: 4
}

const LANGUAGE_LABELS = {
  'zh-Hans': '简体中文',
  'zh-Hant': '繁体中文',
  en: 'English',
  ja: '日本語'
}

const DEFAULT_LANGUAGE = 'zh-Hans'

// 把五花八门的语言串（zh_TW / zh-HK / en-US / ja-JP 等）归一到支持的四种之一
function normalizeLanguage(language) {
  const raw = String(language || '')
    .replace('_', '-')
    .toLowerCase()

  // 台/港/澳繁体统一归为繁体中文
  if (
    raw.indexOf('zh-hant') === 0 ||
    raw.indexOf('zh-tw') === 0 ||
    raw.indexOf('zh-hk') === 0 ||
    raw.indexOf('zh-mo') === 0
  ) {
    return 'zh-Hant'
  }

  if (raw.indexOf('ja') === 0) {
    return 'ja'
  }

  if (raw.indexOf('en') === 0) {
    return 'en'
  }

  return DEFAULT_LANGUAGE
}

// 读取系统原始语言串：优先新版 getAppBaseInfo，降级 getSystemInfoSync
function getRawSystemLanguage() {
  try {
    if (wx.getAppBaseInfo) {
      const appBaseInfo = wx.getAppBaseInfo()
      if (appBaseInfo && appBaseInfo.language) {
        return appBaseInfo.language
      }
    }

    const systemInfo = wx.getSystemInfoSync()
    return (systemInfo && systemInfo.language) || DEFAULT_LANGUAGE
  } catch (error) {
    return DEFAULT_LANGUAGE
  }
}

function getSystemLanguage() {
  return normalizeLanguage(getRawSystemLanguage())
}

// 当前生效语种：用户显式选过就用用户的，否则跟随系统
function getSelectedLanguage() {
  try {
    const saved = wx.getStorageSync(STORAGE_KEY)
    if (saved && LANGUAGE_CODE_MAP[saved]) {
      return saved
    }
  } catch (error) {
    // 读缓存失败按未选过处理
  }
  return getSystemLanguage()
}

// 保存用户选择，返回归一后的值
function setSelectedLanguage(language) {
  const normalized = normalizeLanguage(language)
  try {
    wx.setStorageSync(STORAGE_KEY, normalized)
  } catch (error) {
    // 落盘失败不阻断，本次仍按内存里的选择走
  }
  return normalized
}

// 传给后端的 language 数值
function getLanguageCode() {
  return (
    LANGUAGE_CODE_MAP[getSelectedLanguage()] ||
    LANGUAGE_CODE_MAP[DEFAULT_LANGUAGE]
  )
}

function getLanguageLabel(language) {
  return LANGUAGE_LABELS[language] || LANGUAGE_LABELS[DEFAULT_LANGUAGE]
}

module.exports = {
  STORAGE_KEY,
  DEFAULT_LANGUAGE,
  LANGUAGE_CODE_MAP,
  LANGUAGE_LABELS,
  normalizeLanguage,
  getSystemLanguage,
  getSelectedLanguage,
  setSelectedLanguage,
  getLanguageCode,
  getLanguageLabel
}
