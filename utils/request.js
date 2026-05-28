const config = require('./config')
const mock = require('./mock')

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

function getToken() {
  return wx.getStorageSync('token') || ''
}

function showError(message) {
  if (!message) {
    return
  }

  wx.showToast({
    title: message,
    icon: 'none'
  })
}

// 统一的错误处理：默认弹 toast 提示；遇到 401 清除本地登录态后再抛给调用方
function handleBusinessError(error, options) {
  const message = error && error.message ? error.message : '请求失败'

  // 调用方可通过 options.showError === false 关闭自动提示（自行处理错误）
  if (options.showError !== false) {
    showError(message)
  }

  if (error && error.code === 401) {
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
  const header = Object.assign({}, options.header)
  const token = getToken()

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
  if (config.useMock || options.mock) {
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
      url: buildUrl(options.url),
      method,
      data,
      header,
      timeout: options.timeout || config.timeout,
      success(res) {
        // wx.request 只要收到响应就算 success，需在这里按 HTTP 状态码和业务 code 二次判定
        const body = res.data || {}

        // 登录过期：HTTP 401 或业务 code 401
        if (res.statusCode === 401 || body.code === 401) {
          reject({
            code: 401,
            message: body.message || '登录已过期'
          })
          return
        }

        // 非 2xx 视为服务器异常
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject({
            code: res.statusCode,
            message: body.message || '服务器异常'
          })
          return
        }

        // 约定 code 为 0 表示成功，非 0 即业务错误
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

module.exports = {
  request,
  get(url, data, options) {
    return request(Object.assign({}, options, {
      url,
      data,
      method: 'GET'
    }))
  },
  post(url, data, options) {
    return request(Object.assign({}, options, {
      url,
      data,
      method: 'POST'
    }))
  },
  put(url, data, options) {
    return request(Object.assign({}, options, {
      url,
      data,
      method: 'PUT'
    }))
  },
  delete(url, data, options) {
    return request(Object.assign({}, options, {
      url,
      data,
      method: 'DELETE'
    }))
  }
}
