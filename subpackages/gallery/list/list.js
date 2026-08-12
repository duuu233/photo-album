// 官方图库（设计稿：assets/ai/UI页面/官方图库.png）
//
// 2026-08-12：数据由本地 mock 切到真实后端（`/Client/Product/*`，见 utils/gallery-api.js 顶部）。
// 随之而来的三件事，都是「接口只给了这些」逼出来的，不是设计选择：
//   ① 列表**分页**了（后端默认 10 条/页），本页改为滚到底续拉；
//   ② 列表项**没有图片比例**，先按 DEFAULT_RATIO 占位、图片 bindload 后按真实宽高校正那一张；
//   ③ 列表项**没有收藏态**，另拉一页收藏列表在端上标记（拉不到就一律描边心）。
// ②③ 是后端缺口，补齐后端上这两段兜底即可删，详见 gallery-api.js 文件头。
const fold = require('../../../utils/fold-adapt')
const galleryApi = require('../../../utils/gallery-api')
const toast = require('../../../utils/toast')

const app = getApp()

// 瀑布流单列宽度（rpx）：(750 − 48×2 页面留白 − 20 列间距) ÷ 2。
// 与 subpackages/gallery/shared.wxss 的 .waterfall 布局一一对应，改一处要同时改另一处。
const COLUMN_WIDTH = 317

Page(fold.adapt({
  data: {
    categories: [],
    activeCategory: '',
    columns: [[], []],
    total: 0,
    loading: true,
    // 上拉续页（后端分页，见文件头）
    loadingMore: false,
    hasMore: false
  },

  onLoad() {
    this.loadCategories()
  },

  onShow() {
    if (wx.hideTabBar) {
      wx.hideTabBar({ animation: false })
    }
    // 从详情页/收藏页返回时收藏态可能变了，重进本页按当前分类重拉第一页。
    // 分类还没拉到（首次 onLoad 与 onShow 挨着触发）时不动，交给 loadCategories 起头。
    if (this.data.categories.length) {
      this.loadPhotos(this.data.activeCategory)
    }
  },

  async loadCategories() {
    try {
      const categories = await galleryApi.getCategories()
      // 首项是端上补的「全部」（id 为空串），所以这里不能用 `if (first)` 判空
      const first = categories.length ? categories[0].id : ''
      this.setData({ categories, activeCategory: first })
      this.loadPhotos(first)
    } catch (error) {
      this.setData({ categories: [], loading: false })
    }
  },

  onSelectCategory(event) {
    // ⚠️「全部」那一项的 id 是**空串**，取值要防着 undefined：直接 String(undefined)
    // 会得到 'undefined'，与任何分类都对不上，点它就成了死键
    const raw = event.currentTarget.dataset.id
    const id = raw === undefined || raw === null ? '' : String(raw)
    if (id !== this.data.activeCategory) {
      this.setData({ activeCategory: id })
      this.loadPhotos(id)
    }
  },

  /**
   * 拉某个分类的第一页。切分类、进页面、从详情返回都走这里。
   * 收藏态与图片一起并行取（见文件头缺口③），慢的那个决定这一屏什么时候出。
   */
  async loadPhotos(categoryId) {
    this.setData({ loading: true })
    try {
      const [page, favoriteIds] = await Promise.all([
        galleryApi.getPhotos({ categoryId, pageIndex: 1 }),
        galleryApi.getFavoriteIds()
      ])
      // 切分类期间可能又切走了，回来的数据不再覆盖当前分类
      if (this.data.activeCategory !== categoryId) {
        return
      }
      this._favoriteIds = favoriteIds
      this._pageIndex = page.pageIndex
      this.setData({
        columns: this.buildColumns(this.markFavorites(page.list)),
        total: page.total,
        hasMore: page.hasMore,
        loading: false,
        loadingMore: false
      })
    } catch (error) {
      if (this.data.activeCategory === categoryId) {
        this.setData({
          columns: [[], []],
          total: 0,
          hasMore: false,
          loading: false,
          loadingMore: false
        })
      }
    }
  },

  /**
   * 滚到底续下一页。
   * ⚠️ 续页是**往两列里追加**，不是把全量重新分列：重新分列会把已经在屏上的卡片挪位，
   * 用户正看的那张会跳走。所以这里拿两列各自的当前累计高度接着往下排（见 buildColumns）。
   */
  async loadMorePhotos() {
    if (this.data.loading || this.data.loadingMore || !this.data.hasMore) {
      return
    }
    const categoryId = this.data.activeCategory
    const pageIndex = (this._pageIndex || 1) + 1
    this.setData({ loadingMore: true })
    try {
      const page = await galleryApi.getPhotos({ categoryId, pageIndex })
      if (this.data.activeCategory !== categoryId) {
        return
      }
      this._pageIndex = page.pageIndex
      this.setData({
        columns: this.appendColumns(this.markFavorites(page.list)),
        total: page.total || this.data.total,
        hasMore: page.hasMore,
        loadingMore: false
      })
    } catch (error) {
      this.setData({ loadingMore: false })
    }
  },

  onScrollToLower() {
    this.loadMorePhotos()
  },

  /** 用收藏 id 集合给列表项打上 favorited（后端列表项没有这个字段，见文件头缺口③） */
  markFavorites(list) {
    const ids = this._favoriteIds || []
    if (!ids.length) {
      return list
    }
    return list.map((photo) =>
      Object.assign({}, photo, { favorited: ids.indexOf(photo.id) > -1 })
    )
  },

  /**
   * 按累计高度分两列，并把每张图的**渲染高度**提前算出来。
   * 高度先定下来，图片加载完就不会再撑开容器（否则用户正在看的卡片会被顶走）。
   * ⚠️ 当前后端不给比例，这里落到 DEFAULT_RATIO，真实高度由 onImageLoad 校正。
   */
  buildColumns(list) {
    const sized = list.map((photo) =>
      Object.assign({}, photo, {
        imgHeight: galleryApi.photoHeight(photo.ratio, COLUMN_WIDTH)
      })
    )
    return galleryApi.splitColumns(sized)
  },

  /** 续页：把新一批接着排进现有两列（短的那列先拿），不动已经在屏上的卡片 */
  appendColumns(list) {
    const columns = [this.data.columns[0].slice(), this.data.columns[1].slice()]
    const heights = columns.map((column) =>
      column.reduce((sum, item) => sum + item.imgHeight + 0.22 * COLUMN_WIDTH, 0)
    )
    list.forEach((photo) => {
      const imgHeight = galleryApi.photoHeight(photo.ratio, COLUMN_WIDTH)
      const target = heights[0] <= heights[1] ? 0 : 1
      columns[target].push(Object.assign({}, photo, { imgHeight }))
      heights[target] += imgHeight + 0.22 * COLUMN_WIDTH
    })
    return columns
  },

  /**
   * 图片加载完成后按真实宽高校正这一张的高度（后端列表项没有比例，见文件头缺口①）。
   * 只改高度、**不重新分列**：重排会让用户正在看的卡片整块跳走。
   * 高度没变化（后端补了比例、或两次算出来一样）就不 setData，免得每张图都白跑一次渲染。
   */
  onImageLoad(event) {
    const detail = event.detail || {}
    const width = Number(detail.width) || 0
    const height = Number(detail.height) || 0
    if (!width || !height) {
      return
    }
    const col = Number(event.currentTarget.dataset.col)
    const index = Number(event.currentTarget.dataset.index)
    const photo = this.data.columns[col] && this.data.columns[col][index]
    if (!photo) {
      return
    }
    const imgHeight = galleryApi.photoHeight(width / height, COLUMN_WIDTH)
    if (imgHeight === photo.imgHeight) {
      return
    }
    this.setData({ [`columns[${col}][${index}].imgHeight`]: imgHeight })
  },

  /**
   * 卡片右上角红心：就地切收藏态（2026-08-12 需求 4，逻辑与「我的收藏」页同源）。
   *
   * 与收藏页的差别只有一处、但很关键：**收藏页取消后那张图要消失、必须重拉列表；
   * 本页不能重拉**。图库列表里收藏与否都还在列表上，重拉会让瀑布流按新数据重排，
   * 用户正在看的卡片被挪走 —— 所以这里只按 data-col/data-index 原地改那一张的 favorited。
   *
   * 先请求、后改 UI：收藏态的真相在服务端，先乐观改再回滚的写法，
   * 在失败时会让红心闪一下又弹回去，比慢 200ms 更难受。
   */
  async onToggleFavorite(event) {
    const dataset = event.currentTarget.dataset
    const id = dataset.id
    if (!id || this._toggling) {
      return
    }
    if (!app.requireLogin()) {
      return
    }
    const col = Number(dataset.col)
    const index = Number(dataset.index)
    const current = this.data.columns[col] && this.data.columns[col][index]
    if (!current || current.id !== id) {
      return
    }
    // 同步闸：连点两下会对同一张图切两次，最后一次的结果还可能先回来
    this._toggling = true
    try {
      const favorited = await galleryApi.toggleFavorite(id, current.favorited)
      const photo = this.data.columns[col] && this.data.columns[col][index]
      // 切分类等原因导致这一格已经不是刚才那张图了，就别改错人（整页数据自会刷新）
      if (photo && photo.id === id) {
        this.setData({ [`columns[${col}][${index}].favorited`]: favorited })
      }
      // 本地收藏 id 集合同步跟上：续页/重进本页时新拉的那批要按最新状态标记
      this.syncFavoriteId(id, favorited)
      toast.show(favorited ? '已收藏' : '已取消收藏')
    } catch (error) {
      toast.show('操作失败，请重试')
    } finally {
      this._toggling = false
    }
  },

  syncFavoriteId(id, favorited) {
    const ids = (this._favoriteIds || []).slice()
    const index = ids.indexOf(id)
    if (favorited && index < 0) {
      ids.push(id)
    } else if (!favorited && index > -1) {
      ids.splice(index, 1)
    }
    this._favoriteIds = ids
  },

  goDetail(event) {
    const id = event.currentTarget.dataset.id
    if (!id) {
      return
    }
    wx.navigateTo({
      url: `/subpackages/gallery/detail/detail?id=${encodeURIComponent(id)}`
    })
  },

  // 「我的收藏」：2026-08-12 由「我的」页迁到本页分类条右端（收藏的就是官方图库的图，
  // 入口贴着图库更顺手）。登录闸与原来一致——收藏是账号数据，未登录进去只会是空页。
  // 回到本页时 onShow 会按当前分类重拉，收藏页里取消的收藏在这边也就跟着更新了。
  goFavorites() {
    if (!app.requireLogin()) {
      return
    }
    wx.navigateTo({
      url: '/subpackages/gallery/favorites/favorites'
    })
  }
}))
