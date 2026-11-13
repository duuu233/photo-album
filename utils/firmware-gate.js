// 固件升级判断（2026-11-13，产品口径）：强制升级 / 强提醒升级的弹框与拦截。
//
// 什么时候判断：
//   · WiFi 版在线才判断，离线（含休眠 / 关机 / 本地模式 / 状态查不到）不判；
//   · 蓝牙版已连接才判断，未连接不判。
// 判断场景：
//   · 设备详情页（蓝牙 detail / WiFi wifi-detail）：进入后判断一次，点功能按钮再判断——强制升级与强提醒升级都弹；
//   · 设备列表页：蓝牙「投屏」、WiFi「投屏」「轮播设置」——只判强制升级；
//   · 首页「拍照投屏」「相册投屏」——只判强制升级。
// 弹框：
//   · 强制升级：「立即升级 / 取消」，可以取消，但取消后这次操作不继续；再次点击或进入触发判断的场景会再弹；
//   · 强提醒升级（只在详情页判断）：「立即升级 / 取消」，取消后操作照常继续；
//   · 立即升级都跳升级页（蓝牙 ota 页自动开始，WiFi wifi-ota 步骤页），这次操作不再继续。
// 有没有新版本，与详情页「固件升级」行红点同一套判定：
//   · WiFi：IoT GET /api/device/info 的 firmwareVersion 对比 newVersionNo（wifiOta.evaluate 为 available）；
//     本地有进行中的升级记录（ota_inflight）时不弹，避免重复下发；
//   · 蓝牙：0x03 读回的当前固件版本对比 newVersionNo，且下载地址是有效 .bin；读不到版本时退回后端 isUpdate
//    （同 detail.js hasFirmwareUpdate）。
// 升级方式取 api.normalizeDevice 归一后的 updateType（详情出参 compulsory 优先，旧猜测字段兜底）：1 = 强制升级，其它 = 强提醒升级。
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

// 升级方式：updateType 1 = 强制，其它 = 强提醒
function modeOf(device) {
  return Number(device && device.updateType) === 1 ? FORCE : REMIND
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
  if (f.forceOnly && mode !== FORCE) {
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

// 列表页 / 首页：现查一遍再判断（只判强制升级）。device 为列表或选中设备记录（带 id）。
// 返回 Promise<boolean>：true = 继续这次操作
async function guardAction(device, options) {
  const o = Object.assign({ forceOnly: true }, options)
  if (!device || !device.id) {
    return true
  }
  try {
    const d = deps()
    const { api, iotApi, wifiStatus, activeDevice } = d
    const isWifi = d.broadcastMatch.isWifiDevice(device)
    let facts
    let liveId = ''
    if (isWifi) {
      const deviceNo = wifiOta.plainDeviceNo(device.productDeviceId || device.deviceNo)
      if (!deviceNo || wifiOta.readInflight(deviceNo)) {
        return true
      }
      const info = await iotApi.getDeviceInfo(deviceNo, { showError: false })
      if (wifiStatus.deviceState(info) !== 'online') {
        return true
      }
      facts = { isWifi, online: true, currentVersion: textValue(info && (info.firmwareVersion || (info.shadow || {}).version)) }
    } else {
      liveId = activeDevice.findConnectedDeviceId(device)
      if (!liveId) {
        return true
      }
      facts = { isWifi, connected: true, currentVersion: await readBleVersion(liveId, d) }
    }
    const latest = await api.getDeviceDetail(device.id, { showError: false })
    const record = Object.assign({}, device, latest, { id: device.id })
    const decision = decide(record, Object.assign(facts, { forceOnly: o.forceOnly }))
    if (!decision.mode) {
      return true
    }
    console.log('[固件升级] 拦截', isWifi ? 'WiFi' : '蓝牙', device.id, decision.mode, facts.currentVersion, '→', decision.version)
    return prompt(record, decision, { isWifi, liveId })
  } catch (error) {
    console.warn('[固件升级] 判断失败，放行', error && error.message)
    return true
  }
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
  wrapActions,
  guardAction
}
