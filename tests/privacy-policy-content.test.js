// 隐私政策正文的回归用例（2026-09-10 换成法务 20260909 那份 docx）。
//
// 这一页的正文是**法律文本**，端上只负责渲染：数据来自 privacy-content.js（由法务文档逐块
// 转换而来）。AI 同意弹窗里写着「详情请见《BoltStar 隐私政策》第八节」——**指路指不到**
// 就是合规缺口，不是排版问题。所以这里锁三件事：
//   ① 正文确实是那份全文（14 章齐全，含跨境传输那一章，四张表列数对齐）；
//   ② 弹窗里那句指路能落到实处（第八章确实讲跨境传输）；
//   ③ 页面把每种区块都画出来了（少画一种，就有整块正文在真机上凭空消失）。
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')

const content = require('../subpackages/settings/privacy/privacy-content')
const consent = require('../utils/ai-service-consent')

// ── ① 正文是法务那份全文 ──────────────────────────────────────────────────
const chapters = content.blocks.filter(item => item.type === 'h2')
assert.equal(chapters.length, 14, '隐私政策应有 14 章（法务全文）')
assert.match(content.meta, /2026 年 8 月 28 日/, '页首应写明法务文档的更新日期')
assert.match(content.meta, /版本：/, '页首应写明文档版本')

const tables = content.blocks.filter(item => item.type === 'table')
assert.equal(tables.length, 4, '权限 / 共享 / SDK / 收集清单四张表都要在')
tables.forEach((table, index) => {
  assert.ok(table.head.length >= 3, `第 ${index + 1} 张表缺表头`)
  assert.ok(table.rows.length > 0, `第 ${index + 1} 张表没有数据行`)
  table.rows.forEach(row => {
    assert.equal(
      row.length,
      table.head.length,
      `第 ${index + 1} 张表有一行的列数与表头对不上（转换漏了单元格）`
    )
  })
})

// ── ② AI 同意弹窗那句「详情请见……第八节」必须指得到 ──────────────────────
const eighth = chapters[7]
assert.ok(eighth, '缺少第八章')
assert.match(
  eighth.text,
  /跨境传输/,
  'AI 同意弹窗指向「第八节」讲的就是跨境传输，章节顺序变了要同步改弹窗文案'
)
assert.match(
  consent.CONSENT_CROSS_BORDER_NOTICE,
  /第八节/,
  '弹窗的境外传输告知应指向隐私政策第八节'
)

// ── ③ 页面把每种区块都画出来 ──────────────────────────────────────────────
const markup = read('subpackages/settings/privacy/privacy.wxml')
const kinds = new Set(content.blocks.map(item => item.type))
;['h2', 'h3', 'li', 'p', 'table'].forEach(kind => {
  assert.ok(kinds.has(kind), `正文里应当有 ${kind} 区块`)
})
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

// 旧版正文的痕迹不该再留在页面上（日期随正文数据一起来自法务文档）
;['2026-5-13', '2026 年 8 月 13 日'].forEach(stale => {
  assert.ok(
    !markup.includes(stale),
    `页面不该写死旧版日期 ${stale}：日期随正文数据一起来自法务文档`
  )
})

// ── ④ 经产品确认的排版修正必须在（法务下次给新版时，这几条要重新过一遍） ──────
assert.match(content.meta, /生效日期：2026 年 9 月 10 日/, '生效日期已按产品口径填实，不该再是占位符')
assert.match(content.meta, /版本：V1\.0/, '版本号是 V1.0（原文的 VI.0 已确认是笔误）')
;['待填写', 'VI.0'].forEach(stale => {
  assert.ok(!content.meta.includes(stale), `页首不该再出现「${stale}」`)
})
const plain = content.blocks
  .map(item => (item.type === 'table'
    ? [...item.head, ...item.rows.flat()].join(' ')
    : item.text))
  .join('\n')
;[/[一-鿿][,;]/, /[,;][一-鿿]/, /。。/].forEach(pattern => {
  assert.ok(!pattern.test(plain), `中文句子里仍有半角标点或重复句号：${pattern}`)
})

console.log('privacy policy content tests passed')
