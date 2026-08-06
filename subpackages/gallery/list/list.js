// 官方图库（设计稿：assets/ai/UI页面/官方图库.png）
//
// ⚠️ 图库数据来自 utils/gallery-api.js 的 mock，后端接口尚未提供（见该模块顶部说明）。
//    真实接口应带分页，滚到底加载下一页；mock 阶段一次给全，先不做分页。
const fold = require('../../../utils/fold-adapt')
const galleryApi = require('../../../utils/gallery-api')

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

  goDetail(event) {
    const id = event.currentTarget.dataset.id
    if (!id) {
      return
    }
    wx.navigateTo({
      url: `/subpackages/gallery/detail/detail?id=${encodeURIComponent(id)}`
    })
  }
}))
