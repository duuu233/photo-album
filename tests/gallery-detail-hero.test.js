// 图片详情页「大图 ↔ 白卡」的接缝。
//
// 版式是「大图垫在最底层（absolute, top:0），白卡在滚动区里从图的下沿往下接」。
// 两个盒子的**起点不一样**，这是本页最容易踩的坑：
//   · 大图 .detail-hero 是 `position:absolute; top:0`，从**屏幕顶端**起算（沉浸式，图要铺到状态栏）；
//   · 白卡在 .fold-scroll 里，而滚动区是 .fold-viewport 的第二个 flex 子项，从**导航栏下沿**起算。
// 所以留白必须写成 `heroPad vw − navHeight`。曾经两边都只写 heroPad vw，
// 白卡因此整体下沉了一整个导航高度，图片下沿与白卡之间空出一条约 60~70px 的断层（2026-08-21 修）。
//
// 2026-09-01（产品：「下面的文字部分不要挡住图片，让图片完整展示出来，下面适当减少高度」）又加两条：
//   · 白卡**不许压图**：原来的 `− 3vh`（圆角压在图上）去掉，白卡顶 = 图片底，严丝合缝；
//   · 大图**整张要看得全**：高度封顶在 `--hero-max`（一屏 − 底部文字区 − 安全区），
//     配 `mode="aspectFit"`；长图不再有下半截落在屏幕外，且底部永远留得下标题/简介/按钮。
//
// 这里不看字符串，直接把 wxml 的内联表达式与 wxss 的 max-height **算出来**：给定一屏尺寸与图片比例，
// 断言「白卡顶 = 图片底」且「图片底 ≤ 一屏 − 底部文字区」。谁把 navHeight、max-height 或
// aspectFit 改回去，用例立刻红。
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const dir = path.join(root, 'subpackages/gallery/detail')
const wxml = fs.readFileSync(path.join(dir, 'detail.wxml'), 'utf8')
const wxss = fs.readFileSync(path.join(dir, 'detail.wxss'), 'utf8')
const js = fs.readFileSync(path.join(dir, 'detail.js'), 'utf8')

// 导航高度得真从组件测量回来，写死会在不同机型上错位
assert.ok(
  /<page-nav[^>]*bind:measure="onNavMeasure"/.test(wxml),
  'page-nav 要绑 measure，页面才拿得到实测导航高度'
)
assert.ok(/onNavMeasure\(event\)/.test(js), 'detail.js 要实现 onNavMeasure')
assert.ok(/navHeight: NAV_HEIGHT_DEFAULT/.test(js), 'navHeight 要有兜底默认值，免得首帧闪断层')
// 同一个实测值还要以 --nav-h 落到根容器上：.detail-spacer 的 max-height 要用它
assert.ok(
  /--nav-h:\s*\{\{navHeight\}\}px/.test(wxml),
  '根容器要写 `--nav-h: {{navHeight}}px`，否则留白的 max-height 只能吃 64px 兜底'
)
// 封顶后盒子比例不再等于图片比例，aspectFill 会开始裁两边 —— 必须是 aspectFit
assert.ok(
  /class="detail-hero"[\s\S]{0,200}?mode="aspectFit"/.test(wxml),
  '大图必须是 mode="aspectFit"：被 --hero-max 压矮时 aspectFill 会裁掉左右两边'
)

// ---- 取出四条要一起算的表达式 ----
function ruleBody(selector) {
  const matched = wxss.match(new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`))
  assert.ok(matched, `detail.wxss 里找不到 ${selector} 规则`)
  return matched[1]
}
function decl(body, prop) {
  const matched = body.match(new RegExp(`(?:^|;|\\n)\\s*${prop}\\s*:\\s*([^;]+);`))
  assert.ok(matched, `找不到声明 ${prop}`)
  return matched[1].trim()
}

const shell = ruleBody('.detail-shell')
const CARD_MIN = decl(shell, '--detail-card-min') // 底部文字区最少要留的高度
const HERO_MAX = decl(shell, '--hero-max') // 大图高度上限
const heroMaxDecl = decl(ruleBody('.detail-hero'), 'max-height')
const spacerMaxDecl = decl(ruleBody('.detail-spacer'), 'max-height')

const heroInline = wxml.match(/class="detail-hero"[\s\S]*?style="height: ([^"]+)"/)
assert.ok(heroInline, '大图高度是 wxml 内联给的')
const spacerInline = wxml.match(/class="detail-spacer" style="height: ([^"]+)"/)
assert.ok(spacerInline, '.detail-spacer 的高度是 wxml 内联给的')

// ---- 把 CSS 表达式按给定视口算成 px ----
function toPx(expr, ctx) {
  let s = expr
  for (let i = 0; i < 5; i += 1) {
    s = s
      .replace(/var\(--hero-max\)/g, `(${HERO_MAX})`)
      .replace(/var\(--detail-card-min\)/g, `(${CARD_MIN})`)
      .replace(/var\(--safe-bottom,\s*0px\)/g, `${ctx.safeBottom}px`)
      .replace(/var\(--nav-h,\s*64px\)/g, `${ctx.navHeight}px`)
      .replace(/\{\{heroPad\}\}/g, String(ctx.heroPad))
      .replace(/\{\{navHeight\}\}/g, String(ctx.navHeight))
  }
  assert.ok(!/var\(|\{\{/.test(s), `表达式里还有没代入的变量：${s}`)
  const px = s
    .replace(/calc\(/g, '(')
    .replace(/([\d.]+)rpx/g, (_, n) => `(${n} * ${ctx.vw / 750})`) // rpx 必须在 px 之前
    .replace(/([\d.]+)vw/g, (_, n) => `(${n} * ${ctx.vw / 100})`)
    .replace(/([\d.]+)vh/g, (_, n) => `(${n} * ${ctx.vh / 100})`)
    .replace(/([\d.]+)px/g, '$1')
  // eslint-disable-next-line no-new-func
  return Function(`"use strict"; return (${px})`)()
}

// 三种机型 × 四种图片比例都要成立（含一张会被封顶的长图）
const viewports = [
  { name: 'iPhone 13', vw: 390, vh: 844, navHeight: 91, safeBottom: 34 },
  { name: '小屏 SE', vw: 320, vh: 568, navHeight: 64, safeBottom: 0 },
  { name: '大屏安卓', vw: 412, vh: 915, navHeight: 96, safeBottom: 24 }
]
const ratios = [
  { name: '竖图 3:4（兜底比例）', heroPad: 133.33 },
  { name: '横图 16:9', heroPad: 56.25 },
  { name: '方图', heroPad: 100 },
  { name: '长图（钳到上限 240）', heroPad: 240, capped: true }
]

viewports.forEach(vp => {
  ratios.forEach(r => {
    const ctx = Object.assign({}, vp, { heroPad: r.heroPad })
    // 实际生效的高度 = 内联高度被 max-height 压过之后的值
    const heroBottom = Math.min(toPx(heroInline[1], ctx), toPx(heroMaxDecl, ctx))
    const spacer = Math.min(toPx(spacerInline[1], ctx), toPx(spacerMaxDecl, ctx))
    const cardTop = vp.navHeight + spacer // 白卡顶（距屏幕顶端）
    const cardMin = toPx(CARD_MIN, ctx) + vp.safeBottom
    const label = `${vp.name} / ${r.name}`

    assert.ok(
      Math.abs(cardTop - heroBottom) < 0.01,
      `${label}：白卡顶必须正好落在图片下沿（不压图、也不留断层），实际差 ${(cardTop - heroBottom).toFixed(2)}px`
    )
    assert.ok(
      heroBottom <= vp.vh - cardMin + 0.01,
      `${label}：图片下沿越过了「一屏 − 底部文字区」，长图的下半截会永远看不到（实际 ${heroBottom.toFixed(2)}px）`
    )
    assert.ok(
      vp.vh - cardTop >= cardMin - 0.01,
      `${label}：底部文字区只剩 ${(vp.vh - cardTop).toFixed(2)}px，放不下标题+简介+贴底按钮的让位`
    )
    if (r.capped) {
      assert.ok(
        heroBottom < (r.heroPad / 100) * vp.vw - 0.01,
        `${label}：这张图按真实比例算高过一屏，必须被 --hero-max 封顶`
      )
    }
  })
})

console.log('gallery-detail-hero.test.js 全部通过')
