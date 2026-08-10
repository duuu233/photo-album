// Token 管理（设计稿：assets/ai/UI页面/Token管理.png）
//
// 余额取 `/Client/Order/getUserAccount`、套餐取 `/Client/Order/getGoodsList`，
// 都封装在 utils/token-api.js。套餐的 `id` 是后端 goodsId 的字符串形态，
// 经 URL 传给确认页后由那边下单（见该模块顶部的整条支付链路说明）。
const fold = require('../../../utils/fold-adapt')
const tokenApi = require('../../../utils/token-api')
const toast = require('../../../utils/toast')

const app = getApp()

Page(fold.adapt({
  data: {
    // statusBarHeight / safeBottom / navHeight 由 fold.adapt 注入并在 onResize 重测
    account: {
      balance: 0,
      totalPurchased: 0,
      totalSpent: 0
    },
    packages: [],
    // 默认选中：进页面就有可买的档位，避免「立即购买」一直是灰的
    selectedId: ''
  },

  onShow() {
    this.loadAccount()
    this.loadPackages()
  },

  async loadAccount() {
    if (!app.requireLogin()) {
      return
    }
    try {
      const account = await tokenApi.getAccount()
      this.setData({ account })
    } catch (error) {
      // 失败保留上次成功值：弱网回到本页把余额清零，用户会以为 Token 没了
      if (!this._accountLoaded) {
        this.setData({ account: { balance: 0, totalPurchased: 0, totalSpent: 0 } })
      }
      return
    }
    this._accountLoaded = true
  },

  async loadPackages() {
    try {
      const list = await tokenApi.getPackages()
      // 单价在这里算一次写进 data：wxml 里不能调用 JS 方法，
      // 也避免列表与确认页各算一遍算出不一样的数（口径见 token-api.unitPriceOf）
      const packages = list.map((item) => Object.assign({}, item, {
        unitPrice: tokenApi.unitPriceOf(item)
      }))
      this.setData({
        packages,
        // 保留用户已选的那档；没选过就默认选设计稿高亮的第二档（有赠送的主推档），
        // 只有一档时退回第一档
        selectedId: this.data.selectedId
          || (packages[1] && packages[1].id)
          || (packages[0] && packages[0].id)
          || ''
      })
    } catch (error) {
      this.setData({ packages: [] })
    }
  },

  onSelectPackage(event) {
    const id = event.currentTarget.dataset.id
    if (id && id !== this.data.selectedId) {
      this.setData({ selectedId: id })
    }
  },

  goConfirm() {
    const { selectedId, packages } = this.data
    if (!selectedId) {
      toast.show('请先选择套餐')
      return
    }
    if (!app.requireLogin()) {
      return
    }
    const picked = packages.filter((item) => item.id === selectedId)[0]
    if (!picked) {
      toast.show('套餐已失效，请重新选择')
      return
    }
    wx.navigateTo({
      url: `/subpackages/token/confirm/confirm?id=${encodeURIComponent(picked.id)}`
    })
  },

  goRecords() {
    if (!app.requireLogin()) {
      return
    }
    wx.navigateTo({
      url: '/subpackages/token/records/records'
    })
  }
}))
