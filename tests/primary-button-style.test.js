// 主按钮观感统一（2026-08-21 定案）：全站主按钮都用同一套**橙色渐变**
// `linear-gradient(90deg, #ff8338, #ff621f)` + 橙色外发光，**不再有任何按钮用底图**。
//
// 这一版是当天翻过一次的结论：先按「统一成 primary-btn-bg.png 底图」改过一轮，产品随后改口，
// 于是连图片详情 / Token 两页原本就用底图的 `.cta-button` 也一并改成渐变，底图整张删掉。
// 会踩的坑都在「改坏了不报错、只有肉眼能看出来」这一类：
//   ① 漏一个按钮 → 两种观感混在一起；
//   ② 模板里还留着 `<image class="cta-button-bg">` → 引用一张已删除的图，渲染成空白方块；
//   ③ 渐变数值写歪（角度/色值）→ 与别处差一点点，截图对比才看得出来。
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')
const stripComments = text =>
  text.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')

// 把「选择器列表里出现过这个类」的规则**全部**并起来看：
// 圆角这类声明常写在合并规则里（如 `.ota-primary, .ota-secondary { border-radius: 999rpx }`），
// 只认独占那一条会误判成「没设圆角」。
const declarationsFor = (file, selector) => {
  const text = stripComments(read(file))
  const bodies = []
  const rules = text.match(/[^{}]+\{[^}]*\}/g) || []
  rules.forEach(rule => {
    const [head, body] = [rule.slice(0, rule.indexOf('{')), rule.slice(rule.indexOf('{') + 1, -1)]
    const hit = head
      .split(',')
      .map(part => part.trim())
      .some(part => part === selector || part.endsWith(' ' + selector) || part.startsWith(selector))
    if (hit) bodies.push(body)
  })
  assert.ok(bodies.length, `${file} 里找不到规则 ${selector}`)
  return bodies.join('\n')
}

const ORANGE = /linear-gradient\(\s*90deg\s*,\s*#ff8338\s*,\s*#ff621f\s*\)/i

// 全站主按钮：样式文件 / 选择器 / 说明
const BUTTONS = [
  ['styles/cta-button.wxss', '.cta-button', '贴底主按钮（图片详情 / Token 管理 / 确认购买共用）'],
  ['subpackages/settings/shared.wxss', '.primary-btn', '设置类共用主按钮'],
  ['pages/home/home.wxss', '.primary-action', '首页弹层与绑定流程贴底按钮'],
  ['subpackages/device/bind/bind.wxss', '.primary-action', '搜索设备页贴底按钮'],
  ['subpackages/device/ota/ota.wxss', '.ota-primary', '固件升级主按钮'],
  ['subpackages/projection/preview/preview.wxss', '.preview-submit', '投屏预览「开始投屏」'],
  ['subpackages/projection/result/result.wxss', '.result-primary', '投屏结果主按钮'],
  ['components/device-picker-sheet/device-picker-sheet.wxss', '.picker-confirm', '「选择投屏设备」弹层主按钮']
]

BUTTONS.forEach(([wxss, selector, label]) => {
  const body = declarationsFor(wxss, selector)
  assert.ok(
    ORANGE.test(body),
    `${label}（${wxss} ${selector}）要用统一的橙色渐变 linear-gradient(90deg,#ff8338,#ff621f)`
  )
  assert.ok(
    /box-shadow\s*:\s*0\s+18rpx\s+36rpx\s+rgba\(255,\s*98,\s*31/.test(body),
    `${label} 的橙色外发光要在（渐变按钮靠它把按钮从背景里托起来）`
  )
  assert.ok(
    /border-radius\s*:\s*999rpx/.test(body),
    `${label} 是全圆角胶囊`
  )
})

// 全站不许再有底图的痕迹：模板里的节点、样式里活着的类、以及图片文件本身
{
  const walk = dir => {
    const out = []
    fs.readdirSync(dir, { withFileTypes: true }).forEach(item => {
      if (['node_modules', '.git', '.codegraph', 'docs', 'assets', 'tests'].includes(item.name)) return
      const full = path.join(dir, item.name)
      if (item.isDirectory()) out.push(...walk(full))
      else if (/\.(wxml|wxss|js)$/.test(item.name)) out.push(full)
    })
    return out
  }
  const offenders = walk(root).filter(file =>
    stripComments(fs.readFileSync(file, 'utf8')).includes('cta-button-bg') ||
    stripComments(fs.readFileSync(file, 'utf8')).includes('primary-btn-bg.png')
  )
  assert.deepEqual(
    offenders.map(f => path.relative(root, f)),
    [],
    '底图方案已下线：模板/样式里不许还有活着的 cta-button-bg 或 primary-btn-bg.png（图片文件已删，留着就是渲染空白）'
  )
  assert.ok(
    !fs.existsSync(path.join(root, 'assets/images/primary-btn-bg.png')),
    'primary-btn-bg.png 已无人引用，应随「清理未引用图片」删除（122KB，是原来最大的一张图）'
  )
  // 回滚依据要留着：改回底图时照着这段注释恢复
  assert.ok(
    read('styles/cta-button.wxss').includes('primary-btn-bg.png'),
    'styles/cta-button.wxss 要把底图方案的做法与几何留在注释里，否则要换回去就得重新推一遍'
  )
}

console.log('primary-button-style.test.js 全部通过')
