const assert = require('node:assert/strict')

// 2026-08-12 AI 模块两项：
//   ① 发起对话前先问服务端「星币够不够」（GET /Client/Order/chkAiDialogue）。
//      此前端上那道闸（LIMIT_ENABLED=false + 按余额比大小）等于没有，余额为 0 也照发。
//      ⚠️ 真机实测「不够」的答复是 **retCode=403 + retMsg**（不是 200+false），
//      即否定答复走的是失败分支，用例按真实形状打桩。
//      这里锁住：不允许时 **/chat 一个请求都不许发**、用户气泡一条都不许上屏、
//      **草稿要还回输入框**（余额见底的用户每次发送都会撞上，让他重打一遍最难受），
//      且提示里的数字来自后端 retMsg、话由端上说（后端原话「token余额不足…30.0 token」不能直接示人）。
//   ② 本地图片上传上限 4 → 5 张，超出提示「当前AI只允许上传5张图」。
const storage = { token: 'user-token', jwtToken: 'jwt-token', userInfo: { id: 'guard-user' } }

let allowDialogue = true
let chatRequests = []
let sessionRequests = []
let checkRequests = []
let toasts = []
let modals = []

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
  getDeviceInfo: () => ({ platform: 'devtools', model: 'test-device' }),
  canIUse: () => true,
  onWindowResize: () => {},
  offWindowResize: () => {},
  createSelectorQuery: () => ({
    in: () => ({ select: () => ({ boundingClientRect: () => ({ exec: () => {} }) }) })
  }),
  showToast: options => toasts.push(options),
  hideToast: () => {},
  showLoading: () => {},
  hideLoading: () => {},
  showModal: options => {
    modals.push(options)
    if (typeof options.success === 'function') {
      options.success({ confirm: false, cancel: true }) // 用户点「知道了」，不跳购买页
    }
  },
  navigateTo: () => {},
  request(options) {
    const url = String(options.url)
    if (url.indexOf('/Client/Order/chkAiDialogue') > -1) {
      checkRequests.push(options)
      options.success({
        statusCode: 200,
        data: allowDialogue
          ? { retCode: 200, retMsg: 'success', retData: true }
          : // 真机原样：403 + 带最低余额的 retMsg + retData null
            {
              retCode: 403,
              retMsg: 'token余额不足，需要最低余额：30.0 token',
              retData: null
            }
      })
      return { abort() {} }
    }
    if (url.indexOf('/Client/Order/getUserAccount') > -1) {
      options.success({
        statusCode: 200,
        data: { retCode: 200, retData: { availableToken: '0', totalToken: '0', consumeToken: '0' } }
      })
      return { abort() {} }
    }
    if (url.indexOf('/session/new') > -1) {
      sessionRequests.push(options)
      options.success({
        statusCode: 200,
        data: { success: true, data: { session_id: 'sess-new' } }
      })
      return { abort() {} }
    }
    if (url.indexOf('/chat') > -1) {
      chatRequests.push(options) // 挂着不回：本用例只关心「发没发出去」
      return { abort() {}, onChunkReceived() {} }
    }
    throw new Error(`用例没有为 ${url} 准备桩数据`)
  }
}
global.getApp = () => ({ globalData: { userInfo: { id: 'guard-user' } } })
global.getCurrentPages = () => []
global.requirePlugin = () => {
  throw new Error('plugin not available in test')
}

let pageConfig = null
global.Page = config => {
  pageConfig = config
}

const aiServiceConsent = require('../utils/ai-service-consent')
aiServiceConsent.grantCurrentUserConsent()

// 选图与上传都走桩：本用例验的是张数闸，不验相册/OSS
const media = require('../utils/media')
const api = require('../utils/api')
let albumCalls = []
media.chooseFromAlbum = count => {
  albumCalls.push(count)
  return Promise.resolve(
    Array.from({ length: 6 }, (raw, index) => ({
      tempFilePath: `local-${index}.png`,
      width: 1080,
      height: 1920
    }))
  )
}
media.compressToTarget = filePath =>
  Promise.resolve({ filePath, bytes: 1024, compressed: false })
api.setFileUpload = () => Promise.resolve(['https://oss/uploaded.png'])

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
  page.data.sessionId = 'sess-guard' // 已有会话：把建会话这一段摘出去，只看星币闸
  page._uid = 0
  page._pid = 0
  page._typeTimer = null
  page._progressTimer = null
  page._stream = null
  page._stick = true
  page._lastStickAt = 0
  page._chatViewH = 0
  page._chatReq = null
  page._createReq = null
  page._retryByMessage = {}
  chatRequests = []
  sessionRequests = []
  checkRequests = []
  toasts = []
  modals = []
  albumCalls = []
  return page
}

// ① 星币不足：拦住、不发请求、草稿还回来
async function testBlockedWhenNotAllowed() {
  allowDialogue = false
  const page = createPage()
  page.data.inputValue = '画一只猫'

  await page.onSendTap()

  assert.equal(chatRequests.length, 0, '服务端说不行，/chat 一个请求都不该发')
  assert.equal(page.data.messages.length, 0, '也不该把用户气泡先放上去再撤')
  assert.equal(page.data.inputValue, '画一只猫', '草稿必须还回输入框，别让用户重打一遍')
  assert.equal(page.data.sending, false, '没发出去就不能把发送按钮锁死')
  // 弹窗是**页面自绘**的（2026-08-12 需求 1，与删除确认框同一套版式），不再走 wx.showModal
  assert.equal(modals.length, 0, '不该再用原生 wx.showModal，样式与全站对不上')
  assert.equal(page.data.tokenDialog.show, true)
  // 数字取后端的（30.0 → 30，星币是整数计价，`.0` 只会让人以为还有小数位），
  // 话由端上说：后端原话带「token」和接口味，不能直接示人
  assert.equal(
    page.data.tokenDialog.desc,
    '发起一次 AI 对话至少需要 30 星币，当前余额不足。购买后即可继续和星宝聊天。'
  )
  assert.ok(!/token/i.test(page.data.tokenDialog.desc), '对外一律「星币」，不许漏出 token 字样')
}

// ②' 星币不足时**连会话都不该建**（2026-08-12 需求 2：校验要排在 /session/new 之前）
async function testNoSessionCreatedWhenBlocked() {
  allowDialogue = false
  const page = createPage()
  page.data.sessionId = '' // 空态：这条消息本来会触发建会话
  page.data.inputValue = '画一只猫'

  await page.onSendTap()

  assert.equal(
    sessionRequests.length,
    0,
    '钱不够就别去占会话：每用户上限 20 条，余额见底的用户点几次就占满了'
  )
  assert.equal(chatRequests.length, 0)
  assert.equal(page.data.sessionId, '')
  assert.equal(page.data.tokenDialog.show, true)
}

// ② 允许：照常发出去
async function testPassesWhenAllowed() {
  allowDialogue = true
  const page = createPage()
  page.data.inputValue = '画一只猫'

  await page.onSendTap()

  assert.equal(chatRequests.length, 1, '校验通过就该照常发 /chat')
  assert.equal(page.data.inputValue, '', '发出去了才清草稿')
  assert.equal(page.data.messages.length, 2, '用户气泡 + AI 占位气泡')
  assert.equal(page.data.tokenDialog.show, false)
  assert.equal(
    checkRequests.length,
    1,
    '一次发送只该打一次校验：onSendTap 查过之后要把结论透传给 sendChat，别两处各打一遍'
  )
  // 顺带把 usertoken 这个新参数在**页面链路**上再验一次（ai-stream-chat 验的是接口层）
  assert.equal(chatRequests[0].data.usertoken, 'user-token')
  page.stopGenerate(true)
}

// ③ 本地图片最多 5 张
async function testImageLimitIsFive() {
  allowDialogue = true
  const page = createPage()

  // 相册一次给回 6 张（部分机型不严格按 count 限制）：只留 5 张并提示
  await page.pickImage('album')
  assert.deepEqual(albumCalls, [5], '向相册要的张数就是剩余额度')
  assert.equal(page.data.pendingImages.length, 5, '多出来的第 6 张要被截掉')
  assert.equal(toasts.length, 1)
  assert.equal(toasts[0].title, '当前AI只允许上传5张图')

  // 已经满了：连相册都不该打开
  toasts = []
  albumCalls = []
  await page.pickImage('album')
  assert.deepEqual(albumCalls, [], '已达上限就别再拉起相册了')
  assert.equal(toasts.length, 1)
  assert.equal(toasts[0].title, '当前AI只允许上传5张图')
}

;(async () => {
  await testBlockedWhenNotAllowed()
  await testNoSessionCreatedWhenBlocked()
  await testPassesWhenAllowed()
  await testImageLimitIsFive()
  console.log('ai dialogue guard tests passed')
})().catch(error => {
  console.error(error)
  process.exitCode = 1
})
