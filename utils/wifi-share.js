// WiFi 版设备分享（2026-10-29）的纯逻辑：详情页「分享设备 / 删除设备」只给所有者，分享列表页分出所有者与接收者。
// 简化版分享（服务端未做邀请码）：所有者发微信卡片，卡片路径带设备号 / 产品 ID / 设备名 / 所有者 userId 与昵称；
// 接收者在接受页调 addUserProduct（isToHave=0、shareUserId=所有者 userId）。成员列表用 getShareUserProductList，
// 移除成员用 delUserProduct（成员那条 userProductId）。
// 已知风险：没有一次性 / 过期 / 撤回，卡片被转发时拿到的人都能加入，由服务端校验兜底。

// 是否所有者：isToHave=1 是；带分享者 shareUserId 的是接收者；两者都没有的是分享上线前绑定的老记录，按所有者算
function isOwner(device) {
  const d = device || {}
  if (Number(d.isToHave) === 1) {
    return true
  }
  return !(Number(d.shareUserId) > 0)
}

function toMember(raw) {
  const r = raw || {}
  return {
    id: String(r.userProductId != null ? r.userProductId : ''),
    name: r.userName || r.nickName || '微信用户',
    avatar: r.avatar || r.avatarUrl || '',
    joinedAt: r.createTime || r.joinTime || r.addTime || ''
  }
}

// 列表 → { owner, members }：isToHave=1 的是所有者（固定第一栏），其余是接收者；
// 列表里没有所有者时用 fallbackOwner（当前用户，进得来这页的就是所有者）
function splitMembers(list, fallbackOwner) {
  let owner = null
  const members = []
  ;(list || []).forEach(raw => {
    if (!owner && Number(raw && raw.isToHave) === 1) {
      owner = toMember(raw)
    } else if (raw) {
      members.push(toMember(raw))
    }
  })
  return { owner: owner || (fallbackOwner ? toMember(fallbackOwner) : null), members }
}

const ACCEPT_PAGE = '/subpackages/device/wifi-share-accept/wifi-share-accept'
const PENDING_KEY = 'pendingShareAccept'
const PENDING_TTL_MS = 10 * 60 * 1000 // 未登录点了接受、去登录：10 分钟内登录成功才回接受页

function decode(value) {
  const text = String(value == null ? '' : value)
  try {
    return decodeURIComponent(text)
  } catch (error) {
    return text
  }
}

// 卡片路径：d 设备号（绑定时的完整格式，带冒号）、p 产品 ID、u 所有者 userId、n 设备名、o 所有者昵称
function buildAcceptPath(info) {
  const i = info || {}
  const query = [
    ['d', i.deviceId],
    ['p', i.productId],
    ['u', i.ownerUserId],
    ['n', i.deviceName],
    ['o', i.ownerName]
  ]
    .filter(pair => pair[1] !== undefined && pair[1] !== null && pair[1] !== '')
    .map(pair => `${pair[0]}=${encodeURIComponent(String(pair[1]))}`)
    .join('&')
  return `${ACCEPT_PAGE}?${query}`
}

// 接受页 options → 分享信息；缺设备号 / 产品 / 所有者任一项返回 null（卡片无效）
function parseAcceptQuery(options) {
  const o = options || {}
  const info = {
    deviceId: decode(o.d).trim(),
    productId: decode(o.p).trim(),
    ownerUserId: decode(o.u).trim(),
    deviceName: decode(o.n).trim() || '智能相框',
    ownerName: decode(o.o).trim()
  }
  if (!info.deviceId || !/^\d+$/.test(info.productId) || !/^\d+$/.test(info.ownerUserId)) {
    return null
  }
  return info
}

function plainDeviceNo(value) {
  return String(value || '').replace(/[:\-\s]/g, '').toUpperCase()
}

// 已绑定列表里有没有这台（按设备号去冒号比较）
function findBound(devices, deviceId) {
  const target = plainDeviceNo(deviceId)
  return (devices || []).filter(item => item && [item.productDeviceId, item.deviceNo, item.rawProductDeviceId].some(value => plainDeviceNo(value) === target))[0] || null
}

module.exports = {
  ACCEPT_PAGE,
  PENDING_KEY,
  PENDING_TTL_MS,
  isOwner,
  toMember,
  splitMembers,
  buildAcceptPath,
  parseAcceptQuery,
  findBound
}
