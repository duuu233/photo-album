// 官方图库 / 我的收藏：**重拉列表不许把已经量准的图片比例打回默认占位**（2026-09-04 报障）。
//
// 现象：图库里一张宽 > 高的横图，点进详情再返回，卡片被拉长、图被放大裁切。
// 成因是三件既有设定叠在一起，单看每一条都对：
//   ① 后端列表项不给比例（gallery-api.js 缺口①），首屏一律按 DEFAULT_RATIO＝3:4 **竖图**占位；
//   ② 真实比例靠 `bindload` 量一次补上（onImageLoad）；
//   ③ 从详情页返回要重拉一遍列表对账收藏态（图库页 onShow 静默重拉、收藏页每次 onShow 重拉）。
// ③ 把每张卡的高度按 ① 重算了一遍，而此时屏上 image 的 `src` 没变、**不会再触发 ②**，
// 于是横图永远停在 423rpx 的竖盒子里，`aspectFill` 放大裁切 —— 肉眼就是「图被拉长」。
//
// 这里锁的就是「量准的比例活过重拉」这一条：两个页面各走一遍「首屏占位 → 量准 → 重拉」。
const assert = require('node:assert/strict')
const path = require('path')

global.wx = new Proxy({}, { get: () => () => {} })
global.getApp = () => ({ requireLogin: () => true, globalData: {} })
global.getCurrentPages = () => []

// 用真的 gallery-api：占位高度、真实高度都要按线上那套公式算，写死数字会跟着 DEFAULT_RATIO 一起过期
const galleryApi = require('../utils/gallery-api')
const COLUMN_WIDTH = 317 // 与两个页面里的常量同源（列宽 rpx）

const PLACEHOLDER = galleryApi.photoHeight(0, COLUMN_WIDTH) // 比例未知 → 3:4 竖图占位
const LANDSCAPE = { width: 1600, height: 900 } // 报障里那种「宽度大于高度」的图
const MEASURED = galleryApi.photoHeight(LANDSCAPE.width / LANDSCAPE.height, COLUMN_WIDTH)
assert.ok(MEASURED < PLACEHOLDER, '前置条件：横图量准之后应当比 3:4 的占位矮')

// 后端每次都只给这些（没有 ratio、没有收藏态），所以「重拉」拿回来的是同一份未知比例的数据
const photoPage = () => ({
  list: [{ id: '1', productImgId: 1, title: '横图', url: 'a.png', thumbUrl: 'a.png', ratio: 0, favorited: false }],
  total: 1,
  pageIndex: 1,
  hasMore: false
})
galleryApi.getCategories = async () => [{ id: '', categoryId: 0, name: '全部' }]
galleryApi.getPhotos = async () => photoPage()
galleryApi.getFavorites = async () => photoPage()
galleryApi.getFavoriteIds = async () => []

// 最小页面宿主：只实现两个页面用到的 setData（含 `columns[0][0].imgHeight` 这种路径写法）
function loadPage(file) {
  let options = null
  global.Page = value => {
    options = value
  }
  const full = path.join(__dirname, '..', file)
  delete require.cache[require.resolve(full)]
  require(full)
  const ctx = Object.create(options)
  ctx.data = JSON.parse(JSON.stringify(options.data))
  ctx.setData = function (patch) {
    Object.keys(patch).forEach(key => {
      const hit = /^columns\[(\d+)\]\[(\d+)\]\.(\w+)$/.exec(key)
      if (hit) {
        this.data.columns[Number(hit[1])][Number(hit[2])][hit[3]] = patch[key]
      } else {
        this.data[key] = patch[key]
      }
    })
  }
  return ctx
}

const firstCard = ctx => ctx.data.columns.reduce((found, column) => found || column[0], null)
const measure = ctx =>
  ctx.onImageLoad({
    detail: LANDSCAPE,
    currentTarget: { dataset: { col: ctx.data.columns[0].length ? 0 : 1, index: 0 } }
  })
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

;(async () => {
  // ── 官方图库列表页：进页面 → 图加载完 → 点进详情再返回（onShow 静默重拉） ─────────
  {
    const ctx = loadPage('subpackages/gallery/list/list.js')
    await ctx.loadPhotos('')
    assert.equal(firstCard(ctx).imgHeight, PLACEHOLDER, '首屏比例未知，按 3:4 占位')

    measure(ctx)
    assert.equal(firstCard(ctx).imgHeight, MEASURED, 'bindload 量到真实宽高后要校正成横图高度')

    // 走真实入口：返回本页时 onShow 会按当前分类静默重拉一遍
    ctx.data.categories = [{ id: '', name: '全部' }]
    ctx.onShow()
    await tick()

    assert.equal(
      firstCard(ctx).imgHeight,
      MEASURED,
      '从详情页返回重拉之后，量准的横图高度必须还在（打回 3:4 就是「图被拉长」那个 bug）'
    )
  }

  // ── 我的收藏页：本页 onShow **每次都整页重拉**（取消收藏那张要消失），同样不许丢比例 ──
  {
    const ctx = loadPage('subpackages/gallery/favorites/favorites.js')
    await ctx.loadFavorites()
    assert.equal(firstCard(ctx).imgHeight, PLACEHOLDER, '首屏比例未知，按 3:4 占位')

    measure(ctx)
    assert.equal(firstCard(ctx).imgHeight, MEASURED, 'bindload 量到真实宽高后要校正成横图高度')

    await ctx.loadFavorites()
    assert.equal(
      firstCard(ctx).imgHeight,
      MEASURED,
      '收藏页每次 onShow 都重拉，量准的横图高度同样必须活过这一遭'
    )
  }

  console.log('gallery-return-ratio.test.js 全部通过')
})().catch(error => {
  console.error(error)
  process.exit(1)
})
