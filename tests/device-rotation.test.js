const assert = require('assert')
const deviceRotation = require('../utils/device-rotation')

// ── 横向：设备 rotationDegree，缺失/非法回退 270°（历史行为，本轮未改） ──
assert.strictEqual(deviceRotation.degreeFor({ rotationDegree: 90 }), 90)
assert.strictEqual(deviceRotation.degreeFor({ rotationDegree: '180' }), 180)
assert.strictEqual(deviceRotation.degreeFor({ rotationDegree: 0 }), 0)
assert.strictEqual(deviceRotation.degreeFor({ rotationDegree: null }), 270)
assert.strictEqual(deviceRotation.degreeFor({ rotationDegree: '' }), 270)
assert.strictEqual(deviceRotation.degreeFor({ rotationDegree: 'invalid' }), 270)
assert.strictEqual(deviceRotation.degreeFor(null), 270)

// ── 竖向：2026-08-04 起读设备新增字段 verticalRotation，**缺失即 0（不旋转）** ──
// 此前是所有设备固定 180°；改动后没有下发该字段的设备一律不再旋转。
assert.strictEqual(deviceRotation.verticalDegreeFor({ verticalRotation: 180 }), 180)
assert.strictEqual(deviceRotation.verticalDegreeFor({ verticalRotation: '90' }), 90)
// 0 是合法值（设备明确要求不旋转），不能被当成「缺失」再补默认角
assert.strictEqual(deviceRotation.verticalDegreeFor({ verticalRotation: 0 }), 0)
assert.strictEqual(deviceRotation.verticalDegreeFor({ verticalRotation: null }), 0)
assert.strictEqual(deviceRotation.verticalDegreeFor({ verticalRotation: '' }), 0)
assert.strictEqual(deviceRotation.verticalDegreeFor({ verticalRotation: 'invalid' }), 0)
assert.strictEqual(deviceRotation.verticalDegreeFor({}), 0)
assert.strictEqual(deviceRotation.verticalDegreeFor(null), 0)
// 大小写/后缀兼容写法（后端字段名定稿后可删）
assert.strictEqual(deviceRotation.verticalDegreeFor({ verticalRotationDegree: 180 }), 180)
assert.strictEqual(deviceRotation.verticalDegreeFor({ verticalrotation: 270 }), 270)
// 正式名优先于兼容名
assert.strictEqual(
  deviceRotation.verticalDegreeFor({ verticalRotation: 90, verticalrotation: 270 }),
  90
)

// ── 两个方向各取各的字段，绝不互相串用 ──
assert.strictEqual(
  deviceRotation.exportDegreeFor({ rotationDegree: 90, verticalRotation: 180 }, 'landscape'),
  90
)
assert.strictEqual(
  deviceRotation.exportDegreeFor({ rotationDegree: 90, verticalRotation: 180 }, 'portrait'),
  180
)
// 竖向不再受 rotationDegree 影响：只有 verticalRotation 说了算，没有就是 0
assert.strictEqual(deviceRotation.exportDegreeFor({ rotationDegree: 270 }, 'portrait'), 0)
assert.strictEqual(deviceRotation.exportDegreeFor(null, 'portrait'), 0)
assert.strictEqual(deviceRotation.exportDegreeFor(null, 'landscape'), 270)

// ── 轴向对调判定：90/270 会把画面宽高对调，导出目标矩形与反向预览都要跟着换 ──
assert.strictEqual(deviceRotation.isQuarterTurn(90), true)
assert.strictEqual(deviceRotation.isQuarterTurn(270), true)
assert.strictEqual(deviceRotation.isQuarterTurn(-90), true)
assert.strictEqual(deviceRotation.isQuarterTurn(450), true)
assert.strictEqual(deviceRotation.isQuarterTurn(0), false)
assert.strictEqual(deviceRotation.isQuarterTurn(180), false)
assert.strictEqual(deviceRotation.isQuarterTurn(360), false)
assert.strictEqual(deviceRotation.isQuarterTurn('invalid'), false)

assert.strictEqual(deviceRotation.normalizeDegree(-90), 270)
assert.strictEqual(deviceRotation.normalizeDegree(360), 0)
assert.strictEqual(deviceRotation.normalizeDegree('180'), 180)

console.log('device rotation tests passed')
