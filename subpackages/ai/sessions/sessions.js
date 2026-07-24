// AI 会话列表页 —— 需求「会话列表管理」：时间倒序、标题=首条消息、每页 20 条滚动加载、
// 长按删除单条、清空全部（二次确认）、新建会话。数据仅保留最近 7 天（后端策略）。
// 选中/新建通过 Storage(aiOpenSession) 传回聊天页（chat.onShow 消费）。
const aiApi = require('../../../utils/ai-api')
const aiI18n = require('../../../utils/ai-i18n')
const system = require('../../../utils/system')
const toast = require('../../../utils/toast')

const PAGE_SIZE = 20

// ISO 时间 → 列表友好展示：今天显示 HH:mm，其余显示 MM-DD HH:mm
function formatTime(iso) {
  const date = new Date(iso)
  if (isNaN(date.getTime())) {
    return ''
  }
  const now = new Date()
  const pad = n => (n < 10 ? `0${n}` : `${n}`)
  const hm = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  return sameDay ? hm : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${hm}`
}

Page({
  data: {
    statusBarHeight: 20,
    safeBottom: 0,
    loading: true,
    sessions: [], // 当前已展示（分页追加）
    hasMore: false,
    currentId: '' // 聊天页当前会话，高亮标记
  },

  onLoad(options) {
    this.setData(Object.assign({ currentId: (options && options.current) || '' }, system.getLayoutMetrics()))
    this._all = [] // 接口一次回全部，前端按 20 条/页分段展示（需求分页交互）
    this.loadSessions()
  },

  async loadSessions() {
    this.setData({ loading: true })
    try {
      const sessions = await aiApi.listSessions()
      this._all = sessions.map(item => ({
        sessionId: item.session_id,
        title: item.title || '新对话',
        msgCount: item.msg_count || 0,
        timeText: formatTime(item.updated_at || item.created_at)
      }))
      this.setData({
        loading: false,
        sessions: this._all.slice(0, PAGE_SIZE),
        hasMore: this._all.length > PAGE_SIZE
      })
    } catch (error) {
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
  },

  // 点击会话：传回聊天页载入历史
  onSessionTap(event) {
    const index = event.currentTarget.dataset.index
    const session = this.data.sessions[index]
    if (!session) {
      return
    }
    wx.setStorageSync('aiOpenSession', { sessionId: session.sessionId, title: session.title })
    wx.navigateBack()
  },

  // 长按删除单条（需求：左滑或长按，取长按实现）
  onSessionLongPress(event) {
    const index = event.currentTarget.dataset.index
    const session = this.data.sessions[index]
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
      this._all = this._all.filter(item => item.sessionId !== session.sessionId)
      this.setData({
        sessions: this.data.sessions.filter(item => item.sessionId !== session.sessionId)
      })
      toast.show({ title: '已删除', icon: 'none' })
      // 删的是聊天页正打开的会话：让聊天页回到新会话，避免继续往已删会话发消息
      if (session.sessionId === this.data.currentId) {
        wx.setStorageSync('aiOpenSession', { newSession: true })
      }
    } catch (error) {
      aiI18n.handleAiError(error)
    }
  },

  // 清空所有会话（二次确认后逐个删除——接口无批量删除）
  clearAll() {
    if (!this._all.length) {
      return
    }
    wx.showModal({
      title: '清空所有会话',
      content: '将删除全部会话及聊天记录，且不可恢复，确定清空？',
      confirmText: '清空',
      confirmColor: '#d64541',
      success: async res => {
        if (!res.confirm) {
          return
        }
        wx.showLoading({ title: '清空中', mask: true })
        try {
          for (const session of this._all) {
            await aiApi.deleteSession(session.sessionId)
          }
          wx.hideLoading()
          this._all = []
          this.setData({ sessions: [], hasMore: false })
          wx.setStorageSync('aiOpenSession', { newSession: true })
          toast.show({ title: '已清空', icon: 'none' })
        } catch (error) {
          wx.hideLoading()
          // 部分删除成功也要刷新剩余列表，如实展示
          aiI18n.handleAiError(error)
          this.loadSessions()
        }
      }
    })
  },

  // 新建会话：回聊天页并重置为默认界面
  createNew() {
    wx.setStorageSync('aiOpenSession', { newSession: true })
    wx.navigateBack()
  }
})
