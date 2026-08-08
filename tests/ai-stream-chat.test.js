const assert = require('node:assert/strict')

// BoltStar 流式 /chat（assets/BoltStar-SSE-前端接入文档 -改.md）：
//   ① 地址切到流式部署，enableChunked=true，响应从 onChunkReceived 逐块收；
//   ② chunk 是 ArrayBuffer，且**汉字可能被切在两块之间**、SSE 行也可能被切断，解码/分行都要能续上；
//   ③ pre_text/progress/image/text/done 逐个回调，同时汇总成 { text, images } 供调用方兜底。
const storage = { jwtToken: 'jwt-stream-test' }
const globalData = { userInfo: { id: 'stream-user' } }

let lastRequest = null
let chunkHandler = null

function toArrayBuffer(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
}

global.getApp = () => ({ globalData })
global.getCurrentPages = () => []
global.wx = {
  getStorageSync(key) {
    return storage[key]
  },
  canIUse() {
    return true
  },
  request(options) {
    lastRequest = options
    return {
      onChunkReceived(handler) {
        chunkHandler = handler
      },
      abort() {}
    }
  }
}

const aiApi = require('../utils/ai-api')

// 按字节切：cuts 是切点，用来模拟「一个汉字/一行被拆到两个 chunk」
function pushText(text, cuts) {
  const bytes = Buffer.from(text, 'utf8')
  const points = (cuts || []).concat([bytes.length])
  let start = 0
  points.forEach(end => {
    if (end <= start) {
      return
    }
    chunkHandler({ data: toArrayBuffer(bytes.subarray(start, end)) })
    start = end
  })
}

async function testStreamHappyPath() {
  const events = []
  const promise = aiApi.chatStream(
    {
      sessionId: 's-1',
      message: '画一只猫',
      imgOrientation: 'vertical',
      imageUrls: ['https://oss/a.png']
    },
    { onEvent: event => events.push(event) }
  )

  assert.equal(
    lastRequest.url,
    'https://boltstagent-web-jncfttrxvt.ap-southeast-1.fcapp.run/chat'
  )
  assert.equal(lastRequest.enableChunked, true)
  assert.equal(lastRequest.method, 'POST')
  assert.equal(lastRequest.header.Authentication, 'Bearer jwt-stream-test')
  // 请求参数与非流式版完全一致（接入文档 §五）
  assert.deepEqual(lastRequest.data, {
    user_id: 'boltfox_stream-user',
    session_id: 's-1',
    message: '画一只猫',
    img_orientation: 'vertical',
    image_urls: ['https://oss/a.png']
  })

  // 「正在为您绘制…」这行故意在**汉字中间**（第 22 字节）断开，验证残字节能续上
  pushText('data: {"type":"pre_text","content":"正在为您绘制一只猫"}\n', [22])
  pushText('data: {"type":"progress","progress":5,"stage":"request_sent"}\n')
  // 一行被切成两块（行尾换行还没到），下一块才补齐
  pushText('data: {"type":"progress","progress":50,"stage":"partial_succeeded"}\n', [30])
  pushText('data: {"type":"image","content":"http://oss/cat.png"}\r\n')
  pushText('data: {"type":"text","content":"画面里"}\ndata: {"type":"text","content":"有一只猫🐱"}\n')
  pushText('data: {"type":"progress","progress":100,"stage":"done"}\n')
  // 最后一行不带换行：靠 flush 兜住
  pushText('data: {"type":"done","orientation":"vertical"}')

  lastRequest.success({ statusCode: 200, data: '' })
  const result = await promise

  assert.deepEqual(
    events.map(event => event.type),
    ['pre_text', 'progress', 'progress', 'image', 'text', 'text', 'progress', 'done']
  )
  assert.equal(events[0].content, '正在为您绘制一只猫')
  assert.deepEqual(events.filter(e => e.type === 'progress').map(e => e.progress), [5, 50, 100])
  assert.equal(result.text, '画面里有一只猫🐱')
  assert.deepEqual(result.images, ['http://oss/cat.png'])
  assert.equal(result.orientation, 'vertical')
  assert.equal(result.done, true)
}

// 网关 JWT 缺失：流式下错误体照样从 chunk 回来，必须认出来并转成可展示文案（沿用白名单机制）
async function testGatewayError() {
  const promise = aiApi.chatStream({ sessionId: 's-2', message: 'hi', imgOrientation: 'square' }, {})
  pushText(
    JSON.stringify({
      Code: 'JWTTokenIsMissing',
      Message: 'the jwt token is missing',
      RequestId: 'req-9'
    })
  )
  lastRequest.success({ statusCode: 403, data: '' })
  const error = await promise.then(() => null, err => err)
  assert.equal(error.code, 31001)
  assert.match(error.userMessage, /JWTTokenIsMissing/)
  assert.match(error.userMessage, /req-9/)
}

// 一个事件都没收到（上游直接断/空响应）：归为 30001，页面走失败卡片可重试
async function testEmptyStream() {
  const promise = aiApi.chatStream({ sessionId: 's-3', message: 'hi', imgOrientation: 'square' }, {})
  lastRequest.success({ statusCode: 200, data: '' })
  const error = await promise.then(() => null, err => err)
  assert.equal(error.code, 30001)
  // detail 后面还跟着响应体开头（排障用，形状不对时一眼看出是什么），只断言前缀
  assert.match(error.detail, /^EMPTY_STREAM body=/)
}

// EMPTY_STREAM 的 detail 要带上响应体开头，且长响应只截前 200 字符、不把整段灌进日志
async function testEmptyStreamDetail() {
  const promise = aiApi.chatStream({ sessionId: 's-9', message: 'hi', imgOrientation: 'square' }, {})
  const junk = `不是 SSE 的响应体${'x'.repeat(500)}`
  lastRequest.success({ statusCode: 200, data: junk })
  const error = await promise.then(() => null, err => err)
  assert.equal(error.code, 30001)
  assert.match(error.detail, /^EMPTY_STREAM body=不是 SSE 的响应体/)
  assert.match(error.detail, /共 \d+ 字符/)
  assert.ok(error.detail.length < junk.length, 'detail 应截断，不能整段带出来')
}

// 服务端把事件分隔符转义成了字面 \n（反斜杠+n），整个响应体一行、没有真换行 ——
// 2026-08-06 真机实测，一次完整生图流因此报 EMPTY_STREAM、页面出「生成未完成」。
// 兜底：还原分隔符后重新解析，事件、图、文字、方向都要照常拿到。
async function testEscapedSeparatorRecovery() {
  const events = []
  const promise = aiApi.chatStream(
    { sessionId: 's-esc', message: '画一个动漫少女', imgOrientation: 'vertical' },
    { onEvent: event => events.push(event) }
  )
  const body = [
    'data: {"type":"pre_text","content":"正在为您绘制樱花树下的动漫少女画面…"}',
    'data: {"type":"progress","progress":5,"stage":"starting"}',
    'data: {"type": "progress", "progress": 50, "stage": "partial_succeeded"}',
    'data: {"type":"image","content":"https://inkstar.oss-ap-southeast-1.aliyuncs.com/a.jpg?sig=x"}',
    'data: {"type":"text","content":"画面里"}',
    'data: {"type":"text","content":"银发少女"}',
    'data: {"type":"progress","progress":100,"stage":"done"}',
    'data: {"type":"done","orientation":"vertical"}'
  ].join('\\n\\n') + '\\n\\n' // 注意：这里是**字面**反斜杠+n，不是换行
  assert.equal(body.indexOf('\n'), -1, '整段响应体里不能有真换行，否则测的就不是这个场景')
  pushText(body, [17, 60, 133]) // 切点故意落在汉字中间
  lastRequest.success({ statusCode: 200, data: '' })
  const result = await promise
  assert.equal(events.length, 8)
  assert.equal(events[0].type, 'pre_text')
  assert.equal(result.images.length, 1)
  assert.equal(result.text, '画面里银发少女')
  assert.equal(result.orientation, 'vertical')
  assert.equal(result.done, true)
}

// 还原时只能动**当分隔符用的** \n：JSON 正文里的 \n（回复文字自带换行）动了就把事件劈开了
async function testEscapedSeparatorKeepsInlineNewline() {
  const promise = aiApi.chatStream(
    { sessionId: 's-esc2', message: 'hi', imgOrientation: 'square' },
    {}
  )
  const body =
    [
      'data: {"type":"text","content":"第一行\\n第二行"}',
      'data: {"type":"done","orientation":"square"}'
    ].join('\\n\\n') + '\\n\\n'
  pushText(body, [20])
  lastRequest.success({ statusCode: 200, data: '' })
  const result = await promise
  // 正文里的 \n 由 JSON.parse 解成真换行，事件本身没被劈开
  assert.equal(result.text, '第一行\n第二行')
  assert.equal(result.done, true)
}

// 个别环境不落实 enableChunked（一个 chunk 都不回调，整段响应直接进 success）：
// 把整段当 SSE 文本补喂一次，事件照样还原得出来，不白跑一趟
async function testWholeBodyFallback() {
  const events = []
  const promise = aiApi.chatStream(
    { sessionId: 's-5', message: 'hi', imgOrientation: 'square' },
    { onEvent: event => events.push(event) }
  )
  lastRequest.success({
    statusCode: 200,
    data: 'data: {"type":"text","content":"你好呀"}\ndata: {"type":"done","orientation":"square"}\n'
  })
  const result = await promise
  assert.deepEqual(events.map(event => event.type), ['text', 'done'])
  assert.equal(result.text, '你好呀')
}

// 用户点「停止生成」：abort 用专有 code，页面据此静默处理
async function testAbort() {
  const promise = aiApi.chatStream({ sessionId: 's-4', message: 'hi', imgOrientation: 'square' }, {})
  lastRequest.fail({ errMsg: 'request:fail abort' })
  const error = await promise.then(() => null, err => err)
  assert.equal(error.code, 'ABORTED')
}

async function run() {
  await testStreamHappyPath()
  await testGatewayError()
  await testEmptyStream()
  await testEmptyStreamDetail()
  await testEscapedSeparatorRecovery()
  await testEscapedSeparatorKeepsInlineNewline()
  await testWholeBodyFallback()
  await testAbort()
  console.log('ai stream chat tests passed')
}

run().catch(error => {
  console.error(error)
  process.exitCode = 1
})
