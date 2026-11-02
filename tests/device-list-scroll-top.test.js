// 我的设备列表：蓝牙设备点「连接」成功后，连上的设备排到第一张，页面要平滑滚回顶部（2026-11-02）。
// 本页是页面级滚动（不是 scroll-view），所以用 wx.pageScrollTo 且必须带 duration（丝滑动效）。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const source = fs.readFileSync(path.join(__dirname, '../subpackages/device/list/list.js'), 'utf8')

const applyStart = source.indexOf('applyConnectedDevice(device, deviceId, info) {')
assert.ok(applyStart > 0, '连接成功收尾 applyConnectedDevice 仍在')
const applyEnd = source.indexOf('\n  },\n', applyStart)
const applyBody = source.slice(applyStart, applyEnd)
assert.match(applyBody, /this\.scrollListToTop\(\)/, '连接成功后要滚回顶部')
assert.ok(
  applyBody.indexOf('this.scrollListToTop()') > applyBody.indexOf('reorderingDeviceId: String(device.id)'),
  '先完成重排再滚，滚到顶看到的就是刚连上的那张'
)

const scrollStart = source.indexOf('scrollListToTop() {')
assert.ok(scrollStart > 0)
const scrollBody = source.slice(scrollStart, source.indexOf('\n  },\n', scrollStart))
assert.match(scrollBody, /wx\.pageScrollTo\(\{\s*scrollTop:\s*0,\s*duration:\s*[1-9]\d*/, '平滑滚到顶部（带 duration）')

console.log('device-list-scroll-top: ok')
