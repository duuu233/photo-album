// 固件升级页版式的产品要求：
//  ① 顶部导航**不给返回箭头**（升级不可逆，页面里不留「随手点一下就走」的入口）（2026-08-13）；
//  ② 百分比进度条下面挂两条升级规则，且**只在进行中这一屏**出现（2026-08-13）；
//  ③ 进度条下面那行协议说明（「传输中：xxx/xxx 字节（x/x 包）」）**屏蔽**，不再上屏（2026-09-02）。
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

// ── ③ 进度条下面那行说明已屏蔽（2026-09-02） ──────────────────────────────
// 只认**活着的**节点：本次改动在 wxml/wxss 里留了说明用的注释（含 `progress-note`、
// `progressText` 字样），先把注释剥掉再断言，否则注释一写用例就红。
const liveWxml = wxml.replace(/<!--[\s\S]*?-->/g, '')
assert.ok(
  liveWxml.indexOf('progress-note') === -1 && liveWxml.indexOf('progressText') === -1,
  '进度条下面不许再渲染那行协议说明（字节数/包序只进日志，不给用户看）'
)
// 百分比与进度条本体必须还在：屏蔽的只是下面那行说明，不是整个进度显示。
assert.ok(
  /class="progress-percent"/.test(liveWxml) && /class="progress-fill"/.test(liveWxml),
  '百分比与进度条要保留：这一屏只剩它们和两条规则在说话'
)

// 页面 JS 也不该再往 data 里塞 progressText（留着就是没人渲染的死数据、白刷 setData），
// 但**必须**继续把它打进阶段日志——真机排查卡在哪一段全靠这条。
const otaJs = fs
  .readFileSync(path.join(__dirname, '..', 'subpackages', 'device', 'ota', 'ota.js'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
assert.ok(
  !/progressText\s*:/.test(otaJs),
  'ota.js 不该再有 progressText 这个 data 字段（没有渲染方）'
)
assert.ok(
  /说明: progressText/.test(otaJs),
  '协议层的说明文案要继续进阶段日志：界面不给看，排查时还得看'
)

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
