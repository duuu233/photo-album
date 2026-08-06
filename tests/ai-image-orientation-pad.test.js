const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

// 图片占位比例（pad = 高/宽×100）与后端**实际出图尺寸**的一致性，两件事：
//
//   ① 文生图三档：2026-08-06 后端确认 horizontal 2560×1440 / square 1920×1920 /
//      vertical 1440×2560，即 16:9 / 1:1 / 9:16。API 文档 v1.0.4 §四写的
//      1472×1104 / 1328×1328 / 1104×1472（4:3 / 1:1 / 3:4）**已作废**，别照着它改回去。
//      这里直接拿 ORIENTATION_OPTIONS 里的 size 字符串反算 pad 对不对，改了尺寸忘了改 pad 就红。
//
//   ② 图生图/融合图**不吃这三档**：后端规则是「像素 ≥ 3,686,400 保持原尺寸，不足则等比放大到
//      3,686,400」——等比放大不改宽高比，所以出图比例跟**用户原图**走，与 img_orientation 无关。
//      占位比例必须取原图的，取成方向档的话图加载完会跳一下（且加载前那一帧会裁）。
const CHAT = path.join(__dirname, '..', 'subpackages/ai/chat/chat.js')
const source = fs.readFileSync(CHAT, 'utf8')

// 3,686,400 = 2560×1440 = 1920×1920，三档文生图正好都踩在这个像素数上
const MIN_PIXELS = 3686400

function testOrientationPadsMatchDeclaredSizes() {
  const block = source.slice(
    source.indexOf('const ORIENTATION_OPTIONS'),
    source.indexOf('const ORIENTATION_ALIAS')
  )
  const entries = block.match(/key:\s*'(\w+)',[\s\S]*?size:\s*'(\d+)×(\d+)',\s*\n\s*pad:\s*([\d.]+)/g)
  assert.ok(entries && entries.length === 3, '应能解析出三档方向')

  const seen = {}
  entries.forEach(entry => {
    const [, key, w, h, pad] = entry.match(
      /key:\s*'(\w+)',[\s\S]*?size:\s*'(\d+)×(\d+)',\s*\n\s*pad:\s*([\d.]+)/
    )
    const width = Number(w)
    const height = Number(h)
    const expected = Number(((height / width) * 100).toFixed(2))
    assert.ok(
      Math.abs(Number(pad) - expected) < 0.01,
      `${key} 尺寸 ${w}×${h} 的 pad 应是 ${expected}，实际写的是 ${pad}`
    )
    // 三档都是 3,686,400 像素（后端同一套出图规格），尺寸抄错一位数这里就拦下
    assert.equal(width * height, MIN_PIXELS, `${key} 尺寸像素数应为 ${MIN_PIXELS}`)
    seen[key] = { width, height, pad: Number(pad) }
  })

  assert.deepEqual(Object.keys(seen).sort(), ['horizontal', 'square', 'vertical'])
  assert.equal(seen.horizontal.pad, 56.25) // 16:9
  assert.equal(seen.square.pad, 100) // 1:1
  assert.equal(seen.vertical.pad, 177.78) // 9:16

  // 三档都得落在钳制区间内，否则 clampPad 会把比例改掉、图又要被裁
  const min = Number(source.match(/const IMAGE_PAD_MIN = ([\d.]+)/)[1])
  const max = Number(source.match(/const IMAGE_PAD_MAX = ([\d.]+)/)[1])
  Object.keys(seen).forEach(key => {
    assert.ok(
      seen[key].pad >= min && seen[key].pad <= max,
      `${key} 的 pad ${seen[key].pad} 超出 [${min}, ${max}]，会被 clampPad 改掉`
    )
  })

  // 历史消息取不到方向时的默认值，语义是「按竖向占位」，得跟着竖向一起变
  const fallback = Number(source.match(/const IMAGE_PAD_DEFAULT = ([\d.]+)/)[1])
  assert.equal(fallback, seen.vertical.pad, 'IMAGE_PAD_DEFAULT 应与竖向一致')
}

// ---- 页面侧：replyImagePad 的取值优先级 ----
const storage = {}
global.wx = {
  getStorageSync: key => storage[key],
  setStorageSync: (key, value) => {
    storage[key] = value
  },
  removeStorageSync: key => delete storage[key],
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
global.getApp = () => ({ globalData: { userInfo: { id: 'pad-test' } } })
global.getCurrentPages = () => []
global.requirePlugin = () => {
  throw new Error('plugin not available in test')
}

let pageConfig = null
global.Page = config => {
  pageConfig = config
}
require('../subpackages/ai/chat/chat.js')

function createPage() {
  const page = Object.create(pageConfig)
  page.data = JSON.parse(JSON.stringify(pageConfig.data))
  page.setData = patch => Object.assign(page.data, patch)
  return page
}

function testReplyImagePadPrefersSourceImage() {
  const page = createPage()

  // 文生图（没带原图）：按当前方向档
  page.data.orientation = 'vertical'
  assert.equal(page.replyImagePad(), 177.78)
  page.data.orientation = 'horizontal'
  assert.equal(page.replyImagePad(), 56.25)
  page.data.orientation = 'square'
  assert.equal(page.replyImagePad(), 100)

  // 别名也要归一化（landscape → horizontal），否则会掉进 vertical 兜底
  page.data.orientation = 'landscape'
  assert.equal(page.replyImagePad(), 56.25)

  // 图生图：跟用户原图走，方向档一概不管
  page.data.orientation = 'vertical'
  page._replyPad = 66.67 // 用户传了一张 3:2 横图
  assert.equal(page.replyImagePad(), 66.67, '图生图应按原图比例占位，不按 img_orientation')

  // 原图比例异常（拿不到宽高时 pad 为 0）：回落到方向档，不能占出个 0 高的盒子
  page._replyPad = 0
  assert.equal(page.replyImagePad(), 177.78)

  // 极端长图要被钳住，免得占位盒把整屏撑没了
  page._replyPad = 900
  assert.equal(page.replyImagePad(), 240)
}

testOrientationPadsMatchDeclaredSizes()
testReplyImagePadPrefersSourceImage()
console.log('ai image orientation pad tests passed')
