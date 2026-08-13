// 固件升级页版式的两条产品要求（2026-08-13）：
//  ① 顶部导航**不给返回箭头**（升级不可逆，页面里不留「随手点一下就走」的入口）；
//  ② 百分比进度条下面挂两条升级规则，且**只在进行中这一屏**出现。
//
// 这两条都只落在 wxml 上（没有 JS 状态可断言），所以本文件按结构读 wxml 文本来锁：
// 断言点选的是「会真正改变用户所见」的那几处，不是格式细节 —— 缩进/换行怎么调都不该让它红。
//
// ⚠️ 同时锁住反面：底部「返回」按钮必须还在。否则升级成功后用户在页面上找不到任何出口，
// 就从「防误触」变成「把人困住」了。
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const wxml = fs.readFileSync(
  path.join(__dirname, '..', 'subpackages', 'device', 'ota', 'ota.wxml'),
  'utf8'
)

// ── ① 顶部导航不给返回箭头 ────────────────────────────────────────────────
const navTag = wxml.match(/<page-nav[^>]*>/)
assert.ok(navTag, '升级页应有 page-nav')
assert.ok(
  /show-back\s*=\s*"\{\{\s*false\s*\}\}"/.test(navTag[0]),
  'page-nav 必须显式 show-back="{{false}}"：默认值是 true，不传就还有返回箭头'
)

// ── ② 两条规则：文案逐字对齐需求，且挂在进度条**下面** ──────────────────────
const RULES = [
  '1）升级过程请耐心等待升级结果，意外中断可能导致电子纸设备无法使用',
  '2）若升级失败造成设备无法连接，请尝试重新进入小程序\\app或断电重启设备'
]
RULES.forEach(text => {
  assert.ok(wxml.indexOf(text) > -1, `规则文案必须逐字保留：${text}`)
})

const barAt = wxml.indexOf('progress-fill') // 百分比进度条本体
const rulesAt = wxml.indexOf(RULES[0])
assert.ok(barAt > -1 && rulesAt > barAt, '规则要排在进度条下面，不能跑到它上面去')
assert.ok(
  wxml.indexOf(RULES[0]) < wxml.indexOf(RULES[1]),
  '两条规则的先后顺序按需求给的来'
)

// 规则必须落在 `screenStatus === 'progress'` 那个 block 里：进行中之外的画面
// （检查版本/发现新版本/成功/失败）挂着它只会跟结论文案抢注意力。
const progressBlock = wxml.match(
  /<block wx:if="\{\{screenStatus === 'progress'\}\}">([\s\S]*?)<\/block>/
)
assert.ok(progressBlock, "wxml 应有 screenStatus === 'progress' 的 block")
RULES.forEach(text => {
  assert.ok(
    progressBlock[1].indexOf(text) > -1,
    '规则必须写在「进行中」这一屏的 block 内，否则每一屏都会挂着它'
  )
})

// ── 反面：底部「返回」按钮还在，别把用户困在升级页 ──────────────────────────
const actionsAt = wxml.indexOf('ota-actions')
assert.ok(actionsAt > -1, '结果画面的按钮区应保留')
assert.ok(
  wxml.indexOf('ota-secondary') > actionsAt && /bindtap="goBack"/.test(wxml),
  '底部「返回」按钮必须保留：去掉的只是顶部箭头，成功/失败后仍要能离开'
)
assert.ok(
  /wx:if="\{\{screenStatus !== 'progress'\}\}"/.test(wxml),
  '按钮区仍按「非进行中」渲染：升级途中不该出现返回按钮'
)

console.log('ota-screen-rules.test.js 全部通过')
