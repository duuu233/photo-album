// WiFi 版「优雅刷新升级」（2026-11-13，产品需求；原名渲染固件管理）：只有产品渲染模式 = fpga16 的设备才有（目前只有 10.1 寸）。
//
//   · 最新版本只读设备详情（getUserProductDetail → api.getDeviceDetail）：newVersionNoFpga / downloadPathFpga / upgradeTipsFpga（版本说明）；
//     不做版本列表（产品 2026-11-13 改口）。
//   · 不做红点（2026-11-14 产品要求）：原「看过的版本号」本地缓存 fpga_seen 与 WiFi 详情「设备信息」、设备信息页入口两处红点一并去掉。
//   · 点「优雅刷新升级」直接进安装步骤页 = 固件升级页（subpackages/device/wifi-ota）的 fpga 模式：版式、进度条、四步状态全部复用，
//     只改文字并显示版本说明；下发复用 POST /api/device/ota，type=fpga、version = FPGA 最新版本、url = downloadPathFpga。
//   · 设备不上报 FPGA 版本（ota/status 的 baseVersion 为 null），不显示设备当前版本；
//   · 下发返回 4047 = 今日升级次数已达上限，按当前语种提示（limitText）。
const OTA_TYPE_FPGA = 'fpga'

function text(value) {
  return String(value == null ? '' : value).trim()
}

function isFpgaRender(renderMode) {
  return text(renderMode).toLowerCase() === 'fpga16'
}

function isHttpUrl(value) {
  return /^https?:\/\/\S+$/i.test(text(value))
}

// 设备详情里的最新优雅刷新版本：{ version, url, intro }；没有版本号返回 null
function latestOf(device) {
  const version = text(device && device.newVersionNoFpga)
  if (!version) {
    return null
  }
  return {
    version,
    url: text(device && device.downloadPathFpga),
    intro: text(device && device.upgradeTipsFpga)
  }
}

// 4047：今日升级次数已达上限（2026-11-13 服务端新增，type=fpga 下发时返回）。按用户选的语种（没选跟随系统）
const LIMIT_CODE = 4047
const LIMIT_TEXTS = {
  'zh-Hans': '今日升级次数已达上限',
  'zh-Hant': '今日升級次數已達上限',
  en: "You've reached today's upgrade limit",
  ja: '本日のアップデート回数の上限に達しました'
}

function isLimitError(error) {
  return Number(error && error.code) === LIMIT_CODE
}

function limitText(language) {
  let lang = language
  if (!lang) {
    try {
      lang = require('./language').getSelectedLanguage()
    } catch (error) {
      lang = ''
    }
  }
  return LIMIT_TEXTS[lang] || LIMIT_TEXTS['zh-Hans']
}

// 安装页文字（与固件升级页同一套版式，只换文字）
const TEXTS = {
  main: {
    nav: '固件升级',
    checkingTitle: '检测版本中',
    checkingHint: '正在检查固件版本，请稍候…',
    runningTitle: '设备正在升级',
    runningHint: '升级期间请保持设备通电和网络连接，可离开本页，进度不受影响',
    doneTitle: '升级完成',
    doneStep: '升级完成',
    failTitle: '升级失败',
    timeoutTitle: '升级超时',
    confirmTitle: '固件升级',
    confirmText: '立即升级',
    retryText: '重新升级',
    sending: '下发中',
    targetLabel: '最新版本'
  },
  fpga: {
    nav: '优雅刷新升级',
    checkingTitle: '准备安装',
    checkingHint: '正在读取设备信息，请稍候…',
    runningTitle: '设备正在安装优雅刷新固件',
    runningHint: '安装期间请保持设备通电和网络连接，可离开本页，进度不受影响',
    doneTitle: '安装完成',
    doneStep: '安装完成',
    failTitle: '安装失败',
    timeoutTitle: '安装超时',
    confirmTitle: '优雅刷新升级',
    confirmText: '立即安装',
    retryText: '重新安装',
    sending: '下发中',
    targetLabel: '最新版本'
  }
}

function textsFor(type) {
  return type === OTA_TYPE_FPGA ? TEXTS.fpga : TEXTS.main
}

module.exports = {
  OTA_TYPE_FPGA,
  isFpgaRender,
  isHttpUrl,
  latestOf,
  TEXTS,
  textsFor,
  LIMIT_CODE,
  LIMIT_TEXTS,
  isLimitError,
  limitText
}
