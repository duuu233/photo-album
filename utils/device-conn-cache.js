// 本机 BLE「直连缓存」：{ 后端稳定设备ID(归一化) -> 本机上次成功连上的微信 deviceId }。
//
// 用途：已绑定设备复连时，命中缓存就短超时直连旧 deviceId、跳过整段扫描（见 active-device.tryDirectConnect）。
//
// 为什么存本机而不是后端：微信 createBLEConnection 用的 deviceId 是「设备 × 手机」的函数——
//   iOS 上是本机系统给外设生成的 UUID（换一部手机就不同、不可跨机共享）；
//   安卓上是射频 MAC（隐私随机地址会周期轮换、设备重置后也变）。
// 存后端会把 A 手机生成的值发给 B 手机，B 上拿它连接必然超时失败还白等——比本机没缓存直接扫描更慢。
// 本机 storage 天然按手机隔离，正好匹配这个句柄的语义。
//
// 键：后端唯一且固定的设备ID（normalizeDevice 落在 device.productDeviceId，如 "E9:48:C2:1E:D4:28"），
//     归一化（去分隔符+大写）后作键，保证同一台设备在两侧格式差异下仍命中。
// 值：本机上次成功建连时微信给的有效 deviceId（安卓=MAC / iOS=UUID），原样存、原样喂给 createBLEConnection。
//
// 自愈：缓存失效（设备重启/换机/地址轮换/离线）时直连快速失败并回落扫描；
// 若旧版本曾把 B 的句柄误写到 A 键下，active-device 会在 0x01 完整 ID 校验失败后删除该键并排除 B。
// 只有完整身份校验通过的扫描结果才会重新写入缓存。
const STORAGE_KEY = 'bleDirectConnCache'

// 与 active-device.normalizeSerial 同规则：去 :-空格 + 大写
function normalizeKey(value) {
  return String(value == null ? '' : value).replace(/[:\-\s]/g, '').toUpperCase()
}

function readAll() {
  try {
    return wx.getStorageSync(STORAGE_KEY) || {}
  } catch (error) {
    return {}
  }
}

function writeAll(all) {
  try {
    wx.setStorageSync(STORAGE_KEY, all)
  } catch (error) {
    // 落盘失败不影响连接：下次没缓存就走扫描，功能不缺、只是不省那一次
  }
}

// 取这台设备上次直连成功的微信 deviceId；无缓存返回 ''
function get(backendId) {
  const key = normalizeKey(backendId)
  if (!key) {
    return ''
  }
  return readAll()[key] || ''
}

// 记住这台设备本次有效的微信 deviceId（值未变则不写盘）
function put(backendId, deviceId) {
  const key = normalizeKey(backendId)
  if (!key || !deviceId) {
    return
  }
  const all = readAll()
  if (all[key] === deviceId) {
    return
  }
  all[key] = deviceId
  writeAll(all)
}

// 删除这台设备的缓存：解绑、或完整设备 ID 校验发现键值串台时调用。
function remove(backendId) {
  const key = normalizeKey(backendId)
  if (!key) {
    return
  }
  const all = readAll()
  if (!(key in all)) {
    return
  }
  delete all[key]
  writeAll(all)
}

module.exports = {
  get,
  put,
  remove
}
