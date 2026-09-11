// 语种相关逻辑已统一收口到 utils/language（含日语，且优先取用户选择）。
// 这里只做转发，保留原有导出名，避免调用方（app.js 登录上报）改动。
const language = require('./language')

const LANGUAGE_LABELS = language.LANGUAGE_LABELS

// 当前生效语种。注意 value 取的是**用户选择优先**的语种，不再是纯系统语言——
// 登录时上报这个值，后端才能按用户实际选的语种返回内容。
function getSystemLanguageInfo() {
  const value = language.getSelectedLanguage()

  return {
    raw: value,
    value,
    label: language.getLanguageLabel(value)
  }
}

// 当前是否**开发版**小程序（`envVersion === 'develop'`，含微信开发者工具）。
//
// 读法与 utils/request.js 判 mock 的那份同源（`wx.getAccountInfoSync().miniProgram.envVersion`），
// 但口径更严：那边只拦正式版，这里**只认开发版**——体验版(trial)和正式版(release) 一律返回
// false。**取不到环境信息时返回 false**（按"不是开发版"处理，最保守）：宁可在某台设备上少
// 一个入口，也不能把内部入口漏到体验版或线上。
//
// 用途：屏蔽只给开发/联调用的入口，见 subpackages/device/bind（调试台入口）与
// subpackages/device/debug（调试台本身的二次拦截）。
//
// 2026-09-11 产品口径：**只要开发版可以看到就行，体验版也屏蔽入口，包括正式版。**
function isDevEnv() {
  try {
    return wx.getAccountInfoSync().miniProgram.envVersion === 'develop'
  } catch (error) {
    return false
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
  // 转发自 utils/language，保持旧调用方可用
  normalizeLanguage: language.normalizeLanguage,
  isDevTools,
  isDevEnv
}
