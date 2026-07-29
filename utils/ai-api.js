// BoltStar AI（星宝）第三方接口层。文档：docs/reference/ai/BoltStar-API-Doc-v2-1.0.4.md（当前对接版本）
//
// 与 utils/request.js 分开的原因：AI 服务是独立的第三方（阿里云 FC），Base URL、响应结构
// （success/code/data/params/detail）、错误码体系都与 BoltFox 后端不同，公共参数（token/language 头）
// 也不适用，硬塞进 request.js 反而两边互相迁就。错误统一 reject { code, params, detail }；
//
// 鉴权（2026-07-29 起网关强制）：每个请求带 `Authentication: Bearer <jwtToken>` 头，
// jwtToken 来自 BoltFox 登录接口 setWechatAppLogin 的下发（app.js 存 storage『jwtToken』），
// 与 request.js 打给 BoltFox 后端的是同一枚、同一个头名（注意是 Authentication 不是 Authorization）。
// 缺失时网关直接 403 { Code: 'JWTTokenIsMissing' }，由下方白名单转成可展示文案。
// 已确认可安全展示的固定网关错误额外带 userMessage，
// 由 utils/ai-i18n.handleAiError 按语种/区间分发提示。
//
// ⚠️ 小程序 wx.request 不支持 SSE/ReadableStream，只能走「非流式」URL + 客户端打字机
//（文档 §四）。流式 URL 仅留作 Web/Flutter 参考。
const NON_STREAM_BASE_URL = 'https://boltstaat-agent-fwdomalzks.ap-southeast-1.fcapp.run'
const STREAM_BASE_URL = 'https://boltstagent-web-jncfttrxvt.ap-southeast-1.fcapp.run' // 小程序不可用，勿在本文件内使用

// 普通接口 15s；/chat 与 /image/enhance 涉及生图（上游文生图可能 30s+），放宽到 120s 且不重试
const DEFAULT_TIMEOUT = 15000
const GENERATE_TIMEOUT = 120000

// 阿里云网关在 JWT 缺失时返回的是大写字段，和 BoltStar 的
// { success, code, data, params, detail } 业务协议完全不同。只对白名单中的固定
// Code + Message 生成可展示文案，避免把其它未知网关响应或 detail 泄露给用户。
const JWT_TOKEN_MISSING_CODE = 'JWTTokenIsMissing'
const JWT_TOKEN_MISSING_MESSAGE = 'the jwt token is missing'

function parseResponseBody(data) {
  if (typeof data !== 'string') {
    return data
  }
  try {
    return JSON.parse(data)
  } catch (error) {
    return data
  }
}

function gatewayErrorMessage(body) {
  if (
    !body ||
    typeof body !== 'object' ||
    body.Code !== JWT_TOKEN_MISSING_CODE ||
    body.Message !== JWT_TOKEN_MISSING_MESSAGE
  ) {
    return ''
  }
  const requestId =
    body.RequestId === undefined || body.RequestId === null
      ? ''
      : String(body.RequestId).trim()
  return `JWTTokenIsMissing：the jwt token is missing${
    requestId ? `（RequestId: ${requestId}）` : ''
  }`
}

// 与 app.js 一致：内存(globalData)优先、storage 兜底。每次请求现取，登录/退出后无需重启生效。
function getJwtToken() {
  const app = typeof getApp === 'function' ? getApp() : null
  return (
    (app && app.globalData && app.globalData.jwtToken) ||
    wx.getStorageSync('jwtToken') ||
    ''
  )
}

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
  const header = { 'Content-Type': 'application/json' }
  const jwtToken = getJwtToken()
  // 未登录（无 jwtToken）不带头照发：网关会回 JWTTokenIsMissing，走白名单提示，不在端上另造错误
  if (jwtToken) {
    header.Authentication = `Bearer ${jwtToken}`
  }
  const promise = new Promise((resolve, reject) => {
    task = wx.request({
      url: `${NON_STREAM_BASE_URL}${options.url}`,
      method: options.method || 'POST',
      data: options.data,
      timeout: options.timeout || DEFAULT_TIMEOUT,
      header,
      success(res) {
        const body = parseResponseBody(res.data)
        const gatewayMessage = gatewayErrorMessage(body)
        if (gatewayMessage) {
          reject({
            code: 31001,
            detail: gatewayMessage,
            userMessage: gatewayMessage
          })
          return
        }
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
  gatewayErrorMessage,

  // POST /session/new — 新建会话，resolve session 对象 { session_id, title, ... }。
  // title 默认「新对话」，后端在首条用户消息后自动填成该消息前 20 字（v1.0.4 §二）。
  // ⚠️ 每个用户最多 20 个会话（v1.0.4 §5.2），超限 reject code=20013 MAX_SESSIONS_REACHED，
  // 由调用方传 onSessionLimit 引导用户去会话列表删旧的（见 ai-i18n.handleAiError）。
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

  // ⚠️ 2026-07-25 起本模块不再提供任何「清空」能力：会话级「清空全部」已下线，
  //    消息级 `clearHistory()`（`DELETE /chat/history/clear`）也一并删除（原本全项目无调用）。
  //    清理一律走逐条删：会话用 deleteSession、消息用 deleteMessage。别再加回来，理由见
  //    docs/changes/2026-07-24-AI模块开发进度.md。

  // POST /chat（非流式）— 对话/生图/图文多模态。resolve { text, images }。
  // params: { sessionId, message, imgOrientation(必传: vertical/horizontal/square),
  //           imgStyle(可选: cartoon/landscape/portrait/anime 触发一键生图), temperature,
  //           imageUrls(可选: 图片 URL 数组，最多 4 张；文档 §二「图片支持」——
  //             1 张+生图关键词=图生图美化 / 多张+关键词=友好拒绝 / 其余=AI 分析讨论，均由服务端分流) }
  // 返回的 promise 带 .abort()，页面「停止生成」时调用。
  //
  // ⚠️ v1.0.4 起 `new_session` 参数**已废弃**：会话是不是新的由后端自己判断，前端不再传。
  // 同时「你好，我是星宝✨」这句自我介绍接口也不再返回了，它是纯前端静态展示
  //（chat.wxml 的 .welcome 区块，仅在 messages 为空时显示），所以 text 里不会再带招呼语前缀。
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
