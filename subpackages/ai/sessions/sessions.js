// AI 会话列表页 —— 时间倒序、按日期分组、每页 20 条滚动加载、左滑/长按删除单条、新建会话。
// 数据仅保留最近 7 天（后端策略）。
//
// 与聊天页怎么联动（2026-07-25 重做，用户要求「从会话列表进去要能原路径返回」）：
//   ① 点某条会话 / 点「新建对话」→ **navigateTo 新开一个聊天页**（见 goChat）。本页因此留在
//      页面栈里，新聊天页的返回键就原路退回本列表，再返回才回到进来时的那个聊天页。
//      老实现是 Storage(aiOpenSession) + navigateBack：本页被弹出栈、下层聊天页就地换会话，
//      于是「返回」直接退出了 AI，而且点「新建对话」还会把下层那段对话从界面上抹掉。
//   ② 页面栈快满（微信上限 10 层）或 navigateTo 失败 → 降级回老路子（就地改下层聊天页 +
//      navigateBack），只是返回键又变成直接退出。见 goChat 的 degrade。
//   ③ 删掉的会话正被某个聊天页打开着 → 直接调那个页面实例的 resetFromList()，
//      **不再用 Storage 传全局标记**（会误伤新开的聊天页，理由见 chat.js resetFromList 上方注释）。
// ⚠️ 若后续 UI 改成「聊天页内左侧抽屉」，本页连同上面这套跨页协议可以整体删掉。
//
// ⚠️ 2026-07-25 本模块**没有也不要再加**任何「清空」入口：接口无批量删除能力，只能逐条打
//    DELETE /session（最坏 20 个串行请求），中途失败还会留下删一半且无法回滚的状态。
//    要清理一律长按逐条删（列表底部已有「长按会话可删除」提示）。
const aiApi = require('../../../utils/ai-api')
const aiI18n = require('../../../utils/ai-i18n')
const system = require('../../../utils/system')
const toast = require('../../../utils/toast')
const fold = require('../../../utils/fold-adapt')

const PAGE_SIZE = 20
// 删除图是 136×112 的完整圆角按钮；多留 16rpx 间距，让它像 APP 一样与滑开的卡片分离。
const DELETE_REVEAL_RPX = 152

const CHAT_ROUTE = 'subpackages/ai/chat/chat'

// 到这个页面栈深度就不再叠聊天页（微信硬上限 10 层）。留一层余量：聊天页里还能再开投屏预览、
// 绑定设备等页面，撞上上限的表现是 navigateTo 静默失败、点了没反应。
const PAGE_STACK_SOFT_LIMIT = 9

// 本页正下方那一页若是聊天页就返回它（本列表只能从聊天页进来，正常一定命中）。
// 降级路径要就地改它，「当前」标记也是指它打开着的会话。
function chatPageBelow() {
  const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : []
  const previous = pages.length >= 2 ? pages[pages.length - 2] : null
  return previous && previous.route === CHAT_ROUTE ? previous : null
}

// 页面栈里所有聊天页：删会话时要精确通知「正打开这条会话」的那一页（可能不止下方那一页）
function chatPagesInStack() {
  const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : []
  return pages.filter(page => page && page.route === CHAT_ROUTE)
}

// 「N 条消息」补数的并发上限（2026-07-25）。
// 背景：/session/list 回来的 msg_count 恒为 0（排查结论见 docs/changes/2026-07-24-AI模块开发进度.md，
// **前端取值无误**——同一个 item 里的 title/updated_at 都显示正常，只有 msg_count 是 0），
// 只能拿 /chat/history 的 total 兜底。代价是 N+1 请求，所以严格限制：
// 只补**当前已渲染出来的那几行**、page_size=1 只要 total、并发 ≤ 本值、失败静默、每条只试一次。
// ⚠️ 后端把 msg_count 修好后，把 fillMsgCounts/_counted 及两处调用一并删掉即可（自动回落到接口值）。
const HISTORY_FILL_CONCURRENCY = 4

// ISO 时间 → 卡片右侧只显示 HH:mm；日期由列表分组标题承载。
function formatTime(iso) {
  const date = new Date(iso)
  if (isNaN(date.getTime())) {
    return ''
  }
  const pad = n => (n < 10 ? `0${n}` : `${n}`)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function dateKey(iso) {
  const date = new Date(iso)
  if (isNaN(date.getTime())) {
    return 'unknown'
  }
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`
}

function dateLabel(iso) {
  const date = new Date(iso)
  if (isNaN(date.getTime())) {
    return '更早'
  }
  const now = new Date()
  if (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  ) {
    return '今天'
  }
  return `${date.getMonth() + 1}月${date.getDate()}日`
}

// 只给每个日期分组的第一条写 groupLabel，WXML 仍可保持单层循环，分页/补数逻辑无需改形态。
function decorateGroups(list) {
  let previousKey = ''
  return (list || []).map(item => {
    const firstInGroup = item.dateKey !== previousKey
    previousKey = item.dateKey
    return Object.assign({}, item, {
      groupLabel: firstInGroup ? item.dateLabel : ''
    })
  })
}

function getDeleteRevealWidth() {
  try {
    const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    return Math.round(((info.windowWidth || 375) * DELETE_REVEAL_RPX) / 750)
  } catch (error) {
    return 76
  }
}

// 折叠屏/分屏适配：Page 配置外面包一层 fold.adapt（方案见 utils/fold-adapt.js 与
// styles/fold-adapt.wxss）。只叠加「形态变化后重测状态栏/安全区」等钩子，页面原有配置一字不改。
Page(fold.adapt({
  data: {
    statusBarHeight: 20,
    safeBottom: 0,
    loading: true,
    sessions: [], // 当前已展示（分页追加）
    hasMore: false,
    currentId: '', // 聊天页当前会话，高亮标记
    openedSessionId: '', // 左滑后当前露出删除按钮的会话
    swipingSessionId: '', // 正随手指移动的会话
    swipeTransform: ''
  },

  onLoad(options) {
    this.setData(Object.assign({ currentId: (options && options.current) || '' }, system.getLayoutMetrics()))
    this._all = [] // 接口一次回全部，前端按 20 条/页分段展示（需求分页交互）
    this._counted = {} // sessionId → 已试过补数（不论成败只试一次，防翻页来回反复打接口）
    this._navigating = false // 在途的跳转，防连点叠出两页聊天页
    this._lastOpened = '' // 上次从本页打开的会话：退回本页时只重新补它的条数（它才刚变过）
    this._deleteActionWidth = getDeleteRevealWidth()
    this._swipeStart = null
    this._swipeDelta = null
    this._swipeAxis = ''
    this._swipeOffset = 0
    this._suppressTapUntil = 0
    this.loadSessions()
  },

  // 本页现在会留在页面栈里（点会话是新开聊天页，见 goChat），用户聊完退回来时标题/时间/条数
  // 都可能变了，所以每次重新可见都静默刷一遍。首次 onShow 紧跟 onLoad，跳过以免重复请求。
  onShow() {
    this._navigating = false
    if (this.data.openedSessionId || this.data.swipingSessionId) {
      this.setData({
        openedSessionId: '',
        swipingSessionId: '',
        swipeTransform: ''
      })
    }
    if (!this._shownOnce) {
      this._shownOnce = true
      return
    }
    if (this._lastOpened) {
      delete this._counted[this._lastOpened] // 刚聊过的那条条数肯定变了，允许再补一次
    }
    this.loadSessions(true)
  },

  // silent=true：静默刷新（不显示整页 loading、失败也不打扰），用于退回本页时对齐最新数据
  async loadSessions(silent) {
    if (!silent) {
      this.setData({ loading: true })
    }
    try {
      const sessions = await aiApi.listSessions()
      // 已经补到的条数带过来：接口的 msg_count 恒为 0（见 HISTORY_FILL_CONCURRENCY 注释），
      // 不带就会把补好的条数刷没了，还得再打一轮 /chat/history。
      // 只带 _counted 里还认账的那些：onShow 会把「刚聊过那条」从 _counted 里删掉，
      // 于是它这里也不被带过来 → msgCount 归 0 → fillMsgCounts 会重新补它的真实条数。
      const counted = {}
      this._all.forEach(item => {
        if (item.msgCount && this._counted[item.sessionId]) {
          counted[item.sessionId] = item.msgCount
        }
      })
      this._all = decorateGroups(
        sessions.map(item => {
          const timestamp = item.updated_at || item.created_at
          return {
            sessionId: item.session_id,
            title: item.title || '新对话',
            msgCount: item.msg_count || counted[item.session_id] || 0,
            timeText: formatTime(timestamp),
            dateKey: dateKey(timestamp),
            dateLabel: dateLabel(timestamp)
          }
        })
      )
      // 静默刷新保持用户已翻到的行数，别把人拉回第一页
      const shown = Math.max(PAGE_SIZE, this.data.sessions.length)
      this.setData({
        loading: false,
        sessions: this._all.slice(0, shown),
        hasMore: this._all.length > shown
      })
      this.fillMsgCounts() // 不 await：列表先出来，条数补到了再刷一次
    } catch (error) {
      if (silent) {
        return // 静默刷新失败就保持旧列表，不打扰用户（下次退回本页还会再试）
      }
      this.setData({ loading: false })
      aiI18n.handleAiError(error, { onRetry: () => this.loadSessions() })
    }
  },

  // 滚动到底自动加载下一页
  onReachBottom() {
    if (!this.data.hasMore) {
      return
    }
    const next = this._all.slice(0, this.data.sessions.length + PAGE_SIZE)
    this.setData({ sessions: next, hasMore: this._all.length > next.length })
    this.fillMsgCounts() // 新露出来的几行也补
  },

  // 给 msg_count=0 的行补真实条数：逐条拿 /chat/history 的 total（page_size=1，只要 total 不要内容）。
  // 只处理**已渲染出来的行**，并发 HISTORY_FILL_CONCURRENCY 条，失败静默——补数只是锦上添花，
  // 挂了也不该影响列表本身。结果攒齐后**只 setData 一次**（逐条刷会打出十几次 setData）。
  async fillMsgCounts() {
    const targets = this.data.sessions.filter(
      item => !item.msgCount && !this._counted[item.sessionId]
    )
    if (!targets.length) {
      return
    }
    const found = {}
    let cursor = 0
    const worker = async () => {
      while (cursor < targets.length) {
        const session = targets[cursor++]
        this._counted[session.sessionId] = true
        try {
          const history = await aiApi.getHistory(session.sessionId, 1, 1)
          if (history.total > 0) {
            found[session.sessionId] = history.total
          }
        } catch (error) {
          // 静默：补不到就继续显示「只有时间、不带条数」，见 sessions.wxml 的 session-meta
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(HISTORY_FILL_CONCURRENCY, targets.length) }, worker)
    )
    if (!Object.keys(found).length) {
      return
    }
    // _all 与已渲染的 sessions 都要写回：只改后者的话，翻页重切片会把补到的条数又抹掉
    const patch = list =>
      list.map(item =>
        found[item.sessionId] ? Object.assign({}, item, { msgCount: found[item.sessionId] }) : item
      )
    this._all = patch(this._all)
    this.setData({ sessions: patch(this.data.sessions) })
  },

  // 「去聊天页」的唯一出口（点会话 / 点新建对话共用），见文件头 ①②。
  // applyToBelow(page)：降级时怎么就地改下层那个聊天页。
  goChat(query, applyToBelow) {
    if (this._navigating) {
      return // 连点去重：两次 navigateTo 就叠出两页聊天页
    }
    const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : []
    const below = chatPageBelow()
    const degrade = () => {
      if (!below) {
        toast.warn({ title: '页面层级已达上限，请先返回上一页' })
        return
      }
      applyToBelow(below)
      this._navigating = true
      wx.navigateBack()
    }
    if (pages.length >= PAGE_STACK_SOFT_LIMIT) {
      degrade()
      return
    }
    this._navigating = true
    wx.navigateTo({
      url: `/subpackages/ai/chat/chat${query}`,
      fail: () => {
        this._navigating = false
        degrade()
      }
    })
  },

  sessionFromEvent(event) {
    const id = event.currentTarget.dataset.id
    return this.data.sessions.find(item => item.sessionId === id)
  },

  // 点击会话：新开一页聊天页载入这条会话的历史（返回键即原路退回本列表）
  onSessionTap(event) {
    if (Date.now() < this._suppressTapUntil) {
      return
    }
    const session = this.sessionFromEvent(event)
    if (!session || this._navigating) {
      return // 连点去重：navigateBack 那条分支连点两次会一路退过头（把下层聊天页也弹掉）
    }
    if (this.data.openedSessionId) {
      this.setData({ openedSessionId: '' })
      return
    }
    // 点的正是下层聊天页已经打开的那条（列表里带「当前」标记的）：没必要再叠一页一样的，直接退回去
    if (session.sessionId && session.sessionId === this.data.currentId) {
      this._navigating = true
      wx.navigateBack()
      return
    }
    this._lastOpened = session.sessionId
    this.goChat(
      `?sessionId=${session.sessionId}&title=${encodeURIComponent(session.title || '')}`,
      below => {
        below.applySessionFromList(session.sessionId, session.title)
        this.setData({ currentId: session.sessionId }) // 下层换了会话，「当前」标记跟着走
      }
    )
  },

  // 左滑露出删除按钮：横向手势实时跟随，松手按距离/速度吸附；纵向滚动不接管。
  onSessionTouchStart(event) {
    const touch = event.touches && event.touches[0]
    if (!touch) {
      return
    }
    this._swipeStart = {
      id: event.currentTarget.dataset.id,
      x: touch.clientX,
      y: touch.clientY,
      offset:
        this.data.openedSessionId === event.currentTarget.dataset.id
          ? -this._deleteActionWidth
          : 0,
      time: Date.now()
    }
    this._swipeDelta = { x: 0, y: 0 }
    this._swipeAxis = ''
    this._swipeOffset = this._swipeStart.offset
  },

  onSessionTouchMove(event) {
    const touch = event.touches && event.touches[0]
    if (!touch || !this._swipeStart) {
      return
    }
    this._swipeDelta = {
      x: touch.clientX - this._swipeStart.x,
      y: touch.clientY - this._swipeStart.y
    }
    if (!this._swipeAxis) {
      if (Math.max(Math.abs(this._swipeDelta.x), Math.abs(this._swipeDelta.y)) < 6) {
        return
      }
      this._swipeAxis =
        Math.abs(this._swipeDelta.x) > Math.abs(this._swipeDelta.y) ? 'horizontal' : 'vertical'
    }
    if (this._swipeAxis !== 'horizontal') {
      return
    }

    const offset = Math.max(
      -this._deleteActionWidth,
      Math.min(0, this._swipeStart.offset + this._swipeDelta.x)
    )
    this._swipeOffset = offset
    this._suppressTapUntil = Date.now() + 260
    this.setData({
      openedSessionId: '',
      swipingSessionId: this._swipeStart.id,
      swipeTransform: `transform: translate3d(${Math.round(offset)}px, 0, 0);`
    })
  },

  onSessionTouchEnd(event) {
    const start = this._swipeStart
    let delta = this._swipeDelta || { x: 0, y: 0 }
    const touch = event.changedTouches && event.changedTouches[0]
    if (start && touch) {
      delta = {
        x: touch.clientX - start.x,
        y: touch.clientY - start.y
      }
    }
    this._swipeStart = null
    this._swipeDelta = null
    const axis = this._swipeAxis
    this._swipeAxis = ''
    if (!start || axis !== 'horizontal') {
      return
    }

    const elapsed = Math.max(1, Date.now() - start.time)
    const velocity = delta.x / elapsed
    const shouldOpen =
      velocity < -0.35 ||
      (velocity <= 0.35 && this._swipeOffset <= -this._deleteActionWidth * 0.42)
    this._suppressTapUntil = Date.now() + 260
    this.setData({
      openedSessionId: shouldOpen ? start.id : '',
      swipingSessionId: '',
      swipeTransform: ''
    })
  },

  onSessionDeleteTap(event) {
    const session = this.sessionFromEvent(event)
    if (session) {
      this.deleteSession(session)
    }
  },

  // 长按作为不熟悉左滑手势时的无障碍兜底。
  onSessionLongPress(event) {
    const session = this.sessionFromEvent(event)
    if (!session) {
      return
    }
    wx.showActionSheet({
      itemList: ['删除该会话'],
      itemColor: '#d64541',
      success: () => this.deleteSession(session)
    })
  },

  async deleteSession(session) {
    try {
      await aiApi.deleteSession(session.sessionId)
      const shown = this.data.sessions.length
      this._all = decorateGroups(
        this._all.filter(item => item.sessionId !== session.sessionId)
      )
      this.setData({
        sessions: this._all.slice(0, shown),
        hasMore: this._all.length > shown,
        openedSessionId: '',
        swipingSessionId: '',
        swipeTransform: ''
      })
      toast.show({ title: '已删除', icon: 'none' })
      // 删的是某个聊天页正打开的会话：只通知那一页退回空态，避免用户继续往已删会话发消息。
      // 点对点调页面实例，不用 Storage 传全局标记（会误伤别的聊天页，见文件头 ③）；
      // 也**不替他建新会话** —— 这是「没得可显示了」，不是用户要新建（建会话只认「首次发送」）。
      chatPagesInStack()
        .filter(page => page.data && page.data.sessionId === session.sessionId)
        .forEach(page => page.resetFromList())
      if (session.sessionId === this.data.currentId) {
        this.setData({ currentId: '' })
      }
      if (session.sessionId === this._lastOpened) {
        this._lastOpened = ''
      }
    } catch (error) {
      aiI18n.handleAiError(error)
    }
  },

  // 新建对话：新开一页空聊天页（＝AI 默认首页的招呼语），返回键同样原路退回本列表。
  // 这里**不建会话**（新聊天页不带 sessionId 进去也不建）——会话统一等首次发送时才建，
  // 所以也没有「会话数已达上限」可拦：真到 20 条上限，是首次发送时接口回 20013，
  // 由 chat.createSession 的 onSessionLimit 引导用户回本页清理。
  createNew() {
    if (this._navigating) {
      return // 同 onSessionTap：连点会一路退过头
    }
    // 下层本来就是一张还没开口的「新对话」空页：直接退回去，别再叠一页一样的
    const below = chatPageBelow()
    if (below && below.isPristineNewSession()) {
      this._navigating = true
      wx.navigateBack()
      return
    }
    this._lastOpened = ''
    this.goChat('', page => {
      page.resetFromList() // 降级路径才会走到：把下层聊天页就地退回空态（老行为）
      this.setData({ currentId: '' })
    })
  }
}))
