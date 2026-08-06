// 确认购买（设计稿：assets/ai/UI页面/确认购买.png）
//
// ⚠️ 支付通道尚未接入。当前 `tokenApi.createOrder` 只做本地 mock 结算，
//    真实实现必须是「服务端下单 → wx.requestPayment → 服务端回调确认 → 重新拉余额」，
//    绝不能拿客户端的 success 回调直接加余额（见 utils/token-api.js 的说明）。
//
// 需求文档口径：小程序/Android 选「微信支付 / PayPal」，iOS 直接走 Apple IAP。
// 本页是小程序端，只呈现前者两项；iOS IAP 属 APP 端，等 Flutter 侧补齐。
const fold = require('../../../utils/fold-adapt')
const tokenApi = require('../../../utils/token-api')
const toast = require('../../../utils/toast')

Page(fold.adapt({
  data: {
    pkg: {
      id: '',
      tokens: 0,
      gift: 0,
      price: 0,
      priceText: '0.00',
      totalTokens: 0
    },
    channel: 'wechat',
    paying: false
  },

  onLoad(query) {
    this.loadPackage((query && query.id) || '')
  },

  async loadPackage(id) {
    try {
      const list = await tokenApi.getPackages()
      const found = list.filter((item) => item.id === id)[0]
      if (!found) {
        toast.show('套餐已失效，请重新选择')
        setTimeout(() => wx.navigateBack(), 1200)
        return
      }
      this.setData({
        pkg: Object.assign({}, found, {
          priceText: (Number(found.price) || 0).toFixed(2),
          totalTokens: tokenApi.totalTokensOf(found)
        })
      })
    } catch (error) {
      toast.show('套餐信息加载失败')
    }
  },

  onSelectChannel(event) {
    const channel = event.currentTarget.dataset.channel
    if (channel && channel !== this.data.channel) {
      this.setData({ channel })
    }
  },

  async onPay() {
    // 同步闸：支付按钮在 await 之前就置起，避免空窗期连点重复下单
    // （同 AI 聊天页 2026-07-29 的 guardedSend 处理）
    if (this.data.paying || this._paying) {
      return
    }
    if (!this.data.pkg.id) {
      toast.show('请先选择套餐')
      return
    }
    this._paying = true
    this.setData({ paying: true })

    try {
      const result = await tokenApi.createOrder(this.data.pkg, this.data.channel)
      wx.showModal({
        title: '购买成功',
        content: `已到账 ${result.gained} Token`,
        showCancel: false,
        confirmText: '好的',
        success: () => wx.navigateBack()
      })
    } catch (error) {
      // 支付失败按需求要走弹窗而不是 toast（用户刚花过钱，提示必须停留）
      wx.showModal({
        title: '购买失败',
        content: (error && error.message) || '支付未完成，请稍后重试',
        showCancel: false,
        confirmText: '知道了'
      })
    } finally {
      this._paying = false
      this.setData({ paying: false })
    }
  }
}))
