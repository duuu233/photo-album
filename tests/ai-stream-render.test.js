const assert = require('node:assert/strict')

// AI 聊天页的流式渲染状态机（subpackages/ai/chat/chat.js，2026-08-06 SSE 接入）。
// 锁三件容易在后续改动中被打破的事：
//   ① 进度只增不减 —— 服务端重复/乱序推 progress 时进度条不能往回跳；
//   ② 预描述、图、文字都写进**同一个气泡**，图不等文字打完就先上屏；
//   ③ 流结束后要收尾：隐藏进度条、typing 归位、sending 放行（漏了就再也发不出下一条）。
const storage = {}

global.wx = {
  getStorageSync: key => storage[key],
  setStorageSync: (key, value) => {
    storage[key] = value
  },
  removeStorageSync: key => {
    delete storage[key]
  },
  getSystemInfoSync: () => ({ language: 'zh_CN', windowWidth: 375, statusBarHeight: 20 }),
  getWindowInfo: () => ({ windowWidth: 375, statusBarHeight: 20, safeArea: { bottom: 812 } }),
  getAppBaseInfo: () => ({ language: 'zh_CN' }),
  getDeviceInfo: () => ({ platform: 'devtools' }),
  canIUse: () => true,
  request: () => ({ abort() {}, onChunkReceived() {} }),
  onWindowResize: () => {},
  offWindowResize: () => {},
  createSelectorQuery: () => ({
    in: () => ({ select: () => ({ boundingClientRect: () => ({ exec: () => {} }) }) })
  }),
  showToast: () => {},
  hideToast: () => {}
}
global.getApp = () => ({ globalData: { userInfo: { id: 'stream-render' } } })
global.getCurrentPages = () => []
global.requirePlugin = () => {
  throw new Error('plugin not available in test')
}

let pageConfig = null
global.Page = config => {
  pageConfig = config
}

require('../subpackages/ai/chat/chat.js')
assert.ok(pageConfig, 'chat.js 没有注册 Page')

// setData 的路径键（messages[0].content）在测试里也要能写进去，否则验不了流式那些定点更新
function applyPath(target, key, value) {
  const tokens = key.match(/[^.[\]]+/g)
  let node = target
  for (let i = 0; i < tokens.length - 1; i += 1) {
    node = node[tokens[i]]
  }
  node[tokens[tokens.length - 1]] = value
}

function createPage() {
  const page = Object.create(pageConfig)
  page.data = JSON.parse(JSON.stringify(pageConfig.data))
  page.setData = (patch, done) => {
    Object.keys(patch).forEach(key => applyPath(page.data, key, patch[key]))
    if (typeof done === 'function') {
      done()
    }
  }
  page._uid = 0
  page._typeTimer = null
  page._stream = null
  page._stick = true
  page._lastStickAt = 0
  page._chatViewH = 0
  page._retryByMessage = {}
  return page
}

function pushHolder(page) {
  const holder = {
    id: ++page._uid,
    serverId: '',
    role: 'assistant',
    kind: 'rich',
    content: '',
    images: [],
    loading: true,
    typing: false,
    failed: false,
    preText: '',
    streaming: false,
    progress: 0,
    progressLabel: '',
    timestampMs: 0,
    timeLabel: ''
  }
  page.data.messages = page.data.messages.concat([holder])
  page.data.sending = true
  return holder
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// 打字机是异步的（递归 setTimeout），等它把积压打完 + settleStream 收尾
async function waitSettled(page) {
  for (let i = 0; i < 400; i += 1) {
    if (!page.data.sending) {
      return
    }
    await wait(20)
  }
  throw new Error('流式回复没有收尾：sending 一直没放行')
}

async function testGenerateFlow() {
  const page = createPage()
  const holder = pushHolder(page)
  page.beginStream(holder.id)

  // 接入文档 §三 的生图事件顺序
  page.onStreamEvent(holder.id, { type: 'pre_text', content: '正在为您绘制赛博朋克城市的雨夜夜景…' })
  let message = page.data.messages[0]
  assert.equal(message.loading, false, 'pre_text 一到就该收起三点动画')
  assert.equal(message.streaming, true)
  assert.equal(message.preText, '正在为您绘制赛博朋克城市的雨夜夜景…')
  assert.equal(message.progress, 5, 'pre_text 先把进度条顶到 5%')

  ;[5, 12, 28, 45].forEach(progress => page.onStreamEvent(holder.id, { type: 'progress', progress }))
  assert.equal(page.data.messages[0].progress, 45)
  assert.equal(page.data.messages[0].progressLabel, 'AI 正在创作中…')

  page.onStreamEvent(holder.id, { type: 'progress', progress: 50 })
  assert.equal(page.data.messages[0].progressLabel, '图片初稿已完成 ✨')

  // 图先上屏（此时文字一个字都还没来）
  page.onStreamEvent(holder.id, { type: 'image', content: 'http://oss/city.png' })
  message = page.data.messages[0]
  assert.equal(message.images.length, 1)
  assert.equal(message.images[0].url, 'http://oss/city.png')
  // 竖向出图 1440×2560(9:16) → 2560/1440 = 177.78（2026-08-06 后端确认的实际尺寸，
  // 此前按文档 v1.0.4 的 3:4 取 133.33，那组已作废）
  assert.equal(message.images[0].pad, 177.78, '图应按当前 img_orientation 预占高度')
  assert.equal(message.content, '')

  // 迟到/乱序的小进度不能让进度条倒退
  page.onStreamEvent(holder.id, { type: 'progress', progress: 8 })
  assert.equal(page.data.messages[0].progress, 50)

  ;[80, 85, 90].forEach(progress => page.onStreamEvent(holder.id, { type: 'progress', progress }))
  assert.equal(page.data.messages[0].progressLabel, '正在优化细节…')

  page.onStreamEvent(holder.id, { type: 'text', content: '画面里' })
  page.onStreamEvent(holder.id, { type: 'text', content: '霓虹灯映在积水上🌃' })
  assert.equal(page.data.messages[0].typing, true)

  page.onStreamEvent(holder.id, { type: 'progress', progress: 100 })
  page.finishStream(holder.id, {
    text: '画面里霓虹灯映在积水上🌃',
    images: ['http://oss/city.png'],
    orientation: 'vertical',
    done: true
  })

  await waitSettled(page)
  message = page.data.messages[0]
  assert.equal(message.content, '画面里霓虹灯映在积水上🌃', '文字要全部打完')
  assert.equal(message.typing, false)
  assert.equal(message.streaming, false, 'done 之后进度条要隐藏')
  assert.equal(message.images.length, 1, '汇总结果里的图不能被重复追加一遍')
  assert.equal(message.preText, '正在为您绘制赛博朋克城市的雨夜夜景…', '预描述保留在回复里')
  assert.equal(page.data.sending, false)
  assert.equal(page.data.messages.length, 1)
}

// 纯文字场景：没有任何 progress/pre_text 事件，界面不该出现进度条
async function testTextOnlyFlow() {
  const page = createPage()
  const holder = pushHolder(page)
  page.beginStream(holder.id)

  page.onStreamEvent(holder.id, { type: 'text', content: '你好呀' })
  page.onStreamEvent(holder.id, { type: 'done', orientation: 'square' })
  page.finishStream(holder.id, { text: '你好呀', images: [], orientation: 'square', done: true })

  await waitSettled(page)
  const message = page.data.messages[0]
  assert.equal(message.content, '你好呀')
  assert.equal(message.streaming, false)
  assert.equal(message.preText, '')
  assert.equal(message.loading, false)
}

// 服务端没推 text 事件、只在汇总结果里给了全文：兜底补齐，不能白丢一段回复
async function testAggregateFallback() {
  const page = createPage()
  const holder = pushHolder(page)
  page.beginStream(holder.id)

  page.finishStream(holder.id, {
    text: '这是最终文本',
    images: ['http://oss/a.png'],
    orientation: 'vertical',
    done: true
  })

  await waitSettled(page)
  const message = page.data.messages[0]
  assert.equal(message.content, '这是最终文本')
  assert.equal(message.images.length, 1)
}

// 一句话一张图都没有：不留空白气泡
async function testEmptyReplyRemovesBubble() {
  const page = createPage()
  const holder = pushHolder(page)
  page.beginStream(holder.id)
  page.onStreamEvent(holder.id, { type: 'progress', progress: 5 })
  page.finishStream(holder.id, { text: '', images: [], orientation: '', done: true })

  await waitSettled(page)
  assert.equal(page.data.messages.length, 0, '空回复要把占位气泡收掉')
}

// 停止生成：已流出的内容留着，进度条/打字机归位，sending 放行
async function testStopKeepsStreamedContent() {
  const page = createPage()
  const holder = pushHolder(page)
  page.beginStream(holder.id)
  page.onStreamEvent(holder.id, { type: 'pre_text', content: '正在为您绘制…' })
  page.onStreamEvent(holder.id, { type: 'image', content: 'http://oss/b.png' })
  page.onStreamEvent(holder.id, { type: 'text', content: '画面里' })

  page.stopGenerate(false)
  assert.equal(page._stream, null)
  assert.equal(page.data.sending, false)
  const message = page.data.messages[0]
  assert.ok(message, '已经出图了，气泡不能被整条丢掉')
  assert.equal(message.streaming, false)
  assert.equal(message.typing, false)
  assert.equal(message.images.length, 1)

  // 一个字都没出来的流式气泡（只收到进度）在停止时应被清掉，别留空白框
  const page2 = createPage()
  const holder2 = pushHolder(page2)
  page2.beginStream(holder2.id)
  page2.onStreamEvent(holder2.id, { type: 'progress', progress: 5 })
  page2.stopGenerate(false)
  assert.equal(page2.data.messages.length, 0)
}

async function run() {
  await testGenerateFlow()
  await testTextOnlyFlow()
  await testAggregateFallback()
  await testEmptyReplyRemovesBubble()
  await testStopKeepsStreamedContent()
  console.log('ai stream render tests passed')
}

run().catch(error => {
  console.error(error)
  process.exitCode = 1
})
