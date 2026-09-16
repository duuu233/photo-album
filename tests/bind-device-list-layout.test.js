// 绑定设备页「搜到的设备列表 ↔ 贴底立即绑定」的版式回归。
//
// 版面（2026-09-16 起）：`.bind-content` 是**竖向 flex**，高度 = 导航以下一屏，
// 底部用 `padding-bottom` 替绝对定位的「立即绑定」在流里占位；
// 中间三块——雷达 / 统计行 / 设备列表——按 flex 分高度：
//   · 列表目标高度 = **4.5 张设备卡**（产品要求：最后一张露一半，表示还能滑）；
//   · 一屏装不下时**先压雷达**（`flex-shrink: 8`，列表只有 1），压到 `min-height` 才轮到列表。
//
// 上一版（2026-08-27）是一条经验值 max-height：
//   `calc(100vh - --nav-h - 960rpx - --safe-bottom)`，960rpx 是「上面几块加按钮一共多高」。
// 它的两个老毛病这次一并没了：① 经验值与上方排版脱钩，雷达一改就得跟着调；
// ② 列表只能拿到剩下的高度（iPhone 13 上约 2.2 张），够不到产品要的 4.5 张。
//
// 这里仍然不看字符串对错，而是把 wxss 里的 calc()/var()/rpx/vh 按机型**算成 px**，
// 再跑一遍 flex 收缩，断言最终「列表下沿不越过按钮顶」且「主流机型看得到 4.5 张」。
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const wxss = fs
  .readFileSync(path.join(root, 'subpackages/device/bind/bind.wxss'), 'utf8')
  // 注释里为了讲来龙去脉必然还会写到旧的算式，先剥掉再断言
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

const rpxOf = value => {
  assert.ok(value, '缺少声明')
  const match = /(-?[\d.]+)rpx/.exec(value)
  assert.ok(match, `${value} 不是 rpx 值`)
  return Number(match[1])
}

const content = ruleBody('.bind-content')
const list = ruleBody('.device-list')
const radar = ruleBody('.radar-wrap')
const radarFound = ruleBody('.radar-wrap--found')
const card = ruleBody('.nearby-device')
const bottom = ruleBody('.bind-bottom')
const button = ruleBody('.primary-action')

// ── ① 结构：竖向 flex + 底部替按钮占位 ─────────────────────────────
assert.equal(declaration(content, 'display'), 'flex', '.bind-content 按竖向 flex 排三块')
assert.equal(declaration(content, 'flex-direction'), 'column')
const contentPadBottom = declaration(content, 'padding-bottom')
assert.ok(
  contentPadBottom && /var\(--safe-bottom\)/.test(contentPadBottom),
  '.bind-content 的 padding-bottom 要含 --safe-bottom，否则全面屏上列表会伸进手势条'
)
// 按钮 112 + 贴底 48 + 与列表的缝 ≥16：少给一项，列表就会重新压到按钮底下
assert.ok(
  rpxOf(contentPadBottom) >=
    rpxOf(declaration(button, 'height')) + rpxOf(declaration(bottom, 'bottom')) + 16,
  '.bind-content 的 padding-bottom 至少要容下「按钮高 + 贴底距离 + 一条缝」'
)

// ── ② 列表：封顶 4.5 张 + 允许被压 ───────────────────────────────
const listMaxRpx = rpxOf(declaration(list, 'max-height'))
assert.equal(
  declaration(list, 'height'),
  null,
  '.device-list 用 max-height 封顶而不是写死 height：只搜到一两台时按内容收，不留大片空档'
)
assert.equal(declaration(list, 'box-sizing'), 'border-box')
assert.equal(
  declaration(list, 'min-height'),
  '0',
  'flex 项要 min-height:0 才压得动（默认 auto 压不到内容高以下）'
)
const listFlex = declaration(list, 'flex').split(/\s+/)
assert.equal(listFlex[0], '0', '列表不抢富余高度')
assert.ok(Number(listFlex[1]) > 0, '列表要允许收缩，矮屏上才不会把卡片顶到按钮底下')
// 列表盒子底部要有留白（最后一张卡片的投影 + 滚到底时不贴着按钮）
const listPadding = declaration(list, 'padding').split(/\s+/)
assert.equal(listPadding.length, 3, '.device-list 的 padding 写成「上 左右 下」三段')
assert.ok(
  rpxOf(listPadding[2]) >= 16,
  `.device-list 底部留白太小（${listPadding[2]}）：滚到底时最后一张卡片会贴着「立即绑定」`
)

// 一张卡有多高：按 wxss 里的**实际声明**算，改了卡片样式这里会跟着变
//   卡本体 = 上下 padding + 上下描边 + 设备名一行 + 两行副标题（各带一条上间距）
// 行高各端不同：iOS 苹方 ≈1.4、安卓 ≈1.2，所以按区间算。
const cardPadY = rpxOf(declaration(card, 'padding'))
const cardBorder = rpxOf(declaration(card, 'border'))
const cardGap = rpxOf(declaration(card, 'margin-bottom'))
const nameSize = rpxOf(declaration(ruleBody('.nearby-name'), 'font-size'))
const subBody = ruleBody('.nearby-sub')
const subSize = rpxOf(declaration(subBody, 'font-size'))
const subGap = rpxOf(declaration(subBody, 'margin-top'))
const cardBody = lineHeight =>
  cardPadY * 2 + cardBorder * 2 + nameSize * lineHeight + 2 * (subGap + subSize * lineHeight)
const LINE_HEIGHTS = [
  { name: '安卓（行高≈1.2）', lh: 1.2 },
  { name: 'iOS 苹方（行高≈1.4）', lh: 1.4 }
]
// 可见张数：整张按「卡本体 + 间距」占位，露出的那张只算它露出来的比例
const visibleCards = (heightRpx, lh) => {
  const body = cardBody(lh)
  const pitch = body + cardGap
  let rest = heightRpx
  let shown = 0
  while (rest >= pitch) {
    rest -= pitch
    shown += 1
  }
  return shown + Math.min(1, Math.max(0, rest / body))
}
LINE_HEIGHTS.forEach(({ name, lh }) => {
  const shown = visibleCards(listMaxRpx, lh)
  assert.ok(
    shown >= 4.2 && shown <= 4.9,
    `${name}：max-height ${listMaxRpx}rpx 只够 ${shown.toFixed(2)} 张，产品要的是「4 张整 + 露半张」`
  )
})

// ── ③ 雷达：已发现态让位，且先于列表被压 ──────────────────────────
const radarShrink = Number(declaration(radar, 'flex').split(/\s+/)[1])
assert.ok(
  radarShrink > Number(listFlex[1]),
  '雷达的 flex-shrink 必须大于列表的：矮屏上要先压雷达，不能反过来切设备卡'
)
assert.ok(
  rpxOf(declaration(radarFound, 'height')) < rpxOf(declaration(radar, 'height')),
  '.radar-wrap--found 要比默认态矮：让出来的高度正是列表从 2 张多长到 4.5 张的那一截'
)
const radarMinRpx = rpxOf(declaration(radarFound, 'min-height'))

// 已发现态那个类要真的挂上去，否则样式写了也用不上
const wxml = fs.readFileSync(
  path.join(root, 'subpackages/device/bind/bind.wxml'),
  'utf8'
).replace(/<!--[\s\S]*?-->/g, '')
assert.ok(
  /class="radar-wrap \{\{devices\.length \? 'radar-wrap--found' : ''\}\}"/.test(wxml),
  '雷达缩小要按 devices.length 挂 radar-wrap--found，与设备列表的渲染条件保持一致'
)

// ── ④ 按机型跑一遍 flex 收缩 ──────────────────────────────────────
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

// flex 收缩：不够分时按「flex-shrink × flex-basis」摊，碰到 min-height 就冻结，
// 剩下的收缩量重新分给没冻结的项（与浏览器的 freeze-重算循环同构）。
const resolveFlex = (items, avail) => {
  const size = new Map(items.map(item => [item.name, item.basis]))
  const frozen = new Set(items.filter(item => !item.shrink).map(item => item.name))
  for (let pass = 0; pass < 20; pass += 1) {
    const total = [...size.values()].reduce((a, b) => a + b, 0)
    const overflow = total - avail
    if (overflow <= 0.001) break
    const flexible = items.filter(item => !frozen.has(item.name))
    const weight = flexible.reduce((sum, item) => sum + item.shrink * item.basis, 0)
    if (!weight) break
    let violated = false
    flexible.forEach(item => {
      const next = size.get(item.name) - (overflow * item.shrink * item.basis) / weight
      if (next < item.min) {
        size.set(item.name, item.min)
        frozen.add(item.name)
        violated = true
      } else {
        size.set(item.name, next)
      }
    })
    if (!violated) break
  }
  return size
}

// ⚠️ 折叠屏展开（宽而矮，1rpx 被放得很大）仍不在这张表里：那种形态下光是雷达加调试台横幅
// 就几乎吃满一屏，本页会退化成「雷达很小 + 列表很矮」。这一版至少不会再把卡片塞到按钮底下
// （padding-bottom 是硬预留），但版式仍然挤，见变更文档「待办」。
const viewports = [
  { name: 'iPhone 13（全面屏）', vw: 390, vh: 844, navHeight: 91, statusBar: 47, safeBottom: 34, wantCards: 4.2 },
  { name: '小屏 SE', vw: 320, vh: 568, navHeight: 64, statusBar: 20, safeBottom: 0, wantCards: 3 },
  { name: '大屏安卓', vw: 412, vh: 915, navHeight: 96, statusBar: 32, safeBottom: 24, wantCards: 4.2 }
]

// 统计行整行高度 ≈ 文案行高 + 上下 margin；调试台横幅只在开发版渲染（正式版整块不在）。
const HEAD_RPX = 87
const DEBUG_ENTRY_RPX = 124

viewports.forEach(vp => {
  const rpx = vp.vw / 750
  const contentH = toPx(declaration(content, 'height'), vp)
  const avail = contentH - toPx(contentPadBottom, vp)
  const buttonTop =
    contentH - toPx(declaration(bottom, 'bottom'), vp) - toPx(declaration(button, 'height'), vp)

  ;[false, true].forEach(withDebugEntry => {
    const label = `${vp.name}${withDebugEntry ? '（开发版，带调试台横幅）' : ''}`
    const radarMarginTop = rpxOf(declaration(radarFound, 'margin-top')) * rpx
    const fixed = (withDebugEntry ? DEBUG_ENTRY_RPX * rpx : 0) + HEAD_RPX * rpx + radarMarginTop
    const items = [
      { name: 'fixed', basis: fixed, shrink: 0, min: fixed },
      {
        name: 'radar',
        basis: rpxOf(declaration(radarFound, 'height')) * rpx,
        shrink: radarShrink,
        min: radarMinRpx * rpx
      },
      { name: 'list', basis: listMaxRpx * rpx, shrink: Number(listFlex[1]), min: 0 }
    ]
    const size = resolveFlex(items, avail)
    const used = [...size.values()].reduce((a, b) => a + b, 0)

    // 列表下沿 = 上面几块 + 列表高度，永远要落在按钮顶上方（padding-bottom 是硬预留）
    assert.ok(
      used <= avail + 0.5 && used <= buttonTop + 0.5,
      `${label}：三块共 ${used.toFixed(1)}px，越过了按钮顶 ${buttonTop.toFixed(1)}px`
    )
    // 雷达不许被压过头（压没了就只剩一片空白，看不出是「找到设备了」）
    assert.ok(
      size.get('radar') >= radarMinRpx * rpx - 0.5,
      `${label}：雷达被压到 ${(size.get('radar') / rpx).toFixed(0)}rpx，低于 min-height`
    )
    // 正式版要给到 4.5 张；开发版的调试台横幅会吃掉约一张的高度，只要求别退回改版前的 2 张多
    const listRpx = size.get('list') / rpx
    const shown = Math.min(...LINE_HEIGHTS.map(({ lh }) => visibleCards(listRpx, lh)))
    const want = withDebugEntry ? Math.min(vp.wantCards, 3.2) : vp.wantCards
    assert.ok(
      shown >= want,
      `${label}：列表只剩 ${listRpx.toFixed(0)}rpx ≈ ${shown.toFixed(2)} 张，低于预期的 ${want} 张`
    )
  })
})

console.log('bind-device-list-layout.test.js 全部通过')
