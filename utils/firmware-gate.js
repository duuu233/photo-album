// 固件升级判断（2026-11-13，产品口径；同日按产品复核改）：强制升级 / 强提醒升级的弹框与拦截。
//
// 升级类型取后台「升级类型」compulsory（api.normalizeDevice 归一成 updateType）：
//   1 = 强制升级、2 = 强提示升级（强提醒）、3 = 弱提示升级、4 = 不提示升级。只有 1、2 弹框；
//   3、4 照改动前只亮「固件升级」红点、用户自己点去升级。红点不分类型，1、2 也照样亮。
// 什么时候判断：WiFi 版在线才判断（离线 / 休眠 / 本地模式 / 查不到不判）；蓝牙版已连接才判断。
// 强提醒升级：只在进入设备详情页时弹，每台设备每次启动小程序只弹一次（取消后本次不再提醒，重新打开小程序才再提醒）；
//   详情页的功能按钮、列表页、首页都不弹强提醒。
// 强制升级：
//   · 设备详情页：进入时弹；取消后点任意功能按钮（投屏、轮播设置等）都再弹，且这次操作不继续；
//   · 列表页（蓝牙「投屏」，WiFi「投屏」「轮播设置」）、首页（拍照 / 相册投屏）：点击时弹，取消后这次操作不继续，再点再弹。
//     本次启动第一次点某台设备时显示 loading 现查一次（设备详情 + 当前固件版本），结果存本地缓存 fw_gate_cache；
//     之后再点直接按缓存判断，不再请求接口。详情页进入时的判定也会写进缓存；升级完成（蓝牙 ota 页成功、
//     WiFi 主固件升级走到设备重启确认）后把缓存改成「无需升级」。
// 弹框：「立即升级 / 取消」；立即升级都跳升级页（蓝牙 ota 页自动开始，WiFi wifi-ota 步骤页），这次操作不再继续。
// 有没有新版本，与详情页「固件升级」行红点同一套判定：
//   · WiFi：IoT GET /api/device/info 的 firmwareVersion 对比 newVersionNo（wifiOta.evaluate 为 available）；
//     本地有进行中的升级记录（ota_inflight）时不弹，避免重复下发；
//   · 蓝牙：0x03 读回的当前固件版本对比 newVersionNo，且下载地址是有效 .bin；读不到版本时退回后端 isUpdate
//    （同 detail.js hasFirmwareUpdate）。
// 查询失败（网络 / 接口 / 蓝牙读不到）一律放行，不因为查不到把用户挡在门外。
const wifiOta = require('./wifi-ota')

// 现查用到的接口 / 蓝牙模块只在 guardAction 里按需加载：详情页只用纯判断与弹框，不必连带加载蓝牙层
function deps() {
  return {
    api: require('./api'),
    iotApi: require('./iot-api'),
    wifiStatus: require('./wifi-status'),
    broadcastMatch: require('./broadcast-match'),
    activeDevice: require('./active-device'),
    deviceInfo: require('./device-info'),
    deviceBle: require('./device-ble')
  }
}

const FORCE = 'force'
const REMIND = 'remind'

const TEXT = {
  title: '固件升级',
  confirm: '立即升级',
  cancel: '取消'
}

function textValue(value) {
  return String(value == null ? '' : value).trim()
}

// 升级类型：1 = 强制、2 = 强提示（强提醒）；3 弱提示、4 不提示及其它都不弹
function modeOf(device) {
  const type = Number(device && device.updateType)
  return type === 1 ? FORCE : type === 2 ? REMIND : ''
}

const CACHE_KEY = 'fw_gate_cache'
// 本次启动已现查过的设备（模块级，小程序关闭后重来）；强提醒本次启动已弹过的设备
const verified = new Set()
const reminded = new Set()

function readCache() {
  try {
    const value = wx.getStorageSync(CACHE_KEY)
    return value && typeof value === 'object' ? value : {}
  } catch (error) {
    return {}
  }
}

// 记下这台设备的判定结果（{ mode, version }，mode 为 '' 表示无需弹），并算作本次启动已查过
function remember(deviceId, decision) {
  const id = String(deviceId || '')
  if (!id) {
    return
  }
  const cache = readCache()
  cache[id] = { mode: (decision && decision.mode) || '', version: (decision && decision.version) || '', at: Date.now() }
  try {
    wx.setStorageSync(CACHE_KEY, cache)
  } catch (error) {
    // 存不了下次点击再现查
  }
  verified.add(id)
}

// 升级完成：缓存改成无需升级
function markUpgraded(deviceId) {
  remember(deviceId, { mode: '', version: '' })
}

// 模拟重新打开小程序（测试用）：清掉本次启动的「已查过 / 已提醒」
function resetSession() {
  verified.clear()
  reminded.clear()
}

// 本次启动查过才用缓存；没查过返回 null（调用方现查）
function cachedDecision(deviceId) {
  const id = String(deviceId || '')
  if (!id || !verified.has(id)) {
    return null
  }
  const entry = readCache()[id]
  return entry ? { mode: entry.mode || '', version: entry.version || '' } : null
}

function isBinUrl(url) {
  return /\.bin(?:[?#]|$)/i.test(textValue(url))
}

function sameVersion(a, b) {
  const x = textValue(a).toUpperCase()
  const y = textValue(b).toUpperCase()
  return !!x && !!y && x === y
}

// 蓝牙版有没有可用的新版本（同 detail.js hasFirmwareUpdate：已连接前提由调用方保证）
function bleHasUpdate(device, currentVersion) {
  const latest = textValue(device && device.newVersionNo)
  const url = textValue(device && device.downloadPath)
  const packageOk = !!latest && !!url && isBinUrl(url)
  const current = textValue(currentVersion)
  if (current) {
    return !!latest && !sameVersion(current, latest) && packageOk
  }
  return Number(device && device.isUpdate) === 1 && packageOk
}

// WiFi 版有没有新版本（同 wifi-detail 红点；在线前提由调用方保证）
function wifiHasUpdate(device, firmwareVersion) {
  return wifiOta.evaluate(firmwareVersion, device && device.newVersionNo, device && device.downloadPath).state === 'available'
}

// 由已知事实得出这次要不要弹、弹哪种。facts：
//   { isWifi, online（WiFi）, connected（蓝牙）, currentVersion, hasUpdate（可选，页面红点结果）,
//     inflight（WiFi 进行中的升级）, forceOnly }
// 返回 { mode: 'force' | 'remind' | '', version }
function decide(device, facts) {
  const f = facts || {}
  const none = { mode: '', version: '' }
  if (!device) {
    return none
  }
  // 详情页直接传页面上红点的判定结果（hasUpdate），保证「红点亮 = 会弹」；列表页 / 首页按版本现算
  const known = typeof f.hasUpdate === 'boolean'
  let needed
  if (f.isWifi) {
    needed = !!f.online && !f.inflight && (known ? f.hasUpdate : wifiHasUpdate(device, f.currentVersion))
  } else {
    needed = !!f.connected && (known ? f.hasUpdate : bleHasUpdate(device, f.currentVersion))
  }
  if (!needed) {
    return none
  }
  const mode = modeOf(device)
  if (!mode || (f.forceOnly && mode !== FORCE)) {
    return none
  }
  return { mode, version: textValue(device.newVersionNo) }
}

function otaUrl(device, isWifi) {
  const id = encodeURIComponent(String((device && device.id) || ''))
  return isWifi ? `/subpackages/device/wifi-ota/wifi-ota?id=${id}` : `/subpackages/device/ota/ota?id=${id}&auto=1`
}

// 立即升级：蓝牙版先把这台（带当下有效连接）设为选中设备，升级页按选中设备走那条 BLE 会话
function goUpgrade(device, isWifi, liveId) {
  if (!isWifi && liveId) {
    const app = getApp()
    if (app && app.setSelectedDevice) {
      app.setSelectedDevice(Object.assign({}, device, { deviceId: liveId, bleDeviceId: liveId, connected: true }))
    }
  }
  wx.navigateTo({ url: otaUrl(device, isWifi) })
}

// 按 decide 结果弹框。返回 Promise<boolean>：true = 这次操作继续，false = 不继续（强制升级取消 / 去升级了）
function prompt(device, decision, options) {
  const o = options || {}
  if (!decision || !decision.mode) {
    return Promise.resolve(true)
  }
  const force = decision.mode === FORCE
  const version = decision.version || '新版本'
  const content = force
    ? `检测到新版本：${version}，请升级固件后继续使用该设备`
    : `检测到新版本：${version}，建议立即升级`
  return new Promise(resolve => {
    wx.showModal({
      title: TEXT.title,
      content,
      cancelText: TEXT.cancel,
      confirmText: TEXT.confirm,
      success: res => {
        if (res && res.confirm) {
          goUpgrade(device, !!o.isWifi, o.liveId)
          resolve(false)
          return
        }
        resolve(!force)
      },
      fail: () => resolve(!force)
    })
  })
}

// 详情页进入时判断一次（facts 同 decide，不带 forceOnly）：结果写进缓存；
// 强制升级照弹，强提醒每台设备每次启动只弹一次。返回 Promise<boolean>（同 prompt）
function checkOnEnter(device, facts, options) {
  const decision = decide(device, Object.assign({}, facts, { forceOnly: false }))
  if (device && device.id) {
    remember(device.id, decision)
  }
  if (decision.mode === REMIND) {
    const id = String((device && device.id) || '')
    if (reminded.has(id)) {
      return Promise.resolve(true)
    }
    reminded.add(id)
  }
  return prompt(device, decision, options)
}

// 当前固件版本（蓝牙）：先看本次连接登记过的 0x01 结果，没有再读一次 0x03；读不到返回 ''
async function readBleVersion(liveId, d) {
  const { deviceInfo, deviceBle } = d
  const cached = deviceInfo.peek(liveId)
  const version = textValue(cached && cached.info && cached.info.firmwareVersion)
  if (version) {
    return version
  }
  try {
    return textValue(await deviceBle.getSwVersion(liveId))
  } catch (error) {
    return ''
  }
}

// 详情页：给按钮方法套一层「先判断再执行」。页面需提供 firmwareGate()：不用弹时同步返回 true（按钮照旧同步执行），
// 要弹时返回 prompt 的 Promise。强制升级取消 / 去升级了 → 不执行原方法。
// 须在 tapGuard.wrap 之前套（防连点锁才能盖住弹框期间）。
function wrapActions(definition, names) {
  names.forEach(name => {
    const fn = definition[name]
    if (typeof fn !== 'function') {
      throw new Error(`firmwareGate.wrapActions：${name} 不是页面方法`)
    }
    definition[name] = function gated(...args) {
      const pass = this.firmwareGate()
      if (pass === true) {
        return fn.apply(this, args)
      }
      return Promise.resolve(pass).then(go => (go ? fn.apply(this, args) : undefined))
    }
  })
  return definition
}

// 列表页 / 首页（只判强制升级）。device 为列表或选中设备记录（带 id）。
// 本次启动没查过这台：显示 loading 现查一遍并写缓存；查过了直接按缓存判断，不再请求接口。
// 返回 Promise<boolean>：true = 继续这次操作
async function guardAction(device, options) {
  const o = Object.assign({ forceOnly: true }, options)
  if (!device || !device.id) {
    return true
  }
  try {
    const d = deps()
    const isWifi = d.broadcastMatch.isWifiDevice(device)
    let liveId = ''
    if (isWifi) {
      const deviceNo = wifiOta.plainDeviceNo(device.productDeviceId || device.deviceNo)
      // 列表里已知不在线的不判；首页调用前已确认在线（options.online），不看记录里可能过时的 wifiStatus
      if (!deviceNo || wifiOta.readInflight(deviceNo) || (!o.online && device.wifiStatus && device.wifiStatus !== 'online')) {
        return true
      }
    } else {
      liveId = d.activeDevice.findConnectedDeviceId(device)
      if (!liveId) {
        return true
      }
    }
    let decision = cachedDecision(device.id)
    let record = device
    if (!decision) {
      wx.showLoading({ title: '检查固件版本', mask: true })
      try {
        const fetched = await fetchDecision(device, isWifi, liveId, d)
        if (!fetched) {
          return true
        }
        decision = fetched.decision
        record = fetched.record
        remember(device.id, decision)
      } finally {
        wx.hideLoading()
      }
    }
    if (!decision.mode || (o.forceOnly && decision.mode !== FORCE)) {
      return true
    }
    console.log('[固件升级] 拦截', isWifi ? 'WiFi' : '蓝牙', device.id, decision.mode, '→', decision.version)
    return prompt(record, decision, { isWifi, liveId })
  } catch (error) {
    console.warn('[固件升级] 判断失败，放行', error && error.message)
    return true
  }
}

// 现查：WiFi 查 IoT 设备信息（在线 + 当前版本），蓝牙读当前版本；再拉设备详情拿最新版本与升级类型。
// 不在线返回 null（不判、不写缓存）；返回 { decision（不带 forceOnly，缓存给后续用）, record }
async function fetchDecision(device, isWifi, liveId, d) {
  let facts
  if (isWifi) {
    const deviceNo = wifiOta.plainDeviceNo(device.productDeviceId || device.deviceNo)
    const info = await d.iotApi.getDeviceInfo(deviceNo, { showError: false })
    if (d.wifiStatus.deviceState(info) !== 'online') {
      return null
    }
    facts = { isWifi, online: true, currentVersion: textValue(info && (info.firmwareVersion || (info.shadow || {}).version)) }
  } else {
    facts = { isWifi, connected: true, currentVersion: await readBleVersion(liveId, d) }
  }
  const latest = await d.api.getDeviceDetail(device.id, { showError: false })
  const record = Object.assign({}, device, latest, { id: device.id })
  return { decision: decide(record, facts), record }
}

module.exports = {
  FORCE,
  REMIND,
  TEXT,
  modeOf,
  bleHasUpdate,
  wifiHasUpdate,
  decide,
  otaUrl,
  prompt,
  checkOnEnter,
  remember,
  markUpgraded,
  cachedDecision,
  resetSession,
  wrapActions,
  guardAction
}
