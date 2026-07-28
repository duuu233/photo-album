const assert = require('node:assert/strict')

const shownToasts = []
const responseBody = {
  RequestId: '1-6a687ba9-01f194-2ccddcd63f58',
  Code: 'JWTTokenIsMissing',
  Message: 'the jwt token is missing'
}

global.getApp = () => ({
  globalData: {
    userInfo: { id: 'gateway-error-test-user' }
  }
})
global.getCurrentPages = () => []
global.wx = {
  getStorageSync() {
    return undefined
  },
  request(options) {
    queueMicrotask(() => {
      options.success({
        statusCode: 403,
        // 覆盖网关未声明 application/json、wx.request 因此返回字符串的情况。
        data: JSON.stringify(responseBody)
      })
    })
    return {
      abort() {}
    }
  },
  showToast(options) {
    shownToasts.push(options)
  }
}

const aiApi = require('../utils/ai-api')
const aiI18n = require('../utils/ai-i18n')

async function run() {
  const expected =
    'JWTTokenIsMissing：the jwt token is missing' +
    '（RequestId: 1-6a687ba9-01f194-2ccddcd63f58）'

  assert.equal(aiApi.gatewayErrorMessage(responseBody), expected)
  assert.equal(
    aiApi.gatewayErrorMessage({
      ...responseBody,
      Message: 'another gateway error'
    }),
    '',
    '只允许固定 Code + Message 进入用户可见提示'
  )

  let caught
  try {
    await aiApi.newSession()
  } catch (error) {
    caught = error
  }

  assert.ok(caught, '固定网关错误必须 reject')
  assert.equal(caught.code, 31001)
  assert.equal(caught.userMessage, expected)

  aiI18n.handleAiError(caught)
  assert.equal(shownToasts.length, 1)
  assert.equal(shownToasts[0].title, `接口-${expected}`)
  assert.equal(shownToasts[0].duration, 5000)

  console.log('ai gateway error tests passed')
}

run().catch(error => {
  console.error(error)
  process.exitCode = 1
})
