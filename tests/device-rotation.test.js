const assert = require('assert')
const deviceRotation = require('../utils/device-rotation')

assert.strictEqual(deviceRotation.degreeFor({ rotationDegree: 90 }), 90)
assert.strictEqual(deviceRotation.degreeFor({ rotationDegree: '180' }), 180)
assert.strictEqual(deviceRotation.degreeFor({ rotationDegree: 0 }), 0)
assert.strictEqual(deviceRotation.degreeFor({ rotationDegree: null }), 270)
assert.strictEqual(deviceRotation.degreeFor({ rotationDegree: '' }), 270)
assert.strictEqual(deviceRotation.degreeFor({ rotationDegree: 'invalid' }), 270)
assert.strictEqual(deviceRotation.degreeFor(null), 270)

// 横向沿用每台设备的 rotationDegree；竖向无论设备字段为何都固定旋转 180°。
assert.strictEqual(deviceRotation.exportDegreeFor({ rotationDegree: 90 }, 'landscape'), 90)
assert.strictEqual(deviceRotation.exportDegreeFor({ rotationDegree: 0 }, 'landscape'), 0)
assert.strictEqual(deviceRotation.exportDegreeFor(null, 'landscape'), 270)
assert.strictEqual(deviceRotation.exportDegreeFor({ rotationDegree: 0 }, 'portrait'), 180)
assert.strictEqual(deviceRotation.exportDegreeFor({ rotationDegree: 90 }, 'portrait'), 180)
assert.strictEqual(deviceRotation.exportDegreeFor({ rotationDegree: 270 }, 'portrait'), 180)
assert.strictEqual(deviceRotation.exportDegreeFor(null, 'portrait'), 180)

console.log('device rotation tests passed')
