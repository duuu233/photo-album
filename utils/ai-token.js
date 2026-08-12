// AI 模块的星币（原文案「Token」，2026-08-12 全站改称星币；字段名仍是后端的 availableToken）余额与「能不能发起对话」的闸。
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
// 拦截口径（2026-08-12 重做）：**够不够发一轮对话由服务端说了算** ——
// `GET /Client/Order/chkAiDialogue` → `canDialogue()`，发送前调一次，false 就拦下。
//
// 在此之前这里是个开着口子的假闸：`LIMIT_ENABLED = false` + `hasBalance()`（按余额数字比大小），
// 等的是「一轮对话到底扣多少、余额为 0 时网关回什么码」这两个端上永远猜不出来的答案，
// 于是余额为 0 也照发，全靠网关那边兜。新接口把这个悬案了结了，那套开关连同 `hasBalance()`
// 一并删除 —— 留着两个口径不一致的闸只会让「到底谁拦的」无从查起。
const api = require('./api')
const tokenApi = require('./token-api')

// 读不到余额时页面显示什么：用 null 表示「未知」，页面渲染成 '--'，
// 绝不用 0 兜底 —— 那会让有余额的用户看到「0 星币」而不敢用。
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

// 能否发起一次 AI 对话 —— **唯一的闸**，由服务端裁决
//（2026-08-12 新增 GET /Client/Order/chkAiDialogue）。每次发送前调一次：够不够扣、
// 有没有免费额度、账号有没有被停，全在服务端那一个判断里，端上不再拿余额数字自己推
//（推不准，见文件头）。
//
// 返回 { allowed, required, message }：
//   allowed=false 时 required 是后端给的最低余额（真机实测 30，抠不到为 0），
//   message 是后端原话，供页面在抠不到数字时兜底措辞（见 chat.js showTokenShortModal）。
//
// ⚠️ **只有明确的 403「余额不足」才拦**；校验接口自己出问题（网络抖动、后端 5xx）一律放行：
// 读不到判据就把 AI 锁死是更糟的失败模式 —— 真不够的话紧接着那次 /chat 服务端照样会拒，
// 用户看到的是真实原因，而不是被端上一次网络故障扣上一顶「星币不足」的帽子。
// 同理由见本文件 fetchBalance。
async function canDialogue() {
  try {
    return await tokenApi.checkAiDialogue({ showError: false })
  } catch (error) {
    console.warn('[AI] chkAiDialogue 校验失败，本次放行（由服务端在 /chat 侧兜底）', error)
    return { allowed: true, required: 0, message: '' }
  }
}

// 页面展示：未知显示 '--'，其余显示数字本身（0 就显示 0，那是真实状态）。
function displayBalance(balance) {
  return balance === UNKNOWN_BALANCE || balance === undefined ? '--' : String(balance)
}

module.exports = {
  UNKNOWN_BALANCE,
  cachedBalance,
  fetchBalance,
  refreshBalance,
  canDialogue,
  displayBalance
}
