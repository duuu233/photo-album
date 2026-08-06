// 购买 & 消费记录（设计稿：assets/ai/UI页面/购买 & 消费记录-*.png）
//
// ⚠️ 数据来自 utils/token-api.js 的 mock，后端接口尚未提供（见该模块顶部说明）。
//    真实接口应带分页，本页滚到底再加载下一页；mock 阶段一次给全，先不做分页逻辑，
//    免得留下一套没法验证的假分页。
const fold = require('../../../utils/fold-adapt')
const tokenApi = require('../../../utils/token-api')

Page(fold.adapt({
  data: {
    tab: 'purchase',
    purchaseList: [],
    spendList: [],
    // 当前 Tab 的条数：空态判断用，避免在 wxml 里对两个数组各写一遍三元
    currentCount: 0,
    loading: true
  },

  onLoad() {
    this.loadTab('purchase')
  },

  onSwitchTab(event) {
    const tab = event.currentTarget.dataset.tab
    if (tab && tab !== this.data.tab) {
      this.loadTab(tab)
    }
  },

  async loadTab(tab) {
    const cacheKey = tab === 'spend' ? 'spendList' : 'purchaseList'
    const cached = this.data[cacheKey]

    // 已经拉过的 Tab 直接切，不再转圈重拉——两个 Tab 来回点是常见操作
    if (cached && cached.length) {
      this.setData({ tab, currentCount: cached.length, loading: false })
      return
    }

    this.setData({ tab, loading: true, currentCount: 0 })
    try {
      const list = await tokenApi.getRecords(tab)
      const normalized = tab === 'spend'
        ? list
        // 金额固定两位小数：后端可能回 199 或 "199.0"，直接渲染会出现 ¥199 / ¥199.0 混排
        : list.map((item) => Object.assign({}, item, {
          amountText: (Number(item.amount) || 0).toFixed(2)
        }))

      // 切 Tab 期间可能已经切走了，回来的数据只写进对应数组，不改当前 Tab 的展示
      const patch = {}
      patch[cacheKey] = normalized
      if (this.data.tab === tab) {
        patch.currentCount = normalized.length
        patch.loading = false
      }
      this.setData(patch)
    } catch (error) {
      if (this.data.tab === tab) {
        this.setData({ loading: false, currentCount: 0 })
      }
    }
  }
}))
