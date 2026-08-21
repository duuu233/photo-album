// 图片资源体检（2026-08-21）：小程序包体是硬指标，躺着不用的图片就是白占体积；
// 反过来，引用一张**不存在**的图小程序不会报错，只会安静地渲染成空白（改名漏改就是这么翻车的）。
// 两个方向都在这里钉住，以后加图删图不用再靠人肉扫一遍。
//
// 判定规则：
//   · 只认**代码里活着的引用**（先剥注释）—— 注释里提到不算在用；
//   · 测试文件里的引用不算（用例引用它不等于 App 用它）；
//   · 动态拼路径的目录整体豁免，但**豁免的理由必须还在**（下面会去源码里核对那行拼接还在不在）；
//   · 故意注释保留的图（被注释掉的 UI 块、留着备查的旧素材）走白名单，且要求「注释还在」。
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const IMG_ROOT = path.join(root, 'assets/images')
const SRC_EXT = ['.js', '.wxml', '.wxss', '.json', '.wxs']
const IMG_EXT = /\.(png|jpe?g|svg|gif)$/i

const stripComments = (text, ext) => {
  if (ext === '.wxml') return text.replace(/<!--[\s\S]*?-->/g, '')
  if (ext === '.wxss') return text.replace(/\/\*[\s\S]*?\*\//g, '')
  if (ext === '.js' || ext === '.wxs') {
    return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  }
  return text
}

const walk = (dir, filter) => {
  const out = []
  fs.readdirSync(dir, { withFileTypes: true }).forEach(item => {
    if (['node_modules', '.git', '.codegraph', 'docs', 'assets', 'tests'].includes(item.name)) return
    const full = path.join(dir, item.name)
    if (item.isDirectory()) out.push(...walk(full, filter))
    else if (filter(item.name)) out.push(full)
  })
  return out
}

// ── 代码里活着的引用 ────────────────────────────────────────
const REF_RE = /\/assets\/[A-Za-z0-9_\-./]+\.(?:png|jpe?g|svg|gif)/g
const live = new Set()
walk(root, name => SRC_EXT.includes(path.extname(name))).forEach(file => {
  const code = stripComments(fs.readFileSync(file, 'utf8'), path.extname(file))
  ;(code.match(REF_RE) || []).forEach(ref => live.add(ref))
})

// ① 引用的图必须存在（引用空文件不报错，只会渲染成空白）
const missing = [...live].filter(ref => !fs.existsSync(path.join(root, ref.slice(1))))
assert.deepEqual(missing, [], '这些图被代码引用、但文件不在：小程序不会报错，只会渲染成空白')

// ② 动态拼路径的目录豁免 —— 但**豁免的理由必须还在**
const battery = fs.readFileSync(path.join(root, 'utils/battery.js'), 'utf8')
assert.ok(
  /\/assets\/images\/BatteryLevel\/battery-\$\{/.test(battery),
  'BatteryLevel 整目录是靠 utils/battery.js 里 `battery-${n}.png` 拼出来的才豁免；' +
    '这行拼接没了就该重新核对这个目录，而不是继续无条件放行'
)
const dynamicDirs = ['assets/images/BatteryLevel/']

// ③ 故意留着的图：必须仍被对应文件的注释「认领」，否则说明那段注释已删、图也该跟着删
const parked = [
  ['assets/images/mine-bg-placeholder.jpg', 'pages/mine/mine.wxml', '「我的」页换背景前那张占位图，产品要求留着以便换回去'],
  ['assets/images/set-icon01.png', 'subpackages/settings/index/index.wxml', '被注释掉的「语种设置」入口图标（页面本身还在，只是入口隐藏）'],
  ['assets/images/set-icon05.png', 'subpackages/settings/index/index.wxml', '被注释掉的「更新BoltStar」入口图标（页面本身还在）'],
  ['assets/images/search-icon01.png', 'subpackages/settings/guide/guide.wxml', '被注释掉的帮助搜索框图标']
]
parked.forEach(([file, owner, why]) => {
  assert.ok(fs.existsSync(path.join(root, file)), `${file} 在白名单里却已不存在，请同步删掉白名单（${why}）`)
  assert.ok(
    fs.readFileSync(path.join(root, owner), 'utf8').includes(path.basename(file)),
    `${file} 靠 ${owner} 的注释认领才留着（${why}）；那段注释若已删除，这张图也该删`
  )
})
const parkedFiles = new Set(parked.map(([f]) => f))

// ④ 剩下的一律不许「无人引用」
const unused = []
;(function collect(dir) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach(item => {
    const full = path.join(dir, item.name)
    if (item.isDirectory()) return collect(full)
    if (!IMG_EXT.test(item.name)) return
    const rel = path.relative(root, full).split(path.sep).join('/')
    if (dynamicDirs.some(d => rel.startsWith(d))) return
    if (parkedFiles.has(rel)) return
    if (!live.has('/' + rel)) unused.push(rel)
  })
})(IMG_ROOT)

assert.deepEqual(
  unused,
  [],
  '这些图片没有任何活着的引用，白占小程序包体：要么用起来，要么删掉，' +
    '确实要留就加进上面的 parked 白名单并写明理由'
)

console.log(`unused-assets.test.js 全部通过（扫了 ${live.size} 条引用）`)
