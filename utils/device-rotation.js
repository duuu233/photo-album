// 横向构图写入设备竖向物理画布时的顺时针旋转角。
// 后端设备列表/详情字段 rotationDegree 是真源；旧设备、旧缓存和异常值保持历史 270° 行为。
const DEFAULT_ROTATION_DEG = 270
// 竖向构图不读取设备字段，所有设备固定顺时针旋转 180° 后导出。
const PORTRAIT_ROTATION_DEG = 180

function degreeFor(device) {
  const raw = device && device.rotationDegree
  if (raw === undefined || raw === null || raw === '') {
    return DEFAULT_ROTATION_DEG
  }
  const degree = Number(raw)
  return Number.isFinite(degree) ? degree : DEFAULT_ROTATION_DEG
}

// 按取景方向返回最终导出角：只有横向使用设备 rotationDegree，竖向固定 180°。
function exportDegreeFor(device, orientation) {
  return orientation === 'landscape' ? degreeFor(device) : PORTRAIT_ROTATION_DEG
}

module.exports = {
  DEFAULT_ROTATION_DEG,
  PORTRAIT_ROTATION_DEG,
  degreeFor,
  exportDegreeFor
}
