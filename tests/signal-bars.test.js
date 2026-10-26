// 信号格（2026-10-26，仿 iPhone 信号格）：搜索设备列表、WiFi 列表的信号强弱统一用 4 根竖条显示，
// 满格 4 格、最弱 1 格、未知 0 格全灰；门槛与原文字档位（强 / 正常 / 偏弱 / 弱）同一组，不再显示文字。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const signal = require('../utils/signal')
const root = path.join(__dirname, '..')

assert.deepEqual(
  [-27, -55, -56, -67, -68, -78, -79, -95].map(signal.rssiToLevel),
  [4, 4, 3, 3, 2, 2, 1, 1],
  '≥-55 满格、≥-67 三格、≥-78 两格、更弱一格'
)
assert.deepEqual([0, undefined, null, 5, 'x'].map(signal.rssiToLevel), [0, 0, 0, 0, 0], '未知 / 非法 RSSI 为 0 格（全灰）')

const strip = text => text.replace(/<!--[\s\S]*?-->/g, '')
const bind = strip(fs.readFileSync(path.join(root, 'subpackages/device/bind/bind.wxml'), 'utf8'))
assert.equal((bind.match(/<signal-bars [^>]*level="\{\{item\.signalLevel\}\}"/g) || []).length, 2, '搜索设备列表蓝牙行、WiFi 行都用信号格')
assert.ok(!/signalText/.test(bind), '搜索设备列表不再显示「强 / 弱」文字')
const list = strip(fs.readFileSync(path.join(root, 'subpackages/device/wifi-list/wifi-list.wxml'), 'utf8'))
assert.ok(/<signal-bars [^>]*level="\{\{item\.level\}\}"/.test(list), 'WiFi 列表用同一个信号格组件')
for (const page of ['subpackages/device/bind/bind.json', 'subpackages/device/wifi-list/wifi-list.json']) {
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, page), 'utf8')).usingComponents['signal-bars'], '/components/signal-bars/signal-bars', `${page} 注册信号格组件`)
}
const tpl = fs.readFileSync(path.join(root, 'components/signal-bars/signal-bars.wxml'), 'utf8')
assert.equal((tpl.match(/signal-bars__bar/g) || []).length, 4, '4 根竖条')

console.log('signal-bars: ok')
