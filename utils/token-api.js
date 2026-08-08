// Token（支付体系）客户端接口层。
//
// ⚠️ 后端接口尚未提供：`docs/reference/client-api-matrix.md` 里没有任何余额、套餐、订单或
//    消费流水的 `/Client/...` 端点。本模块先按需求文档（`assets/ai/支付&ai&官方图库.docx`
//    「二、支付体系（Token管理）」）把**客户端契约**固定下来，数据由本地 mock 提供，
//    这样 UI 与页面逻辑可以先完成、接口就位后只替换每个方法体内的取数分支。
//
// 接入真实接口时的落点（每个方法内都标了 TODO）：
//   - `getAccount()`      → 余额/累计购买/累计消耗
//   - `getPackages()`     → 套餐列表
//   - `getRecords(type)`  → 购买记录 / 消费记录（分页）
//   - `createOrder()`     → 下单 + 拉起支付
// 与 BoltFox 其它接口一样，真实实现应经 `utils/request.js`（自动带 token/terminal/language），
// 不要在这里自己拼 header。
//
// 另见 `subpackages/ai/chat/chat.js` 的 `TOKEN_LIMIT_ENABLED`：聊天页的扣费拦截目前是关的，
// 余额接口接上之后应连同该开关一起改回 true，两处共用同一个余额口径。

const MOCK_DELAY = 240

// 余额本地缓存 key。真实接口接入后应删除：余额必须以服务端为准，
// 客户端缓存只会在多端购买/消费时产生对不上的数字。
const MOCK_ACCOUNT_KEY = 'mockTokenAccount'

const DEFAULT_ACCOUNT = {
  balance: 1280, // 当前可用余额
  totalPurchased: 12280, // 总额（累计购买）
  totalSpent: 11000 // 已消耗
}

// 套餐：价格、Token 数、赠送数。`gift` 为 0 表示无赠送（设计稿里 200 Token 那档就没有角标）。
const MOCK_PACKAGES = [
  { id: 'pkg_200', tokens: 200, price: 99, gift: 0 },
  { id: 'pkg_500', tokens: 500, price: 199, gift: 20 },
  { id: 'pkg_1200', tokens: 1200, price: 399, gift: 80 },
  { id: 'pkg_2500', tokens: 2500, price: 799, gift: 200 }
]

const MOCK_PURCHASE_RECORDS = [
  { id: 'p1', time: '2026-05-20 14:30', tokens: 500, gift: 20, amount: 199, channel: '微信支付', status: '已完成' },
  { id: 'p2', time: '2026-05-18 10:22', tokens: 200, gift: 0, amount: 99, channel: '微信支付', status: '已完成' },
  { id: 'p3', time: '2026-05-15 18:45', tokens: 1200, gift: 80, amount: 399, channel: 'PayPal', status: '已完成' },
  { id: 'p4', time: '2026-05-12 09:15', tokens: 500, gift: 20, amount: 199, channel: 'PayPal', status: '已完成' },
  { id: 'p5', time: '2026-05-10 16:50', tokens: 200, gift: 0, amount: 99, channel: '微信支付', status: '已完成' }
]

const MOCK_SPEND_RECORDS = [
  { id: 's1', time: '2026-05-20 15:42', scene: 'AI 生成写实图', tokens: 10 },
  { id: 's2', time: '2026-05-20 15:40', scene: 'AI 生成人物图', tokens: 10 },
  { id: 's3', time: '2026-05-20 15:35', scene: 'AI 生成动漫图', tokens: 20 },
  { id: 's4', time: '2026-05-19 21:18', scene: 'AI 生成肖像图', tokens: 10 },
  { id: 's5', time: '2026-05-19 20:45', scene: 'AI 生成风景图', tokens: 10 },
  { id: 's6', time: '2026-05-19 20:30', scene: 'AI 生成风景图', tokens: 10 }
]

function delay(value) {
  return new Promise((resolve) => {
    setTimeout(() => resolve(value), MOCK_DELAY)
  })
}

function readMockAccount() {
  try {
    const cached = wx.getStorageSync(MOCK_ACCOUNT_KEY)
    if (cached && typeof cached === 'object' && typeof cached.balance === 'number') {
      return cached
    }
  } catch (error) {
    // 读缓存失败按默认值走，不影响页面展示
  }
  return Object.assign({}, DEFAULT_ACCOUNT)
}

function writeMockAccount(account) {
  try {
    wx.setStorageSync(MOCK_ACCOUNT_KEY, account)
  } catch (error) {
    // 写失败只影响 mock 的连续性，不抛给页面
  }
}

/**
 * 单个套餐「合计获得」= 基础 Token + 赠送 Token。
 * 确认购买页与购买记录都用它，避免两处各算一遍算出不同的数。
 */
function totalTokensOf(pkg) {
  if (!pkg) {
    return 0
  }
  return (Number(pkg.tokens) || 0) + (Number(pkg.gift) || 0)
}

/**
 * 单价（约）：设计稿上每张套餐卡底部的 `≈ ¥0.36/Token`。
 * 按**含赠送**的总数算，否则赠送多的档位单价反而显得更贵，与「越买越划算」的排序相悖。
 */
function unitPriceOf(pkg) {
  const total = totalTokensOf(pkg)
  if (!total) {
    return '0.00'
  }
  return ((Number(pkg.price) || 0) / total).toFixed(2)
}

module.exports = {
  totalTokensOf,
  unitPriceOf,

  /** Token 账户概览：当前可用余额 / 总额（累计购买）/ 已消耗 */
  getAccount() {
    // TODO(后端): 替换为 request.get('/Client/Token/getAccount')
    return delay(readMockAccount())
  },

  /** 套餐列表（Token 管理页横向滑动） */
  getPackages() {
    // TODO(后端): 替换为 request.get('/Client/Token/getPackageList')
    return delay(MOCK_PACKAGES.map((item) => Object.assign({}, item)))
  },

  /**
   * 购买 / 消费记录。
   * @param {'purchase'|'spend'} type
   */
  getRecords(type) {
    // TODO(后端): 替换为 request.get('/Client/Token/getRecordList', { type, page, pageSize })
    const list = type === 'spend' ? MOCK_SPEND_RECORDS : MOCK_PURCHASE_RECORDS
    return delay(list.map((item) => Object.assign({}, item)))
  },

  /**
   * 下单并拉起支付。
   *
   * ⚠️ 目前只做 mock 结算（直接把 Token 加到本地余额）。真实实现分两步且**不能省**：
   *   ① 服务端下单拿到 prepay 参数；
   *   ② 微信支付走 `wx.requestPayment`，PayPal 需要 H5/webview 承载（小程序内无原生 SDK，
   *      合规性与跳转方式要先与后端和微信审核确认）。
   *   支付结果一律以**服务端回调**为准，绝不能用客户端的 success 回调直接加余额。
   *
   * @param {object} pkg     套餐
   * @param {'wechat'|'paypal'} channel 支付方式
   */
  createOrder(pkg, channel) {
    // TODO(后端): 替换为 request.post('/Client/Token/createOrder', { packageId, channel })
    //             成功后按返回的 prepay 参数调 wx.requestPayment，再重新拉一次 getAccount()
    if (channel === 'paypal') {
      return Promise.reject({
        code: 'PAYPAL_UNAVAILABLE',
        message: 'PayPal 支付通道尚未接入'
      })
    }

    const account = readMockAccount()
    const gained = totalTokensOf(pkg)
    const next = {
      balance: account.balance + gained,
      totalPurchased: account.totalPurchased + gained,
      totalSpent: account.totalSpent
    }
    writeMockAccount(next)
    return delay({ orderId: `mock_${pkg.id}`, gained, account: next })
  }
}
