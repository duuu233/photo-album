// AI Token 余额（**演示逻辑**）——支付体系（Java 后端）未接，先用本地存储模拟
// 「余额展示 + 每次对话扣 1 + 不足拦截」。接入真实接口后只改本文件的 readBalance/spend 即可，
// 页面侧无需改动。
//
// 2026-08-10 从 subpackages/ai/chat/chat.js 提取成公共模块：会话列表页也要显示同一份余额
//（需求「历史会话页顶部显示 token 余额」），常量再复制一份必然会漂。
//
// LIMIT_ENABLED=false（2026-08-03 起）：余额是本地假的、支付又没上线，扣满 DEFAULT_BALANCE 次
// 就再也发不出消息，纯粹卡住体验/测试。关掉后 —— 不扣费、不拦截，余额恒显示 DEFAULT_BALANCE
//（storage 里可能留着历史扣到 0 的旧值，一并忽略，否则会显示 0 Token 像坏了）。
// 接后端时把它改回 true，其余逻辑原样还在。
const STORAGE_KEY = 'aiTokenBalanceDemo'
const DEFAULT_BALANCE = 100
const LIMIT_ENABLED = false

function readBalance() {
  if (!LIMIT_ENABLED) {
    return DEFAULT_BALANCE
  }
  const value = wx.getStorageSync(STORAGE_KEY)
  return typeof value === 'number' ? value : DEFAULT_BALANCE
}

// 扣 1 并落盘，返回扣完的余额。限制关闭时是空操作（返回当前展示值，调用方不必判分支）。
function spend(current) {
  if (!LIMIT_ENABLED) {
    return current
  }
  const balance = Math.max(0, Number(current || 0) - 1)
  wx.setStorageSync(STORAGE_KEY, balance)
  return balance
}

module.exports = {
  STORAGE_KEY,
  DEFAULT_BALANCE,
  LIMIT_ENABLED,
  readBalance,
  spend
}
