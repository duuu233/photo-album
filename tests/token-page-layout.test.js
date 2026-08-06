// Token 管理页的 UI 细节回归用例（2026-08-06）。
//
// 这一页返工过一轮，四处缺陷各自对应一条这里锁住的硬约束，都是「肉眼一看就丑、
// 但代码里看着很正常」的类型，改坏了没有别的地方会报错：
//
//   ① 套餐横滑区右侧比页面其他内容短一截 —— scroll-view 的基础样式带 `width: 100%`，
//      光靠负外边距只能把它整体左移，右边照旧少一块；
//   ② 「总额 / 已消耗」中间的分隔线偏左又偏短 —— 留白只写在右侧、高度还写死；
//   ③ 选中档位（默认 500 Token）的内容比左右两张高半格 —— 选中态角标绝对定位后不再占高；
//   ④ 「购买 & 消费记录」显示成转义串 —— WXML 只有 <text decode> 会还原 HTML 转义符。
//
// ①③ 是布局约束，只能在 wxss/wxml 文本层面锁；④ 顺手做成全仓扫描，别的页面写错也能拦下。
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')

// 把 wxss 拆成 { selector, body }，做法同 tests/fold-scroll-phantom.test.js：
// 先去注释再按 `}` 断开，本仓没有嵌套规则，这个精度够用。
const readRules = file => {
  const text = read(file).replace(/\/\*[\s\S]*?\*\//g, '')
  return text
    .split('}')
    .map(chunk => chunk.split('{'))
    .filter(parts => parts.length === 2)
    .map(([selector, body]) => ({ selector: selector.trim(), body: body.trim() }))
}

// 同一选择器可能分散在多条规则里，判定要合起来看
const bodyOf = (file, selector) => {
  const bodies = readRules(file)
    .filter(item => item.selector.split(',').some(one => one.trim() === selector))
    .map(item => item.body)
  assert.ok(bodies.length, `${file} 里找不到规则 ${selector}`)
  return bodies.join(';')
}

const declaration = (body, prop) => {
  const match = new RegExp(`(?:^|;)\\s*${prop}\\s*:([^;]+)`).exec(body)
  return match ? match[1].trim() : null
}

const INDEX_WXSS = 'subpackages/token/index/index.wxss'
const INDEX_WXML = 'subpackages/token/index/index.wxml'

// ── ① 套餐横滑区必须真的通栏 ────────────────────────────────────────────────
// 页面左右各留 48rpx，横滑区用负外边距挣脱出去。scroll-view 与普通 view 不同，
// 基础样式里带 `width: 100%`：不显式改回 auto，负外边距只是把这 100% 左移，
// 右边永远比页面窄 96rpx（横滑区和其余卡片对不齐，滑到底最后一张还差一截）。
{
  const body = bodyOf(INDEX_WXSS, '.package-scroll')
  const margin = declaration(body, 'margin') || ''
  const hasNegativeMargin = /-\d/.test(margin) ||
    /-\d/.test(declaration(body, 'margin-left') || '') ||
    /-\d/.test(declaration(body, 'margin-right') || '')
  assert.ok(hasNegativeMargin, '.package-scroll 不再用负外边距通栏了？用例需要同步更新')

  const width = declaration(body, 'width')
  assert.ok(
    width && width !== '100%',
    '.package-scroll 用负外边距通栏，就必须显式写 width（auto）：' +
      'scroll-view 基础样式的 width:100% 会让它右侧比页面窄 96rpx，横滑区与其他卡片对不齐。'
  )
}

// 右侧留白靠占位 flex 项：flex 容器的 padding-right 在溢出（可滚动）方向上会被 webview 丢掉，
// 滑到底时最后一张卡会贴死屏幕右缘。
{
  const row = bodyOf(INDEX_WXSS, '.package-row')
  const padding = declaration(row, 'padding') || ''
  assert.ok(
    /padding-left/.test(row) || padding.split(/\s+/).length >= 4,
    '.package-row 需要自己承担左侧留白（横滑区已通栏），否则首张卡片贴死屏幕左缘'
  )
  assert.ok(
    readRules(INDEX_WXSS).some(item => item.selector === '.package-row::after'),
    '.package-row::after 占位项不可删：flex 容器的 padding-right 在溢出方向上会被丢掉，' +
      '滑到底时最后一张卡会贴死屏幕右缘、与页面右侧留白对不齐。'
  )
}

// ── ② 总额 / 已消耗中间那条分隔线：两侧留白相等 ─────────────────────────────
{
  const body = bodyOf(INDEX_WXSS, '.account-stat-split')
  // margin 简写：2/3 值时左右同为第 2 个值，4 值时右 = 第 2、左 = 第 4；也允许写长写法
  const parts = (declaration(body, 'margin') || '').split(/\s+/).filter(Boolean)
  const right = declaration(body, 'margin-right') || parts[1]
  const left = declaration(body, 'margin-left') || (parts.length === 4 ? parts[3] : parts[1])
  assert.ok(
    left && right && left === right && !/^0/.test(left),
    '.account-stat-split 的左右外边距必须相等且非 0，否则分隔线紧贴左列、看着偏心'
  )
  assert.ok(
    /align-self:\s*stretch/.test(body),
    '.account-stat-split 的高度要跟满「标题 + 数字」两行（align-self: stretch），' +
      '写死高度会比两行内容矮一截、上下也不居中'
  )
}

// ── ③ 选中的套餐卡片内容不能比其他档位高半格 ────────────────────────────────
// 选中态角标是 `position: absolute`（贴卡片右上角），脱离文档流就不再占高；
// 卡片又是 justify-content: center，剩下的内容会整体上移。
// 所以角标外面必须常驻一个固定高度的占位行（不带 wx:if，四张卡都渲染）。
{
  const active = bodyOf(INDEX_WXSS, '.package-card--active .package-gift')
  assert.ok(/position:\s*absolute/.test(active), '选中态角标不再绝对定位了？用例需要同步更新')

  const slot = bodyOf(INDEX_WXSS, '.package-gift-slot')
  const height = declaration(slot, 'height')
  assert.ok(
    height && !/^(auto|0)/.test(height),
    '.package-gift-slot 必须写固定高度：选中态角标绝对定位后不占高，' +
      '没有等高占位，选中那张卡的「Token 数 / 价格 / 单价」会比左右两张高半格。'
  )

  const wxml = read(INDEX_WXML)
  const slotTag = /<view class="package-gift-slot"[^>]*>/.exec(wxml)
  assert.ok(slotTag, `${INDEX_WXML} 里找不到 .package-gift-slot 占位行`)
  assert.ok(
    !/wx:(if|else)/.test(slotTag[0]),
    '.package-gift-slot 不能带 wx:if / wx:else：无赠送的档位（200 Token）也要占住这一行，' +
      '否则四张卡的内容不在同一条水平线上。'
  )
}

// ── ④ WXML 文本节点里不许写 HTML 转义符 ─────────────────────────────────────
// WXML 只有 `<text decode="{{true}}">` 会还原转义符，普通 view 会把转义串本身原样显示
// （本页的「购买 & 消费记录」曾经就显示成一串转义码）。属性值里不受影响，先剔除再扫。
{
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).reduce((files, entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      return entry.name === '.git' || entry.name === 'node_modules' ? files : files.concat(walk(full))
    }
    return entry.name.endsWith('.wxml') ? files.concat(full) : files
  }, [])

  const ENTITY = /&(?:[a-zA-Z][a-zA-Z0-9]*|#\d+);/

  walk(root).forEach(file => {
    const textNodes = fs.readFileSync(file, 'utf8')
      .replace(/<!--[\s\S]*?-->/g, '')   // 注释
      .replace(/"[^"]*"/g, '""')         // 属性值（`{{a > b}}` 里的 > 也一并挡掉）
      .replace(/<[^>]*>/g, '\n')         // 标签本身，只留文本节点
    const hit = ENTITY.exec(textNodes)
    assert.ok(
      !hit,
      `${path.relative(root, file)} 的文本节点里出现 HTML 转义符 ${hit && hit[0]}：` +
        'WXML 不会还原它，页面上会原样显示这串字符。直接写字面量，' +
        '确需转义就用 <text decode="{{true}}">。'
    )
  })
}

console.log('token-page-layout: ok')
