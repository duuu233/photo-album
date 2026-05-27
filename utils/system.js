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

function getLayoutMetrics() {
  try {
    const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    const safeBottom = Math.max(0, (info.screenHeight || 0) - (info.safeArea ? info.safeArea.bottom : info.windowHeight || 0))

    return {
      statusBarHeight: info.statusBarHeight || 20,
      safeBottom
    }
  } catch (error) {
    return {
      statusBarHeight: 20,
      safeBottom: 0
    }
  }
}

module.exports = {
  LANGUAGE_LABELS,
  getLayoutMetrics,
  getSystemLanguageInfo,
  normalizeLanguage,
  isDevTools
}
