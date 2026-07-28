const assert = require('node:assert/strict')

const storage = {
  token: 'mini-user-token',
  jwtToken: 'mini-jwt-token'
}
const requestHeaders = []
const uploadHeaders = []

global.getCurrentPages = () => []
global.getApp = () => null
global.wx = {
  getAccountInfoSync() {
    return { miniProgram: { envVersion: 'release' } }
  },
  getStorageSync(key) {
    return storage[key]
  },
  getDeviceInfo() {
    return { model: 'test-device' }
  },
  getAppBaseInfo() {
    return { language: 'zh-CN' }
  },
  request(options) {
    requestHeaders.push(options.header)
    options.success({
      statusCode: 200,
      data: { retCode: 200, retData: { ok: true } }
    })
  },
  uploadFile(options) {
    uploadHeaders.push(options.header)
    options.success({
      statusCode: 200,
      data: JSON.stringify({ retCode: 200, retData: { ok: true } })
    })
  },
  showToast() {},
  hideToast() {}
}

const http = require('../utils/request')

;(async () => {
  await http.get('/Client/Test/authenticated', {}, { mock: false })

  assert.equal(requestHeaders[0].userToken, 'mini-user-token')
  assert.equal(requestHeaders[0].Authorization, 'Bearer mini-user-token')
  assert.equal(requestHeaders[0].Authentication, 'Bearer mini-jwt-token')

  await http.get('/Client/Test/public', {}, { auth: false, mock: false })

  assert.equal(requestHeaders[1].userToken, undefined)
  assert.equal(requestHeaders[1].Authorization, undefined)
  assert.equal(requestHeaders[1].Authentication, undefined)

  await http.upload({
    url: '/Client/Test/upload',
    filePath: 'test-image.jpg',
    mock: false
  })

  assert.equal(uploadHeaders[0].userToken, 'mini-user-token')
  assert.equal(uploadHeaders[0].Authorization, 'Bearer mini-user-token')
  assert.equal(uploadHeaders[0].Authentication, 'Bearer mini-jwt-token')

  console.log('request authentication tests passed')
})().catch(error => {
  console.error(error)
  process.exitCode = 1
})
