const assert = require('node:assert/strict')

// AI 网关 2026-07-29 起强制 JWT：每个 aiRequest 必须带 `Authentication: Bearer <jwtToken>`，
// 取值与 app.js 一致（globalData 优先、storage 兜底），未登录则不带头（由网关回 JWTTokenIsMissing）。
const storage = {}
const globalData = { userInfo: { id: 'jwt-header-test-user' } }
const sentHeaders = []

global.getApp = () => ({ globalData })
global.getCurrentPages = () => []
global.wx = {
  getStorageSync(key) {
    return storage[key]
  },
  request(options) {
    sentHeaders.push(options.header)
    queueMicrotask(() => {
      options.success({
        statusCode: 200,
        data: { success: true, code: 0, data: { session: { session_id: 's1' } } }
      })
    })
    return {
      abort() {}
    }
  }
}

const aiApi = require('../utils/ai-api')

async function run() {
  // 1) globalData 有 jwtToken：优先用它
  globalData.jwtToken = 'jwt-from-global'
  storage.jwtToken = 'jwt-from-storage'
  await aiApi.newSession()
  assert.equal(sentHeaders[0].Authentication, 'Bearer jwt-from-global')
  assert.equal(sentHeaders[0]['Content-Type'], 'application/json')

  // 2) globalData 没有：回退 storage（重登后先落 storage 的场景）
  globalData.jwtToken = ''
  await aiApi.listSessions()
  assert.equal(sentHeaders[1].Authentication, 'Bearer jwt-from-storage')

  // 3) 都没有（未登录）：不带 Authentication 头，照常发出
  delete storage.jwtToken
  await aiApi.newSession()
  assert.equal(sentHeaders[2].Authentication, undefined)
  assert.equal(sentHeaders[2]['Content-Type'], 'application/json')

  console.log('ai jwt header tests passed')
}

run().catch(error => {
  console.error(error)
  process.exitCode = 1
})
