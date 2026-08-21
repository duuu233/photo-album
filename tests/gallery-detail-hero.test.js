// 图片详情页「大图 ↔ 白卡」的接缝（2026-08-21 修）。
//
// 版式是「大图垫在最底层，白卡从图的下沿往上盖 3vh」。两个盒子的**起点不一样**，这是本页最容易踩的坑：
//   · 大图 .detail-hero 是 `position:absolute; top:0`，从**屏幕顶端**起算（沉浸式，图要铺到状态栏）；
//   · 白卡在 .fold-scroll 里，而滚动区是 .fold-viewport 的第二个 flex 子项，从**导航栏下沿**起算。
// 所以留白必须写成 `heroPad vw − navHeight − 3vh`。曾经两边都只写 heroPad vw，
// 白卡因此整体下沉了一整个导航高度，图片下沿与白卡之间空出一条约 60~70px 的断层。
//
// 这里不看字符串，直接把 wxml 里那条内联表达式**算出来**：给定一屏尺寸与图片比例，
// 断言「白卡顶 = 图片底 − 3vh」，谁再把 navHeight 那项删掉都会红。
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const wxml = fs.readFileSync(
  path.join(root, 'subpackages/gallery/detail/detail.wxml'),
  'utf8'
)
const js = fs.readFileSync(
  path.join(root, 'subpackages/gallery/detail/detail.js'),
  'utf8'
)

// 导航高度得真从组件测量回来，写死会在不同机型上错位
assert.ok(
  /<page-nav[^>]*bind:measure="onNavMeasure"/.test(wxml),
  'page-nav 要绑 measure，页面才拿得到实测导航高度'
)
assert.ok(/onNavMeasure\(event\)/.test(js), 'detail.js 要实现 onNavMeasure')
assert.ok(/navHeight: NAV_HEIGHT_DEFAULT/.test(js), 'navHeight 要有兜底默认值，免得首帧闪断层')

const matched = wxml.match(/class="detail-spacer" style="height: calc\(([^"]+)\)"/)
assert.ok(matched, '.detail-spacer 的高度是 wxml 内联 calc(...) 给的')

// 把 `{{heroPad}}vw - {{navHeight}}px - 3vh` 按给定视口算成 px
function evalHeight(expr, { heroPad, navHeight, vw, vh }) {
  const filled = expr
    .replace(/\{\{heroPad\}\}/g, String(heroPad))
    .replace(/\{\{navHeight\}\}/g, String(navHeight))
  const px = filled
    .replace(/([\d.]+)vw/g, (_, n) => `(${n} * ${vw / 100})`)
    .replace(/([\d.]+)vh/g, (_, n) => `(${n} * ${vh / 100})`)
    .replace(/([\d.]+)px/g, '$1')
  // eslint-disable-next-line no-new-func
  return Function(`"use strict"; return (${px})`)()
}

// 三种机型 × 三种图片比例都要成立
const viewports = [
  { name: 'iPhone 13', vw: 390, vh: 844, navHeight: 91 },
  { name: '小屏 SE', vw: 320, vh: 568, navHeight: 64 },
  { name: '大屏安卓', vw: 412, vh: 915, navHeight: 96 }
]
const ratios = [
  { name: '竖图 3:4（兜底比例）', heroPad: 133.33 },
  { name: '横图 16:9', heroPad: 56.25 },
  { name: '方图', heroPad: 100 }
]

viewports.forEach(vp => {
  ratios.forEach(r => {
    const spacer = evalHeight(matched[1], {
      heroPad: r.heroPad,
      navHeight: vp.navHeight,
      vw: vp.vw,
      vh: vp.vh
    })
    const cardTop = vp.navHeight + spacer // 白卡顶（距屏幕顶端）
    const heroBottom = (r.heroPad / 100) * vp.vw // 图片底（距屏幕顶端）
    const overlap = heroBottom - cardTop // 白卡压在图上的量
    assert.ok(
      Math.abs(overlap - 0.03 * vp.vh) < 0.01,
      `${vp.name} / ${r.name}：白卡应当正好压在图片下沿上方 3vh，实际 ${overlap.toFixed(2)}px`
    )
    assert.ok(
      overlap > 0,
      `${vp.name} / ${r.name}：白卡顶不能落在图片下沿之下——那就是产品看到的空白断层`
    )
  })
})

console.log('gallery-detail-hero.test.js 全部通过')
