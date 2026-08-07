const assert = require('node:assert/strict')

// AI 聊天页的流式渲染状态机（subpackages/ai/chat/chat.js，2026-08-06 SSE 接入）。
// 锁四件容易在后续改动中被打破的事：
//   ① 进度只增不减 —— 服务端重复/乱序推 progress 时进度条不能往回跳；
//   ② 进度是**补间**上屏的 —— 服务端只给里程碑，中间读数由前端补（2026-08-07「-改」版文档 §三）；
//   ③ 预描述、图、文字都写进**同一个气泡**，图不等文字打完就先上屏；
//   ④ 流结束后要收尾：隐藏进度条、typing 归位、sending 放行（漏了就再也发不出下一条）。
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
  page._progressTimer = null
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
    genPad: 177.78, // 渐变占位盒的比例，与真图同源（见 chat.js replyImagePad）
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

// 补间一步 80ms；等这么久足够确认「进度确实不动了」（用于验倒退被丢弃）
const PROGRESS_SETTLE_MS = 300

// 进度不再是收到就贴上去，而是每 80ms 补一步爬过去（chat.js pumpProgress），
// 所以断言之前得等它爬到位。
async function waitProgress(page, value) {
  for (let i = 0; i < 200; i += 1) {
    if (page.data.messages[0].progress >= value) {
      return
    }
    await wait(20)
  }
  throw new Error(`进度没有爬到 ${value}%（停在 ${page.data.messages[0].progress}%）`)
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

  // 接入文档「-改」版 §二 的生图事件顺序（stage 原样照抄）
  page.onStreamEvent(holder.id, { type: 'pre_text', content: '正在为您绘制赛博朋克城市的雨夜夜景…' })
  let message = page.data.messages[0]
  assert.equal(message.loading, false, 'pre_text 一到就该收起三点动画')
  assert.equal(message.streaming, true)
  assert.equal(message.preText, '正在为您绘制赛博朋克城市的雨夜夜景…')
  await waitProgress(page, 5)
  assert.equal(page.data.messages[0].progress, 5, 'pre_text 先把进度条顶到 5%')
  assert.equal(page.data.messages[0].progressLabel, '正在连接生图引擎…')

  ;[
    { progress: 5, stage: 'request_sent' },
    { progress: 15, stage: 'generating' },
    { progress: 30, stage: 'generating' },
    { progress: 45, stage: 'generating' }
  ].forEach(event => page.onStreamEvent(holder.id, Object.assign({ type: 'progress' }, event)))
  await waitProgress(page, 45)
  assert.equal(page.data.messages[0].progress, 45)
  assert.equal(page.data.messages[0].progressLabel, 'AI 正在创作中…')

  page.onStreamEvent(holder.id, { type: 'progress', progress: 50, stage: 'partial_succeeded' })
  await waitProgress(page, 50)
  assert.equal(page.data.messages[0].progressLabel, '初稿已完成 ✨')

  // 迟到/乱序的小进度不能让进度条倒退
  page.onStreamEvent(holder.id, { type: 'progress', progress: 8, stage: 'generating' })
  await wait(PROGRESS_SETTLE_MS)
  assert.equal(page.data.messages[0].progress, 50)
  assert.equal(page.data.messages[0].progressLabel, '初稿已完成 ✨', '倒退的 stage 也不能改文案')

  // 服务端 2026-08-07 起在 progress 事件上直接带 message：有就用它，不再走本地 stage 映射
  page.onStreamEvent(holder.id, {
    type: 'progress',
    progress: 80,
    stage: 'completed',
    message: '正在打磨细节呢'
  })
  await waitProgress(page, 80)
  assert.equal(
    page.data.messages[0].progressLabel,
    '正在打磨细节呢',
    '服务端给了 message 就直接显示，别再用本地那句「正在优化细节…」'
  )

  // message 是空串/纯空格时当没给，回落到 stage 映射（否则占位盒里会空一行）
  page.onStreamEvent(holder.id, {
    type: 'progress',
    progress: 82,
    stage: 'completed',
    message: '   '
  })
  await waitProgress(page, 82)
  assert.equal(page.data.messages[0].progressLabel, '正在优化细节…')
  ;[
    { progress: 85, stage: 'downloading' },
    { progress: 90, stage: 'uploaded' }
  ].forEach(event => page.onStreamEvent(holder.id, Object.assign({ type: 'progress' }, event)))
  await waitProgress(page, 90)
  assert.equal(page.data.messages[0].progressLabel, '正在下载图片…')

  // 图排在 progress 90 之后（文档 §二），此时文字一个字都还没来
  page.onStreamEvent(holder.id, { type: 'image', content: 'http://oss/city.png' })
  message = page.data.messages[0]
  assert.equal(message.images.length, 1)
  assert.equal(message.images[0].url, 'http://oss/city.png')
  // 竖向出图 1440×2560(9:16) → 2560/1440 = 177.78（2026-08-06 后端确认的实际尺寸，
  // 此前按文档 v1.0.4 的 3:4 取 133.33，那组已作废）
  assert.equal(message.images[0].pad, 177.78, '图应按当前 img_orientation 预占高度')
  assert.equal(message.content, '')

  page.onStreamEvent(holder.id, { type: 'text', content: '画面里' })
  page.onStreamEvent(holder.id, { type: 'text', content: '霓虹灯映在积水上🌃' })
  assert.equal(page.data.messages[0].typing, true)

  page.onStreamEvent(holder.id, { type: 'progress', progress: 100, stage: 'done' })
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

// 渐变占位盒的收起时机（2026-08-07 需求「达到 100% 渲染生成的图片」）。
// 图在 90% 之后就推过来了，但要压着不显示；streaming 必须在 **读数爬到 100 的那一刻**落下
// ——不能等 settleStream，那要等打字机把几十条 text 打完，图会晚好几秒才出来。
async function testCanvasHidesAtHundred() {
  const page = createPage()
  const holder = pushHolder(page)
  page.beginStream(holder.id)

  page.onStreamEvent(holder.id, { type: 'pre_text', content: '正在为您绘制…' })
  assert.equal(page.data.messages[0].streaming, true, '有进度事件就该挂出占位盒')

  // 图到了（文档 §二：排在 progress 90 之后），但此时 streaming 仍为 true → wxml 上真图不渲染
  page.onStreamEvent(holder.id, { type: 'progress', progress: 90, stage: 'uploaded' })
  page.onStreamEvent(holder.id, { type: 'image', content: 'http://oss/a.png' })
  await waitProgress(page, 90)
  assert.equal(page.data.messages[0].images.length, 1, '图要先收进 images')
  assert.equal(page.data.messages[0].streaming, true, '没到 100% 之前占位盒不能收')

  // 文字还在流：此时依然是占位盒
  page.onStreamEvent(holder.id, { type: 'text', content: '画面里' })
  assert.equal(page.data.messages[0].streaming, true)

  // 读数爬到 100：占位盒立刻收起，真图上屏（不等打字机打完）
  page.onStreamEvent(holder.id, { type: 'progress', progress: 100, stage: 'done' })
  assert.equal(page.data.messages[0].streaming, true, '90→100 补间途中占位盒还得挂着')
  await waitProgress(page, 100)
  assert.equal(page.data.messages[0].streaming, false, '读数到 100 时占位盒要立刻收起换真图')
  assert.equal(page.data.messages[0].progress, 100)
  assert.equal(page.data.messages[0].progressLabel, '生成完成')
  assert.equal(page.data.messages[0].typing, true, '文字这时候还没打完，打字机不受影响')

  // 100% 之后服务端又补推一条 progress（重复/迟到的都可能）：占位盒不能被翻出来盖住真图
  page.onStreamEvent(holder.id, { type: 'progress', progress: 90, stage: 'uploaded' })
  page.onStreamEvent(holder.id, { type: 'progress', progress: 100, stage: 'done' })
  assert.equal(page.data.messages[0].streaming, false, '收起后不能再显形')

  page.finishStream(holder.id, { text: '画面里', images: ['http://oss/a.png'], done: true })
  await waitSettled(page)
  assert.equal(page.data.messages[0].images.length, 1)
  assert.equal(page.data.messages[0].streaming, false)
}

// 补间本身（2026-08-07「-改」版文档 §三）：服务端只推里程碑，前端必须把中间读数补出来。
// demo.png 上那个 47% 就是补出来的——里程碑里根本没有 47 这一级。
async function testProgressTweensBetweenMilestones() {
  const page = createPage()
  const holder = pushHolder(page)
  page.beginStream(holder.id)

  const seen = []
  const setData = page.setData
  page.setData = patch => {
    setData(patch, undefined)
    if (patch['messages[0].progress'] !== undefined) {
      seen.push(patch['messages[0].progress'])
    }
  }

  page.onStreamEvent(holder.id, { type: 'progress', progress: 45, stage: 'generating' })
  await waitProgress(page, 45)
  page.onStreamEvent(holder.id, { type: 'progress', progress: 50, stage: 'partial_succeeded' })
  await waitProgress(page, 50)

  assert.ok(seen.indexOf(47) > -1, `45→50 之间要补出 47%，实际读数：${seen.join(',')}`)
  // 只增不减，且一步都不越过目标（宁可停在里程碑上等下一条，也不能自己往前跑）
  seen.forEach((value, i) => {
    assert.ok(i === 0 || value > seen[i - 1], `进度读数不能回退：${seen.join(',')}`)
    assert.ok(value <= 50, `补间不能跑到服务端给的目标之前：${seen.join(',')}`)
  })
  // 远离目标时一步 3、临近时一步 1（文档 §三）：0→45 这段的步长必须比 45→50 那段大
  assert.ok(seen[1] - seen[0] === 3, `离目标远时一步 3：${seen.join(',')}`)
  assert.ok(seen[seen.length - 1] - seen[seen.length - 2] === 1, `临近目标时一步 1：${seen.join(',')}`)
}

// 服务端漏推 100（真机上出现过事件不全）：settleStream 仍要把占位盒兜下来，
// 否则图永远出不来、占位盒一直挂着
async function testCanvasHidesWhenHundredMissing() {
  const page = createPage()
  const holder = pushHolder(page)
  page.beginStream(holder.id)

  page.onStreamEvent(holder.id, { type: 'progress', progress: 5 })
  page.onStreamEvent(holder.id, { type: 'image', content: 'http://oss/b.png' })
  page.onStreamEvent(holder.id, { type: 'progress', progress: 90 })
  await waitProgress(page, 90)
  assert.equal(page.data.messages[0].streaming, true)

  // 没有 progress:100，直接结束
  page.finishStream(holder.id, { text: '好了', images: ['http://oss/b.png'], done: true })
  await waitSettled(page)
  assert.equal(page.data.messages[0].streaming, false, 'settleStream 要兜底收起占位盒')
  assert.equal(page.data.messages[0].images.length, 1)
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

// 图下面那段描述必须**逐字**出，不能一帧糊上去（2026-08-07：STREAM_TYPE_TICKS 60→180 前，
// 一次性涌进来的全文会在 ~0.8s 内冲完，肉眼看不出在打字）。
// 这里模拟最糟的情况：所有 text 事件在同一帧到达（响应体一次性解析的那条兜底路径就是这样）。
async function testTypewriterRevealsGradually() {
  const page = createPage()
  const holder = pushHolder(page)
  page.beginStream(holder.id)

  const frames = []
  const setData = page.setData
  page.setData = patch => {
    setData(patch, undefined)
    if (patch['messages[0].content'] !== undefined) {
      frames.push(patch['messages[0].content'].length)
    }
  }

  const full = '画面里是一只软萌的灰色垂耳兔，长耳朵垂在两侧，圆眼睛亮亮的，毛绒质感很足。'
  Array.from(full).forEach(ch =>
    page.onStreamEvent(holder.id, { type: 'text', content: ch })
  )
  page.finishStream(holder.id, { text: full, images: [], done: true })
  await waitSettled(page)

  assert.equal(page.data.messages[0].content, full, '最终要打全')
  // 每帧最多 ceil(积压/180) 字：这段 37 字全部积压时也只能 1 字/帧，帧数不该被压缩掉
  assert.ok(
    frames.length >= Array.from(full).length,
    `应逐字出，实际只用了 ${frames.length} 帧打完 ${Array.from(full).length} 字`
  )
  frames.forEach((len, i) => {
    assert.ok(i === 0 || len > frames[i - 1], '每帧只增不减')
  })
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
  await testCanvasHidesAtHundred()
  await testProgressTweensBetweenMilestones()
  await testCanvasHidesWhenHundredMissing()
  await testTextOnlyFlow()
  await testTypewriterRevealsGradually()
  await testAggregateFallback()
  await testEmptyReplyRemovesBubble()
  await testStopKeepsStreamedContent()
  console.log('ai stream render tests passed')
}

run().catch(error => {
  console.error(error)
  process.exitCode = 1
})
