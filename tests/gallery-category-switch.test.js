// 官方图库切分类：切的时候只能有 loading，不能「旧图 + 加载中」同屏（2026-08-13 需求 3）。
//
// 原实现只置 loading=true，瀑布流的数据还是上一分类的 —— 屏上是上一分类的图，
// 底下挂一行「加载中…」，用户点了 A 却在看 B 的图，直到新数据回来才整屏跳变。
//
// 这里锁三件事：
//   ① 切分类的**那一刻**（数据还没回来）列表就必须是空的，且 loading=true；
//   ② 数据回来后一次性出图、loading 关掉；
//   ③ 「返回本页同步收藏态」那次刷新（onShow）**不清屏**：那是背景刷新，
//      把用户正看着的一屏清成「加载中…」再长回来，比不刷新还难受。
const assert = require('node:assert/strict')
const path = require('path')

// 接口整模块打桩：本用例控制「什么时候把数据放回来」
const galleryApiPath = require.resolve('../utils/gallery-api')
let releasePhotos = null
const photoPage = list => ({ list, total: list.length, pageIndex: 1, hasMore: false })
require.cache[galleryApiPath] = {
  id: galleryApiPath,
  filename: galleryApiPath,
  loaded: true,
  exports: {
    getCategories: async () => [],
    getPhotos: () =>
      new Promise(resolve => {
        releasePhotos = resolve
      }),
    getFavoriteIds: async () => [],
    photoHeight: () => 400,
    splitColumns: list => [list.slice(0, 1), list.slice(1)],
    toggleFavorite: async () => true
  }
}

global.wx = new Proxy(
  {},
  {
    get: () => options => {
      if (options && typeof options.fail === 'function') {
        options.fail({})
      }
    }
  }
)
global.getApp = () => ({ requireLogin: () => true })

let pageOptions = null
global.Page = options => {
  pageOptions = options
}
require(path.join('..', 'subpackages', 'gallery', 'list', 'list.js'))

const ctx = Object.create(pageOptions)
ctx.data = Object.assign({}, pageOptions.data, {
  categories: [{ id: '', name: '全部' }, { id: 'c2', name: '风景' }],
  activeCategory: '',
  // 屏上已经有上一分类的图（这正是出问题的前提）
  columns: [[{ id: 'old-1', imgHeight: 400 }], [{ id: 'old-2', imgHeight: 400 }]],
  total: 2,
  loading: false
})
ctx.setData = function (patch) {
  Object.assign(this.data, patch)
}

;(async () => {
  // ── ①② 切分类：先清屏只留 loading，数据回来才出图 ──────────────────────
  // 走真实入口（它会先把 activeCategory 切过去，loadPhotos 回来时要靠它判断「有没有又切走」）
  ctx.onSelectCategory({ currentTarget: { dataset: { id: 'c2' } } })

  assert.deepEqual(
    ctx.data.columns,
    [[], []],
    '切分类的那一刻上一分类的图就必须清掉——留着就是「旧图 + 加载中」同屏'
  )
  assert.equal(ctx.data.total, 0, '计数一起清，否则翻页脚注会先按旧数据出一行')
  assert.equal(ctx.data.loading, true, '这一屏只有「加载中…」')

  assert.ok(releasePhotos, '前置条件：请求已经发出去了')
  releasePhotos(photoPage([{ id: 'new-1', ratio: 0.75 }, { id: 'new-2', ratio: 0.75 }]))
  await new Promise(resolve => setTimeout(resolve, 0))

  assert.equal(ctx.data.loading, false, '数据回来才收掉 loading')
  assert.deepEqual(
    ctx.data.columns.flat().map(item => item.id),
    ['new-1', 'new-2'],
    '出的是新分类的图'
  )

  // ── ③ 返回本页的静默刷新：不清屏、不显示加载中 ───────────────────────
  releasePhotos = null
  const silent = ctx.loadPhotos('c2', { silent: true })

  assert.deepEqual(
    ctx.data.columns.flat().map(item => item.id),
    ['new-1', 'new-2'],
    '背景刷新期间用户正看着的那一屏必须原样留着'
  )
  assert.equal(ctx.data.loading, false, '背景刷新不显示「加载中…」')

  releasePhotos(photoPage([{ id: 'new-1', ratio: 0.75 }]))
  await silent

  console.log('gallery-category-switch.test.js 全部通过')
})().catch(error => {
  console.error(error)
  process.exit(1)
})
