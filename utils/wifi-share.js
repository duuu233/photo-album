// WiFi 版设备分享（2026-10-29）的纯逻辑：详情页「分享设备 / 删除设备」只给所有者，分享列表页分出所有者与接收者。
// 分享邀请 / 移除成员的服务端接口还没有（见 docs/wifi/设备分享方案.md「服务端」），列表先用老服务已有的
// getShareUserProductList（avatar、userName、isToHave、userProductId）。

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

module.exports = {
  isOwner,
  toMember,
  splitMembers
}
