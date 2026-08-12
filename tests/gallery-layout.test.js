// 官方图库三页的版式回归（2026-08-12 产品三条）。
//
// 全是「改坏了没有任何地方会报错、只有肉眼能看出来」的约束：
//   ① 「我的收藏」入口从「我的」页搬到官方图库分类条右端 —— 两处都留着就是两个入口指同一页；
//   ② 收藏按钮必须**在横滑区外面**：写进 scroll-view 里它就跟着分类一起滑走了，
//      而 .category-scroll 少了 min-width:0 又会被分类撑开、把收藏挤出屏幕（flex 的老坑）；
//   ③ 图片详情去掉「适用设备尺寸」后，让开贴底「开始投屏」的那段 padding-bottom
//      原本挂在 .detail-sizes 上 —— 跟着区块一起删掉的话，简介长一点就会从按钮底下穿过去。
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')

// 去掉注释再断言：注释里为了讲清来龙去脉必然还会提到「我的收藏」「适用设备尺寸」这些词
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
    `(?:^|\\})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`
  ).exec(text)
  assert.ok(match, `${file} 里找不到规则 ${selector}`)
  return match[1]
}

// ── ① 「我的」页不再有收藏入口，官方图库页接手 ──────────────────────────────
{
  const mineWxml = readCode('pages/mine/mine.wxml')
  assert.ok(!/goFavorites/.test(mineWxml), '「我的」页的收藏入口应已移除')
  assert.ok(!/我的收藏/.test(mineWxml), '「我的」页不该再出现「我的收藏」这一行')

  const mineJs = readCode('pages/mine/mine.js')
  assert.ok(
    !/gallery-api/.test(mineJs),
    '收藏数不再展示，getFavoriteCount 那次请求也该一并去掉'
  )

  const listJs = readCode('subpackages/gallery/list/list.js')
  assert.ok(/goFavorites/.test(listJs), '跳转逻辑要搬到官方图库页')
  assert.ok(
    /requireLogin/.test(listJs),
    '收藏是账号数据，入口仍要过登录闸（未登录进去只会是空页）'
  )
}

// ── ② 收藏按钮固定在分类横滑区**外** ───────────────────────────────────────
{
  const listWxml = readCode('subpackages/gallery/list/list.wxml')
  const scrollStart = listWxml.indexOf('<scroll-view class="category-scroll"')
  const scrollEnd = listWxml.indexOf('</scroll-view>', scrollStart)
  assert.ok(scrollStart > -1 && scrollEnd > scrollStart, '分类横滑区还在吗？')

  const insideScroll = listWxml.slice(scrollStart, scrollEnd)
  assert.ok(
    !/category-fav/.test(insideScroll),
    '收藏按钮不能写进 scroll-view：那样它会跟着分类一起被滑走，「固定在右边」就没了'
  )
  assert.ok(
    /category-fav/.test(listWxml.slice(scrollEnd)),
    '收藏按钮应排在横滑区之后，作为分类行的固定右端'
  )
  assert.ok(
    /compact/.test(listWxml),
    '顶部 nav 用紧凑档（产品「太大了」），去掉后本页顶部会重新胖回去'
  )

  const listWxss = 'subpackages/gallery/list/list.wxss'
  const scrollBody = ruleBody(listWxss, '.category-scroll')
  assert.equal(
    declaration(scrollBody, 'min-width'),
    '0',
    '.category-scroll 少了 min-width:0，分类一多就会把收藏按钮挤出屏幕（flex 子项默认按内容撑开）'
  )
  const favBody = ruleBody(listWxss, '.category-fav')
  assert.ok(
    /0\s+0\s+auto/.test(declaration(favBody, 'flex') || ''),
    '.category-fav 必须 flex: 0 0 auto，否则会被分类压扁'
  )
}

// ── ③ 图片详情：没有「适用设备尺寸」，且白卡自己让开贴底按钮 ────────────────
{
  const detailWxml = readCode('subpackages/gallery/detail/detail.wxml')
  assert.ok(!/适用设备尺寸/.test(detailWxml), '「适用设备尺寸」区块应已去掉')
  assert.ok(!/photo\.sizes/.test(detailWxml), '尺寸标签也一并去掉')

  const detailWxss = 'subpackages/gallery/detail/detail.wxss'
  const cardBody = ruleBody(detailWxss, '.detail-card')
  const padding = `${declaration(cardBody, 'padding') || ''};${declaration(cardBody, 'padding-bottom') || ''}`
  assert.ok(
    /var\(--safe-bottom/.test(padding),
    '白卡要留出贴底「开始投屏」的高度（这段原本挂在已删除的 .detail-sizes 上），' +
      '否则简介长一点就会从按钮底下穿过去'
  )

  // 大图与留白必须一起改：图高于留白，白卡的圆角才压在图上
  const vh = (file, selector, prop) => {
    const value = declaration(ruleBody(file, selector), prop) || ''
    const matched = /([0-9.]+)vh/.exec(value)
    assert.ok(matched, `${selector} 的 ${prop} 不再是 vh 了？用例需要同步更新`)
    return Number(matched[1])
  }
  const hero = vh(detailWxss, '.detail-hero', 'height')
  const spacer = vh(detailWxss, '.detail-spacer', 'flex')
  assert.ok(hero > spacer, '大图要比留白高，白卡的圆角才压在图上（设计稿如此）')
  assert.ok(hero >= 55, `大图应放大到至少 55vh（当前 ${hero}vh），产品要「图片尽量多展示」`)
}

console.log('gallery layout tests passed')
