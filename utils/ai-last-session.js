// 「上次离开 AI 页时停在哪一页」——底栏 AI 图标据此决定再次进入时打开什么（2026-08-13 需求 5）。
//
// 需求原文的两条，判据其实是同一个：聊天页的 sessionId。
//   · 上次是在**某条会话**里离开的（sessionId 非空）→ 再点 AI 图标回到那条会话，而不是默认页；
//   · 上次是在 **AI 默认页**离开的（sessionId 为空）→ 再点 AI 图标仍是默认页。
// 「默认页」与「还没建会话」永远是同一件事：会话只在用户发出第一条消息时才建
// （见 subpackages/ai/chat/chat.js createSession 上方注释），所以空态一定没有 sessionId。
//
// 为什么只存在内存里、不落 storage：AI 会话历史服务端只保留 7 天（超期 getHistory 回 10001），
// 跨启动记住一条可能早就过期、或已被别的端删掉的会话，用户点进去只会得到一个报错的空聊天页。
// 内存里这条一定是**本次运行刚聊过的**，必然还在。重启小程序回落到默认页是可接受的退化。
//
// 谁写：聊天页（onShow / onUnload，即「这一页此刻是可见的」与「用户离开了这一页」两个时刻）。
// 谁读：components/custom-tabbar 的 goAi。
// 谁清：会话被删除时（会话列表页 deleteSession）——不清的话下次点 AI 会打开一条已删会话。
let lastSessionId = ''
let lastSessionTitle = ''

// 记下聊天页当前停在哪条会话。sessionId 传空串＝停在默认页（这是有效值，不是"没记录"）。
function remember(sessionId, title) {
  lastSessionId = String(sessionId || '')
  lastSessionTitle = lastSessionId ? String(title || '') : ''
}

function get() {
  return { sessionId: lastSessionId, title: lastSessionTitle }
}

// 清掉记录，回落到「下次点 AI 进默认页」。
// 传 sessionId 时只在命中那一条才清（删的是别的会话就不该影响这条记录）。
function forget(sessionId) {
  if (sessionId && sessionId !== lastSessionId) {
    return
  }
  lastSessionId = ''
  lastSessionTitle = ''
}

module.exports = {
  remember,
  get,
  forget
}
