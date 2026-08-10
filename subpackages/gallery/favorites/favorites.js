// 我的收藏（设计稿：assets/ai/UI页面/我的收藏.png）
//
// ⚠️ 收藏关系目前落在本机 Storage（utils/gallery-api.js 的 mock），换设备即丢、也不跨端同步。
//    真实实现必须是服务端账号维度的收藏关系。
const fold = require('../../../utils/fold-adapt')
const galleryApi = require('../../../utils/gallery-api')
const toast = require('../../../utils/toast')

// 与 subpackages/gallery/shared.wxss 的 .waterfall 布局对应，同 list.js
const COLUMN_WIDTH = 317

Page(fold.adapt({
  data: {
    columns: [[], []],
    total: 0,
    loading: true
  },

  // onShow 而不是 onLoad：从详情页取消收藏后返回，列表要少掉那一张
  onShow() {
    this.loadFavorites()
  },

  async loadFavorites() {
    try {
      const list = await galleryApi.getFavorites()
      const sized = list.map((photo) => Object.assign({}, photo, {
        imgHeight: Math.round(COLUMN_WIDTH / (Number(photo.ratio) || 1))
      }))
      this.setData({
        columns: galleryApi.splitColumns(sized),
        total: list.length,
        loading: false
      })
    } catch (error) {
      this.setData({ columns: [[], []], total: 0, loading: false })
    }
  },

  async onToggleFavorite(event) {
    const id = event.currentTarget.dataset.id
    if (!id || this._toggling) {
      return
    }
    // 同步闸：取消收藏会重排整个瀑布流，连点两下会对两张不同的图生效
    this._toggling = true
    try {
      await galleryApi.toggleFavorite(id)
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
