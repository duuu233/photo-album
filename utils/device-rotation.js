// 横向构图写入设备竖向物理画布时的顺时针旋转角。
// 后端设备列表/详情字段 rotationDegree 是真源；旧设备、旧缓存和异常值保持历史 270° 行为。
const DEFAULT_ROTATION_DEG = 270

function degreeFor(device) {
  const raw = device && device.rotationDegree
  if (raw === undefined || raw === null || raw === '') {
    return DEFAULT_ROTATION_DEG
  }
  const degree = Number(raw)
  return Number.isFinite(degree) ? degree : DEFAULT_ROTATION_DEG
}

module.exports = {
  DEFAULT_ROTATION_DEG,
  degreeFor
}
