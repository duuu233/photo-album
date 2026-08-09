// 购买 & 消费记录（设计稿：assets/ai/UI页面/购买 & 消费记录-*.png）
//
// 数据来自 `GET /Client/Order/getUserAccountTrade`（inOutType 1=购买 2=消费），封装在
// utils/token-api.js。接口是**分页**的，后端默认一页 10 条，所以本页必须翻页——
// 否则不论用户买过多少次，这里永远只显示第一页，看着像记录丢了。
//
// 两个 Tab 各自维护自己的页码与「还有没有下一页」，切 Tab 不互相干扰、也不重拉已加载的那侧。
const fold = require('../../../utils/fold-adapt')
const tokenApi = require('../../../utils/token-api')

function newPager() {
  return { pageIndex: 0, hasMore: true, loaded: false }
}

Page(fold.adapt({
  data: {
    tab: 'purchase',
    purchaseList: [],
    spendList: [],
    // 当前 Tab 的条数：空态判断用，避免在 wxml 里对两个数组各写一遍三元
    currentCount: 0,
    loading: true,
    // 上拉加载下一页的状态；hasMore 指的是**当前 Tab**还有没有下一页
    loadingMore: false,
    hasMore: false
  },

  onLoad() {
    this._pagers = {
      purchase: newPager(),
      spend: newPager()
    }
    this.loadTab('purchase')
  },

  onSwitchTab(event) {
    const tab = event.currentTarget.dataset.tab
    if (tab && tab !== this.data.tab) {
      this.loadTab(tab)
    }
  },

  loadTab(tab) {
    const pager = this._pagers[tab]

    // 已经拉过的 Tab 直接切，不再转圈重拉——两个 Tab 来回点是常见操作
    if (pager.loaded) {
      const list = this.data[tab === 'spend' ? 'spendList' : 'purchaseList']
      this.setData({
        tab,
        currentCount: list.length,
        loading: false,
        loadingMore: false,
        hasMore: pager.hasMore
      })
      return
    }

    this.setData({ tab, loading: true, currentCount: 0, loadingMore: false, hasMore: false })
    this.fetchPage(tab, 1)
  },

  // 滚到底加载下一页。同步闸 _fetching 挡住惯性滚动连发的多次 scrolltolower，
  // 否则同一页会被拉两三次、列表里出现重复条目。
  onScrollToLower() {
    const tab = this.data.tab
    const pager = this._pagers[tab]
    if (this._fetching || !pager.loaded || !pager.hasMore) {
      return
    }
    this.setData({ loadingMore: true })
    this.fetchPage(tab, pager.pageIndex + 1)
  },

  async fetchPage(tab, pageIndex) {
    if (this._fetching) {
      return
    }
    this._fetching = true

    const cacheKey = tab === 'spend' ? 'spendList' : 'purchaseList'
    try {
      const result = await tokenApi.getRecords(tab, { pageIndex })
      const rows = tab === 'spend'
        ? result.list
        // 金额固定两位小数：后端可能回 199 或 "199.0"，直接渲染会出现 ¥199 / ¥199.0 混排
        : result.list.map((item) => Object.assign({}, item, {
          amountText: (Number(item.amount) || 0).toFixed(2)
        }))

      const pager = this._pagers[tab]
      pager.pageIndex = result.pageIndex
      pager.hasMore = result.hasMore
      pager.loaded = true

      const merged = pageIndex === 1 ? rows : this.data[cacheKey].concat(rows)

      // 切 Tab 期间可能已经切走了，回来的数据只写进对应数组，不改当前 Tab 的展示
      const patch = {}
      patch[cacheKey] = merged
      if (this.data.tab === tab) {
        patch.currentCount = merged.length
        patch.loading = false
        patch.loadingMore = false
        patch.hasMore = result.hasMore
      }
      this.setData(patch)
    } catch (error) {
      // 接口层已 toast，这里只收尾状态。翻页失败保留已有列表，hasMore 不动，用户可再拉一次重试。
      if (this.data.tab === tab) {
        this.setData({
          loading: false,
          loadingMore: false,
          currentCount: this.data[cacheKey].length
        })
      }
    } finally {
      this._fetching = false
    }
  }
}))
