const assert = require('node:assert/strict')

// AI 接口响应结构兼容：流式版部署（2026-08-06 切）实测把 /session/new 的 `data.session`
// 包装层去掉了，字段直接挂在 data 下，而文档 v1.0.4 写的是嵌套结构。ai-api 两种都得吃，
// /session/list、/chat/history 同样兜底。本测试把两种形状各跑一遍，外加「都对不上」的兜底。
let nextResponse = null

global.getApp = () => ({ globalData: { userInfo: { id: 'shape-test-user' } } })
global.getCurrentPages = () => []
global.wx = {
  getStorageSync() {
    return ''
  },
  request(options) {
    queueMicrotask(() => {
      options.success({ statusCode: 200, data: nextResponse })
    })
    return { abort() {} }
  }
}

const aiApi = require('../utils/ai-api')

const SESSION = {
  session_id: '3280b044',
  title: '新对话',
  created_at: '2026-08-06T14:18:28.190045+00:00',
  updated_at: '2026-08-06T14:18:28.190061+00:00',
  msg_count: 0
}
const MESSAGES = [
  { id: 'm1', role: 'user', content: '你好', timestamp: '2026-08-06T14:18:30+00:00' }
]

async function run() {
  // ---- /session/new ----

  // 1) 嵌套结构（文档 v1.0.4）
  nextResponse = { success: true, code: 10000, data: { session: SESSION } }
  assert.equal((await aiApi.newSession()).session_id, '3280b044')

  // 2) 扁平结构（流式版部署实测）
  nextResponse = { success: true, code: 10000, data: SESSION }
  const flat = await aiApi.newSession()
  assert.equal(flat.session_id, '3280b044')
  assert.equal(flat.title, '新对话')

  // 3) 两种都对不上：reject 30001，不能让调用方拿 undefined 去读 .session_id
  nextResponse = { success: true, code: 10000, data: { whatever: 1 } }
  await assert.rejects(aiApi.newSession(), error => {
    assert.equal(error.code, 30001)
    assert.equal(error.detail, 'SESSION_MISSING')
    return true
  })

  // ---- /session/list ----

  nextResponse = { success: true, code: 10000, data: { sessions: [SESSION] } }
  assert.equal((await aiApi.listSessions()).length, 1)

  nextResponse = { success: true, code: 10000, data: [SESSION] }
  assert.equal((await aiApi.listSessions())[0].session_id, '3280b044')

  // 空/异常结构统一给空数组，页面按「没有会话」渲染
  nextResponse = { success: true, code: 10000, data: {} }
  assert.deepEqual(await aiApi.listSessions(), [])

  // ---- /chat/history ----

  nextResponse = { success: true, code: 10000, data: { data: MESSAGES, total: 126 } }
  const nested = await aiApi.getHistory('3280b044')
  assert.equal(nested.list.length, 1)
  assert.equal(nested.total, 126)
  assert.equal(nested.expired, false)

  // 扁平结构：拿得到消息，total 没有就是 0（不拿 list.length 冒充，见 ai-api 注释）
  nextResponse = { success: true, code: 10000, data: MESSAGES }
  const flatHistory = await aiApi.getHistory('3280b044')
  assert.equal(flatHistory.list[0].id, 'm1')
  assert.equal(flatHistory.total, 0)

  // 10001 历史过期：expired 照旧要能识别出来
  nextResponse = { success: true, code: 10001, data: {} }
  const expired = await aiApi.getHistory('3280b044')
  assert.equal(expired.expired, true)
  assert.deepEqual(expired.list, [])

  console.log('ai response shape tests passed')
}

run().catch(error => {
  console.error(error)
  process.exitCode = 1
})
