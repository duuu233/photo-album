// 本应用支持的三种语言及其展示名
const LANGUAGE_LABELS = {
  'zh-Hans': '简体中文',
  'zh-Hant': '繁体中文',
  en: 'English'
}

// 读取系统原始语言串：优先用新版 getAppBaseInfo，降级到 getSystemInfoSync，全部失败兜底简中
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

// 把五花八门的语言串（zh_TW / zh-HK / en-US 等）归一到应用支持的三种之一
function normalizeLanguage(language) {
  const raw = String(language || '').replace('_', '-').toLowerCase()

  // 台/港/澳繁体统一归为繁体中文
  if (raw.indexOf('zh-hant') === 0 || raw.indexOf('zh-tw') === 0 || raw.indexOf('zh-hk') === 0 || raw.indexOf('zh-mo') === 0) {
    return 'zh-Hant'
  }

  if (raw.indexOf('en') === 0) {
    return 'en'
  }

  // 其余 zh 开头一律按简体中文处理
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
    // 新版基础库用 getDeviceInfo 读取 platform，降级到已废弃的 getSystemInfoSync
    const info = wx.getDeviceInfo ? wx.getDeviceInfo() : wx.getSystemInfoSync()
    return info.platform === 'devtools'
  } catch (error) {
    return false
  }
}

// 计算自定义导航/底部所需的安全区尺寸：状态栏高度 + 底部安全距离（适配刘海屏/全面屏）
function getLayoutMetrics() {
  try {
    const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    // 底部安全距离 = 屏幕高度 - 安全区底部，避免内容被 Home Indicator 遮挡
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
