// BoltStar AI（星宝）第三方接口层。文档：assets/ai/BoltStar-API-Doc-v2-1.0.3.md
//
// 与 utils/request.js 分开的原因：AI 服务是独立的第三方（阿里云 FC），Base URL、响应结构
// （success/code/data/params/detail）、错误码体系都与 BoltFox 后端不同，公共参数（token/language 头）
// 也不适用，硬塞进 request.js 反而两边互相迁就。错误统一 reject { code, params, detail }，
// 由 utils/ai-i18n.handleAiError 按语种/区间分发提示。
//
// ⚠️ 小程序 wx.request 不支持 SSE/ReadableStream，只能走「非流式」URL + 客户端打字机
//（文档 §四）。流式 URL 仅留作 Web/Flutter 参考。
const NON_STREAM_BASE_URL = 'https://boltstaat-agent-fwdomalzks.ap-southeast-1.fcapp.run'
const STREAM_BASE_URL = 'https://boltstagent-web-jncfttrxvt.ap-southeast-1.fcapp.run' // 小程序不可用，勿在本文件内使用

// 普通接口 15s；/chat 与 /image/enhance 涉及生图（上游文生图可能 30s+），放宽到 120s 且不重试
const DEFAULT_TIMEOUT = 15000
const GENERATE_TIMEOUT = 120000

// 当前登录用户作为 AI 侧 user_id（同一 user_id 多端历史互通，文档 §5.3.5）。
// 未登录兜底一个固定演示 id，保证 demo 可跑通。
function getAiUserId() {
  const app = getApp()
  const user =
    (app && app.globalData && app.globalData.userInfo) ||
    wx.getStorageSync('userInfo') ||
    {}
  const id = user.id || user.userNo || user.userId
  return id ? `boltfox_${id}` : 'boltfox_demo_user'
}

// 基础请求：resolve 整个响应体 { success, code, data }（code=10001「历史已过期」这类
// 成功但带语义的场景需要调用方看 code，所以不只回 data）；
// 失败（success=false / HTTP 非 200 / 网络错误）reject { code, params, detail }。
// 返回的 promise 挂了 .abort()，供「终止 AI 回复」用（文档 §5.3.4）。
function aiRequest(options) {
  let task = null
  const promise = new Promise((resolve, reject) => {
    task = wx.request({
      url: `${NON_STREAM_BASE_URL}${options.url}`,
      method: options.method || 'POST',
      data: options.data,
      timeout: options.timeout || DEFAULT_TIMEOUT,
      header: { 'Content-Type': 'application/json' },
      success(res) {
        const body = res.data
        if (res.statusCode === 200 && body && body.success) {
          resolve(body)
          return
        }
        if (body && body.code) {
          reject({ code: body.code, params: body.params, detail: body.detail })
          return
        }
        // 非标响应（网关 502 等）归为上游错误
        reject({ code: 30001, detail: `HTTP ${res.statusCode}` })
      },
      fail(err) {
        const msg = (err && err.errMsg) || ''
        // abort 是用户主动终止，用专有 code 让调用方静默处理，不弹错误提示
        if (msg.indexOf('abort') > -1) {
          reject({ code: 'ABORTED' })
          return
        }
        // 网络失败/超时归为「响应超时」30002，提示语可重试
        reject({ code: 30002, detail: msg })
      }
    })
  })
  promise.abort = () => {
    if (task && typeof task.abort === 'function') {
      task.abort()
    }
  }
  return promise
}

module.exports = {
  STREAM_BASE_URL,
  NON_STREAM_BASE_URL,
  getAiUserId,

  // POST /session/new — 新建会话，resolve session 对象 { session_id, title, ... }
  newSession() {
    return aiRequest({
      url: '/session/new',
      data: { user_id: getAiUserId() }
    }).then(body => body.data.session)
  },

  // GET /session/list — 会话列表（按更新时间倒序），resolve sessions 数组
  listSessions() {
    return aiRequest({
      url: `/session/list?user_id=${encodeURIComponent(getAiUserId())}`,
      method: 'GET'
    }).then(body => (body.data && body.data.sessions) || [])
  },

  // DELETE /session — 删除会话（含全部历史，不可恢复）
  deleteSession(sessionId) {
    return aiRequest({
      url: '/session',
      method: 'DELETE',
      data: { user_id: getAiUserId(), session_id: sessionId }
    })
  },

  // GET /chat/history — 拉取历史（时间倒序分页）。
  // resolve { expired, list, total }；expired=true 即 code=10001（超 7 天自动清除，
  // 调用方 toast info.10001）。list 里 role=assistant 且 content 以 http 开头 = 图片。
  getHistory(sessionId, page = 1, pageSize = 20) {
    const query = [
      `user_id=${encodeURIComponent(getAiUserId())}`,
      `session_id=${encodeURIComponent(sessionId)}`,
      `page=${page}`,
      `page_size=${pageSize}`
    ].join('&')
    return aiRequest({
      url: `/chat/history?${query}`,
      method: 'GET'
    }).then(body => ({
      expired: body.code === 10001,
      list: (body.data && body.data.data) || [],
      total: (body.data && body.data.total) || 0
    }))
  },

  // DELETE /chat/history — 删除单条消息
  deleteMessage(sessionId, messageId) {
    return aiRequest({
      url: '/chat/history',
      method: 'DELETE',
      data: { user_id: getAiUserId(), session_id: sessionId, message_id: messageId }
    })
  },

  // DELETE /chat/history/clear — 清空会话消息（会话本身保留）
  clearHistory(sessionId) {
    return aiRequest({
      url: '/chat/history/clear',
      method: 'DELETE',
      data: { user_id: getAiUserId(), session_id: sessionId }
    })
  },

  // POST /chat（非流式）— 对话/生图/图文多模态。resolve { text, images }。
  // params: { sessionId, message, imgOrientation(必传: vertical/horizontal/square),
  //           imgStyle(可选: cartoon/landscape/portrait/anime 触发一键生图), newSession, temperature,
  //           imageUrls(可选: 图片 URL 数组，最多 4 张；文档 v1.0.3 §二「图片支持」——
  //             1 张+生图关键词=图生图美化 / 多张+关键词=友好拒绝 / 其余=AI 分析讨论，均由服务端分流) }
  // 返回的 promise 带 .abort()，页面「停止生成」时调用。
  chat(params) {
    const data = {
      user_id: getAiUserId(),
      session_id: params.sessionId,
      message: params.message,
      img_orientation: params.imgOrientation
    }
    if (params.imgStyle) {
      data.img_style = params.imgStyle
    }
    // 图文多模态：带上用户上传的图片 URL（服务端按张数+关键词决定图生图/讨论/拒绝）。
    // 超 4 张服务端回 20012，前端已在选图时拦截，这里不再截断。
    if (Array.isArray(params.imageUrls) && params.imageUrls.length) {
      data.image_urls = params.imageUrls
    }
    if (params.newSession) {
      data.new_session = true
    }
    if (params.temperature !== undefined) {
      data.temperature = params.temperature
    }
    const req = aiRequest({
      url: '/chat',
      data,
      timeout: GENERATE_TIMEOUT
    })
    const promise = req.then(body => ({
      text: (body.data && body.data.text) || '',
      images: (body.data && body.data.images) || []
    }))
    promise.abort = req.abort
    return promise
  },

  // POST /image/enhance — 图片美化（图生图）。imageUrl 须是可公网访问的 URL（先经
  // api.setFileUpload 上传原图拿 URL）。resolve 美化后图片 URL。
  enhanceImage(imageUrl, prompt) {
    const data = { user_id: getAiUserId(), image_url: imageUrl }
    if (prompt) {
      data.prompt = prompt
    }
    const req = aiRequest({
      url: '/image/enhance',
      data,
      timeout: GENERATE_TIMEOUT
    })
    const promise = req.then(body => (body.data && body.data.image) || '')
    promise.abort = req.abort
    return promise
  }
}
