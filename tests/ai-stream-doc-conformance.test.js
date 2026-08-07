const assert = require('node:assert/strict')

// 按 assets/BoltStar-SSE-前端接入文档 -改.md §二「SSE 事件类型」逐条核对解析层
//（章节号是「-改」版的；同样的报文在上一版里是 §六，两版事件流一字未改）。
// 文档里的原始报文直接抄进来当用例，服务端改格式时这里先红。
// 覆盖三处文档与标准 SSE 不一致、容易踩的地方：
//   · 文档的完整流示例用**单个 \n** 分隔事件（标准 SSE 是空行 \n\n）——两种都得吃；
//   · 报文里 `data: ` 带空格，而文档示例代码写死 slice(6)——我们按 slice(5)+trim 更稳；
//   · 纯文字场景的文字里有 emoji（4 字节），chunk 边界劈开时不能吐出半个字符。
let lastRequest = null

global.getApp = () => ({ globalData: { userInfo: { id: 'GA7593223' } } })
global.getCurrentPages = () => []
global.wx = {
  getStorageSync: () => 'jwt',
  canIUse: () => true,
  request(options) {
    const task = {
      onChunkReceived(cb) {
        this._cb = cb
      },
      abort() {}
    }
    lastRequest = { options, task }
    return task
  }
}

const aiApi = require('../utils/ai-api')

// 按字节切块，模拟真机 onChunkReceived —— 汉字/emoji 必然被劈在块边界
function feedChunks(task, body, size) {
  const buf = Buffer.from(body, 'utf8')
  for (let i = 0; i < buf.length; i += size) {
    const slice = buf.slice(i, i + size)
    task._cb({
      data: slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength)
    })
  }
}

async function collect(body, { sep = '\n', chunkSize = 7 } = {}) {
  const events = []
  const promise = aiApi.chatStream(
    { sessionId: 's-doc', message: 'hi', imgOrientation: 'square' },
    { onEvent: event => events.push(event) }
  )
  const { task, options } = lastRequest
  feedChunks(task, body.join(sep) + sep, chunkSize)
  options.success({ statusCode: 200, data: '' })
  return { result: await promise, events }
}

// ---- §6.6 完整 SSE 流示例（生图场景），原文照抄 ----
const DOC_IMAGE_FLOW = [
  'data: {"type":"pre_text","content":"正在为您绘制软萌可爱的小猫画面…"}',
  'data: {"type":"progress","progress":5,"stage":"starting"}',
  'data: {"type":"progress","progress":5,"stage":"request_sent"}',
  'data: {"type":"progress","progress":15,"stage":"generating"}',
  // 2026-08-07 服务端在 progress 上新增 message（文案改由后端下发）：解析层同样原样透传
  'data: {"type":"progress","progress":30,"stage":"generating","message":"正在创作图片"}',
  'data: {"type":"progress","progress":45,"stage":"generating"}',
  'data: {"type":"progress","progress":50,"stage":"partial_succeeded"}',
  'data: {"type":"progress","progress":80,"stage":"completed"}',
  'data: {"type":"progress","progress":85,"stage":"downloading"}',
  'data: {"type":"progress","progress":90,"stage":"uploaded"}',
  'data: {"type":"image","content":"https://inkstar.oss-.../xxx.jpg?...签名"}',
  'data: {"type":"text","content":"画面里"}',
  'data: {"type":"text","content":"是软乎乎"}',
  'data: {"type":"text","content":"的橘白奶猫。"}',
  'data: {"type":"progress","progress":100,"stage":"done"}',
  'data: {"type":"done","orientation":"square"}'
]

// ---- §6.7 纯文字场景（含 emoji）----
const DOC_TEXT_FLOW = [
  'data: {"type":"text","content":"你好呀"}',
  'data: {"type":"text","content":"😊我是星宝"}',
  'data: {"type":"text","content":"…"}',
  'data: {"type":"done","orientation":"square"}'
]

async function testImageFlowSingleLf() {
  // 文档 §6.6 就是单 \n 分隔的
  const { result, events } = await collect(DOC_IMAGE_FLOW, { sep: '\n' })
  assert.equal(events.length, 16)
  assert.equal(events[0].type, 'pre_text')
  assert.equal(events[0].content, '正在为您绘制软萌可爱的小猫画面…')
  assert.equal(result.images.length, 1)
  assert.match(result.images[0], /^https:\/\/inkstar\.oss-/)
  assert.equal(result.text, '画面里是软乎乎的橘白奶猫。')
  assert.equal(result.orientation, 'square')
  assert.equal(result.done, true)

  // stage 全部原样透传给页面：解析层不解读它，但页面要靠它出文案
  //（chat.js STAGE_LABELS —— 5 有 starting/request_sent 两种 stage，光看数值分不开），
  // 所以这一层一个都不能吃掉、也不能改名
  const stages = events.filter(e => e.type === 'progress').map(e => e.stage)
  assert.deepEqual(stages, [
    'starting',
    'request_sent',
    'generating',
    'generating',
    'generating',
    'partial_succeeded',
    'completed',
    'downloading',
    'uploaded',
    'done'
  ])

  // 新增的 message 字段也必须原样到页面（页面优先用它出文案，见 chat.js progressLabel）
  const messages = events.filter(e => e.type === 'progress' && e.message).map(e => e.message)
  assert.deepEqual(messages, ['正在创作图片'])
}

async function testImageFlowBlankLine() {
  // 标准 SSE 的空行分隔（真机实测就是这个）：结果必须和单 \n 完全一致
  const { result, events } = await collect(DOC_IMAGE_FLOW, { sep: '\n\n' })
  assert.equal(events.length, 16)
  assert.equal(result.text, '画面里是软乎乎的橘白奶猫。')
  assert.equal(result.done, true)
}

async function testTextFlowWithEmoji() {
  // 4 字节 emoji 被 chunk 劈开也得完整还原（chunkSize=3 保证劈中）
  const { result, events } = await collect(DOC_TEXT_FLOW, { sep: '\n\n', chunkSize: 3 })
  assert.equal(events.length, 4)
  assert.equal(result.text, '你好呀😊我是星宝…')
  assert.equal(Array.from(result.text)[3], '😊', 'emoji 不能被劈成两半')
  assert.equal(result.orientation, 'square')
  assert.equal(result.images.length, 0)
}

async function testDataPrefixWithoutSpace() {
  // 文档 §4.1 示例代码写死 slice(6)（依赖 `data: ` 带空格）。服务端哪天不带空格，
  // 那份示例会把 JSON 的第一个字符吃掉；我们按 slice(5)+trim，两种都认。
  const { result } = await collect(
    [
      'data:{"type":"text","content":"无空格"}',
      'data:  {"type":"text","content":"多空格"}',
      'data: {"type":"done","orientation":"vertical"}'
    ],
    { sep: '\n\n' }
  )
  assert.equal(result.text, '无空格多空格')
  assert.equal(result.orientation, 'vertical')
}

async function run() {
  await testImageFlowSingleLf()
  await testImageFlowBlankLine()
  await testTextFlowWithEmoji()
  await testDataPrefixWithoutSpace()
  console.log('ai stream doc conformance tests passed')
}

run().catch(error => {
  console.error(error)
  process.exitCode = 1
})
