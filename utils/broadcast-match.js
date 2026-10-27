// 蓝牙广播名 ↔ 后台产品广播 ID（产品列表 broadcastId）的匹配规则（2026-10-26，WiFi 版接入）。
//
// 后台配置两种写法：
//   · 蓝牙版：固定广播名，如 `EF6-370`、`EB-169`；
//   · WiFi 版：带 `*` 的模板，如 `IJ_*`。按 `*` 拆成前缀 / 后缀，广播名前后缀都对上、且被 `*`
//     替换的中间部分**正好 12 位**才算命中，中间这 12 位就是设备 deviceId（= MQTT clientid，
//     例 `IJ_E348C21ED428` → `E348C21ED428`；`IJ_*ABC` 配 `IJ_E348C21ED428ABC` 同样取 `E348C21ED428`）。
//
// 只认广播 local name，不依赖 MAC：iOS 拿不到 MAC。大小写不敏感；deviceId 统一转大写。
//
// 内置 WiFi 模板 `IJ_*`（2026-10-26 追加）：WiFi 前缀按对接约定固定为 `IJ_`。广播名合这个模板的一律认作
// WiFi 设备，不看后台把广播 ID 写成 `IJ_*`、`IJ_` 还是别的——写成不带 `*` 的 `IJ_` 时，旧逻辑会按蓝牙版
// 包含匹配把它当蓝牙设备，既不查规格、也拦不住未知设备。后台另配的其它 `*` 模板照样生效（先于内置模板）。
//
// ⚠️ 蓝牙版沿用原来的「包含匹配」（广播名里含该广播 ID 即命中，允许带前后缀），与扫描白名单、
// 搜索列表尺寸（api.scanSizeModel）、绑定选产品（api.bindDevice）同一口径——改成完全匹配会让
// 广播名带后缀的现网设备搜不到。WiFi 模板不参与包含匹配（广播名里本来就不会有字面的 `*`）。
const WIFI_DEVICE_ID_LENGTH = 12
const WIFI_DEVICE_ID_RE = /^[0-9A-Z]{12}$/

const BUILTIN_WIFI_TEMPLATE = 'IJ_*'

const COMM_WIFI = 'WIFI'
const COMM_BLE = 'BLE'

function normalizeId(value) {
  return String(value || '').trim().toUpperCase()
}

function isWildcard(broadcastId) {
  return normalizeId(broadcastId).indexOf('*') > -1
}

// 单条模板匹配：命中返回 12 位 deviceId，否则空串。模板里多于一个 `*` 视为配置错误，不匹配。
function matchWildcard(name, broadcastId) {
  const pattern = normalizeId(broadcastId)
  const parts = pattern.split('*')
  if (parts.length !== 2) {
    return ''
  }
  const text = normalizeId(name)
  const prefix = parts[0]
  const suffix = parts[1]
  if (text.length !== prefix.length + suffix.length + WIFI_DEVICE_ID_LENGTH) {
    return ''
  }
  if (text.indexOf(prefix) !== 0 || text.slice(text.length - suffix.length) !== suffix) {
    return ''
  }
  const middle = text.slice(prefix.length, text.length - suffix.length)
  return WIFI_DEVICE_ID_RE.test(middle) ? middle : ''
}

function namesOf(device) {
  return [device && device.name, device && device.localName].filter(Boolean)
}

// WiFi 设备识别：先按后台配置的 `*` 模板，再按内置 `IJ_*`。命中返回 { broadcastId, wifiDeviceId }，否则 null。
function wifiMatch(device, broadcastIds) {
  const templates = (broadcastIds || [])
    .map(normalizeId)
    .filter(isWildcard)
    .concat(BUILTIN_WIFI_TEMPLATE)
  const names = namesOf(device)
  for (let i = 0; i < templates.length; i++) {
    for (let j = 0; j < names.length; j++) {
      const wifiDeviceId = matchWildcard(names[j], templates[i])
      if (wifiDeviceId) {
        return { broadcastId: templates[i], wifiDeviceId }
      }
    }
  }
  return null
}

// 判定一台扫描到的设备属于哪类：
//   { commType: 'WIFI', broadcastId, wifiDeviceId } / { commType: 'BLE', broadcastId } / null（都不命中）
// WiFi 优先：它要求整名精确对上模板，比蓝牙的包含匹配更具体；合 WiFi 模板的设备绝不归为蓝牙版。
function classify(device, broadcastIds) {
  const wifi = wifiMatch(device, broadcastIds)
  if (wifi) {
    return { commType: COMM_WIFI, broadcastId: wifi.broadcastId, wifiDeviceId: wifi.wifiDeviceId }
  }
  const ids = (broadcastIds || []).map(normalizeId).filter(Boolean)
  const names = namesOf(device)
  const upperNames = names.map(normalizeId)
  let best = ''
  ids.forEach(id => {
    if (!isWildcard(id) && upperNames.some(name => name.indexOf(id) > -1) && id.length > best.length) {
      best = id
    }
  })
  return best ? { commType: COMM_BLE, broadcastId: best } : null
}

// 已绑定设备记录是不是 WiFi 版（2026-10-27，我的设备分组用）：看所属产品的 broadcastId——
// WiFi 产品后台配的是带 `*` 的模板（如 `IJ_*`），也认写成 `IJ_` 前缀的；蓝牙版是固定广播名（`EF6-370` 等）。
function isWifiBroadcastId(broadcastId) {
  const id = normalizeId(broadcastId)
  return !!id && (isWildcard(id) || id.indexOf(BUILTIN_WIFI_TEMPLATE.replace('*', '')) === 0)
}

// 设备记录是不是 WiFi 版：列表页打过的 isWifi、配网绑定回来的 commType，或所属产品的广播 ID
function isWifiDevice(device) {
  return !!device && (device.isWifi === true || device.commType === COMM_WIFI || isWifiBroadcastId(device.broadcastId))
}

module.exports = {
  COMM_WIFI,
  COMM_BLE,
  WIFI_DEVICE_ID_LENGTH,
  isWildcard,
  isWifiBroadcastId,
  isWifiDevice,
  matchWildcard,
  wifiMatch,
  classify
}
