const config = require('./config')
const mock = require('./mock')
const toast = require('./toast')

const WECHAT_MINI_PROGRAM_TERMINAL = 3
const LANGUAGE_CODE_MAP = {
  en: 1,
  'zh-Hans': 2,
  'zh-Hant': 3,
  ja: 4
}

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

function normalizeLanguage(language) {
  const raw = String(language || '')
    .replace('_', '-')
    .toLowerCase()

  if (
    raw.indexOf('zh-hant') === 0 ||
    raw.indexOf('zh-tw') === 0 ||
    raw.indexOf('zh-hk') === 0 ||
    raw.indexOf('zh-mo') === 0
  ) {
    return 'zh-Hant'
  }

  if (raw.indexOf('ja') === 0) {
    return 'ja'
  }

  if (raw.indexOf('en') === 0) {
    return 'en'
  }

  return 'zh-Hans'
}

function getLanguageCode() {
  const info = getSystemInfo()
  const normalized = normalizeLanguage(info.language)
  return LANGUAGE_CODE_MAP[normalized] || LANGUAGE_CODE_MAP['zh-Hans']
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
  addUserProduct: '绑定设备',
  getUserProductList: '设备列表',
  getUserProductDetail: '设备详情',
  editUserProduct: '编辑设备',
  delUserProduct: '删除设备',
  clearUserProductImg: '一键清空设备图片',
  getUserProductClearImg: '设备清空状态',
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

// 统一的错误处理：默认弹 toast 提示；遇到 401 清除本地登录态后再抛给调用方
function handleBusinessError(error, options) {
  let message = error && error.message ? error.message : '请求失败'

  // 接口报错统一加「接口-」前缀，方便和「设备-」(蓝牙/设备返回) 错误区分；幂等避免重复加。
  // 同时写回 error.message，让用 showError:false 自行 toast 的调用方也带上前缀。
  if (!/^接口-/.test(message)) {
    message = '接口-' + message
  }
  if (error) {
    error.message = message
  }

  // 调用方可通过 options.showError === false 关闭自动提示（自行处理错误）
  // 报错 toast 追加接口中文名与 url，方便定位是哪个接口出错；仅用于展示，不写回 error.message。
  if (options.showError !== false) {
    showError(message + apiErrorSuffix(options.url))
  }

  if (error && (error.code === 401 || error.code === 406)) {
    wx.removeStorageSync('token')
    wx.removeStorageSync('userInfo')
  }

  throw error
}

// 全局请求入口：处理鉴权头、loading、mock 分流与统一的成功/失败解析
function request(rawOptions) {
  const options = normalizeOptions(rawOptions)
  const method = (options.method || 'GET').toUpperCase()
  const data = options.data || {}
  const token = getToken()
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

  // mock 模式（本地开发无后端时）走内存模拟接口，绕过真实网络请求
  if ((config.useMock && options.mock !== false) || options.mock) {
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

  return new Promise((resolve, reject) => {
    wx.request({
      url: buildUrl(appendQuery(options.url, clientQuery)),
      method,
      data,
      header,
      timeout: options.timeout || config.timeout,
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
    .then(res => {
      done()
      return res
    })
    .catch(error => {
      done()
      return handleBusinessError(error, options)
    })
}

function upload(rawOptions) {
  const options = normalizeOptions(rawOptions)
  const token = getToken()
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
        timeout: options.timeout || config.timeout,
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
