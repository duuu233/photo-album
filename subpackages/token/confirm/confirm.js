// 确认购买（设计稿：assets/ai/UI页面/确认购买.png）
//
// 微信支付走**小程序虚拟支付**（Token 是虚拟商品）：
//   建单 /Client/Order/addOrder → wx.requestVirtualPayment → 微信回调我们后端发货 → 轮询余额确认。
// 整条链路封装在 utils/token-api.js 的 purchase()，本页只负责按钮态与结果提示。
//
// ⚠️ 到账与否一律以服务端余额为准。wx.requestVirtualPayment 的 success 只是弱确认
//    （微信异常退出就可能丢），绝不能拿它直接给用户加余额。
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
      const result = await tokenApi.purchase(this.data.pkg, this.data.channel)
      this.showPurchaseResult(result)
    } catch (error) {
      this.showPurchaseError(error)
    } finally {
      this._paying = false
      this.setData({ paying: false })
    }
  },

  // 支付成功后的三种收尾：已到账（带数字）、已到账（拿不到支付前余额，不报数）、
  // 回调还没到（钱已付，别说成失败）。
  showPurchaseResult(result) {
    const pending = result && result.pending

    if (pending) {
      wx.showModal({
        title: '支付已完成',
        // payStatus 1=微信侧确认已支付。查不到状态时也不说「失败」——钱可能已经扣了，
        // 让用户去记录页核对比让他重复付一次强。
        content: result.payStatus === 1
          ? 'Token 到账稍有延迟，请稍后在「Token管理」查看余额'
          : '支付结果确认中，请稍后在「购买 & 消费记录」查看',
        showCancel: false,
        confirmText: '知道了',
        success: () => wx.navigateBack()
      })
      return
    }

    // 拿不到支付前余额时算不出增量（基线那次请求失败了），就报服务端的当前余额——
    // 那是真实值，比编一句「已到账」诚实，也比不给数字有用。
    const gained = result && result.gained
    const balance = result && result.account ? result.account.balance : null

    wx.showModal({
      title: '购买成功',
      content: gained
        ? `已到账 ${gained} Token`
        : balance === null
          ? 'Token 已到账'
          : `当前余额 ${balance} Token`,
      showCancel: false,
      confirmText: '好的',
      success: () => wx.navigateBack()
    })
  },

  showPurchaseError(error) {
    const code = error && error.code

    // 用户自己取消不是故障：轻提示即可，弹窗会让「点错了」变成一次二次确认
    if (code === 'PAY_CANCELED') {
      toast.show('已取消支付')
      return
    }

    // 支付失败按需求要走弹窗而不是 toast（用户刚花过钱，提示必须停留）
    wx.showModal({
      title: '购买失败',
      content: (error && error.message) || '支付未完成，请稍后重试',
      showCancel: false,
      confirmText: '知道了'
    })
  }
}))
