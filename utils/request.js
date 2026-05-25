const config = require('./config')
const mock = require('./mock')

function normalizeOptions(options) {
  if (typeof options === 'string') {
    return {
      url: options
    }
  }
  return options || {}
}

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

function handleBusinessError(error, options) {
  const message = error && error.message ? error.message : '请求失败'

  if (options.showError !== false) {
    showError(message)
  }

  if (error && error.code === 401) {
    wx.removeStorageSync('token')
    wx.removeStorageSync('userInfo')
  }

  throw error
}

function request(rawOptions) {
  const options = normalizeOptions(rawOptions)
  const method = (options.method || 'GET').toUpperCase()
  const data = options.data || {}
  const header = Object.assign({}, options.header)
  const token = getToken()

  if (token && options.auth !== false) {
    header.Authorization = `Bearer ${token}`
  }

  if (options.loading) {
    wx.showLoading({
      title: options.loadingText || '加载中',
      mask: true
    })
  }

  const done = () => {
    if (options.loading) {
      wx.hideLoading()
    }
  }

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
        const body = res.data || {}

        if (res.statusCode === 401 || body.code === 401) {
          reject({
            code: 401,
            message: body.message || '登录已过期'
          })
          return
        }

        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject({
            code: res.statusCode,
            message: body.message || '服务器异常'
          })
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
