// 绑定设备页「搜到的设备列表 ↔ 贴底立即绑定」的版式回归（2026-08-27 修）。
//
// 版面是「导航以下一屏固定高度 .bind-content + 底部绝对定位的『立即绑定』」，
// 中间的设备列表 .device-list 是唯一会长的一块，靠 max-height 卡住、超出部分自己滚。
// 这条 max-height 曾经有两处漏算：
//   ① 减的是 --status-bar（状态栏）而不是整个导航 --nav-h，少减一个胶囊行 88rpx；
//   ② 完全没减 --safe-bottom（全面屏手势条）。
// 于是设备一多，列表下沿就落到「立即绑定」顶下方（iPhone 13 约 88px）：设备项被按钮压住，
// 而且越出的那截仍在 .bind-content 之内、只是被按钮盖着，scroll-view 自认为放得下全部卡片、
// 连滚都不给滚——用户既看不见也划不动。
//
// 这里不看字符串，直接把 wxss 里的 calc() 按机型**算成 px**，断言「列表下沿不越过按钮顶」。
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const wxss = fs
  .readFileSync(path.join(root, 'subpackages/device/bind/bind.wxss'), 'utf8')
  // 注释里为了讲来龙去脉必然还会写到旧的 --status-bar 算式，先剥掉再断言
  .replace(/\/\*[\s\S]*?\*\//g, '')

const ruleBody = selector => {
  const match = new RegExp(
    `(?:^|\\}|;)\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`
  ).exec(wxss)
  assert.ok(match, `bind.wxss 里找不到规则 ${selector}`)
  return match[1]
}

const declaration = (body, prop) => {
  const match = new RegExp(`(?:^|;|\\{)\\s*${prop}\\s*:([^;}]+)`).exec(body)
  return match ? match[1].trim() : null
}

const content = ruleBody('.bind-content')
const list = ruleBody('.device-list')
const bottom = ruleBody('.bind-bottom')
const button = ruleBody('.primary-action')

// ── ① 列表高度必须减掉「整个导航」和「手势条」，这正是当初漏掉的两项 ──────────
const listMaxHeight = declaration(list, 'max-height')
assert.ok(listMaxHeight, '.device-list 靠 max-height 卡高度，超出部分在 scroll-view 内部滚')
assert.ok(
  /var\(--nav-h/.test(listMaxHeight),
  '.device-list 要减实测导航高度 --nav-h（只减 --status-bar 会少减一个胶囊行 88rpx）'
)
assert.ok(
  /var\(--safe-bottom\)/.test(listMaxHeight),
  '.device-list 要减 --safe-bottom，否则全面屏上列表会伸到手势条区域、压住按钮'
)
// 内边距要算进 max-height 里，不然底部留白等于把盒子又撑高一截
assert.equal(declaration(list, 'box-sizing'), 'border-box')

// ── ② 列表盒子底部要有留白（最后一张卡片的投影 + 不贴着按钮）──────────────
const listPadding = declaration(list, 'padding').split(/\s+/)
assert.equal(listPadding.length, 3, '.device-list 的 padding 写成「上 左右 下」三段')
const listPadBottomRpx = Number(listPadding[2].replace('rpx', ''))
assert.ok(
  listPadBottomRpx >= 16,
  `.device-list 底部留白太小（${listPadding[2]}）：滚到底时最后一张卡片会贴着「立即绑定」`
)

// ── ③ 数值：列表下沿永远在「立即绑定」顶上方 ────────────────────────────────
// 把 calc(...) / var(...) / rpx / vh 按给定机型算成 px
const substituteVars = (expr, vars) => {
  let out = expr
  let guard = 0
  while (out.includes('var(') && guard++ < 20) {
    const start = out.indexOf('var(')
    let depth = 0
    let end = start
    for (; end < out.length; end += 1) {
      if (out[end] === '(') depth += 1
      else if (out[end] === ')' && (depth -= 1) === 0) break
    }
    const inner = out.slice(start + 4, end) // `--nav-h, calc(...)` 或 `--safe-bottom`
    const name = inner.split(',')[0].trim()
    assert.ok(name in vars, `未知的 CSS 变量 ${name}`)
    out = `${out.slice(0, start)}${vars[name]}px${out.slice(end + 1)}`
  }
  return out
}

const toPx = (expr, vp) => {
  const filled = substituteVars(expr, {
    '--nav-h': vp.navHeight,
    '--status-bar': vp.statusBar,
    '--safe-bottom': vp.safeBottom
  })
  const px = filled
    .replace(/calc\(/g, '(')
    .replace(/([\d.]+)rpx/g, (_, n) => `(${n} * ${vp.vw / 750})`)
    .replace(/([\d.]+)vh/g, (_, n) => `(${n} * ${vp.vh / 100})`)
    .replace(/([\d.]+)vw/g, (_, n) => `(${n} * ${vp.vw / 100})`)
    .replace(/([\d.]+)px/g, '$1')
  // eslint-disable-next-line no-new-func
  return Function(`"use strict"; return (${px})`)()
}

// ⚠️ 不含折叠屏展开（宽而矮，1rpx 被放得很大）：那种形态下光是雷达 500rpx + 调试台横幅
// 就几乎吃掉整屏，这条 max-height 算出来是负的（CSS 按 0 处理，列表整个不显示），
// 上面那几块自己就压到按钮上了——本页版式在该形态下的老问题，本次没动，见变更文档「待办」。
const viewports = [
  { name: 'iPhone 13（全面屏）', vw: 390, vh: 844, navHeight: 91, statusBar: 47, safeBottom: 34 },
  { name: '小屏 SE', vw: 320, vh: 568, navHeight: 64, statusBar: 20, safeBottom: 0 },
  { name: '大屏安卓', vw: 412, vh: 915, navHeight: 96, statusBar: 32, safeBottom: 24 }
]

// 列表**上面**那几块的高度：调试台横幅 ≈131 + 雷达 500+40 + 统计行 ≈92 ≈ 763rpx。
// 字体行高在各端有零点几的出入，故按一个区间来卡：
//   · 用上界算列表下沿 —— 上界都不越过按钮，实际更不会；
//   · 用下界算缝隙 —— 下界都留得不多，就说明没白扔可视高度。
const ABOVE_LIST_MAX_RPX = 790
const ABOVE_LIST_MIN_RPX = 740

viewports.forEach(vp => {
  const rpx = vp.vw / 750
  const contentH = toPx(declaration(content, 'height'), vp)
  const listH = toPx(listMaxHeight, vp)
  const buttonH = toPx(declaration(button, 'height'), vp)
  const buttonOffset = toPx(declaration(bottom, 'bottom'), vp)

  const buttonTop = contentH - buttonOffset - buttonH // 「立即绑定」顶，距导航下沿
  const listBottomMax = ABOVE_LIST_MAX_RPX * rpx + listH // 列表下沿（按上界估）

  assert.ok(
    listBottomMax <= buttonTop,
    `${vp.name}：列表下沿 ${listBottomMax.toFixed(1)}px 越过了按钮顶 ${buttonTop.toFixed(1)}px —— 设备项会被「立即绑定」压住，而且压住的那截还滚不出来`
  )
  const gapMax = buttonTop - ABOVE_LIST_MIN_RPX * rpx - listH
  assert.ok(
    gapMax < 60,
    `${vp.name}：列表与按钮之间空了 ${gapMax.toFixed(1)}px，可视高度白扔了`
  )

  // 列表本身还得放得下东西（一张设备卡 ≈190rpx）
  assert.ok(
    listH >= 190 * rpx,
    `${vp.name}：列表只剩 ${(listH / rpx).toFixed(0)}rpx，连一张设备卡（≈190rpx）都放不下`
  )
})

console.log('bind-device-list-layout.test.js 全部通过')
