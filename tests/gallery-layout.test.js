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
  // 规则前面可能是上一条规则的 `}`、文件开头，或 `@import "…";` 的分号
  const match = new RegExp(
    `(?:^|\\}|;)\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`
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
  // 产品明确要求「和收藏模块在样式上做一点点区分，不要一样」：收藏入口不能再是分类那种胶囊
  assert.ok(
    !declaration(favBody, 'border-radius'),
    '.category-fav 不该再画成胶囊——和分类长一样，用户会当成「最后一个分类」'
  )
  assert.ok(
    declaration(favBody, 'border-left'),
    '.category-fav 用竖分隔线与分类分家（形状/底色/颜色三处都不同才分得开）'
  )

  // 分类条上下要留出间距（需求 3）：收紧的是导航栏，不是这一条
  const barBody = ruleBody(listWxss, '.category-bar')
  const margin = declaration(barBody, 'margin') || ''
  const top = Number((/^\s*(\d+)rpx/.exec(margin) || [])[1])
  assert.ok(top >= 16, `.category-bar 上外边距 ${top}rpx 太小，产品要求「上下再多一点间距」`)
}

// ── ④ 图库列表卡片右上角的红心：按收藏态变化，且**不重拉列表** ─────────────
{
  const listWxml = readCode('subpackages/gallery/list/list.wxml')
  assert.ok(/photo-fav/.test(listWxml), '列表卡片右上角要有收藏角标')
  assert.ok(
    /photo\.favorited\s*\?/.test(listWxml),
    '角标图必须跟着 favorited 走（实心/描边两态），否则点了没反应'
  )
  assert.ok(
    /catchtap="onToggleFavorite"/.test(listWxml),
    '角标要用 catchtap：bindtap 会冒泡到卡片上，点收藏会连带进详情页'
  )
  assert.ok(
    /data-col=/.test(listWxml) && /data-index=/.test(listWxml),
    '要带上列号与下标，才能只改这一张的状态（见下条：不能重拉）'
  )

  const listJs = readCode('subpackages/gallery/list/list.js')
  const toggle = listJs.slice(listJs.indexOf('onToggleFavorite'))
  const body = toggle.slice(0, toggle.indexOf('goDetail'))
  assert.ok(
    !/loadPhotos/.test(body),
    '收藏后不能重拉列表：瀑布流会按新数据重排，用户正在看的卡片被挪走' +
      '（「我的收藏」页要重拉是因为那张图得消失，两页诉求不同）'
  )
  assert.ok(
    /columns\[/.test(body),
    '应按 data-col/data-index 原地改 favorited'
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

  // 顶部大图不许裁图（2026-08-13 需求 4）：高度不再写死，按图片真实比例算。
  // 写死高度 + aspectFill 就是「两个比例对不上 → 放大填满 → 裁掉多出来的」，正是要治的毛病。
  assert.ok(
    !declaration(ruleBody(detailWxss, '.detail-hero'), 'height'),
    '.detail-hero 不该再有写死的 height：高度要跟着图片真实比例走（内联 {{heroPad}}vw）'
  )
  const heroTag = /<image[^>]*class="detail-hero"[\s\S]*?><\/image>/.exec(detailWxml)
  assert.ok(heroTag, '详情页应有 .detail-hero 大图')
  assert.ok(
    /style="height:\s*\{\{heroPad\}\}vw"/.test(heroTag[0]),
    '大图高度由 heroPad（高/宽×100）给：盒子比例＝图片比例，才裁不掉东西'
  )
  assert.ok(
    /bindload="onHeroLoad"/.test(heroTag[0]),
    '必须 bindload 校正比例——后端列表/详情都不下发图片宽高，只有这里拿得到真实尺寸'
  )
  // 2026-09-01「整张图要看得全」：高度封顶在 --hero-max（一屏 − 底部文字区），
  // 盒子被压矮后比例不再等于图片比例，aspectFill 会开始裁两边，所以必须是 aspectFit。
  assert.ok(
    /mode="aspectFit"/.test(heroTag[0]),
    '大图必须 mode="aspectFit"：被 --hero-max 压矮时 aspectFill 会裁掉左右两边'
  )
  assert.ok(
    /max-height:\s*var\(--hero-max\)/.test(ruleBody(detailWxss, '.detail-hero')),
    '.detail-hero 要封顶在 --hero-max，否则长图的下半截永远落在屏幕外（大图 absolute 不跟着滚）'
  )

  // 大图与留白必须同源。
  // ⚠️ 2026-08-21 起表达式要减一个 navHeight：大图是 absolute、从屏幕顶端起算，
  // 而留白在滚动区里、从导航栏下沿起算，不减这一段白卡会整体下沉、露出一条断层。
  // ⚠️ 2026-09-01 起**只剩这两项**：原来的第三项 `− 3vh`（白卡圆角压在图上）按产品
  // 「下面的文字不要挡住图片」去掉，白卡顶＝图片底。
  // 几何本身由 tests/gallery-detail-hero.test.js 按真实机型算数验证。
  const spacerTag = /<view class="detail-spacer"[^>]*>/.exec(detailWxml)
  assert.ok(spacerTag, '详情页应有 .detail-spacer')
  assert.ok(
    /style="height: calc\(\{\{heroPad\}\}vw\s*-\s*\{\{navHeight\}\}px\)"/.test(spacerTag[0]),
    '留白必须用与大图**同一个** heroPad 算，减去实测 navHeight（两个盒子起点差一个导航高度）后到此为止——'
      + '再减任何一项都会重新压住图片下沿'
  )
  assert.ok(
    /max-height:\s*calc\(var\(--hero-max\)\s*-\s*var\(--nav-h/.test(
      ruleBody(detailWxss, '.detail-spacer')
    ),
    '留白要与大图同源封顶：长图被 --hero-max 压矮了、留白没跟着压，断层立刻回来'
  )

  const detailJs = readCode('subpackages/gallery/detail/detail.js')
  assert.ok(
    /onHeroLoad\(event\)/.test(detailJs) && /HERO_PAD_MIN|HERO_PAD_MAX/.test(detailJs),
    'onHeroLoad 要按真实宽高算 heroPad 并钳住极端比例'
  )
}

console.log('gallery layout tests passed')
