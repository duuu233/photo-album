// 投屏导出时整幅构图的顺时针旋转角（度）。两种取景方向各有自己的真源，互不通用：
//
//   · 横向 landscape —— 设备字段 `rotationDegree`；旧设备、旧缓存和异常值保持历史 270° 行为。
//   · 竖向 portrait  —— 设备字段 `verticalRotation`（2026-08-04 新增）；
//     **取不到就默认不旋转（0°）**。此前所有设备一律固定 180°，现改为按设备下发角决定。
//
// ⚠️ 0 是合法角度，判空只能判 undefined/null/''，绝不能用真假值——写成 `raw || 默认值`
//    会把「设备明确要求不旋转」当成缺失，又转回默认角。

// 横向缺省角（历史行为，不要改）
const DEFAULT_ROTATION_DEG = 270
// 竖向缺省角：产品口径「没有该参数就不旋转」
const DEFAULT_VERTICAL_ROTATION_DEG = 0

// 竖向角字段名。`verticalRotation` 是与后端约定的正式名，后两个只是大小写/后缀兼容，
// 后端定稿后可以删；命中顺序即优先级。
const VERTICAL_KEYS = ['verticalRotation', 'verticalRotationDegree', 'verticalrotation']

function toDegree(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') {
    return fallback
  }
  const degree = Number(raw)
  return Number.isFinite(degree) ? degree : fallback
}

function pickVerticalRaw(device) {
  if (!device) {
    return undefined
  }
  for (let i = 0; i < VERTICAL_KEYS.length; i++) {
    const value = device[VERTICAL_KEYS[i]]
    if (value !== undefined && value !== null && value !== '') {
      return value
    }
  }
  return undefined
}

// 横向导出角（设备 rotationDegree，缺失/非法回退 270°）
function degreeFor(device) {
  return toDegree(device && device.rotationDegree, DEFAULT_ROTATION_DEG)
}

// 竖向导出角（设备 verticalRotation，缺失/非法回退 0° = 不旋转）
function verticalDegreeFor(device) {
  return toDegree(pickVerticalRaw(device), DEFAULT_VERTICAL_ROTATION_DEG)
}

// 按取景方向返回最终导出角。导出画布、手机端反向预览、烘焙缓存指纹三处必须都用它取值，
// 否则会出现「设备上正了、手机预览里倒了」或「改了角度却命中旧缓存」。
function exportDegreeFor(device, orientation) {
  return orientation === 'landscape'
    ? degreeFor(device)
    : verticalDegreeFor(device)
}

// 角度归一到 [0,360)，便于判断象限（负角、720 这类值都能正确落位）
function normalizeDegree(degree) {
  const value = Number(degree)
  if (!Number.isFinite(value)) {
    return 0
  }
  return ((value % 360) + 360) % 360
}

// 是否为奇数个直角（90° / 270°）：这类角度会把画面的宽高**对调**，
// 导出目标矩形与手机端反向预览都必须跟着换宽高，否则内容会被裁掉一截。
function isQuarterTurn(degree) {
  return normalizeDegree(degree) % 180 === 90
}

module.exports = {
  DEFAULT_ROTATION_DEG,
  DEFAULT_VERTICAL_ROTATION_DEG,
  degreeFor,
  verticalDegreeFor,
  exportDegreeFor,
  normalizeDegree,
  isQuarterTurn
}
