// 用户协议正文的回归用例（2026-09-10 由 2026-5-13 的旧短文换成法务 20260909 那份 docx）。
//
// 旧版是写死在 wxml 里的三节几百字（前言 + 服务说明 + 账号规则），法务给的是 15 章全文，
// 含星币、AI、固件升级、违规处理阶梯表与争议解决。改法照搬隐私政策那一套：正文进
// agreement-content.js，页面只留一套通用渲染。这里锁的东西与隐私政策同构：
//   ① 正文确实是那份全文（15 章齐全，违规处理那张表列数对齐）；
//   ② 章节里点名的那几件事没有在转换中丢（星币、AI、注销、争议解决）；
//   ③ 页面把每种区块都画出来了，且不再残留旧短文与旧日期。
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')

const content = require('../subpackages/settings/agreement/agreement-content')

// ── ① 正文是法务那份全文 ──────────────────────────────────────────────────
const chapters = content.blocks.filter(item => item.type === 'h2')
assert.equal(chapters.length, 15, '用户协议应有 15 章（法务全文）')
assert.match(content.meta, /2026 年 8 月 28 日/, '页首应写明法务文档的更新日期')
assert.match(content.meta, /版本：/, '页首应写明文档版本')

const tables = content.blocks.filter(item => item.type === 'table')
assert.equal(tables.length, 1, '第九章的违规处理阶梯表要在')
tables.forEach(table => {
  assert.ok(table.head.length >= 2, '违规处理表缺表头')
  assert.ok(table.rows.length > 0, '违规处理表没有数据行')
  table.rows.forEach(row => {
    assert.equal(
      row.length,
      table.head.length,
      '违规处理表有一行的列数与表头对不上（转换漏了单元格）'
    )
  })
})

// ── ② 关键章节没在转换中丢 ────────────────────────────────────────────────
const headings = chapters.map(item => item.text).join('\n')
;['星币', 'AI', '注销', '争议解决', '知识产权', '固件升级'].forEach(topic => {
  assert.ok(
    headings.includes(topic) ||
      content.blocks.some(item => (item.text || '').includes(topic)),
    `正文里应当讲到「${topic}」`
  )
})

// ── ③ 页面把每种区块都画出来，且不再残留旧短文 ────────────────────────────
const markup = read('subpackages/settings/agreement/agreement.wxml')
;["item.type === 'h2'", "item.type === 'h3'", "item.type === 'li'", "item.type === 'table'"].forEach(
  branch => {
    assert.ok(markup.includes(branch), `wxml 缺少 ${branch} 的渲染分支`)
  }
)
assert.ok(
  /wx:else[^>]*class="article-p"/.test(markup),
  'wxml 应把普通段落作为兜底分支画出来'
)
assert.ok(markup.includes('{{docMeta}}'), 'wxml 应画出页首的日期/版本行')
assert.ok(
  !markup.includes('2026-5-13'),
  '页面不该再写死旧版日期：日期随正文数据一起来自法务文档'
)
assert.ok(
  !markup.includes('一、服务说明'),
  '旧短文的章节标题不该还写死在页面里'
)

console.log('user agreement content tests passed')
