const assert = require('assert')
const deviceRotation = require('../utils/device-rotation')

assert.strictEqual(deviceRotation.degreeFor({ rotationDegree: 90 }), 90)
assert.strictEqual(deviceRotation.degreeFor({ rotationDegree: '180' }), 180)
assert.strictEqual(deviceRotation.degreeFor({ rotationDegree: 0 }), 0)
assert.strictEqual(deviceRotation.degreeFor({ rotationDegree: null }), 270)
assert.strictEqual(deviceRotation.degreeFor({ rotationDegree: '' }), 270)
assert.strictEqual(deviceRotation.degreeFor({ rotationDegree: 'invalid' }), 270)
assert.strictEqual(deviceRotation.degreeFor(null), 270)

console.log('device rotation tests passed')
