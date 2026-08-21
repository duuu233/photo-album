// 主按钮底图统一（2026-08-21）：原来用橙色渐变 `linear-gradient(90deg,#ff8338,#ff621f)` 的
// **底部主按钮**，全部改成与图片详情 `.cta-button` 同款的 primary-btn-bg.png 底图。
//
// 这里锁的都是「写错了不报错、只有肉眼能看出来」的点：
//   ① 那几个按钮的样式里不许再有橙色渐变（漏一个就会两种按钮混在一起）；
//   ② 每个按钮节点里必须有 `<image class="cta-button-bg">` —— WXSS 引不了本地图，
//      底图只能是子节点，光改样式不改模板，按钮会变成透明的一块；
//   ③ 每个按钮必须**建立层叠上下文**（position + z-index 非 auto）：底图是 z-index:-1 的子节点，
//      父级不建上下文时它会掉到父级背景之下，整张图直接看不见；
//   ④ 公共类 .cta-button-bg 必须是**百分比**几何，任意尺寸的按钮才通用（原来写死 726×184rpx，
//      只有 654×112rpx 那一种按钮能用）；
//   ⑤ 三处禁用态要把底图藏掉，否则橙色底图盖着灰底，按钮看着还是可点的。
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')
const stripComments = text =>
  text.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')

const ruleBody = (file, selector) => {
  const text = stripComments(read(file))
  const match = new RegExp(
    `(?:^|\\}|;)\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`
  ).exec(text)
  assert.ok(match, `${file} 里找不到规则 ${selector}`)
  return match[1]
}

const ORANGE = /linear-gradient\(\s*90deg\s*,\s*#ff8338\s*,\s*#ff621f\s*\)/i

// 被改造的底部主按钮：样式文件 / 选择器 / 模板文件 / 该模板里应有的按钮数
const BUTTONS = [
  ['subpackages/device/bind/bind.wxss', '.primary-action', 'subpackages/device/bind/bind.wxml', 3],
  ['subpackages/device/ota/ota.wxss', '.ota-primary', 'subpackages/device/ota/ota.wxml', 1],
  ['subpackages/projection/preview/preview.wxss', '.preview-submit', 'subpackages/projection/preview/preview.wxml', 1],
  ['subpackages/projection/result/result.wxss', '.result-primary', 'subpackages/projection/result/result.wxml', 2],
  ['subpackages/settings/shared.wxss', '.primary-btn', 'subpackages/settings/language/language.wxml', 1],
  ['pages/home/home.wxss', '.primary-action', 'pages/home/home.wxml', 3],
  ['components/device-picker-sheet/device-picker-sheet.wxss', '.picker-confirm', 'components/device-picker-sheet/device-picker-sheet.wxml', 1]
]

BUTTONS.forEach(([wxss, selector, wxml, count]) => {
  const body = ruleBody(wxss, selector)

  assert.ok(!ORANGE.test(body), `${wxss} ${selector} 不该再用橙色渐变，底图已改 primary-btn-bg.png`)
  assert.ok(
    !/box-shadow\s*:\s*0\s+18rpx/.test(body),
    `${wxss} ${selector} 的橙色外发光要去掉——发光已经画在底图里，两层叠着会糊出一圈脏边`
  )

  // 层叠上下文：position 非 static 且 z-index 非 auto
  const position = /position\s*:\s*(relative|absolute|fixed)/.exec(body)
  const zIndex = /z-index\s*:\s*(-?\d+)/.exec(body)
  assert.ok(position, `${wxss} ${selector} 需要 position（底图按它定位）`)
  assert.ok(
    zIndex,
    `${wxss} ${selector} 需要 z-index：底图是 z-index:-1 的子节点，父级不建层叠上下文就会掉到背景之下`
  )
  assert.ok(Number(zIndex[1]) >= 0, `${wxss} ${selector} 的 z-index 不能是负数`)

  const nodes = (stripComments(read(wxml)).match(/class="cta-button-bg"/g) || []).length
  assert.equal(
    nodes,
    count,
    `${wxml} 里应有 ${count} 个 <image class="cta-button-bg">（WXSS 引不了本地图，底图只能是子节点）`
  )
})

// 公共底图类：必须是百分比几何，任意尺寸按钮通用
{
  const body = ruleBody('styles/cta-button.wxss', '.cta-button-bg')
  const pct = prop => {
    const m = new RegExp(`${prop}\\s*:\\s*(-?[\\d.]+)%`).exec(body)
    assert.ok(m, `.cta-button-bg 的 ${prop} 必须用百分比（写死 rpx 只有一种尺寸的按钮能用）`)
    return Number(m[1])
  }
  // 底图 726×184，其中胶囊实体 x[36,689] y[30,141] = 654×112
  assert.ok(Math.abs(pct('width') - (726 / 654) * 100) < 0.02, 'width = 726/654')
  assert.ok(Math.abs(pct('height') - (184 / 112) * 100) < 0.02, 'height = 184/112')
  assert.ok(Math.abs(pct('left') + (36 / 654) * 100) < 0.02, 'left = -36/654')
  assert.ok(Math.abs(pct('top') + (30 / 112) * 100) < 0.02, 'top = -30/112')
  assert.ok(/z-index\s*:\s*-1/.test(body), '底图要垫在文案之下')

  // 代入任意按钮尺寸，胶囊实体都应正好铺满按钮盒
  ;[[654, 112], [638, 112], [658, 112], [500, 104], [320, 88]].forEach(([w, h]) => {
    const imgW = w * (726 / 654)
    const imgH = h * (184 / 112)
    const pillW = imgW * (654 / 726)
    const pillH = imgH * (112 / 184)
    const pillLeft = -w * (36 / 654) + imgW * (36 / 726)
    const pillTop = -h * (30 / 112) + imgH * (30 / 184)
    assert.ok(Math.abs(pillW - w) < 0.01 && Math.abs(pillH - h) < 0.01, `${w}×${h} 胶囊尺寸应与按钮一致`)
    assert.ok(Math.abs(pillLeft) < 0.01 && Math.abs(pillTop) < 0.01, `${w}×${h} 胶囊应与按钮左上角对齐`)
  })
}

// 禁用态：底图藏掉，露出灰底
;[
  ['subpackages/projection/preview/preview.wxss', '.preview-submit.is-disabled .cta-button-bg'],
  ['components/device-picker-sheet/device-picker-sheet.wxss', '.picker-confirm--disabled .cta-button-bg'],
  ['subpackages/settings/shared.wxss', '.disabled-btn .cta-button-bg']
].forEach(([file, selector]) => {
  const body = ruleBody(file, selector)
  assert.ok(
    /display\s*:\s*none/.test(body),
    `${file} ${selector} 要 display:none —— 否则橙色底图盖在灰底上，禁用态看着还是可点的`
  )
})

// 自定义组件默认样式隔离，吃不到 app.wxss 的全局 @import，必须自己 import 一次
assert.ok(
  /@import\s+"\.\.\/\.\.\/styles\/cta-button\.wxss"/.test(
    read('components/device-picker-sheet/device-picker-sheet.wxss')
  ),
  'device-picker-sheet 要自己 @import 公共底图样式（组件样式隔离，拿不到 app.wxss 里的）'
)

console.log('primary-button-bg.test.js 全部通过')
