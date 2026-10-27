// IoT 服务（WiFi 版设备：投屏、在线、设备控制、OTA、消息）的 HTTP 传输层。
//
// 刻意不复用 utils/request.js：两边返回结构、错误码和登录失效判据都不一样（见 utils/iot-errors.js）。
// 老服务那套把一切非 2xx 都当「服务器异常」、把 401 当登出；IoT 这边 503 必须保留登录态稍后重试，
// 套用老逻辑会把「权限服务短暂不可用」误判成掉线。这里只借用老服务的登出引导（expireSession）
// 和提示组件，鉴权 token 与老服务是同一个（Header `userToken`）。
const config = require('./config')
const toast = require('./toast')
const http = require('./request')
const iotErrors = require('./iot-errors')
const debugLog = require('./debug-log')

// 联调日志（开发版 / 体验版左下角浮窗）：单测沙箱里可能没有 debug-log，取不到就不记
function trace() {
  if (debugLog && typeof debugLog.add === 'function') {
    debugLog.add.apply(null, arguments)
  }
}

// 网络层失败（断网 / 超时）的静默重试：只给 GET。设备控制、投屏等 POST 有副作用，重发可能重复下发。
const GET_RETRY_MAX = 2
const RETRY_DELAY_MS = 500

function getToken() {
  return wx.getStorageSync('token') || ''
}

function buildUrl(url) {
  if (/^https?:\/\//.test(url)) {
    return url
  }
  return `${config.iotBaseURL}${url}`
}

function appendQuery(url, params) {
  const query = Object.keys(params || {})
    .filter(key => params[key] !== undefined && params[key] !== null && params[key] !== '')
    .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`)
    .join('&')
  if (!query) {
    return url
  }
  return `${url}${url.indexOf('?') === -1 ? '?' : '&'}${query}`
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function sendOnce(sendOptions) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: sendOptions.url,
      method: sendOptions.method,
      data: sendOptions.data,
      header: sendOptions.header,
      timeout: sendOptions.timeout,
      success(res) {
        let body = res.data
        if (typeof body === 'string') {
          try {
            body = JSON.parse(body)
          } catch (error) {
            body = {}
          }
        }
        const result = iotErrors.fromResponse(res.statusCode, body, res.header)
        if (result.ok) {
          resolve(result.data)
        } else {
          reject(result.error)
        }
      },
      fail(error) {
        reject(iotErrors.fromNetworkFailure(error && error.errMsg))
      }
    })
  })
}

function sendWithRetry(sendOptions, retriesLeft) {
  return sendOnce(sendOptions).catch(error => {
    if (error.code === iotErrors.NETWORK_ERROR && retriesLeft > 0) {
      return delay(RETRY_DELAY_MS).then(() => sendWithRetry(sendOptions, retriesLeft - 1))
    }
    throw error
  })
}

// 统一收尾：401 走老服务同一套登出引导；503/429 等只提示、不动登录态。
// 错误对象统一是 { code, message, action, retryAfter, statusCode, serverMessage }，
// message 带「接口(IoT)-」前缀，与老服务的「接口-」、AI 的「接口(AI)-」区分来源。
function handleError(error, options) {
  if (!/^接口\(IoT\)-/.test(error.message)) {
    error.message = `接口(IoT)-${error.message}`
  }
  if (options.showError !== false) {
    toast.show({ title: error.message, icon: 'none', duration: 4000 })
  }
  if (iotErrors.isRelogin(error)) {
    http.expireSession()
  }
  throw error
}

// options：{ url, method, data, query, header, timeout, showError, retry }
//   · GET 的 data 与 query 一起自己拼进 url（空值整项去掉，不让 wx.request 拼出 since=undefined）；
//     POST 的 data 走 JSON body；
//   · retry:false 关掉 GET 的网络静默重试（需要「失败就立即按失败处理」的场景）。
function request(options) {
  const method = (options.method || 'GET').toUpperCase()
  const token = getToken()
  const header = Object.assign({}, options.header)
  if (token && !header.userToken) {
    header.userToken = token
  }
  if (method !== 'GET' && !header['Content-Type']) {
    header['Content-Type'] = 'application/json'
  }
  const isGet = method === 'GET'
  const query = isGet ? Object.assign({}, options.query, options.data) : options.query
  const sendOptions = {
    url: buildUrl(appendQuery(options.url, query)),
    method,
    data: isGet ? {} : options.data || {},
    header,
    timeout: options.timeout || config.timeout
  }
  const retries = isGet && options.retry !== false ? GET_RETRY_MAX : 0
  const startedAt = Date.now()
  const label = `[IoT] ${method} ${appendQuery(options.url, query)}${isGet ? '' : ' 参数'}`
  return sendWithRetry(sendOptions, retries).then(
    data => {
      trace(label, isGet ? '' : sendOptions.data, `→ 成功 ${Date.now() - startedAt}ms 返回`, data)
      return data
    },
    error => {
      trace(label, isGet ? '' : sendOptions.data, `→ 失败 ${Date.now() - startedAt}ms`, error && error.code, error && error.message)
      return handleError(error, options)
    }
  )
}

// multipart 上传（2026-10-27，WiFi 投屏 POST /api/device/play）：wx.uploadFile，不做网络重试（重传会重复投屏）。
// options：{ filePath, name（默认 file）, formData, timeout, showError, onProgress(percent) }
// 返回体同样按 {code,msg,data} 解包，错误与 request 同一套收尾（401 登出引导、503 不登出）。
function upload(url, options) {
  const opts = options || {}
  const token = getToken()
  const header = Object.assign({}, opts.header)
  if (token && !header.userToken) {
    header.userToken = token
  }
  const startedAt = Date.now()
  const label = `[IoT] 上传 ${url} 文件 ${opts.filePath} 参数`
  return new Promise((resolve, reject) => {
    const task = wx.uploadFile({
      url: buildUrl(url),
      filePath: opts.filePath,
      name: opts.name || 'file',
      formData: opts.formData || {},
      header,
      timeout: opts.timeout || config.timeout,
      success(res) {
        let body = res.data
        if (typeof body === 'string') {
          try {
            body = JSON.parse(body)
          } catch (error) {
            body = {}
          }
        }
        const result = iotErrors.fromResponse(res.statusCode, body, res.header)
        if (result.ok) {
          resolve(result.data)
        } else {
          reject(result.error)
        }
      },
      fail(error) {
        reject(iotErrors.fromNetworkFailure(error && error.errMsg))
      }
    })
    if (task && typeof task.onProgressUpdate === 'function' && typeof opts.onProgress === 'function') {
      task.onProgressUpdate(res => {
        try {
          opts.onProgress(Number(res && res.progress) || 0)
        } catch (error) {
          // 页面进度回调出错不影响上传
        }
      })
    }
  }).then(
    data => {
      trace(label, opts.formData, `→ 成功 ${Date.now() - startedAt}ms 返回`, data)
      return data
    },
    error => {
      trace(label, opts.formData, `→ 失败 ${Date.now() - startedAt}ms`, error && error.code, error && error.message)
      return handleError(error, opts)
    }
  )
}

module.exports = {
  request,
  upload,
  get(url, data, options) {
    return request(Object.assign({}, options, { url, data, method: 'GET' }))
  },
  post(url, data, options) {
    return request(Object.assign({}, options, { url, data, method: 'POST' }))
  }
}
