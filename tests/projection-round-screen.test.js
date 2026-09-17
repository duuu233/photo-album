// 圆屏产品（后台「形状类型 = 圆形」→ `shapeType` 1）的投屏预览（2026-09-17 产品定稿）。
//
// 结论是「**预览裁成圆、导出还是方的**」：设备屏幕是圆的，方框四角那一圈本来就显示不出来，
// 所以预览裁圆才是所见即所得；而帧数据仍按方形矩阵传（四角留白），导出一个字不改。
//
// 全是「改坏了不报错、只有肉眼能看出来」的约束，而且有一条硬要求：
//   ⚠️ **不许动到方形的逻辑**（产品原话：千万别改动到现有方形的逻辑和代码）。
//      所以这里既断言圆形态存在，也断言方形那条路原样保留。
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')

// 去掉注释再断言：注释里为了讲清口径必然还会提到 shapeType、圆形、导出这些词
const readCode = file =>
  read(file)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')

const declaration = (body, prop) => {
  const match = new RegExp(`(?:^|;|\\{)\\s*${prop}\\s*:([^;}]+)`).exec(body)
  return match ? match[1].trim() : null
}

const ruleBody = (file, selector) => {
  const text = readCode(file)
  const match = new RegExp(
    `(?:^|\\}|;)\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`
  ).exec(text)
  assert.ok(match, `${file} 里找不到规则 ${selector}`)
  return match[1]
}

const WXML = 'subpackages/projection/preview/preview.wxml'
const WXSS = 'subpackages/projection/preview/preview.wxss'
const JS = 'subpackages/projection/preview/preview.js'

// ── ① 圆形：展示框与取景框都挂上 is-round ────────────────────────────────────
{
  const wxml = readCode(WXML)

  // 展示层（当前格底图）
  assert.ok(
    /class="photo-wrap \{\{device\.shapeType === 1 \? 'is-round' : ''\}\}"/.test(
      wxml
    ),
    '.photo-wrap 要按 device.shapeType === 1 挂 is-round'
  )
  // 编辑层（取景框，框内即最终成像）
  assert.ok(
    /class="edit-clip \{\{device\.shapeType === 1 \? 'is-round' : ''\}\}/.test(
      wxml
    ),
    '.edit-clip 要按 device.shapeType === 1 挂 is-round'
  )

  // 两处都是整圆（50%），不是「大圆角」
  for (const selector of ['.photo-wrap.is-round', '.edit-clip.is-round']) {
    assert.strictEqual(
      declaration(ruleBody(WXSS, selector), 'border-radius'),
      '50%',
      `${selector} 必须是 border-radius: 50%（整圆），不是大圆角`
    )
  }
}

// ── ② 方形：原来那套一个字都不许变 ──────────────────────────────────────────
{
  // 40rpx 圆角是方形产品的样子，必须还在，且**不是** 50%
  for (const selector of ['.photo-wrap', '.edit-clip']) {
    const radius = declaration(ruleBody(WXSS, selector), 'border-radius')
    assert.strictEqual(
      radius,
      '40rpx',
      `${selector} 方形态的圆角要保持 40rpx（产品：别动方形的逻辑）`
    )
  }

  // is-round 只能出现在「加了 .is-round 的选择器」里，不能有人把 50% 写到裸选择器上
  const wxss = readCode(WXSS)
  const roundRules = wxss.match(/[^}]*border-radius:\s*50%[^}]*/g) || []
  for (const rule of roundRules) {
    assert.ok(
      /is-round/.test(rule),
      `写了 border-radius: 50% 的规则必须带 .is-round，否则方形也变圆了：${rule.trim()}`
    )
  }
}

// ── ③ 导出仍是整张方形画布：圆形不许碰烘焙那一段 ────────────────────────────
{
  const js = readCode(JS)

  // 取景比例仍只看设备分辨率，没有按 shapeType 分叉
  assert.ok(
    /getDeviceCropSize\(device\)\s*\{[\s\S]*?Number\(d\.width\)[\s\S]*?Number\(d\.height\)/.test(
      js
    ),
    'getDeviceCropSize 仍按后端 width/height 取比例'
  )

  // 烘焙出的画布尺寸就是设备物理分辨率，且**没有**任何裁圆动作
  assert.ok(
    /const outW = dev\.width/.test(js) && /const outH = dev\.height/.test(js),
    '_bakeToFile 的画布仍是设备物理分辨率'
  )
  assert.ok(
    !/shapeType/.test(js),
    'preview.js 不该出现 shapeType：圆形只影响预览样式，导出/烘焙一个字不改'
  )
  // 画布上不许出现裁剪路径（clip/arc）——那就是把导出也裁圆了
  assert.ok(
    !/ctx\.clip\(|ctx\.arc\(/.test(js),
    '导出画布不许裁圆（ctx.clip/ctx.arc）：设备收到的必须还是方形矩阵，四角留白'
  )
}

console.log('projection round screen tests passed')
