const config = require('./config')
const mock = require('./mock')
const toast = require('./toast')
const language = require('./language')

// 正式版(release)强制禁用 mock，防止本地模拟接口把假数据带到线上；取不到环境信息时按正式版处理（最保守）
let isReleaseEnv = true
try {
  isReleaseEnv = wx.getAccountInfoSync().miniProgram.envVersion === 'release'
} catch (e) {
  isReleaseEnv = true
}

const WECHAT_MINI_PROGRAM_TERMINAL = 3

// 允许直接传字符串当作 url，统一转成 options 对象
function normalizeOptions(options) {
  if (typeof options === 'string') {
    return {
      url: options
    }
  }
  return options || {}
}

// 绝对地址（http/https 开头）原样使用，否则拼上 baseURL
function buildUrl(url) {
  if (/^https?:\/\//.test(url)) {
    return url
  }
  return `${config.baseURL}${url}`
}

function appendQuery(url, params) {
  const query = Object.keys(params || {})
    .filter(
      key =>
        params[key] !== undefined && params[key] !== null && params[key] !== ''
    )
    .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`)
    .join('&')

  if (!query) {
    return url
  }

  return `${url}${url.indexOf('?') === -1 ? '?' : '&'}${query}`
}

function getToken() {
  return wx.getStorageSync('token') || ''
}

function getJwtToken() {
  return wx.getStorageSync('jwtToken') || ''
}

function getSystemInfo() {
  try {
    // 新版基础库：用 getDeviceInfo(取 model) + getAppBaseInfo(取 language) 替代已废弃的 getSystemInfoSync
    if (wx.getDeviceInfo && wx.getAppBaseInfo) {
      return Object.assign({}, wx.getDeviceInfo(), wx.getAppBaseInfo())
    }
    // 旧版基础库降级
    return wx.getSystemInfoSync()
  } catch (error) {
    return {}
  }
}

// 语种统一走 utils/language：优先用户在「语种设置」里选的，其次跟随系统。
// 之前这里只读系统语言，导致用户切了语种后端仍按系统语言返回内容。
function getLanguageCode() {
  return language.getLanguageCode()
}

function appendClientHeaders(header, token) {
  const info = getSystemInfo()
  const nextHeader = Object.assign({}, header)

  if (!nextHeader.terminal) {
    nextHeader.terminal = WECHAT_MINI_PROGRAM_TERMINAL
  }

  if (!nextHeader.language) {
    nextHeader.language = getLanguageCode()
  }

  if (!nextHeader.device && info.model) {
    nextHeader.device = info.model
  }

  if (token && !nextHeader.userToken) {
    nextHeader.userToken = token
  }

  return nextHeader
}

function isClientApi(url) {
  return /^\/Client\//.test(url || '')
}

function getClientQuery(token, header) {
  const info = getSystemInfo()
  const query = {}

  query.terminal =
    header && header.terminal ? header.terminal : WECHAT_MINI_PROGRAM_TERMINAL
  query.language =
    header && header.language ? header.language : getLanguageCode()

  if (header && header.device) {
    query.device = header.device
  } else if (info.model) {
    query.device = info.model
  }

  if (token) {
    query.userToken = token
  }

  return query
}

function parseResponseData(data) {
  if (typeof data !== 'string') {
    return data || {}
  }

  try {
    return JSON.parse(data)
  } catch (error) {
    return {
      data
    }
  }
}

// 接口 url → 简短中文名：报错 toast 里带上「中文名 + url」，方便用户/客服一眼定位是哪个接口出错。
// key 取 url 路径最后一段（方法名），兼容 /devices/:id/firmware 这类带路径参数的地址；映射不到就只带 url。
const API_NAME_MAP = {
  getProductList: '产品列表',
  getProductFaqList: '常见问题列表',
  getProductFaqDetail: '常见问题详情',
  sendEmail: '发送邮件',
  sendEmailToken: '发送邮箱验证码',
  setUserProductUpload: '投屏图片上传',
  getBasicData: '基础数据',
  setFileUpload: '文件上传',
  setWechatAppLogin: '微信登录',
  getUserInfo: '用户信息',
  changeNickName: '修改昵称',
  changeAvatar: '修改头像',
  loginOut: '退出登录',
  userOff: '账号注销',
  changeUserEmail: '修改邮箱',
  addUserProduct: '绑定电子纸设备',
  getUserProductList: '电子纸设备列表',
  getUserProductDetail: '电子纸设备详情',
  editUserProduct: '编辑电子纸设备',
  delUserProduct: '删除电子纸设备',
  clearUserProductImg: '一键清空电子纸设备图片',
  getUserProductClearImg: '电子纸设备清空状态',
  getUserProductImgList: '图库列表',
  delUserProductImg: '删除图片',
  getUserProductImgRecordList: '投屏记录列表',
  editUserProductImgRecord: '更新投屏记录',
  addUserProductImgRecord: '新增投屏记录',
  delUserProductImgRecord: '删除投屏记录',
  phone: '绑定手机号',
  'reset-password': '重置密码',
  password: '修改密码',
  firmware: '获取固件',
  'upgrade-result': '上报升级结果'
}

// 从 url 取出方法名段并映射中文名，返回 { path(去掉query的纯路径), name(映射不到为空) }
function describeApi(url) {
  const path = String(url || '').split('?')[0]
  const segments = path.split('/').filter(Boolean)
  const key = segments.length ? segments[segments.length - 1] : ''
  return {
    path,
    name: API_NAME_MAP[key] || ''
  }
}

// 拼接报错 toast 尾部的接口标识：「（中文名 url）」，无 url 时返回空串
function apiErrorSuffix(url) {
  const api = describeApi(url)
  if (!api.path) {
    return ''
  }
  return `（${api.name ? api.name + ' ' : ''}${api.path}）`
}

function showError(message) {
  if (!message) {
    return
  }

  toast.show({
    title: message,
    icon: 'none',
    // 报错文案更长（带接口名+url），停留 5s 给用户足够时间看清故障来源
    duration: 5000
  })
}

// —— 网络层失败(超时/断网)的静默重试与提示节流 ——
// 单次超时 config.timeout(10s)，失败后最多再自动重试 NETWORK_RETRY_MAX 次(静默不提示)，
// 用户端表现为 loading 最长约 30s(3 次尝试)才提示，避免以前「5-6s 就弹、loading 中隔几秒一个超时」的差体验。
const NETWORK_RETRY_MAX = 2
const NETWORK_RETRY_DELAY = 500
// 多个请求同时超时时合并提示：GAP 内只弹一次网络错误 toast，避免连续刷屏
const NETWORK_ERROR_TOAST_GAP = 3000
let lastNetworkErrorToastAt = 0

// 仅网络层失败(wx.request fail：超时/断网)才重试；业务错误(HTTP 4xx/5xx、业务 code)不重试，避免重复副作用(重复绑定/上传等)
function isNetworkError(error) {
  return !!error && error.code === 'NETWORK_ERROR'
}

// 网络失败的用户友好提示：超时与断网分开措辞
function friendlyNetworkMessage(error) {
  const raw = String((error && error.message) || '')
  return /timeout/i.test(raw) ? '网络超时，请稍后再试' : '网络连接失败，请稍后再试'
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// 节流后的网络错误提示：GAP(3s) 内重复的网络错误只弹一次，合并突发的多个超时
function showNetworkError(message) {
  const now = Date.now()
  if (now - lastNetworkErrorToastAt < NETWORK_ERROR_TOAST_GAP) {
    return
  }
  lastNetworkErrorToastAt = now
  showError(message)
}

// 统一的错误处理：默认弹 toast 提示；遇到 401 清除本地登录态后再抛给调用方
function handleBusinessError(error, options) {
  const networkError = isNetworkError(error)
  let message = error && error.message ? error.message : '请求失败'

  if (networkError) {
    // 网络失败(已静默重试仍不通)：统一友好提示，不加「接口-」前缀与 url —— 这是网络问题而非某个接口的问题。
    message = friendlyNetworkMessage(error)
  } else if (!/^接口-/.test(message)) {
    // 接口报错统一加「接口-」前缀，方便和「设备-」(蓝牙/设备返回) 错误区分；幂等避免重复加。
    // 同时写回 error.message，让用 showError:false 自行 toast 的调用方也带上前缀。
    message = '接口-' + message
  }
  if (error) {
    error.message = message
  }

  // 调用方可通过 options.showError === false 关闭自动提示（自行处理错误）
  if (options.showError !== false) {
    if (networkError) {
      // 网络错误做节流合并，且不追加接口 url(对用户是网络问题，具体接口无意义)
      showNetworkError(message)
    } else {
      // 业务/服务器错误追加接口中文名与 url，方便定位是哪个接口出错；仅用于展示，不写回 error.message。
      showError(message + apiErrorSuffix(options.url))
    }
  }

  if (error && (error.code === 401 || error.code === 406)) {
    handleSessionExpired()
  }

  throw error
}

// 登录过期(401/406)统一登出：早先只清 Storage 不清 globalData，requireLogin 判的是 globalData.token，
// 过期后依然放行、每个请求反复报错，用户卡死在假登录态。这里整体清会话并引导重登；
// 多请求并发 401 时用节流避免重复跳转，已在登录页则不跳（防循环）。
let lastSessionExpiredJumpAt = 0
function handleSessionExpired() {
  const app = typeof getApp === 'function' ? getApp() : null
  if (app && typeof app.clearSession === 'function') {
    app.clearSession()
  } else {
    // App 尚未就绪（启动早期）时兜底清 Storage
    wx.removeStorageSync('token')
    wx.removeStorageSync('jwtToken')
    wx.removeStorageSync('userInfo')
  }

  const now = Date.now()
  if (now - lastSessionExpiredJumpAt < 3000) {
    return
  }
  const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : []
  const current = pages[pages.length - 1]
  if (current && current.route === 'pages/login/login') {
    return
  }
  lastSessionExpiredJumpAt = now
  // 与 requireLogin/ensureLogin 一致用 navigateTo（保留滑动过渡），失败(如页面栈满)不再补救
  wx.navigateTo({ url: '/pages/login/login', fail: () => {} })
}

// 全局请求入口：处理鉴权头、loading、mock 分流与统一的成功/失败解析
function request(rawOptions) {
  const options = normalizeOptions(rawOptions)
  const method = (options.method || 'GET').toUpperCase()
  const data = options.data || {}
  const token = getToken()
  const jwtToken = getJwtToken()
  const authToken = options.auth === false ? '' : token
  const header = appendClientHeaders(options.header, authToken)
  const clientQuery =
    options.clientParams === false || !isClientApi(options.url)
      ? {}
      : getClientQuery(authToken, header)

  // 有 token 且未显式关闭鉴权时，自动带上 Bearer 头
  if (token && options.auth !== false) {
    header.Authorization = `Bearer ${token}`
  }
  if (jwtToken && options.auth !== false) {
    header.Authentication = `Bearer ${jwtToken}`
  }

  if (options.loading) {
    wx.showLoading({
      title: options.loadingText || '加载中',
      mask: true
    })
  }

  // 无论成功失败都要关掉 loading，下面 then/catch 都会调用
  const done = () => {
    if (options.loading) {
      wx.hideLoading()
    }
  }

  // mock 模式（本地开发无后端时）走内存模拟接口，绕过真实网络请求；正式版强制走真实请求
  if (!isReleaseEnv && ((config.useMock && options.mock !== false) || options.mock)) {
    return mock
      .handle({
        url: options.url,
        method,
        data,
        header
      })
      .then(res => {
        done()
        return res
      })
      .catch(error => {
        done()
        return handleBusinessError(error, options)
      })
  }

  const sendOptions = {
    url: buildUrl(appendQuery(options.url, clientQuery)),
    method,
    data,
    header,
    timeout: options.timeout || config.timeout
  }

  return requestWithRetry(sendOptions, NETWORK_RETRY_MAX)
    .then(res => {
      done()
      return res
    })
    .catch(error => {
      done()
      return handleBusinessError(error, options)
    })
}

// 单次网络请求：把 wx.request 包成 Promise，成功后按 HTTP 状态码/业务 code 二次判定，失败归一为 NETWORK_ERROR。
function sendRequest(sendOptions) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: sendOptions.url,
      method: sendOptions.method,
      data: sendOptions.data,
      header: sendOptions.header,
      timeout: sendOptions.timeout,
      success(res) {
        // wx.request 只要收到响应就算 success，需在这里按 HTTP 状态码和业务 code 二次判定
        const body = res.data || {}
        const businessCode = body.code !== undefined ? body.code : body.retCode

        // 登录过期：HTTP 401 或业务 code 401
        if (
          res.statusCode === 401 ||
          businessCode === 401 ||
          businessCode === 406
        ) {
          reject({
            code: businessCode || 401,
            message: body.message || body.retMsg || '登录已过期'
          })
          return
        }

        // 非 2xx 视为服务器异常
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject({
            code: res.statusCode,
            message: body.message || body.retMsg || '服务器异常'
          })
          return
        }

        // 约定 code 为 0 表示成功，非 0 即业务错误
        if (Object.prototype.hasOwnProperty.call(body, 'retCode')) {
          if (body.retCode !== 200) {
            reject({
              code: body.retCode,
              message: body.retMsg || '业务处理失败',
              data: body.retData
            })
            return
          }

          resolve(body.retData !== undefined ? body.retData : body)
          return
        }

        if (body.code && body.code !== 0) {
          reject({
            code: body.code,
            message: body.message || '业务处理失败',
            data: body.data
          })
          return
        }

        // 成功时优先返回 data 字段，便于调用方直接拿到业务数据
        resolve(body.data !== undefined ? body.data : body)
      },
      fail(error) {
        reject({
          code: 'NETWORK_ERROR',
          message: error.errMsg || '网络连接失败'
        })
      }
    })
  })
}

// 带静默重试的请求：仅网络层失败(超时/断网)时等待 NETWORK_RETRY_DELAY 后重试，最多 retriesLeft 次；
// 业务/服务器错误直接抛出（重试无意义且可能造成重复副作用）。
function requestWithRetry(sendOptions, retriesLeft) {
  return sendRequest(sendOptions).catch(error => {
    if (isNetworkError(error) && retriesLeft > 0) {
      return delay(NETWORK_RETRY_DELAY).then(() =>
        requestWithRetry(sendOptions, retriesLeft - 1)
      )
    }
    throw error
  })
}

function upload(rawOptions) {
  const options = normalizeOptions(rawOptions)
  const token = getToken()
  const jwtToken = getJwtToken()
  const authToken = options.auth === false ? '' : token
  const header = appendClientHeaders(options.header, authToken)
  const filePaths = Array.isArray(options.filePaths)
    ? options.filePaths
    : [options.filePath].filter(Boolean)
  const name = options.name || 'fileParam'
  const formData = options.formData || {}
  const query = options.query || {}
  const clientQuery =
    options.clientParams === false || !isClientApi(options.url)
      ? {}
      : getClientQuery(authToken, header)

  if (token && options.auth !== false) {
    header.Authorization = `Bearer ${token}`
  }
  if (jwtToken && options.auth !== false) {
    header.Authentication = `Bearer ${jwtToken}`
  }

  if (!filePaths.length) {
    return handleBusinessError(
      {
        code: 'UPLOAD_FILE_REQUIRED',
        message: '请选择上传文件'
      },
      options
    )
  }

  if (options.loading) {
    wx.showLoading({
      title: options.loadingText || '上传中',
      mask: true
    })
  }

  const done = () => {
    if (options.loading) {
      wx.hideLoading()
    }
  }

  const uploadOne = filePath =>
    new Promise((resolve, reject) => {
      wx.uploadFile({
        url: buildUrl(
          appendQuery(options.url, Object.assign({}, clientQuery, query))
        ),
        filePath,
        name,
        formData,
        header,
        // 上传用更长的 uploadTimeout(不受普通请求 10s 影响)；上传不做自动重试，避免重复上传/重复投屏记录
        timeout: options.timeout || config.uploadTimeout,
        success(res) {
          const body = parseResponseData(res.data)
          const businessCode =
            body.code !== undefined ? body.code : body.retCode

          if (
            res.statusCode === 401 ||
            businessCode === 401 ||
            businessCode === 406
          ) {
            reject({
              code: businessCode || 401,
              message: body.message || body.retMsg || '登录已过期'
            })
            return
          }

          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject({
              code: res.statusCode,
              message: body.message || body.retMsg || '服务器异常'
            })
            return
          }

          if (Object.prototype.hasOwnProperty.call(body, 'retCode')) {
            if (body.retCode !== 200) {
              reject({
                code: body.retCode,
                message: body.retMsg || '业务处理失败',
                data: body.retData
              })
              return
            }

            resolve(body.retData !== undefined ? body.retData : body)
            return
          }

          if (body.code && body.code !== 0) {
            reject({
              code: body.code,
              message: body.message || '业务处理失败',
              data: body.data
            })
            return
          }

          resolve(body.data !== undefined ? body.data : body)
        },
        fail(error) {
          reject({
            code: 'NETWORK_ERROR',
            message: error.errMsg || '网络连接失败'
          })
        }
      })
    })

  return filePaths
    .reduce((promise, filePath) => {
      return promise.then(results =>
        uploadOne(filePath).then(result => results.concat(result))
      )
    }, Promise.resolve([]))
    .then(results => {
      done()
      return filePaths.length === 1 ? results[0] : results
    })
    .catch(error => {
      done()
      return handleBusinessError(error, options)
    })
}

module.exports = {
  request,
  upload,
  get(url, data, options) {
    return request(
      Object.assign({}, options, {
        url,
        data,
        method: 'GET'
      })
    )
  },
  post(url, data, options) {
    return request(
      Object.assign({}, options, {
        url,
        data,
        method: 'POST'
      })
    )
  },
  put(url, data, options) {
    return request(
      Object.assign({}, options, {
        url,
        data,
        method: 'PUT'
      })
    )
  },
  delete(url, data, options) {
    return request(
      Object.assign({}, options, {
        url,
        data,
        method: 'DELETE'
      })
    )
  }
}
