// 「内容不够一屏却有滚动条」的回归用例（2026-08-06）。
//
// 折叠屏方案里有一类块：**高度撑满滚动视口**（`min-height: 100%` / `min-height: calc(100vh - 导航)`），
// 用来还原「根容器就是一屏高」的老观感。这类块只要满足「普通块级 + 没有 padding-top / border-top」，
// 首个子元素的 `margin-top` 就会**穿透出去变成它自己的上外边距**（CSS 外边距合并），
// 把整块往下推同样的距离：
//
//   滚动内容高 = 首个子元素的 margin-top + 一屏  >  滚动视口高  → 凭空多出一截可滚动区域
//
// 表现就是「内容明明装得下，却能滑动/出现滚动条」，**与折叠屏无关，所有机型都有**：
// 登录页曾多出 376rpx（约半屏）、更新页 276rpx、设置/语种页 68rpx、首页绑定态 56rpx。
//
// 所以这里锁一条硬约束：**撑满视口的滚动内容块必须自成 BFC**（`display: flow-root` 等）
// 或自带 padding-top，二者有其一即可挡住合并。删掉 `display: flow-root` 这条用例就红。
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')

// 把 wxss 拆成 { selector, body } —— 只做够用的粗切：先去注释，再按 `}` 断开。
// 本仓 wxss 没有嵌套规则和 @media 里再套花括号的写法，这个精度足够。
const readRules = file => {
  const text = fs.readFileSync(path.join(root, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  return text
    .split('}')
    .map(chunk => chunk.split('{'))
    .filter(parts => parts.length === 2)
    .map(([selector, body]) => ({ selector: selector.trim(), body: body.trim() }))
}

const findRule = (file, selector) => {
  const rule = readRules(file).find(item =>
    item.selector.split(',').some(one => one.trim() === selector)
  )
  assert.ok(rule, `${file} 里找不到规则 ${selector}`)
  return rule
}

// 能挡住外边距合并的写法：自成 BFC，或本块自带上内边距/上边框。
// （`display: block` + `padding-top: 0` 是唯一会漏的组合，也正是出过故障的那种。）
const blocksMarginCollapse = body =>
  /display:\s*(flow-root|flex|inline-flex|grid|inline-grid|inline-block|table)\b/.test(body) ||
  /overflow(-y)?:\s*(hidden|auto|scroll|clip)\b/.test(body) ||
  /padding(-top)?:\s*(?!0[^.\d])/.test(body) ||
  /border-top:\s*(?!0[^.\d])/.test(body)

// 撑满滚动视口的内容块清单：新增同类块时补进来。
const viewportFillers = [
  // 公共方案：登录页 / 设置 / 语种 / 忘记密码 / 更新 / 投屏结果页共用
  { file: 'styles/fold-adapt.wxss', selector: '.fold-scroll-body' },
  // 首页两个场景块（在 .home-scroll 里）：.home-content 是 flex，.binding-content 是块级
  { file: 'pages/home/home.wxss', selector: '.home-content' },
  { file: 'pages/home/home.wxss', selector: '.binding-content' }
]

viewportFillers.forEach(({ file, selector }) => {
  const rule = findRule(file, selector)
  // 同一选择器可能分散在多条规则里（首页把 min-height 写在合并选择器上、display 写在单独规则里），
  // 所以判定要把该文件里命中这个选择器的所有规则合起来看。
  const body = readRules(file)
    .filter(item => item.selector.split(',').some(one => one.trim() === selector))
    .map(item => item.body)
    .join(';')

  assert.ok(
    /min-height:/.test(body),
    `${file} ${selector} 不再撑满视口了？清单需要同步更新`
  )
  assert.ok(
    blocksMarginCollapse(body),
    `${file} ${selector} 撑满了视口却挡不住外边距合并：` +
      '首个子元素的 margin-top 会把整块下推，内容装得下也会多出一截滚动条。' +
      '补 `display: flow-root`（或 padding-top）即可，说明见 styles/fold-adapt.wxss'
  )
  assert.ok(rule.selector.length > 0)
})

// 公共方案这条额外锁死：min-height 与 flow-root 缺一不可（前者管撑满，后者管不虚高）。
const foldBody = findRule('styles/fold-adapt.wxss', '.fold-scroll-body').body
assert.ok(/min-height:\s*100%/.test(foldBody), '.fold-scroll-body 必须 min-height: 100%')
assert.ok(
  /display:\s*flow-root/.test(foldBody),
  '.fold-scroll-body 必须 display: flow-root —— 删掉它，所有套壳页面都会凭空多出一截滚动'
)

// 套了 .fold-scroll-body 的页面若首个子元素带 margin-top，正是本用例保护的场景；
// 这里只做一次存在性核对，确保公共类还在被使用（没人用了就该连规则一起删）。
const users = fs
  .readdirSync(path.join(root, 'pages'))
  .map(name => `pages/${name}/${name}.wxml`)
  .concat([
    'subpackages/projection/result/result.wxml',
    'subpackages/settings/index/index.wxml',
    'subpackages/settings/language/language.wxml',
    'subpackages/settings/update/update.wxml',
    'subpackages/settings/forgot-password/forgot-password.wxml'
  ])
  .filter(file => fs.existsSync(path.join(root, file)))
  .filter(file => fs.readFileSync(path.join(root, file), 'utf8').includes('fold-scroll-body'))

assert.ok(users.length >= 5, `.fold-scroll-body 的使用方只剩 ${users.length} 处，清单可能过期`)

console.log(`fold-scroll-phantom: ok（撑满视口的块 ${viewportFillers.length} 个，套壳页面 ${users.length} 个）`)
