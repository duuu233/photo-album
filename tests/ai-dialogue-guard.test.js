const assert = require('node:assert/strict')

// 2026-08-12 AI 模块两项：
//   ① 发起对话前先问服务端「星币够不够」（GET /Client/Order/chkAiDialogue，retData 是布尔）。
//      此前端上那道闸（LIMIT_ENABLED=false + 按余额比大小）等于没有，余额为 0 也照发。
//      这里锁住：不允许时 **/chat 一个请求都不许发**、用户气泡一条都不许上屏、
//      **草稿要还回输入框**（余额见底的用户每次发送都会撞上，让他重打一遍最难受）。
//   ② 本地图片上传上限 4 → 5 张，超出提示「当前AI只允许上传5张图」。
const storage = { token: 'user-token', jwtToken: 'jwt-token', userInfo: { id: 'guard-user' } }

let allowDialogue = true
let chatRequests = []
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
      options.success({ statusCode: 200, data: { retCode: 200, retData: allowDialogue } })
      return { abort() {} }
    }
    if (url.indexOf('/Client/Order/getUserAccount') > -1) {
      options.success({
        statusCode: 200,
        data: { retCode: 200, retData: { availableToken: '0', totalToken: '0', consumeToken: '0' } }
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
  assert.equal(modals.length, 1)
  assert.equal(modals[0].title, '星币不足')
  assert.equal(modals[0].confirmText, '去购买', '弹窗要给一条出路，不能只说「不够了」')
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
  assert.equal(modals.length, 0)
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
  await testPassesWhenAllowed()
  await testImageLimitIsFive()
  console.log('ai dialogue guard tests passed')
})().catch(error => {
  console.error(error)
  process.exitCode = 1
})
