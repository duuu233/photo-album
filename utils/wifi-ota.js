// WiFi 版设备固件升级（OTA）的纯逻辑（2026-11-02，docs/前端对接文档20261031.md；接口见草稿 3.9）。
//
// 流程：老服务 getDeviceDetail 给目标版本 newVersionNo 与固件包 downloadPath（与蓝牙版同一来源）；
// IoT GET /api/device/info 给设备当前版本 firmwareVersion（服务端已归一化为 x.y.z）；
// 有新版本 → POST /api/device/ota 下发 → 拿 msgid → 步骤页按 GET /api/device/ota/status 与 WS ota.result 走四步。
//
// 状态（对接文档 1.2）：SENT 已下发 / DOWNLOADING 下载中 / FLASHING 刷写中 / VERIFYING 设备回报执行成功、等重启确认 /
//   SUCCESS / FAILED / TIMEOUT 终态。步骤页只消费 SENT~VERIFYING 与 FAILED / TIMEOUT：
//   · VERIFYING 是步骤页的成功终点（第 4 步打勾，「升级完成 · 等待设备重启」），但**不是终态**，本地记录要保留；
//   · SUCCESS 不进步骤页，只用于清本地记录；FAILED / TIMEOUT 在当前那一步打叉、后续不再执行；
//   · 不认识的值（含投屏专用的 UPLOADED）按「未知状态」降级，不白屏。
//
// 本地记录（对接文档第三节）：msgid 在投屏 / 轮播 / OTA 之间共用生成器，单存 msgid 分不清类型，
// 所以用独立 key `ota_inflight:{deviceNo}` 存 { deviceNo, type: 'ota', msgid, version, savedAt }，一台设备只留一条。
// 终态（SUCCESS / FAILED / TIMEOUT）或查询 4044（任务只保留 2 小时）时清掉。
// 「有新版本」之前先看本地有没有进行中的记录：有就显示「升级进行中 · 等待设备重启」，不再提示升级（3.3）。
//
// 进度条（2026-11-12）：ota/status 与 WS ota.result 新增 progress（0~100），规则见下方「升级进度条」一节。
const iotApi = require('./iot-api')

const STORAGE_PREFIX = 'ota_inflight:'
const OTA_TYPE_MAIN = 'main' // 主控升级；FPGA（type=fpga）为渲染固件安装，见 utils/fpga-firmware.js

const STEP_TEXTS = ['已下发，等待设备响应', '设备下载固件中', '设备写入固件中', '升级完成']
const STEP_OF = { SENT: 0, DOWNLOADING: 1, FLASHING: 2, VERIFYING: 3 }
const FINAL_STATUSES = ['SUCCESS', 'FAILED', 'TIMEOUT']
const FAIL_STATUSES = ['FAILED', 'TIMEOUT']

const IN_PROGRESS_TIP = '设备正在升级，请稍候'
const WAIT_REBOOT_TEXT = '等待设备重启'

function plainDeviceNo(deviceNo) {
  return String(deviceNo == null ? '' : deviceNo).replace(/[:\-\s]/g, '').toUpperCase()
}

function normalizeStatus(status) {
  return String(status == null ? '' : status).trim().toUpperCase()
}

function isFinal(status) {
  return FINAL_STATUSES.indexOf(normalizeStatus(status)) > -1
}

function isFailure(status) {
  return FAIL_STATUSES.indexOf(normalizeStatus(status)) > -1
}

// 步骤页四步的展示状态。lastStep：失败时打叉的那一步（= 失败前最后到达的一步，没到过任何一步按第 1 步）。
// 返回 { phase, steps, failedStep }：phase = running / verifying / failed / unknown
function stepsFor(status, lastStep) {
  const s = normalizeStatus(status)
  const reached = typeof lastStep === 'number' && lastStep >= 0 ? Math.min(lastStep, 3) : 0
  const steps = STEP_TEXTS.map((text, index) => ({ key: index, text, status: 'pending' }))
  if (isFailure(s)) {
    steps.forEach((step, index) => {
      step.status = index < reached ? 'done' : index === reached ? 'fail' : 'pending'
    })
    return { phase: 'failed', steps, failedStep: reached }
  }
  if (s in STEP_OF) {
    const current = STEP_OF[s]
    steps.forEach((step, index) => {
      if (s === 'VERIFYING') {
        step.status = 'done'
      } else {
        step.status = index < current ? 'done' : index === current ? 'loading' : 'pending'
      }
    })
    return { phase: s === 'VERIFYING' ? 'verifying' : 'running', steps, failedStep: -1 }
  }
  // 不认识的值：保持在已到达的那一步转圈，不判失败也不判成功
  steps.forEach((step, index) => {
    step.status = index < reached ? 'done' : index === reached ? 'loading' : 'pending'
  })
  return { phase: 'unknown', steps, failedStep: -1 }
}

// 步骤序号（未知值返回 -1），供页面记录「到过哪一步」
function stepIndex(status) {
  const s = normalizeStatus(status)
  return s in STEP_OF ? STEP_OF[s] : -1
}

function failTitle(status) {
  return normalizeStatus(status) === 'TIMEOUT' ? '升级超时' : '升级失败'
}

// ── 升级进度条（2026-11-12）──────────────────────────
// 服务端 progress（GET /api/device/ota/status 与 WS ota.result 新增，可选）：设备私有进度回执 182 / 184 / 186 / 188
// 换算为 20 / 40 / 60 / 80，每收到一条回执 WS 推一次；进入 VERIFYING 后为 100；固件不上报进度时为 null。
// 页面显示值只增不减、匀速前进（每 PROGRESS_TICK_MS 走 1%），走到「上限」就停住等下一次上报：
//   · 还没收到任何进度 → 停在 19 等 20；
//   · 收到 20 / 40 / 60 / 80 → 可走到 39 / 59 / 79 / 98（下一档减 1；80 之后与「不上报」同为 98）；
//     即 19 等 20、39 等 40、59 等 60、79 等 80，没收到下一档数值就一直停住（2026-11-13）；
//   · 状态只决定步骤，不放开分档：DOWNLOADING / FLASHING 本身都不会让进度越过 19 / 39 / 59 / 79；
//   · 固件不上报（progress 为 null）：一个数值都没收到就已进入写入（FLASHING）→ 匀速走到 98 停住；
//     下载阶段为 null 不算「不上报」（可能只是 20 还没到），仍停 19；
//   · VERIFYING（SUCCESS 同）→ 100。FAILED / TIMEOUT 停在当时的位置。
// 进度条左边的文案用当前那一步的步骤文案（activeStep）。
const PROGRESS_FIRST_CAP = 19
const PROGRESS_STEP_GAP = 19
const PROGRESS_SILENT_CAP = 98
const PROGRESS_TICK_MS = 200 // 1% / 200ms：一档 20% 约 4 秒

// progress 字段 → 0~100 整数；null / 缺省 / 非数字 → null（不上报）
function parseProgress(value) {
  if (value === null || value === undefined || value === '') {
    return null
  }
  const n = Number(value)
  if (!isFinite(n)) {
    return null
  }
  return Math.max(0, Math.min(100, Math.round(n)))
}

// 显示值能走到的上限。reported：本次升级收到过的最大进度（null = 一次都没收到）
function progressCap(status, reported) {
  const s = normalizeStatus(status)
  const value = typeof reported === 'number' ? reported : 0
  if (s === 'VERIFYING' || s === 'SUCCESS' || value >= 100) {
    return 100
  }
  if (value > 0) {
    return Math.min(value + PROGRESS_STEP_GAP, PROGRESS_SILENT_CAP)
  }
  // 一个数值都没收到：已到写入阶段 → 固件不上报，走到 98；否则停 19 等 20
  return s === 'FLASHING' ? PROGRESS_SILENT_CAP : PROGRESS_FIRST_CAP
}

// stepsFor 结果里「当前那一步」：转圈或打叉的那一步；全勾（VERIFYING）为最后一步
function activeStep(view) {
  const steps = (view && view.steps) || []
  for (let i = 0; i < steps.length; i++) {
    if (steps[i].status === 'loading' || steps[i].status === 'fail') {
      return i
    }
  }
  return STEP_TEXTS.length - 1
}

// ── 版本号 ─────────────────────────────────────────────

// x.y.z（允许前缀 v / V 与两段、四段）→ 数字段数组；对不上（如旧格式「M H:3 F:0.6.1」）返回 null
function parseVersion(value) {
  const text = String(value == null ? '' : value).trim()
  const match = /^[vV]?(\d+(?:\.\d+){1,3})$/.exec(text)
  return match ? match[1].split('.').map(Number) : null
}

// a > b → 1，a < b → -1，相等 0
function compareParts(a, b) {
  const length = Math.max(a.length, b.length)
  for (let i = 0; i < length; i++) {
    const x = a[i] || 0
    const y = b[i] || 0
    if (x !== y) {
      return x > y ? 1 : -1
    }
  }
  return 0
}

function isHttpUrl(value) {
  return /^https?:\/\/\S+$/i.test(String(value || '').trim())
}

// 是否有新版本：
//   · 目标版本为空 → latest（后台没配升级包）；
//   · 当前版本读不到或不是 x.y.z（还没按新格式上报过）→ unknown（按「无法判断」处理，不报错，对接文档 2.3）；
//   · 两边都是 x.y.z → 目标更高才算有新版本；目标不是 x.y.z 时退回「不相同即有新版本」（与蓝牙版同口径）；
//   · 有新版本但固件包地址不是 http(s) → invalid（服务端也只收 http / https）。
// 返回 { state: available / latest / unknown / invalid, current, latest, url }
function evaluate(currentVersion, latestVersion, downloadPath) {
  const current = String(currentVersion == null ? '' : currentVersion).trim()
  const latest = String(latestVersion == null ? '' : latestVersion).trim()
  const url = String(downloadPath == null ? '' : downloadPath).trim()
  const result = { current, latest, url }
  if (!latest) {
    return Object.assign(result, { state: 'latest' })
  }
  const currentParts = parseVersion(current)
  if (!currentParts) {
    return Object.assign(result, { state: 'unknown' })
  }
  const latestParts = parseVersion(latest)
  const newer = latestParts
    ? compareParts(latestParts, currentParts) > 0
    : latest.toLowerCase() !== current.toLowerCase()
  if (!newer) {
    return Object.assign(result, { state: 'latest' })
  }
  return Object.assign(result, { state: isHttpUrl(url) ? 'available' : 'invalid' })
}

// ── 本地进行中记录 ─────────────────────────────────────

function storageKey(deviceNo) {
  return STORAGE_PREFIX + plainDeviceNo(deviceNo)
}

function readInflight(deviceNo) {
  const no = plainDeviceNo(deviceNo)
  if (!no) {
    return null
  }
  let record = null
  try {
    record = wx.getStorageSync(storageKey(no))
  } catch (error) {
    record = null
  }
  // 类型不对或缺 msgid 的记录不认（防止拿投屏 msgid 去查 OTA 接口，对接文档 3.2）
  if (!record || typeof record !== 'object' || record.type !== 'ota' || !record.msgid) {
    return null
  }
  return record
}

function saveInflight(deviceNo, msgid, extra) {
  const no = plainDeviceNo(deviceNo)
  if (!no || !msgid) {
    return null
  }
  const record = Object.assign({}, extra, { deviceNo: no, type: 'ota', msgid: String(msgid), savedAt: Date.now() })
  try {
    wx.setStorageSync(storageKey(no), record)
  } catch (error) {
    console.warn('[WiFi升级] 保存 msgid 失败', error && error.message)
  }
  return record
}

// 记下最近一次查到的状态（重进页面先按它画，再等接口结果）
function updateInflight(deviceNo, patch) {
  const record = readInflight(deviceNo)
  if (!record) {
    return null
  }
  const next = Object.assign({}, record, patch)
  try {
    wx.setStorageSync(storageKey(record.deviceNo), next)
  } catch (error) {
    // 写失败不影响页面
  }
  return next
}

function clearInflight(deviceNo) {
  const no = plainDeviceNo(deviceNo)
  if (!no) {
    return
  }
  try {
    wx.removeStorageSync(storageKey(no))
  } catch (error) {
    // 清不掉下次查询 4044 时还会再清
  }
}

// 查一次本地进行中任务的服务端状态：终态 / 4044 清本地记录。
// 返回 { record, status, data } —— record 为 null 表示本地没有进行中的任务（或刚被清掉）；
// 查询失败（网络 / 503 等）返回 { record, status: '', error }，记录保留，下次再查。
async function refreshInflight(deviceNo, options) {
  const record = readInflight(deviceNo)
  if (!record) {
    return { record: null, status: '' }
  }
  let data
  try {
    data = await iotApi.getOtaStatus(record.msgid, Object.assign({ showError: false }, options))
  } catch (error) {
    if (error && Number(error.code) === 4044) {
      clearInflight(deviceNo)
      return { record: null, status: '', expired: true }
    }
    return { record, status: record.status || '', error }
  }
  const status = normalizeStatus(data && data.status)
  if (isFinal(status)) {
    clearInflight(deviceNo)
    return { record: null, status, data }
  }
  const lastStep = Math.max(stepIndex(status), typeof record.lastStep === 'number' ? record.lastStep : -1)
  const patch = { status, lastStep }
  // 进度条：记下收到过的最大进度，重进页面从这里接着走
  const progress = parseProgress(data && data.progress)
  if (progress !== null) {
    patch.progress = Math.max(progress, parseProgress(record.progress) || 0)
  }
  const next = updateInflight(deviceNo, patch) || record
  return { record: next, status, data }
}

// 下发失败是不是「已有进行中的升级」：4045 一律是；4000 在 OTA 接口上表示已有升级任务进行中（对接文档 3.4），
// 但 4000 也是通用参数错误码——服务端文案明确说的是别的问题（不含「升级 / 进行中」）时按普通失败处理。
function isBusyError(error) {
  const code = Number(error && error.code)
  if (code === 4045) {
    return true
  }
  if (code !== 4000) {
    return false
  }
  const message = String((error && error.serverMessage) || '').trim()
  return !message || /升级|进行中/.test(message)
}

module.exports = {
  OTA_TYPE_MAIN,
  STEP_TEXTS,
  PROGRESS_TICK_MS,
  parseProgress,
  progressCap,
  activeStep,
  IN_PROGRESS_TIP,
  WAIT_REBOOT_TEXT,
  plainDeviceNo,
  normalizeStatus,
  isFinal,
  isFailure,
  stepsFor,
  stepIndex,
  failTitle,
  parseVersion,
  evaluate,
  storageKey,
  readInflight,
  saveInflight,
  updateInflight,
  clearInflight,
  refreshInflight,
  isBusyError
}
