// WiFi 版「优雅刷新升级」（2026-11-13，产品需求；原名渲染固件管理）：只有产品渲染模式 = fpga16 的设备才有（目前只有 10.1 寸）。
//
//   · 最新版本只读设备详情（getUserProductDetail → api.getDeviceDetail）：newVersionNoFpga / downloadPathFpga / upgradeTipsFpga（版本说明）；
//     不做版本列表（产品 2026-11-13 改口：消息推送要闭环的内容太多，改为红点提醒）。
//   · 红点：本地缓存「看过的版本号」fpga_seen:{deviceNo}。最新版本存在、下载地址有效，且缓存为空或最新版本比缓存高 → 亮红点：
//     WiFi 详情「设备信息」行、设备信息页「优雅刷新升级」行；进入优雅刷新升级页（看到了版本）就记下版本号，红点消失。
//     缓存只在本机，重装 / 换手机会再提醒一次（产品接受）。
//   · 点「优雅刷新升级」直接进安装步骤页 = 固件升级页（subpackages/device/wifi-ota）的 fpga 模式：版式、进度条、四步状态全部复用，
//     只改文字并显示版本说明；下发复用 POST /api/device/ota，type=fpga、version = FPGA 最新版本、url = downloadPathFpga。
//   · 设备不上报 FPGA 版本（ota/status 的 baseVersion 为 null），不显示设备当前版本；
//   · 下发返回 4047 = 今日升级次数已达上限，按当前语种提示（limitText）。
const OTA_TYPE_FPGA = 'fpga'
const SEEN_KEY_PREFIX = 'fpga_seen:'

function text(value) {
  return String(value == null ? '' : value).trim()
}

function isFpgaRender(renderMode) {
  return text(renderMode).toLowerCase() === 'fpga16'
}

function isHttpUrl(value) {
  return /^https?:\/\/\S+$/i.test(text(value))
}

function plainDeviceNo(value) {
  return text(value).replace(/[:\-\s]/g, '').toUpperCase()
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

// 版本比较：都是 x.y.z（可带 v）按数字段比；否则不区分大小写比较，不同即算更新
function versionParts(value) {
  const match = /^[vV]?(\d+(?:\.\d+){0,3})$/.exec(text(value))
  return match ? match[1].split('.').map(Number) : null
}

function isNewer(latest, seen) {
  if (!text(seen)) {
    return true
  }
  const a = versionParts(latest)
  const b = versionParts(seen)
  if (a && b) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const x = a[i] || 0
      const y = b[i] || 0
      if (x !== y) {
        return x > y
      }
    }
    return false
  }
  return text(latest).toLowerCase() !== text(seen).toLowerCase()
}

function seenKey(deviceNo) {
  return SEEN_KEY_PREFIX + plainDeviceNo(deviceNo)
}

function readSeen(deviceNo) {
  if (!plainDeviceNo(deviceNo)) {
    return ''
  }
  try {
    return text(wx.getStorageSync(seenKey(deviceNo)))
  } catch (error) {
    return ''
  }
}

function markSeen(deviceNo, version) {
  if (!plainDeviceNo(deviceNo) || !text(version)) {
    return
  }
  try {
    wx.setStorageSync(seenKey(deviceNo), text(version))
  } catch (error) {
    // 存不了下次还会亮红点
  }
}

// 要不要亮红点：fpga16 设备（renderMode 由调用方查好）、有最新版本且下载地址有效、比本机看过的版本新
function hasNew(device, renderMode) {
  if (!isFpgaRender(renderMode)) {
    return false
  }
  const latest = latestOf(device)
  if (!latest || !isHttpUrl(latest.url)) {
    return false
  }
  return isNewer(latest.version, readSeen(device && (device.productDeviceId || device.deviceNo)))
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
  isNewer,
  readSeen,
  markSeen,
  hasNew,
  TEXTS,
  textsFor,
  LIMIT_CODE,
  LIMIT_TEXTS,
  isLimitError,
  limitText
}
