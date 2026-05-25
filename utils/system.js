const LANGUAGE_LABELS = {
  'zh-Hans': '简体中文',
  'zh-Hant': '繁体中文',
  en: 'English'
}

function getRawLanguage() {
  try {
    if (wx.getAppBaseInfo) {
      const appBaseInfo = wx.getAppBaseInfo()
      if (appBaseInfo && appBaseInfo.language) {
        return appBaseInfo.language
      }
    }

    const systemInfo = wx.getSystemInfoSync()
    return systemInfo.language || 'zh-Hans'
  } catch (error) {
    return 'zh-Hans'
  }
}

function normalizeLanguage(language) {
  const raw = String(language || '').replace('_', '-').toLowerCase()

  if (raw.indexOf('zh-hant') === 0 || raw.indexOf('zh-tw') === 0 || raw.indexOf('zh-hk') === 0 || raw.indexOf('zh-mo') === 0) {
    return 'zh-Hant'
  }

  if (raw.indexOf('en') === 0) {
    return 'en'
  }

  if (raw.indexOf('zh') === 0) {
    return 'zh-Hans'
  }

  return 'zh-Hans'
}

function getSystemLanguageInfo() {
  const raw = getRawLanguage()
  const value = normalizeLanguage(raw)

  return {
    raw,
    value,
    label: LANGUAGE_LABELS[value] || LANGUAGE_LABELS['zh-Hans']
  }
}

function isDevTools() {
  try {
    const systemInfo = wx.getSystemInfoSync()
    return systemInfo.platform === 'devtools'
  } catch (error) {
    return false
  }
}

module.exports = {
  LANGUAGE_LABELS,
  getSystemLanguageInfo,
  normalizeLanguage,
  isDevTools
}
