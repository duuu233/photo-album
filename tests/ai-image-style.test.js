// 一键生图「风格按钮 ↔ img_style」绑定关系的回归用例（2026-08-06）。
//
// 点风格按钮时，按钮的 key 同时决定两件事（subpackages/ai/chat/chat.js onStyleTap）：
//   ① 发给后端的 img_style —— 真正决定出图风格；
//   ② aiI18n.genMessage(key) 自动拼的 message —— 用户气泡里显示的那句话。
// 所以 key 绑错不会报任何错，只是「点漫画出卡通图、气泡还写着卡通」，只能靠用例锁。
//
// 文档 v1.0.3 §5.3.2 的中文对应关系是固定的：
//   cartoon = 卡通「生成图片-卡通」 / anime = 动漫「生成图片-动漫」
//   landscape = 风景 / portrait = 人像
// 「漫画」属于 anime 那一档 —— 同一份文档里 cartoon 的日文文案才是「画像を生成-漫画」。
// 曾经把 漫画→cartoon、卡通→anime 反着绑，两个选项的文案和出图风格互换了。
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')

const storage = {}
global.wx = {
  getStorageSync: key => storage[key],
  setStorageSync: (key, value) => { storage[key] = value },
  removeStorageSync: key => { delete storage[key] },
  getSystemInfoSync: () => ({ language: 'zh_CN' }),
  getAppBaseInfo: () => ({ language: 'zh_CN' })
}

const language = require('../utils/language')
const aiI18n = require('../utils/ai-i18n')

// chat.js 是 Page 文件（依赖一堆小程序运行时），不能 require，只解它的 STYLE_OPTIONS 字面量
const chatSource = fs.readFileSync(path.join(root, 'subpackages/ai/chat/chat.js'), 'utf8')
const block = /const STYLE_OPTIONS = \[([\s\S]*?)\]/.exec(chatSource)
assert.ok(block, 'chat.js 里找不到 STYLE_OPTIONS')

const options = block[1]
  .split('\n')
  .map(line => /\{\s*key:\s*'([^']+)'\s*,\s*label:\s*'([^']+)'\s*\}/.exec(line))
  .filter(Boolean)
  .map(([, key, label]) => ({ key, label }))
assert.equal(options.length, 4, '一键生图应有 4 个风格选项')

// 按钮上的字 → 该发的 img_style。改按钮文案时必须同步这张表，且要对着文档确认语义，
// 别按列表顺序对（顺序对齐正是当初绑反的原因）。
const EXPECTED = { 漫画: 'anime', 人物: 'portrait', 风景: 'landscape', 卡通: 'cartoon' }

options.forEach(({ key, label }) => {
  assert.ok(EXPECTED[label], `出现了未登记的风格按钮「${label}」：请对着文档 §5.3.2 补进本用例`)
  assert.equal(
    key,
    EXPECTED[label],
    `风格按钮「${label}」应发 img_style=${EXPECTED[label]}，现在发的是 ${key}：` +
      '出图风格和气泡文案都会变成另一个选项的'
  )
})
assert.equal(
  new Set(options.map(item => item.key)).size,
  4,
  '四个按钮的 img_style 不能重复（重复必然意味着有一档绑错）'
)

// 文案侧：genMessage 对未知 key 会静默回落成 cartoon 那条（utils/ai-i18n.js），
// key 一旦写错/漏配，用户点任何风格都发「生成图片-卡通」，页面上看不出任何异常。
const LANGUAGES = ['zh-Hans', 'zh-Hant', 'en', 'ja']
LANGUAGES.forEach(lang => {
  language.setSelectedLanguage(lang)
  const messages = options.map(item => aiI18n.genMessage(item.key))
  messages.forEach((message, index) => {
    assert.ok(message, `${lang} 缺少 ${options[index].key} 的一键生图文案`)
  })
  assert.equal(
    new Set(messages).size,
    4,
    `${lang} 的四条一键生图文案出现重复：多半是某个 key 没配、被 genMessage 回落成了卡通那条`
  )
})

// 简体中文按文档逐条对死：这两条就是当初互换的那两个
language.setSelectedLanguage('zh-Hans')
assert.equal(aiI18n.genMessage('cartoon'), '生成图片-卡通')
assert.equal(aiI18n.genMessage('anime'), '生成图片-动漫')

const labelOf = key => options.filter(item => item.key === key)[0].label
assert.equal(labelOf('cartoon'), '卡通', '写着「卡通」的按钮必须发「生成图片-卡通」')
assert.equal(labelOf('anime'), '漫画', '写着「漫画」的按钮必须发 anime 档（「生成图片-动漫」）')

console.log('ai-image-style: ok')
