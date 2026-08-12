// 底栏 AI 图标「接着上次那一页」的路由记忆（2026-08-13 需求 5）。
//
// 需求原文两条：
//   1) 在某条会话里点左上返回退回首页/我的之后，再点 AI 图标应当回到**那条会话**，不是默认页；
//   2) 在 AI 默认页点返回退回首页/我的之后，再点 AI 图标仍应是**默认页**。
// 判据只有一个：聊天页的 sessionId（会话只在首次发送时才建，所以「空态」＝「没有 sessionId」）。
//
// 这里锁四件事：
//   ① 记忆本身的语义：记会话 / 记空态 / 删别人不受影响 / 删自己就清空；
//   ② 底栏按记忆拼 URL：有会话带 sessionId+title 进去（与会话列表点进去同一条路），没有就是干净的默认页；
//   ③ 聊天页在 onShow / onUnload 两个时刻把自己记下来 —— 且**栈里还有别的聊天页时 onUnload 不许记**
//      （那种情况用户看的是下层那页，该由它的 onShow 记自己；两者触发顺序在各基础库上并不一致）；
//   ④ 会话被删时记忆要一并清掉，否则下次点 AI 会打开一条已删会话，只能拿到报错的空聊天页。
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')

function freshRequire(modulePath) {
  delete require.cache[require.resolve(modulePath)]
  return require(modulePath)
}

// ── ① 记忆语义 ────────────────────────────────────────────────
{
  const memo = freshRequire('../utils/ai-last-session')

  assert.deepEqual(memo.get(), { sessionId: '', title: '' }, '初始＝没聊过，进默认页')

  memo.remember('sess-1', '帮我画只猫')
  assert.deepEqual(memo.get(), { sessionId: 'sess-1', title: '帮我画只猫' })

  memo.forget('sess-other')
  assert.equal(memo.get().sessionId, 'sess-1', '删的是别的会话，不该影响这条记录')

  memo.forget('sess-1')
  assert.deepEqual(memo.get(), { sessionId: '', title: '' }, '删掉记着的那条＝回落默认页')

  memo.remember('sess-2', '标题')
  memo.remember('') // 用户回到了 AI 默认页（＋新对话 / 会话被删）
  assert.deepEqual(
    memo.get(),
    { sessionId: '', title: '' },
    '空 sessionId 是有效状态（默认页），必须覆盖掉上一条会话，标题也要跟着清'
  )
}

// ── ② 底栏 AI 图标按记忆拼 URL ──────────────────────────────────
{
  const memo = freshRequire('../utils/ai-last-session')
  const navigations = []
  global.wx = {
    navigateTo: options => navigations.push(options.url),
    switchTab: () => {}
  }
  let tabbar = null
  global.Component = config => {
    tabbar = config
  }
  delete require.cache[require.resolve('../components/custom-tabbar/custom-tabbar.js')]
  require('../components/custom-tabbar/custom-tabbar.js')
  assert.ok(tabbar && tabbar.methods && tabbar.methods.goAi, 'custom-tabbar 没有注册 goAi')

  const tapAi = () => tabbar.methods.goAi.call({ data: { active: 'home' } })

  // 没有记录（本次运行还没进过 AI）→ 干净的默认页
  memo.forget()
  tapAi()
  assert.equal(navigations.pop(), '/subpackages/ai/chat/chat', '没聊过就进 AI 默认页')

  // 上次停在某条会话 → 带着它进去（chat.onLoad 的 options.sessionId 分支会直接载入历史）
  memo.remember('sess-9', '我的 猫')
  tapAi()
  assert.equal(
    navigations.pop(),
    `/subpackages/ai/chat/chat?sessionId=sess-9&title=${encodeURIComponent('我的 猫')}`,
    '上次停在会话里，再点 AI 图标要回到那条会话（标题必须 encode，空格/&/% 都会毁掉 query）'
  )

  // 上次停在 AI 默认页 → 还是默认页（需求第 2 条）
  memo.remember('')
  tapAi()
  assert.equal(navigations.pop(), '/subpackages/ai/chat/chat', '上次停在默认页，再点还是默认页')
}

// ── ③ 聊天页在 onShow / onUnload 记自己 ─────────────────────────
{
  const memo = freshRequire('../utils/ai-last-session')
  const chatSource = fs.readFileSync(
    path.join(root, 'subpackages/ai/chat/chat.js'),
    'utf8'
  )
  // 直接把两个生命周期的实现摘出来跑：整页 Page 配置要拉起插件/接口/布局，
  // 这个用例只关心「谁在什么时刻写了记忆」，不必把整页跑起来。
  assert.ok(
    /onShow\(\)\s*\{[\s\S]*?this\.rememberAsLastAiPage\(\)/.test(chatSource),
    'onShow 必须把本页记成「上次离开 AI 的位置」（栈里叠了多页聊天页时，靠它把记录抢回可见的那页）'
  )
  assert.ok(
    /onUnload\(\)\s*\{[\s\S]*?if \(!this\.hasOtherChatPageInStack\(\)\) \{\s*this\.rememberAsLastAiPage\(\)/.test(
      chatSource
    ),
    'onUnload 只在「栈里没有别的聊天页」时才记：否则记的是用户已经离开的那一页'
  )

  // 行为层：拿一个最小的假页面实例验两条分支
  const page = {
    data: { sessionId: 'sess-a', sessionTitle: '标题A' },
    rememberAsLastAiPage() {
      memo.remember(this.data.sessionId, this.data.sessionTitle)
    },
    hasOtherChatPageInStack() {
      return this._other
    }
  }
  const unload = other => {
    page._other = other
    if (!page.hasOtherChatPageInStack()) {
      page.rememberAsLastAiPage()
    }
  }

  memo.forget()
  unload(false) // 直接退回首页/我的
  assert.equal(memo.get().sessionId, 'sess-a', '离开 AI 时记下当前会话')

  memo.remember('sess-below', '下层那页')
  unload(true) // 退回下层聊天页：记录归下层那页，本页不许覆盖
  assert.equal(
    memo.get().sessionId,
    'sess-below',
    '退回下层聊天页时不能把记录改成正在销毁的这一页'
  )
}

// ── ④ 会话被删：记忆一并清掉 ────────────────────────────────────
{
  const sessionsSource = fs.readFileSync(
    path.join(root, 'subpackages/ai/sessions/sessions.js'),
    'utf8'
  )
  assert.ok(
    /aiLastSession\.forget\(session\.sessionId\)/.test(sessionsSource),
    '删会话时必须清掉指向它的路由记忆，否则下次点 AI 图标会打开一条已删会话'
  )
}

console.log('ai-last-session.test.js 全部通过')
