const assert = require('node:assert/strict')

// 「一键生图」点下去，文案要**立刻**出现在对话框里（2026-08-07 需求）。
//
// 病灶：sendChat 原本先 await createSession()（POST /session/new，真机上约 1s）才把用户气泡
// 上屏 —— 空态下点风格按钮，界面要干等一整趟网络往返才有反应，像是没点着。
// 现在改成「气泡先上屏、再建会话」，建会话失败时把气泡撤回去。
//
// 这里锁两件事：
//   ① 建会话还没回来时，用户气泡已经在 messages 里了；
//   ② 建会话失败时气泡和会话标题都还原，不留一条发不出去的孤儿消息。
const storage = { userInfo: { id: 'instant-bubble' } }
let sessionRequest = null // 扣住在途的 /session/new，用来制造「网络还没回来」这一刻

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
  onWindowResize: () => {},
  offWindowResize: () => {},
  createSelectorQuery: () => ({
    in: () => ({ select: () => ({ boundingClientRect: () => ({ exec: () => {} }) }) })
  }),
  showToast: () => {},
  hideToast: () => {},
  showModal: () => {},
  request(options) {
    // /session/new 不立刻回：由用例决定什么时候放行，好在「还没回来」时断言界面
    if (options.url.indexOf('/session/new') > -1) {
      sessionRequest = options
      return { abort() {} }
    }
    // /chat 挂着不回：本用例只关心用户气泡，不验回复
    return { abort() {}, onChunkReceived() {} }
  }
}
global.getApp = () => ({ globalData: { userInfo: { id: 'instant-bubble' } } })
global.getCurrentPages = () => []
global.requirePlugin = () => {
  throw new Error('plugin not available in test')
}

let pageConfig = null
global.Page = config => {
  pageConfig = config
}

// 已同意 AI 服务协议（否则 sendChat 第一步就会弹协议框停下）
const aiServiceConsent = require('../utils/ai-service-consent')
aiServiceConsent.grantCurrentUserConsent()

require('../subpackages/ai/chat/chat.js')
assert.ok(pageConfig, 'chat.js 没有注册 Page')

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
  page.data.sessionId = '' // 空态：这条消息会触发建会话
  page.data.tokenBalance = 99
  page._uid = 0
  page._typeTimer = null
  page._progressTimer = null
  page._stream = null
  page._stick = true
  page._lastStickAt = 0
  page._chatViewH = 0
  page._chatReq = null
  page._createReq = null
  page._retryByMessage = {}
  sessionRequest = null
  return page
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// 建会话的请求真的发出去了才算「卡在网络上」——否则用例就没测到点子上
async function waitSessionRequest() {
  for (let i = 0; i < 100; i += 1) {
    if (sessionRequest) {
      return sessionRequest
    }
    await wait(5)
  }
  throw new Error('没有发出 POST /session/new')
}

async function testBubbleShowsBeforeSessionCreated() {
  const page = createPage()
  const sent = page.onStyleTap({ currentTarget: { dataset: { key: 'cartoon' } } })

  const request = await waitSessionRequest()
  // ——建会话还挂在网络上的这一刻——
  assert.equal(page.data.messages.length, 1, '文案必须先上屏，不能等建会话回来')
  assert.equal(page.data.messages[0].role, 'user')
  assert.equal(page.data.messages[0].content, '生成图片-卡通')
  assert.equal(page.data.sessionId, '', '此刻会话确实还没建出来')

  request.success({ statusCode: 200, data: { success: true, data: { session_id: 'sess-1' } } })
  await sent
  assert.equal(page.data.sessionId, 'sess-1')
  assert.equal(page.data.messages.length, 2, '会话建好后才追加 AI 的占位气泡')
  assert.equal(page.data.messages[1].role, 'assistant')
  assert.equal(page.data.sessionTitle, '生成图片-卡通', '首条消息同步成会话标题')
  page.stopGenerate(true)
}

async function testBubbleRolledBackWhenSessionFails() {
  const page = createPage()
  const prevTitle = page.data.sessionTitle
  const sent = page.onStyleTap({ currentTarget: { dataset: { key: 'anime' } } })

  const request = await waitSessionRequest()
  assert.equal(page.data.messages.length, 1)

  request.fail({ errMsg: 'request:fail timeout' })
  await sent
  assert.equal(page.data.messages.length, 0, '建会话失败要把刚上屏的气泡撤回去')
  assert.equal(page.data.sessionTitle, prevTitle, '标题也要还原')
  assert.equal(page.data.sending, false, '没发出去就不能把发送按钮锁死')
}

async function run() {
  await testBubbleShowsBeforeSessionCreated()
  await testBubbleRolledBackWhenSessionFails()
  console.log('ai send instant bubble tests passed')
}

run().catch(error => {
  console.error(error)
  process.exitCode = 1
})
