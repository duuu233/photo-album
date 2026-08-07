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
// 流式（2026-08-06 起，见 assets/BoltStar-SSE-前端接入文档 -改.md，2026-08-07 核对：
// 地址/请求体/事件类型/字段名一律未变，仅新增可选的 model_type，故本文件解析层不动）：
// 服务地址整体切到流式版部署，`/chat` 改用 SSE —— 小程序**可以**收流，靠 `wx.request` 的
// `enableChunked: true` + `RequestTask.onChunkReceived`（基础库 2.20.2 起），此前注释里
// 「小程序不支持 SSE」的结论已作废。请求体、参数、JWT 认证方式与非流式版完全一致，
// 变的只有接收方式：一次性 JSON → 逐个 SSE 事件（pre_text / progress / image / text / done）。
//
// ⚠️ 新域名必须加进小程序后台「开发管理 → 服务器域名 → request 合法域名」，否则真机直接 fail
//（开发者工具勾了「不校验合法域名」时看不出来）。
const BASE_URL = 'https://boltstagent-web-jncfttrxvt.ap-southeast-1.fcapp.run'
// 旧的非流式部署。仅剩一个用途：基础库太老、拿不到 onChunkReceived 时的降级链路（见 chat()）；
// 两个部署是同一套服务、同一份会话数据，降级期间会话/历史不会对不上。
const NON_STREAM_BASE_URL = 'https://boltstaat-agent-fwdomalzks.ap-southeast-1.fcapp.run'

// 普通接口 15s；/chat 与 /image/enhance 涉及生图（上游文生图可能 30s+），放宽到 600s 且不重试
//（2026-08-06 两次上调 120s → 300s → 600s：切流式版后长回复+生图很容易顶到前端这条线，
// 被前端掐断比干等更糟 —— 流式下已经有 pre_text/progress 顶着，用户看得见进度，
// 不需要靠短超时来「早点报错」）。
// ⚠️ 这只是**前端**这一侧的上限。若真机上失败稳定发生在明显更短的时刻（60s/180s 之类），
// 那是上游 FC 函数超时或网关空闲回收先跳了，这个数字再大也没用，得找后端调。
// 判断方法：看 chat.js 失败时打的 `[BoltStar] code=… detail=… elapsed=…ms`。
// ⚠️ 只放宽生成类。建会话/列表/历史这些秒级接口仍是 15s：它们卡住多半是网络或网关的事，
// 让用户对着菊花等 5 分钟没有意义，早点报错还能重试。
const DEFAULT_TIMEOUT = 15000
const GENERATE_TIMEOUT = 600000

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

// 响应结构兜底：流式版部署（2026-08-06 切）实测把 /session/new 的 `data.session` 包装层
// 去掉了 —— 字段直接挂在 data 下，而文档 v1.0.4 §二写的仍是嵌套结构（后端是有意改还是漏改
// 尚未与其确认）。两种都得吃：先按文档取包装层，取不到就把 data 自己当结果。
// /session/list、/chat/history 是同样的「data 里再套一层」结构，一并兜住，
// 别等哪天它们也扁平化了才在真机上炸。isValid 用来判断取到的是不是想要的那个东西。
function unwrapData(body, key, isValid) {
  const data = (body && body.data) || null
  if (!data || typeof data !== 'object') {
    return null
  }
  if (isValid(data[key])) {
    return data[key]
  }
  return isValid(data) ? data : null
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
function buildHeader() {
  const header = { 'Content-Type': 'application/json' }
  const jwtToken = getJwtToken()
  // 未登录（无 jwtToken）不带头照发：网关会回 JWTTokenIsMissing，走白名单提示，不在端上另造错误
  if (jwtToken) {
    header.Authentication = `Bearer ${jwtToken}`
  }
  return header
}

function aiRequest(options) {
  let task = null
  const header = buildHeader()
  const promise = new Promise((resolve, reject) => {
    task = wx.request({
      url: `${options.baseUrl || BASE_URL}${options.url}`,
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

// ==================== SSE（流式 /chat） ====================

// onChunkReceived 给的是 **ArrayBuffer**（不是接入文档示例里的字符串），而且一个汉字的 3 个字节
// 完全可能被切在两个 chunk 之间 —— 直接按 chunk 解码就会吐出半个字的乱码。这里按字节缓存，
// 每次只解出「完整字符」那一段，剩下的残字节留到下一个 chunk 再拼。
function utf8Slice(bytes, end) {
  let out = ''
  let i = 0
  while (i < end) {
    const b = bytes[i]
    if (b < 0x80) {
      out += String.fromCharCode(b)
      i += 1
    } else if (b < 0xc0) {
      i += 1 // 落单的续字节（异常数据），跳过，别卡住循环
    } else if (b < 0xe0) {
      out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f))
      i += 2
    } else if (b < 0xf0) {
      out += String.fromCharCode(
        ((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f)
      )
      i += 3
    } else {
      // 4 字节（emoji 等）→ UTF-16 代理对
      const cp =
        ((b & 0x07) << 18) |
        ((bytes[i + 1] & 0x3f) << 12) |
        ((bytes[i + 2] & 0x3f) << 6) |
        (bytes[i + 3] & 0x3f)
      const offset = cp - 0x10000
      out += String.fromCharCode(0xd800 + (offset >> 10), 0xdc00 + (offset & 0x3ff))
      i += 4
    }
  }
  return out
}

// 末尾若是半个多字符，返回「可安全解码」的字节数（只有最后一个序列可能不完整）
function completeByteLength(bytes) {
  const len = bytes.length
  let start = len - 1
  while (start >= 0 && len - start <= 4 && (bytes[start] & 0xc0) === 0x80) {
    start -= 1
  }
  if (start < 0 || len - start > 4) {
    return len // 全是续字节（异常数据）：整段交出去，由 utf8Slice 兜着
  }
  const lead = bytes[start]
  const need = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4
  return start + need <= len ? len : start
}

function createUtf8Decoder() {
  let pending = null
  return {
    decode(data) {
      if (typeof data === 'string') {
        return data // 少数环境（开发者工具/降级实现）直接给字符串
      }
      if (!data) {
        return ''
      }
      const incoming = new Uint8Array(data)
      let bytes = incoming
      if (pending && pending.length) {
        bytes = new Uint8Array(pending.length + incoming.length)
        bytes.set(pending, 0)
        bytes.set(incoming, pending.length)
      }
      const end = completeByteLength(bytes)
      pending = end < bytes.length ? bytes.slice(end) : null
      return utf8Slice(bytes, end)
    }
  }
}

// 排障用：只留个头 + 总长度。响应体几十 KB，整段灌进 console 既看不清也刷屏。
// 只进 console 和 reject 的 detail（detail 严禁展示给用户，见 ai-i18n.handleAiError）。
function previewText(value, limit = 200) {
  let str = ''
  if (typeof value === 'string') {
    str = value
  } else if (value) {
    try {
      str = JSON.stringify(value)
    } catch (error) {
      str = String(value)
    }
  }
  return str.length > limit ? `${str.slice(0, limit)}…(共 ${str.length} 字符)` : str
}

// SSE 逐行解析：`data: {...}` 一行一个事件。chunk 边界不保证落在行尾，最后一行留着下次拼。
function createSseParser(onEvent) {
  let buffer = ''
  const emit = raw => {
    const line = raw.replace(/\r$/, '')
    if (line.indexOf('data:') !== 0) {
      return // event:/id:/retry:/注释行/空行，本协议用不上
    }
    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') {
      return
    }
    let event = null
    try {
      event = JSON.parse(payload)
    } catch (error) {
      console.warn('[BoltStar] SSE 数据行解析失败', previewText(payload))
      return
    }
    onEvent(event)
  }
  return {
    push(text) {
      if (!text) {
        return
      }
      buffer += text
      const lines = buffer.split('\n')
      buffer = lines.pop() // 最后一行可能不完整
      lines.forEach(emit)
    },
    // 连接结束时把残留的最后一行也吐出去（服务端最后一条没带换行时用得上）
    flush() {
      const rest = buffer
      buffer = ''
      if (rest.trim()) {
        emit(rest)
      }
    }
  }
}

// 服务端把 SSE 的事件分隔符转义成了**字面的「\n」（反斜杠 + n 两个字符）**，整个响应体成了
// 一行、一个真换行都没有 —— 2026-08-06 真机实测：一次完整生图流 2230 字符，解析器一个事件都
// 拿不到，只能报 EMPTY_STREAM，页面就是那张「生成未完成」。SSE 规范要求真换行分隔事件，
// 这是服务端的问题，已反馈后端；在他们修好之前先兜住，修好之后这段自然不会再触发。
//
// ⚠️ 只还原**当分隔符用的**那些 \n —— 即后面紧跟着 `data:`（中间可以再夹几个 \n）或者已经到
// 结尾的。JSON 字符串正文里的 \n（回复文字本身带换行时就长这样）必须原样留着，
// 否则会把一个事件的 JSON 从中间劈开，反而更糟。
const ESCAPED_EVENT_SEPARATOR = /\\n(?=(?:\\n)*(?:data:|$))/g

function unescapeEventSeparators(text) {
  return text.replace(ESCAPED_EVENT_SEPARATOR, '\n')
}

// 流式响应里混进来的**非 SSE** 响应体（网关 403 JSON、服务端直接回业务错误 JSON）
function errorFromBody(body) {
  const gatewayMessage = gatewayErrorMessage(body)
  if (gatewayMessage) {
    return { code: 31001, detail: gatewayMessage, userMessage: gatewayMessage }
  }
  if (body && typeof body === 'object' && body.success === false && body.code) {
    return { code: body.code, params: body.params, detail: body.detail }
  }
  return null
}

// 流式请求。逐个事件回调 onEvent，同时把 text/image 汇总成与非流式 chat() 一样的
// { text, images, orientation } 一并 resolve —— 调用方拿它兜底/校对即可，不必自己攒。
// 失败 reject 的形状与 aiRequest 完全一致（{ code, params, detail, userMessage? }）。
function aiStreamRequest(options) {
  const onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {}
  let task = null
  const promise = new Promise((resolve, reject) => {
    const decoder = createUtf8Decoder()
    const result = { text: '', images: [], orientation: '', done: false }
    let raw = '' // 原始响应文本，只用于「压根不是 SSE」时解析错误体 + 排障
    let eventCount = 0
    let streamError = null
    let settled = false
    const settle = (fn, value) => {
      if (!settled) {
        settled = true
        fn(value)
      }
    }

    const parser = createSseParser(event => {
      if (!event || typeof event !== 'object') {
        return
      }
      eventCount += 1
      switch (event.type) {
        case 'text':
          result.text += String(event.content || '')
          break
        case 'image':
          if (event.content) {
            result.images.push(String(event.content))
          }
          break
        case 'done':
          result.done = true
          result.orientation = event.orientation || result.orientation
          break
        case 'error':
          // 服务端在流里报错（事件形状未在文档中固定，尽量兼容）
          streamError = {
            code: Number(event.code) || 30001,
            detail: event.detail || event.message || event.content || 'stream error'
          }
          break
        default:
          break
      }
      // 回调抛错不能连累整条流（页面 setData 出问题时尤其）
      try {
        onEvent(event)
      } catch (error) {
        console.warn('[BoltStar] SSE 事件处理异常', error)
      }
    })

    task = wx.request({
      url: `${BASE_URL}${options.url}`,
      method: options.method || 'POST',
      data: options.data,
      timeout: options.timeout || GENERATE_TIMEOUT,
      header: buildHeader(),
      enableChunked: true, // ✅ 关键：开启分块传输，回调走 onChunkReceived
      responseType: 'text',
      success(res) {
        // 一个 chunk 都没回调过（个别环境不落实 enableChunked，整段响应一次性给到 success）：
        // 把整段当 SSE 文本补喂一次，照样还原得出事件，不至于白跑一趟。
        if (!raw && !eventCount) {
          const whole = decodeMaybeBuffer(res.data)
          if (typeof whole === 'string' && whole.indexOf('data:') > -1) {
            raw = whole
            parser.push(whole)
          }
        }
        parser.flush()
        if (res.statusCode !== 200) {
          const failure =
            errorFromBody(parseResponseBody(raw)) ||
            errorFromBody(parseResponseBody(decodeMaybeBuffer(res.data)))
          settle(reject, failure || { code: 30001, detail: `HTTP ${res.statusCode}` })
          return
        }
        if (streamError) {
          settle(reject, streamError)
          return
        }
        if (!eventCount) {
          const bodyText = raw || decodeMaybeBuffer(res.data)
          // 最后一搏：分隔符被转义成字面 \n 的话，还原后再解析一遍（见 unescapeEventSeparators）。
          // 只在这条「否则必然失败」的路径上做，正常流一步都不碰。
          if (typeof bodyText === 'string' && ESCAPED_EVENT_SEPARATOR.test(bodyText)) {
            ESCAPED_EVENT_SEPARATOR.lastIndex = 0 // /g 正则的 test 会推进 lastIndex，用完必须归零
            parser.push(unescapeEventSeparators(bodyText))
            parser.flush()
          }
          if (eventCount) {
            console.warn(
              '[BoltStar] 响应体的事件分隔符是字面 \\n 而非真换行（SSE 格式不合规，需后端修）；' +
                `已还原并解析出 ${eventCount} 个事件，本次无逐字流式效果`
            )
            if (streamError) {
              settle(reject, streamError)
              return
            }
            settle(resolve, result)
            return
          }
          // 还原也救不回来：多半是网关/服务端直接回了 JSON（错误体），按它报错。
          // 都不是的话就是响应体形状不对，把开头一并带上，一次就能定位。
          const body = parseResponseBody(bodyText)
          settle(
            reject,
            errorFromBody(body) || {
              code: 30001,
              detail: `EMPTY_STREAM body=${previewText(bodyText)}`
            }
          )
          return
        }
        settle(resolve, result)
      },
      fail(err) {
        const msg = (err && err.errMsg) || ''
        if (msg.indexOf('abort') > -1) {
          settle(reject, { code: 'ABORTED' })
          return
        }
        settle(reject, { code: 30002, detail: msg })
      }
    })

    if (task && typeof task.onChunkReceived === 'function') {
      task.onChunkReceived(chunk => {
        const text = decoder.decode(chunk && chunk.data)
        if (!text) {
          return
        }
        // 原始文本只在「还没解析出任何事件」时留着（用于把非 SSE 的错误体解出来）。
        // 正常流一旦跑起来就别再攒了，几十 KB 的回复没必要在内存里存两份。
        if (!eventCount) {
          raw += text
        }
        parser.push(text)
      })
    }
  })
  promise.abort = () => {
    if (task && typeof task.abort === 'function') {
      task.abort()
    }
  }
  return promise
}

// success 里的 res.data 在 enableChunked 下可能是空串、字符串、已解析的对象，也可能是 ArrayBuffer
function decodeMaybeBuffer(data) {
  if (!data || typeof data === 'string') {
    return data || ''
  }
  if (typeof data === 'object' && typeof data.byteLength === 'number') {
    try {
      return createUtf8Decoder().decode(data)
    } catch (error) {
      return ''
    }
  }
  return data // 基础库已经解析成对象了
}

// /chat 请求体：流式与非流式**完全一致**（接入文档 §五「请求参数完全不动」）
function buildChatPayload(params) {
  const data = {
    user_id: getAiUserId(),
    session_id: params.sessionId,
    message: params.message,
    img_orientation: params.imgOrientation
  }
  if (params.imgStyle) {
    data.img_style = params.imgStyle
  }
  // 生图模型档位（2026-08-07「-改」版文档 §一新增）：lite / pro，**不传即 pro**。
  // 页面暂时没有让用户选档的入口，所以正常情况下这一项不会出现在请求体里，
  // 行为与加这个参数之前完全一致；等真要开放「快出图 / 高质量」再从 chat.js 传下来即可。
  if (params.modelType) {
    data.model_type = params.modelType
  }
  // 图文多模态：带上用户上传的图片 URL（服务端按张数+关键词决定图生图/讨论/拒绝）。
  // 超 4 张服务端回 20012，前端已在选图时拦截，这里不再截断。
  if (Array.isArray(params.imageUrls) && params.imageUrls.length) {
    data.image_urls = params.imageUrls
  }
  if (params.temperature !== undefined) {
    data.temperature = params.temperature
  }
  return data
}

module.exports = {
  BASE_URL,
  NON_STREAM_BASE_URL,
  getAiUserId,
  gatewayErrorMessage,

  // 当前基础库能不能收流。false 时调用方降级到非流式 chat()（老基础库/异常环境），
  // 功能不缺，只是回不到进度条与预描述。
  supportsStream() {
    try {
      if (typeof wx === 'undefined' || typeof wx.request !== 'function') {
        return false
      }
      if (typeof wx.canIUse !== 'function') {
        return true
      }
      return !!wx.canIUse('request.object.enableChunked')
    } catch (error) {
      return true
    }
  },

  // POST /session/new — 新建会话，resolve session 对象 { session_id, title, ... }。
  // 嵌套（data.session，文档 v1.0.4）与扁平（字段直接在 data 上，流式版部署实测）都认，见 unwrapData。
  // title 默认「新对话」，后端在首条用户消息后自动填成该消息前 20 字（v1.0.4 §二）。
  // ⚠️ 每个用户最多 20 个会话（v1.0.4 §5.2），超限 reject code=20013 MAX_SESSIONS_REACHED，
  // 由调用方传 onSessionLimit 引导用户去会话列表删旧的（见 ai-i18n.handleAiError）。
  newSession() {
    return aiRequest({
      url: '/session/new',
      data: { user_id: getAiUserId() }
    }).then(body => {
      const session = unwrapData(body, 'session', value => !!(value && value.session_id))
      if (!session) {
        // 两种结构都对不上（又一次改了协议）：别让调用方拿 undefined 去读 .session_id
        // 抛 TypeError —— 那会被 catch 成一句没头没尾的报错。按上游错误 reject，
        // 页面走 handleAiError 的可重试提示，console 里留下 detail 好定位。
        return Promise.reject({ code: 30001, detail: 'SESSION_MISSING' })
      }
      return session
    })
  },

  // GET /session/list — 会话列表（按更新时间倒序），resolve sessions 数组。
  // data.sessions（文档）与 data 直接是数组（若后端同样扁平化）都认。
  listSessions() {
    return aiRequest({
      url: `/session/list?user_id=${encodeURIComponent(getAiUserId())}`,
      method: 'GET'
    }).then(body => unwrapData(body, 'sessions', Array.isArray) || [])
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
    }).then(body => {
      const data = body.data
      return {
        expired: body.code === 10001,
        // data.data（文档）与 data 直接是数组（若后端同样扁平化）都认
        list: unwrapData(body, 'data', Array.isArray) || [],
        // 扁平结构下没有 total 这个字段。不拿 list.length 顶替：sessions.js 用
        // page_size=1 探总数，顶替出来的 1 会当成「1 条消息」显示，比不显示更糟。
        total: (data && !Array.isArray(data) && data.total) || 0
      }
    })
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

  // POST /chat（流式 SSE，**当前主链路**）— 对话/生图/图文多模态。
  // params: { sessionId, message, imgOrientation(必传: vertical/horizontal/square),
  //           imgStyle(可选: cartoon/landscape/portrait/anime 触发一键生图),
  //           modelType(可选: lite/pro，不传即 pro), temperature,
  //           imageUrls(可选: 图片 URL 数组，最多 4 张；文档 §二「图片支持」——
  //             1 张+生图关键词=图生图美化 / 多张+关键词=友好拒绝 / 其余=AI 分析讨论，均由服务端分流) }
  //
  // ⚠️ v1.0.4 起 `new_session` 参数**已废弃**：会话是不是新的由后端自己判断，前端不再传。
  // 同时「您好，我是星宝✨」这句自我介绍接口也不再返回了，它是纯前端静态展示
  //（chat.wxml 的 .welcome 区块，仅在 messages 为空时显示），所以 text 里不会再带招呼语前缀。
  //
  // handlers.onEvent(event) 收原始事件：
  //   pre_text {content}        预描述文案，约 15s 到（等 LLM 第一轮返回），在它之前页面自己顶 loading
  //   progress {progress,stage} 里程碑，只有 5/15/30/45/50/80/85/90/100 这几级
  //                             （中间值要前端自己补，见 chat.js 的 pumpProgress）
  //   image    {content}        生成图 URL，排在 progress 90(uploaded) **之后**，不是 50%
  //   text     {content}        回复文字，每次 1~3 字，调用方自行追加渲染
  //   done     {orientation}    结束
  // resolve 汇总结果 { text, images, orientation, done }，供调用方兜底校对；
  // 返回的 promise 带 .abort()，页面「停止生成」时调用。
  chatStream(params, handlers) {
    const options = handlers || {}
    return aiStreamRequest({
      url: '/chat',
      data: buildChatPayload(params),
      timeout: GENERATE_TIMEOUT,
      onEvent: options.onEvent
    })
  },

  // POST /chat（非流式）— **仅降级用**：基础库拿不到 onChunkReceived 时由页面回退到这条链路
  //（supportsStream() 为 false）。请求体与 chatStream 完全一致，resolve { text, images }，
  // 没有预描述与进度，回复到齐后由页面自己做打字机。返回的 promise 带 .abort()。
  chat(params) {
    const req = aiRequest({
      url: '/chat',
      // 非流式响应只有旧部署给得了，这里显式打回旧地址（见文件头 NON_STREAM_BASE_URL）
      baseUrl: NON_STREAM_BASE_URL,
      data: buildChatPayload(params),
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
