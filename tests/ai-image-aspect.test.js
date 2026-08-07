// AI 生成图「右边被裁掉一截」的回归用例（2026-08-06）。
//
// 图片占位用的是 `padding-bottom: 高/宽%` 撑高度的老套路（需求 1.2/5.2：图没加载完先占住高度，
// 加载完不把上面的内容顶飞）。这个套路有一条**硬前提**：
//
//   百分比 padding 是按**父元素宽度**算的，不是按元素自己的宽度。
//
// 所以占位盒必须与父元素同宽（`width: 100%`），宽度要定就定在父元素上。一旦占位盒自己定了个
// 跟父元素不一样的宽（原先 .bubble-imgs 撑满气泡内容区 622rpx、.img-box 定死 510rpx），
// 算出来的高度就是按 622rpx 来的：
//
//   竖图占位高 = 622 × 133.33% = 829rpx，配 510rpx 宽 → 盒子实际比例 162.6%
//   而图片本身是 133.33% → mode="aspectFill" 按高度放大填满，左右各裁掉 56rpx（共 18% 宽）
//
// 表现就是「图片右边没显示完整」。这里锁住：**凡是用 padding-bottom 百分比占位的盒子，
// 宽度必须是 100%**。把宽度改回定值这条用例就红。
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const WXSS = 'subpackages/ai/chat/chat.wxss'
const WXML = 'subpackages/ai/chat/chat.wxml'

// 与 fold-scroll-phantom 同款粗切：去注释后按 `}` 断开。本仓 wxss 没有嵌套规则。
const readRules = file => {
  const text = fs.readFileSync(path.join(root, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  return text
    .split('}')
    .map(chunk => chunk.split('{'))
    .filter(parts => parts.length === 2)
    .map(([selector, body]) => ({ selector: selector.trim(), body: body.trim() }))
}

// 同名属性后面的覆盖前面的（同特异性下按出现顺序），所以取最后一条。
// 选择器可能是分组写法（`.a, .b { … }`），逐个拆开比对。
const declaredProp = (rules, selector, prop) => {
  const matched = rules.filter(rule =>
    rule.selector.split(',').some(one => one.trim() === selector)
  )
  assert.ok(matched.length, `${WXSS} 里找不到规则 ${selector}`)
  let value = null
  matched.forEach(rule => {
    const found = rule.body.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`))
    if (found) {
      value = found[1].trim()
    }
  })
  return value
}

const declaredWidth = (rules, selector) => declaredProp(rules, selector, 'width')

function testPlaceholderBoxMatchesParentWidth() {
  const rules = readRules(WXSS)

  // AI 气泡：宽度定在父级 .bubble-imgs 上，占位盒跟着 100%
  assert.equal(
    declaredWidth(rules, '.bubble-imgs .img-box'),
    '100%',
    '.img-box 必须与父元素同宽，否则 padding-bottom 百分比按父宽算、比例失真会裁图'
  )
  const parentWidth = declaredWidth(rules, '.bubble-imgs')
  assert.ok(
    parentWidth && parentWidth !== '100%',
    '.bubble-imgs 要承担那个定宽（原先定在 .img-box 上），否则图会撑满整个气泡内容区'
  )
  assert.equal(
    declaredProp(rules, '.bubble-imgs', 'max-width'),
    '100%',
    '.bubble-imgs 定宽后要配 max-width:100%，窄屏才不会溢出气泡'
  )

  // 用户发的图气泡：本来就是父子同宽，一并锁住别被改坏
  assert.equal(declaredWidth(rules, '.bubble--image .img-box'), '100%')

  // 生成中的渐变占位盒（2026-08-07）用的是同一套 padding-bottom 占位手法，同样的约束
  assert.equal(
    declaredWidth(rules, '.gen-canvas'),
    '100%',
    '.gen-canvas 也必须与父元素同宽，否则占位比例失真'
  )
  assert.equal(declaredProp(rules, '.gen-canvas-wrap', 'max-width'), '100%')
}

// 占位盒与真图必须**同尺寸同圆角**：100% 时占位盒原地换成真图，尺寸对不上就会跳一下
function testPlaceholderMatchesFinalImageBox() {
  const rules = readRules(WXSS)
  assert.equal(
    declaredWidth(rules, '.gen-canvas-wrap'),
    declaredWidth(rules, '.bubble-imgs'),
    '渐变占位盒与图片容器要同宽，否则 100% 换真图时宽度会跳'
  )
  assert.equal(
    declaredProp(rules, '.gen-canvas', 'border-radius'),
    declaredProp(rules, '.img-box', 'border-radius'),
    '圆角也要一致，否则换图那一下轮廓会变'
  )
}

// wxml 里凡是挂 `padding-bottom: {{…}}%` 的标签，都得是 .img-box —— 否则上面按选择器锁的
// 约束就漏了新的占位盒
function testOnlyImgBoxUsesPercentPadding() {
  const wxml = fs.readFileSync(path.join(root, WXML), 'utf8')
  const tags = wxml.match(/<[a-z-]+[^>]*padding-bottom:[^>]*>/g) || []
  assert.ok(tags.length >= 2, '预期至少有 AI 气泡与用户图气泡两处占位盒')
  tags.forEach(tag => {
    assert.match(
      tag,
      /class="[^"]*(img-box|gen-canvas)/,
      `用 padding-bottom 百分比占位的标签必须是 .img-box 或 .gen-canvas：${tag.slice(0, 60)}…`
    )
    assert.match(tag, /padding-bottom:\s*\{\{[^}]+\}\}%/, '占位比例应由数据驱动')
  })
}

// 生成中不能同时出现「渐变占位」和「真图」，也不能两个都不出现：
// 占位盒挂 item.streaming，真图挂 item.images.length && !item.streaming，两者互斥且接得上
function testPlaceholderAndImageAreMutuallyExclusive() {
  const wxml = fs.readFileSync(path.join(root, WXML), 'utf8')
  assert.match(
    wxml,
    /class="gen-canvas-wrap"/,
    'wxml 里应有渐变占位盒'
  )
  const canvasTag = wxml.match(/<view[^>]*class="gen-canvas-wrap"[^>]*>/)[0]
  assert.match(canvasTag, /wx:if="\{\{item\.streaming\}\}"/, '占位盒只在生成中显示')

  const imgsTag = wxml.match(/<view[^>]*class="bubble-imgs"[^>]*>/)[0]
  assert.match(
    imgsTag,
    /wx:if="\{\{item\.images\.length && !item\.streaming\}\}"/,
    '真图要等 streaming 落下（progress 到 100）才上屏，否则会和占位盒并排出现两块'
  )

  // 占位盒必须排在 .bubble-imgs 前面、正文之后 —— 换图时才是「原地替换」而不是上下跳
  const canvasAt = wxml.indexOf('class="gen-canvas-wrap"')
  const imgsAt = wxml.indexOf('class="bubble-imgs"')
  const textAt = wxml.indexOf('class="bubble-text"')
  assert.ok(canvasAt < imgsAt, '占位盒要排在图片容器之前')
  assert.ok(textAt < canvasAt, '占位盒要排在正文之后，否则 100% 时图会从文字上方跳到下方')
}

// 顺带把「盒子比例 = 图片比例」这条几何关系算一遍，把踩坑时的数算清楚，别再靠脑补
function testGeometryHoldsAtDesignWidth() {
  const DESIGN = 750 // rpx
  const scrollPadding = 40 * 2 // .chat-scroll padding: 0 40rpx
  const bubblePadding = 24 * 2 // .bubble padding: 20rpx 24rpx
  const bubbleContent = DESIGN - scrollPadding - bubblePadding
  assert.equal(bubbleContent, 622)

  const rules = readRules(WXSS)
  const boxWidth = parseFloat(declaredWidth(rules, '.bubble-imgs')) // 510rpx
  const pad = 133.33 // 竖图 1104×1472

  // 修好后：占位盒与父同宽，高度按自己的宽算 → 比例与图片一致，aspectFill 不裁
  const fixedRatio = (boxWidth * (pad / 100)) / boxWidth
  assert.ok(Math.abs(fixedRatio * 100 - pad) < 0.01, '父子同宽时盒子比例必须等于图片比例')

  // 修好前：高度按父宽(622)算、宽度却是 510 → 比例 162.6%，横向要裁掉 18%
  const brokenRatio = (bubbleContent * (pad / 100)) / boxWidth
  assert.ok(brokenRatio * 100 > 160, '旧写法的失真幅度应显著（用来说明这条用例为什么存在）')
  const croppedRatio = 1 - boxWidth / (bubbleContent * (pad / 100) / (pad / 100))
  assert.ok(croppedRatio > 0.17 && croppedRatio < 0.19)
}

testPlaceholderBoxMatchesParentWidth()
testPlaceholderMatchesFinalImageBox()
testOnlyImgBoxUsesPercentPadding()
testPlaceholderAndImageAreMutuallyExclusive()
testGeometryHoldsAtDesignWidth()
console.log('ai image aspect tests passed')
