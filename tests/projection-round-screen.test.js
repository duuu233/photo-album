const assert = require('assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
const readCode = file => read(file).replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
const wxml = readCode('subpackages/projection/preview/preview.wxml')
const wxss = readCode('subpackages/projection/preview/preview.wxss')
const preview = readCode('subpackages/projection/preview/preview.js')

function ruleBody(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(wxss)
  assert.ok(match, `缺少样式 ${selector}`)
  return match[1]
}

for (const selector of ['photo-wrap', 'edit-clip']) {
  const match = new RegExp(`class="${selector} \\{\\{(device\\.shapeType === 1 \\? 'is-round' : '')\\}\\}`).exec(wxml)
  assert.ok(match, `${selector} 仅在设备 shapeType === 1 时启用圆形`)
  for (const [shapeType, expected] of [[1, 'is-round'], [0, ''], [undefined, ''], [null, ''], ['1', ''], [2, '']]) {
    assert.strictEqual(vm.runInNewContext(match[1], { device: { shapeType } }), expected)
  }
  assert.match(ruleBody(`.${selector}.is-round`), /border-radius:\s*50%\s*;/)
  assert.match(ruleBody(`.${selector}`), /border-radius:\s*40rpx\s*;/)
  assert.match(ruleBody(`.${selector}`), /overflow:\s*hidden\s*;/)
}
assert.match(wxml, /\{\{editPickup \? 'is-pickup' : ''\}\} \{\{dragging \? 'is-dragging' : ''\}\}/)
for (const match of wxss.matchAll(/([^{}]+)\{([^{}]*border-radius:\s*50%[^{}]*)\}/g)) {
  assert.ok(match[1].split(',').every(selector => selector.includes('.is-round')), '圆形样式不得影响默认选择器')
}
assert.match(preview, /getDeviceCropSize\(device\)\s*\{[\s\S]*?Number\(d\.width\)[\s\S]*?Number\(d\.height\)/)
assert.match(preview, /const outW = dev\.width/)
assert.match(preview, /const outH = dev\.height/)
assert.doesNotMatch(preview, /shapeType|ctx\.clip\(|ctx\.arc\(/)

const home = read('pages/home/home.js')
const normalizeSource = home.slice(home.indexOf('function normalizeDevice(device)'), home.indexOf('function sceneState(scene)'))
assert.ok(normalizeSource.startsWith('function normalizeDevice(device)'))
const normalizeDevice = vm.runInNewContext(`${normalizeSource}\nnormalizeDevice`, {
  DEFAULT_DEVICE: { id: 'default' },
  activeDevice: { findConnectedDeviceId: () => 'BLE-HANDLE', stableDeviceId: device => device.deviceNo },
  batteryUtil: { normalizeBattery: value => value, batteryText: () => '80%', batteryIconOf: () => 'battery-80.png' }
})
for (const shapeType of [1, 0, undefined]) {
  const device = { id: 'round-device', deviceNo: 'AABBCCDDEE01', shapeType, width: 500, height: 500, rotationDegree: 270, verticalRotation: 0, battery: 80 }
  const before = JSON.stringify(device)
  const normalized = normalizeDevice(device)
  assert.strictEqual(normalized.shapeType, shapeType, '首页轮播切换设备后仍须保留原始形状字段')
  for (const field of ['id', 'width', 'height', 'rotationDegree', 'verticalRotation', 'battery']) {
    assert.strictEqual(normalized[field], device[field], `不得改变已有字段 ${field}`)
  }
  assert.strictEqual(normalized.deviceId, 'BLE-HANDLE')
  assert.strictEqual(normalized.productDeviceId, device.deviceNo)
  assert.strictEqual(normalized.connected, true)
  assert.strictEqual(JSON.stringify(device), before, '不得修改原设备对象')
}
assert.strictEqual(normalizeDevice(null), null)

console.log('projection round screen tests passed')
