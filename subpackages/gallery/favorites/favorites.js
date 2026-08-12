// 我的收藏（设计稿：assets/ai/UI页面/我的收藏.png）
//
// 2026-08-12：由本地 mock 切到真实后端 `GET /Client/Product/getProductImgCollectionList`
//（分页），取消收藏走 `POST /Client/Product/setImgCollected`，见 utils/gallery-api.js。
// 与图库列表页共用同一套瀑布流与角标；差别只有一个：**这里取消收藏后那张图要消失**，
// 所以必须重拉，而图库列表页只能原地改状态（重拉会把用户正看的卡片挪走）。
const fold = require('../../../utils/fold-adapt')
const galleryApi = require('../../../utils/gallery-api')
const toast = require('../../../utils/toast')

// 与 subpackages/gallery/shared.wxss 的 .waterfall 布局对应，同 list.js
const COLUMN_WIDTH = 317

Page(fold.adapt({
  data: {
    columns: [[], []],
    total: 0,
    loading: true,
    loadingMore: false,
    hasMore: false
  },

  // onShow 而不是 onLoad：从详情页取消收藏后返回，列表要少掉那一张
  onShow() {
    this.loadFavorites()
  },

  async loadFavorites() {
    this.setData({ loading: true })
    try {
      const page = await galleryApi.getFavorites({ pageIndex: 1 })
      this._pageIndex = page.pageIndex
      this.setData({
        columns: this.buildColumns(page.list),
        total: page.total,
        hasMore: page.hasMore,
        loading: false,
        loadingMore: false
      })
    } catch (error) {
      this.setData({
        columns: [[], []],
        total: 0,
        hasMore: false,
        loading: false,
        loadingMore: false
      })
    }
  },

  /** 滚到底续页：追加进现有两列，不重新分列（同图库列表页，理由见那边注释） */
  async loadMoreFavorites() {
    if (this.data.loading || this.data.loadingMore || !this.data.hasMore) {
      return
    }
    const pageIndex = (this._pageIndex || 1) + 1
    this.setData({ loadingMore: true })
    try {
      const page = await galleryApi.getFavorites({ pageIndex })
      this._pageIndex = page.pageIndex
      this.setData({
        columns: this.appendColumns(page.list),
        total: page.total || this.data.total,
        hasMore: page.hasMore,
        loadingMore: false
      })
    } catch (error) {
      this.setData({ loadingMore: false })
    }
  },

  onScrollToLower() {
    this.loadMoreFavorites()
  },

  buildColumns(list) {
    const sized = list.map((photo) =>
      Object.assign({}, photo, {
        imgHeight: galleryApi.photoHeight(photo.ratio, COLUMN_WIDTH)
      })
    )
    return galleryApi.splitColumns(sized)
  },

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

  /** 图片加载完按真实宽高校正高度（后端列表项不给比例，见 gallery-api.js 文件头缺口①） */
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

  async onToggleFavorite(event) {
    const id = event.currentTarget.dataset.id
    if (!id || this._toggling) {
      return
    }
    // 同步闸：取消收藏会重排整个瀑布流，连点两下会对两张不同的图生效
    this._toggling = true
    try {
      // 本页每一张按定义都是已收藏，所以当前态恒为 true
      await galleryApi.toggleFavorite(id, true)
      toast.show('已取消收藏')
      await this.loadFavorites()
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
  }
}))
