// IoT 服务（WiFi 版设备）的统一错误码（接口文档「通用约定 / 错误码」口径，2026-10-26）。
//
// 与 BoltFox 老服务（utils/request.js）是两套口径，不要混用：
//   · 返回结构 `{ code, msg, data }`，code=0 成功；错误文案字段是 `msg`（不是 message / retMsg）；
//   · 只有鉴权失败、资源不存在、上游不可用用非 200 的 HTTP 状态（401 / 404 / 503），其余业务错误
//     HTTP 200 + body.code，以 body.code 为准；
//   · 401 = 登录失效需重登；**503 = 鉴权依赖的老服务暂时不可用，保留登录态稍后重试，绝不能当 401 处理**；
//   · 403 = 无该设备权限（设备未绑定到当前用户也是 403）。
//
// action 告诉调用方该怎么收场：relogin 重新登录 / retry 稍后可重试 / none 按提示处理即可。
const CODE_TABLE = {
  4000: { message: '参数错误', action: 'none' },
  401: { message: '登录已失效，请重新登录', action: 'relogin' },
  403: { message: '无该设备操作权限', action: 'none' },
  404: { message: '请求的资源不存在', action: 'none' },
  // 4040/4041/4044 拆分后的口径：4040 设备不存在、4041 只表示离线、4044 只表示任务不存在/过期
  4040: { message: '设备不存在', action: 'none' },
  4041: { message: '设备已离线，请检查设备网络', action: 'none' },
  4044: { message: '任务不存在或已过期', action: 'none' },
  4045: { message: '设备升级中，请稍后', action: 'retry' },
  4130: { message: '图片过大，请压缩后重试', action: 'none' },
  429: { message: '操作太频繁，请稍后重试', action: 'retry' },
  503: { message: '服务暂时不可用，请稍后重试', action: 'retry' },
  5000: { message: '服务异常，请稍后重试', action: 'retry' },
  5001: { message: '图片处理失败，请换一张试试', action: 'none' },
  5002: { message: '文件上传失败，请重试', action: 'retry' },
  5003: { message: '图片处理超时，请重试', action: 'retry' }
}

const NETWORK_ERROR = 'NETWORK_ERROR'

function toCode(value) {
  if (value === undefined || value === null || value === '') {
    return null
  }
  const number = Number(value)
  return Number.isFinite(number) ? number : value
}

// 429 的建议等待秒数：优先 body.data.retryAfter / body.retryAfter，其次 HTTP Header Retry-After
function readRetryAfter(body, header) {
  const data = body && typeof body.data === 'object' && body.data ? body.data : {}
  const candidates = [data.retryAfter, body && body.retryAfter]
  const headers = header || {}
  Object.keys(headers).forEach(key => {
    if (key.toLowerCase() === 'retry-after') {
      candidates.push(headers[key])
    }
  })
  for (let i = 0; i < candidates.length; i++) {
    const seconds = Number(candidates[i])
    if (Number.isFinite(seconds) && seconds > 0) {
      return seconds
    }
  }
  return 0
}

// 按错误码给出前端文案：码表认得的用码表（统一中文），认不得的退回服务端 msg
function describe(code, serverMessage) {
  const known = CODE_TABLE[code]
  if (known) {
    return { message: known.message, action: known.action }
  }
  // 码表外的 HTTP 5xx（网关 502/504 等，响应体往往是 HTML）：按服务异常、可重试处理
  if (typeof code === 'number' && code >= 500 && code < 600) {
    return { message: CODE_TABLE[5000].message, action: 'retry' }
  }
  const fallback = String(serverMessage || '').trim()
  return { message: fallback || '请求失败', action: 'none' }
}

// 把一次 HTTP 响应归一成 { ok, data } 或 { ok:false, error }。
// error：{ code, message, action, retryAfter, statusCode, serverMessage }
function fromResponse(statusCode, body, header) {
  const payload = body && typeof body === 'object' ? body : {}
  const bodyCode = toCode(payload.code)
  const ok = statusCode >= 200 && statusCode < 300 && (bodyCode === 0 || bodyCode === null)
  if (ok) {
    return { ok: true, data: payload.data !== undefined ? payload.data : null }
  }
  // HTTP 401/403/404/503 以 HTTP 状态为准（body 里一般同码）；其余以 body.code 为准
  const code =
    [401, 403, 404, 503].indexOf(statusCode) > -1 || bodyCode === null || bodyCode === 0
      ? statusCode
      : bodyCode
  const detail = describe(code, payload.msg)
  return {
    ok: false,
    error: {
      code,
      message: detail.message,
      action: detail.action,
      retryAfter: code === 429 ? readRetryAfter(payload, header) : 0,
      statusCode,
      serverMessage: payload.msg || ''
    }
  }
}

// wx.request fail（断网 / 超时 / 域名未配置）
function fromNetworkFailure(errMsg) {
  const raw = String(errMsg || '')
  return {
    code: NETWORK_ERROR,
    message: /timeout/i.test(raw) ? '网络超时，请稍后再试' : '网络连接失败，请稍后再试',
    action: 'retry',
    retryAfter: 0,
    statusCode: 0,
    serverMessage: raw
  }
}

function isRelogin(error) {
  return !!error && error.action === 'relogin'
}

function isRetryable(error) {
  return !!error && error.action === 'retry'
}

module.exports = {
  CODE_TABLE,
  NETWORK_ERROR,
  describe,
  fromResponse,
  fromNetworkFailure,
  readRetryAfter,
  isRelogin,
  isRetryable
}
