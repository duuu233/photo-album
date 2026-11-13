// WiFi 版「优雅刷新升级」（2026-11-13，产品需求；原名渲染固件管理）：只有产品渲染模式 = fpga16 的设备才有（目前只有 10.1 寸）。
//
//   · 设备详情 → 设备信息 → 「优雅刷新升级」：列出后台「优雅刷新管理」（FPGA 版本）里启用的版本（版本号、简介、安装），未启用的不显示；
//   · 设备不上报 FPGA 版本（ota/status 的 baseVersion 为 null），列表与安装页都不显示设备当前版本；
//   · 下发返回 4047 = 今日升级次数已达上限，按当前语种提示（limitText）；
//   · 点「安装」进安装步骤页 = 固件升级页（subpackages/device/wifi-ota）的 fpga 模式：版式、进度条、四步状态全部复用，只改文字、带出简介；
//   · 下发复用 POST /api/device/ota，type=fpga、version = FPGA 目标版本、url = 该版本固件地址；
//     返回值、进度字段、四步交互、本地进行中记录（ota_inflight:{deviceNo}）都与固件升级一致，不单独判断状态。
//
// ⚠️ 用户端列出 FPGA 版本的接口后端还没提供（2026-11-13 核对 Swagger 只有后台 /ZoneAdmin/ProductVersionFpga/*）。
//    接口路径集中在 LIST_API 一处，后端给出后填上即可；为空时列表页显示「版本列表暂未开放」，不发请求。
//    简介字段后台也还没有，取值按下方 INTRO_FIELDS 依次兜底，后端定了字段名后放到第一个。
const LIST_API = '' // 例：'/Client/Product/getProductVersionFpgaList'（入参 productId）——待后端提供
const INTRO_FIELDS = ['versionDesc', 'description', 'desc', 'intro', 'remark', 'upgradeTips', 'content']
const OTA_TYPE_FPGA = 'fpga'
const TARGET_KEY_PREFIX = 'fpga_install_target:'

function text(value) {
  return String(value == null ? '' : value).trim()
}

function isFpgaRender(renderMode) {
  return text(renderMode).toLowerCase() === 'fpga16'
}

function listApiReady() {
  return !!LIST_API
}

function introOf(row) {
  for (const key of INTRO_FIELDS) {
    const value = text(row && row[key])
    if (value) {
      return value
    }
  }
  return ''
}

function isHttpUrl(value) {
  return /^https?:\/\/\S+$/i.test(text(value))
}

// 接口行 → { id, version, intro, url, grade }；未启用（verify 明确为 0）的去掉，按权重从大到小
function normalizeVersions(rows) {
  const list = Array.isArray(rows) ? rows : []
  return list
    .filter(row => row && text(row.versionNumber || row.version) && !(row.verify !== undefined && row.verify !== null && Number(row.verify) !== 1))
    .map(row => ({
      id: text(row.id || row.versionNumber || row.version),
      version: text(row.versionNumber || row.version),
      intro: introOf(row),
      url: text(row.downloadPath || row.url),
      grade: Number(row.grade) || 0
    }))
    .sort((a, b) => b.grade - a.grade)
}

// 拉某产品启用的 FPGA 版本。接口未配置时 resolve { pending: true, list: [] }
async function fetchVersions(productId, options) {
  if (!listApiReady()) {
    return { pending: true, list: [] }
  }
  const http = require('./request') // 用到时才加载请求层（纯逻辑部分在 node 测试里直接引用）
  const data = await http.get(LIST_API, { productId, pageIndex: 1, pageSize: 100 }, Object.assign({ mock: false }, options))
  const rows = Array.isArray(data) ? data : (data && (data.pageData || data.list)) || []
  return { pending: false, list: normalizeVersions(rows) }
}

// 安装目标在列表页与安装页之间用本地存储传（简介可能很长，不放进页面参数）
function saveTarget(deviceId, target) {
  try {
    wx.setStorageSync(TARGET_KEY_PREFIX + deviceId, Object.assign({}, target, { savedAt: Date.now() }))
  } catch (error) {
    // 存不了安装页会提示重新选择
  }
}

function readTarget(deviceId) {
  try {
    const value = wx.getStorageSync(TARGET_KEY_PREFIX + deviceId)
    return value && value.version ? value : null
  } catch (error) {
    return null
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
    targetLabel: '安装版本'
  }
}

function textsFor(type) {
  return type === OTA_TYPE_FPGA ? TEXTS.fpga : TEXTS.main
}

module.exports = {
  LIST_API,
  OTA_TYPE_FPGA,
  INTRO_FIELDS,
  isFpgaRender,
  listApiReady,
  introOf,
  isHttpUrl,
  normalizeVersions,
  fetchVersions,
  saveTarget,
  readTarget,
  TEXTS,
  textsFor,
  LIMIT_CODE,
  LIMIT_TEXTS,
  isLimitError,
  limitText
}
