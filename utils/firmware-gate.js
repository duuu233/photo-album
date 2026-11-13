// 固件升级提醒（2026-11-13 产品改口，取代同日早些时候的「强制升级 / 强提醒」两套判断）：
// 强制升级整套去掉——首页、列表页、设备详情页都不拦截；首页 / 列表页点击时的 loading 现查与本地缓存一并去掉。
// 只保留「强提醒升级」与「弱提示升级」：
//
// 升级类型取后台「升级类型」compulsory（api.normalizeDevice 归一成 updateType）：
//   2 = 强提示升级（强提醒）：「固件升级」红点（用户主动点）+ 进入设备详情页弹提示框；
//       取消后不再弹，关闭 / 重启小程序（本次启动的内存记录丢失）后再进入才再弹；
//   3 = 弱提示升级：只亮红点，用户主动点去升级；4 = 不提示升级 / 没给：同改动前，只按版本亮红点；
//   1 = 原强制升级：后台已隐藏该选项，存量数据按强提醒处理。
// 弹的前提：WiFi 版在线、蓝牙版已连接，且详情页「固件升级」行红点亮（有新版本）——与红点同一个判定，红点亮才会弹。
// 弹框「立即升级 / 取消」：立即升级进升级页（蓝牙 ota 页自动开始，WiFi wifi-ota 步骤页）；取消照常留在详情页。
// 调试日志：每一步打一行「[固件升级] …」（判定依据与结果、是否已提醒过、弹框与用户选择），
// 开发版 / 体验版在左下角「日志」浮窗里能看到（utils/debug-log 包装了 console）；接口返回的升级参数见 utils/api.js。

const REMIND = 'remind'

const TEXT = {
  title: '固件升级',
  confirm: '立即升级',
  cancel: '取消'
}

function log(...args) {
  console.log('[固件升级]', ...args)
}

function textValue(value) {
  return String(value == null ? '' : value).trim()
}

// 日志里的设备称呼：名称#id
function who(device) {
  if (!device) {
    return '（无设备）'
  }
  return `${textValue(device.name || device.deviceName) || '设备'}#${textValue(device.id) || '?'}`
}

function typeName(updateType) {
  const type = Number(updateType)
  return type === 1
    ? '1 强制升级（已取消，按强提醒）'
    : type === 2
      ? '2 强提醒'
      : type === 3
        ? '3 弱提示'
        : type === 4
          ? '4 不提示'
          : `未给（${updateType == null ? '空' : updateType}）`
}

// 升级类型：2 强提醒（1 原强制按强提醒）弹；3 弱提示、4 不提示及其它都不弹（只亮红点）
function modeOf(device) {
  const type = Number(device && device.updateType)
  return type === 1 || type === 2 ? REMIND : ''
}

// 本次启动已提醒过的设备（模块级：小程序关闭 / 重启后清空，再进入详情页再弹）
const reminded = new Set()

// 模拟重新打开小程序（测试用）
function resetSession() {
  reminded.clear()
}

// 由已知事实得出要不要弹。facts：{ isWifi, online（WiFi）, connected（蓝牙）, hasUpdate（详情页红点结果） }
// 返回 { mode: 'remind' | '', version }
function decide(device, facts) {
  const f = facts || {}
  const none = { mode: '', version: '' }
  if (!device) {
    log('判定：没有设备信息 → 不弹')
    return none
  }
  const basis = {
    类型: f.isWifi ? 'WiFi' : '蓝牙',
    升级类型: typeName(device.updateType),
    在线或已连接: f.isWifi ? !!f.online : !!f.connected,
    红点: !!f.hasUpdate,
    最新版本: textValue(device.newVersionNo) || '-',
    下载地址: textValue(device.downloadPath) || '-',
    isUpdate: device.isUpdate
  }
  const result = (decision, reason) => {
    log('判定', who(device), '→', decision.mode ? '弹强提醒' : '不弹', `（${reason}）`, basis)
    return decision
  }
  if (f.isWifi ? !f.online : !f.connected) {
    return result(none, f.isWifi ? 'WiFi 不在线' : '蓝牙未连接')
  }
  if (!f.hasUpdate) {
    return result(none, '红点没亮，无新版本')
  }
  if (!modeOf(device)) {
    return result(none, '有新版本，但升级类型不是强提醒，只亮红点')
  }
  return result({ mode: REMIND, version: textValue(device.newVersionNo) }, '有新版本 + 强提醒')
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
  const url = otaUrl(device, isWifi)
  log('点了「立即升级」→ 跳升级页', who(device), url, !isWifi ? `（蓝牙连接 ${liveId || '无'}）` : '')
  wx.navigateTo({ url })
}

// 按 decide 结果弹框。返回 Promise<boolean>：true = 取消 / 不用弹（留在当前页），false = 去升级了
function prompt(device, decision, options) {
  const o = options || {}
  if (!decision || !decision.mode) {
    return Promise.resolve(true)
  }
  const version = decision.version || '新版本'
  log('弹框', who(device), '强提醒', version)
  return new Promise(resolve => {
    wx.showModal({
      title: TEXT.title,
      content: `检测到新版本：${version}，建议立即升级`,
      cancelText: TEXT.cancel,
      confirmText: TEXT.confirm,
      success: res => {
        if (res && res.confirm) {
          goUpgrade(device, !!o.isWifi, o.liveId)
          resolve(false)
          return
        }
        log('点了「取消」', who(device), '→ 本次启动不再提醒这台')
        resolve(true)
      },
      fail: error => {
        log('弹框失败', who(device), error && error.errMsg)
        resolve(true)
      }
    })
  })
}

// 详情页进入时判断一次（facts 同 decide）：强提醒每台设备每次启动只弹一次。返回 Promise<boolean>（同 prompt）
function checkOnEnter(device, facts, options) {
  log('进入设备详情页判断', who(device))
  const decision = decide(device, facts)
  if (!decision.mode) {
    return Promise.resolve(true)
  }
  const id = String((device && device.id) || '')
  if (reminded.has(id)) {
    log('强提醒：这台本次启动已提醒过，不再弹（关闭 / 重启小程序后再进入才再弹）', who(device))
    return Promise.resolve(true)
  }
  log('强提醒：这台本次启动第一次，弹', who(device))
  reminded.add(id)
  return prompt(device, decision, options)
}

module.exports = {
  REMIND,
  TEXT,
  modeOf,
  decide,
  otaUrl,
  prompt,
  checkOnEnter,
  resetSession
}
