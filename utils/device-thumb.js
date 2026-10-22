// 设备图：按机型（产品的 broadcastId，即蓝牙广播名）区分，2026-10-22 起。
//
// 首页设备卡 / 我的设备 / 设备详情 / 搜索设备 / 命名弹窗 / 投屏选设备六处共用这一个出口，
// 别在模板里再写死某一张图——六处必须同口径，漏改一处只会安静地显示成别的机型。
//
//   EB-169（圆屏）→ home-device-circle-thumb
//   EC-370        → home-device-rectangle-thumb
//   其余机型（EF6-370 / EF6-589 等）与认不出的 → 原来那张 home-device-thumb
//
// 机型从哪来，按可靠程度依次取：
//   ① 设备上的 broadcastId：已绑定记录由 api 按 productId 从产品列表回填（见 api.withProductBroadcastId），
//      刚绑定的由 bindDevice 按匹配到的产品写入；
//   ② 搜索结果（realBluetooth）的蓝牙广播名 name / localName——与扫描白名单同一口径：
//      大小写不敏感的包含匹配。已绑定记录的 name 是用户起的名字，不参与判断，否则改个名图就变了；
//   ③ 都取不到时，shapeType === 1（后台产品「形状类型」= 圆形）按 EB-169 圆屏处理。
const DEFAULT_THUMB = '/assets/images/home-device-thumb.png'

const THUMB_BY_BROADCAST_ID = [
  { broadcastId: 'EB-169', thumb: '/assets/images/home-device-circle-thumb.png' },
  { broadcastId: 'EC-370', thumb: '/assets/images/home-device-rectangle-thumb.png' }
]

const ROUND_THUMB = THUMB_BY_BROADCAST_ID[0].thumb

// 文本里命中哪个机型的广播ID就返回那张图；都不命中返回空串
function thumbOfText(text) {
  const upper = String(text || '').toUpperCase()
  if (!upper) {
    return ''
  }
  const hit = THUMB_BY_BROADCAST_ID.find(item => upper.indexOf(item.broadcastId) > -1)
  return hit ? hit.thumb : ''
}

function thumbOf(device) {
  if (!device) {
    return DEFAULT_THUMB
  }
  const byBroadcastId = thumbOfText(device.broadcastId)
  if (byBroadcastId) {
    return byBroadcastId
  }
  if (device.realBluetooth) {
    const byName = thumbOfText(`${device.name || ''} ${device.localName || ''}`)
    if (byName) {
      return byName
    }
  }
  if (device.shapeType === 1) {
    return ROUND_THUMB
  }
  return DEFAULT_THUMB
}

module.exports = {
  DEFAULT_THUMB,
  THUMB_BY_BROADCAST_ID,
  thumbOf
}
