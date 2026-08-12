// 官方图库（设计稿：assets/ai/UI页面/官方图库.png）
//
// ⚠️ 图库数据来自 utils/gallery-api.js 的 mock，后端接口尚未提供（见该模块顶部说明）。
//    真实接口应带分页，滚到底加载下一页；mock 阶段一次给全，先不做分页。
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
    loading: true
  },

  onLoad() {
    this.loadCategories()
  },

  onShow() {
    if (wx.hideTabBar) {
      wx.hideTabBar({ animation: false })
    }
    // 从详情页返回时收藏态可能变了，重进本页按当前分类重拉一次
    if (this.data.activeCategory) {
      this.loadPhotos(this.data.activeCategory)
    }
  },

  async loadCategories() {
    try {
      const categories = await galleryApi.getCategories()
      const first = (categories[0] && categories[0].id) || ''
      this.setData({ categories, activeCategory: first })
      if (first) {
        this.loadPhotos(first)
      }
    } catch (error) {
      this.setData({ categories: [], loading: false })
    }
  },

  onSelectCategory(event) {
    const id = event.currentTarget.dataset.id
    if (id && id !== this.data.activeCategory) {
      this.setData({ activeCategory: id })
      this.loadPhotos(id)
    }
  },

  async loadPhotos(categoryId) {
    this.setData({ loading: true })
    try {
      const list = await galleryApi.getPhotos(categoryId)
      // 切分类期间可能又切走了，回来的数据不再覆盖当前分类
      if (this.data.activeCategory !== categoryId) {
        return
      }
      this.setData({
        columns: this.buildColumns(list),
        total: list.length,
        loading: false
      })
    } catch (error) {
      if (this.data.activeCategory === categoryId) {
        this.setData({ columns: [[], []], total: 0, loading: false })
      }
    }
  },

  /**
   * 按累计高度分两列，并把每张图的**渲染高度**提前算出来。
   * 高度先定下来，图片加载完就不会再撑开容器（否则用户正在看的卡片会被顶走）。
   */
  buildColumns(list) {
    const sized = list.map((photo) => Object.assign({}, photo, {
      imgHeight: Math.round(COLUMN_WIDTH / (Number(photo.ratio) || 1))
    }))
    return galleryApi.splitColumns(sized)
  },

  /**
   * 卡片右上角红心：就地切收藏态（2026-08-12 需求 4，逻辑与「我的收藏」页同源）。
   *
   * 与收藏页的差别只有一处、但很关键：**收藏页取消后那张图要消失、必须重拉列表；
   * 本页不能重拉**。图库列表里收藏与否都还在列表上，重拉会让瀑布流按新数据重排，
   * 用户正在看的卡片被挪走 —— 所以这里只按 data-col/data-index 原地改那一张的 favorited。
   *
   * 先请求、后改 UI：收藏态的真相在服务端（现为 mock），先乐观改再回滚的写法，
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
    // 同步闸：连点两下会对同一张图切两次，最后一次的结果还可能先回来
    this._toggling = true
    try {
      const favorited = await galleryApi.toggleFavorite(id)
      const col = Number(dataset.col)
      const index = Number(dataset.index)
      const photo =
        this.data.columns[col] && this.data.columns[col][index]
      // 切分类等原因导致这一格已经不是刚才那张图了，就别改错人（整页数据自会刷新）
      if (photo && photo.id === id) {
        this.setData({ [`columns[${col}][${index}].favorited`]: favorited })
      }
      toast.show(favorited ? '已收藏' : '已取消收藏')
    } catch (error) {
      toast.show('操作失败，请重试')
    } finally {
      this._toggling = false
    }
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
