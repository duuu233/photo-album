// AI 模块的 Token 余额。
//
// 2026-08-11 接口对账（https://api.boltfox.cn/swagger-ui.html#/）：**已由本地 demo 切到真实后端**。
// 此前本文件是一套 storage 里的假余额（恒 100、每次对话本地扣 1），AI 侧显示的数字与用户真实
// 账户毫无关系 —— 支付体系上线后这就是明摆着的错数。
//
// 余额来源（两条，都是真实值）：
//   ① `app.globalData.userInfo.availableToken` —— 登录响应 UserInfoDetailApiOut / 用户信息接口
//      UserInfoApiOut 里现在都带 `availableToken`（String）。进页面即有，不必先打一次接口；
//   ② `GET /Client/Order/getUserAccount` —— 权威值，用于刷新（生成完一次图之后余额会变）。
//
// ⚠️ **端上不做扣费**。swagger 的 `/Client/Order` 下只有购买侧四个端点，没有「消费 Token」的
//    Client 端点；而消费记录能从 `getUserAccountTrade(inOutType=2)` 查到 —— 说明扣费发生在
//    服务端（AI 网关侧）。端上再自己减一次就是双重记账，只会和账户对不上。
//    所以本模块只有「读」和「刷新」，`spend()` 已删除。
//
// LIMIT_ENABLED：余额不足时是否**拦截**发送。仍保持 false，等后端把「AI 调用如何扣费、
// 余额为 0 时网关返回什么错误码」定下来再打开（否则会出现「端上放行、网关拒绝」或反过来的
// 割裂）。⚠️ 它现在只控制**拦截**，不再控制余额展示 —— 展示一律是真实值。
const api = require('./api')
const tokenApi = require('./token-api')

const LIMIT_ENABLED = false

// 读不到余额时页面显示什么：用 null 表示「未知」，页面渲染成 '--'，
// 绝不用 0 兜底 —— 那会让有余额的用户看到「0 Token」而不敢用。
const UNKNOWN_BALANCE = null

function toBalance(value) {
  if (value === undefined || value === null || value === '') {
    return UNKNOWN_BALANCE
  }
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, number) : UNKNOWN_BALANCE
}

// 登录时落在会话里的余额（app.applyWechatSession → normalizeUserInfo）。
// 同步可得，用于进页面时先把数字显示出来，避免空一下再跳。
function cachedBalance() {
  const app = typeof getApp === 'function' ? getApp() : null
  const userInfo = (app && app.globalData && app.globalData.userInfo) || null
  return toBalance(userInfo && userInfo.availableToken)
}

// 权威余额：优先查账户接口；失败再退回用户信息接口（两处出参是同一个 availableToken）。
// 都失败返回 UNKNOWN_BALANCE，页面保持上一次的数字或 '--'，不弹错误——
// 余额只是页面上的一个数字，为它弹红字会盖住 AI 的主流程。
async function fetchBalance() {
  try {
    const account = await tokenApi.getAccount({ showError: false })
    const balance = toBalance(account && account.balance)
    if (balance !== UNKNOWN_BALANCE) {
      return balance
    }
  } catch (error) {
    // 落到下面的用户信息兜底
  }

  try {
    const profile = await api.getUserProfile()
    return toBalance(profile && profile.availableToken)
  } catch (error) {
    return UNKNOWN_BALANCE
  }
}

// 生成/对话之后刷新：扣费在服务端发生，端上只能重取。
function refreshBalance() {
  return fetchBalance()
}

// 余额是否足以发起一次 AI 调用。LIMIT_ENABLED=false 时恒 true；
// 余额未知（接口挂了）也放行——不能因为读不到数字就把功能锁死。
function hasBalance(balance) {
  if (!LIMIT_ENABLED) {
    return true
  }
  return balance === UNKNOWN_BALANCE || Number(balance) > 0
}

// 页面展示：未知显示 '--'，其余显示数字本身（0 就显示 0，那是真实状态）。
function displayBalance(balance) {
  return balance === UNKNOWN_BALANCE || balance === undefined ? '--' : String(balance)
}

module.exports = {
  LIMIT_ENABLED,
  UNKNOWN_BALANCE,
  cachedBalance,
  fetchBalance,
  refreshBalance,
  hasBalance,
  displayBalance
}
