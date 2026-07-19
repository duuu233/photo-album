// 富文本归一：把后端富文本编辑器产出的内容处理成 <rich-text nodes> 认得的 HTML 串。
//
// 后端同一个字段可能出现三种形态，都要兜住：
//   1. 转义过的 HTML —— "&lt;p&gt;正文&lt;/p&gt;"，直接丢给 rich-text 会把标签当文字显示出来；
//   2. 原始 HTML —— 但富文本编辑器常产出 rich-text 不支持的标签（section/article/figure…），
//      不支持的节点会被整块丢弃，表现为「内容缺失」；
//   3. 纯文本 —— 只有 \n 换行，HTML 里换行会被折叠，整段挤成一行。
//
// 另外 rich-text 的**外部 class 不作用于内部节点**（官方限制），字号/行高/颜色只能内联，
// 所以最后统一包一层带 style 的 div。

// rich-text 不支持、但富文本编辑器爱用的块级标签：降级成 div，保住里面的内容。
const UNSUPPORTED_BLOCKS = /<(\/?)(section|article|header|footer|main|aside|nav|figure|figcaption)\b/gi
// 整块丢弃的标签（连内容一起），留着只会把 CSS/JS 源码显示成正文。
const DROP_BLOCKS = /<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi

// 与 .guide-body 的视觉保持一致（rich-text 内部节点吃不到外部 class，只能内联重写一遍）。
const DEFAULT_ROOT_STYLE = 'font-size:24rpx;line-height:40rpx;color:rgba(42,43,43,0.6);word-break:break-word;'

function decodeEntities(text) {
  // &amp; 必须最后解，否则 "&amp;lt;" 会被两步解成 "<"。
  return String(text)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
}

function escapeText(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

// 「转义过的 HTML」判定：出现 &lt;标签名 才算，单纯正文里写了个 "&lt;" 不算。
function looksEscapedHtml(text) {
  return /&lt;\s*\/?[a-z][a-z0-9]*/i.test(text)
}

function hasHtmlTag(text) {
  return /<\s*\/?[a-z][a-z0-9]*(\s|\/|>)/i.test(text)
}

// 图片：编辑器里常带着原图尺寸，不限宽会顶破卡片。
function normalizeImages(html) {
  return html.replace(/<img\b([^>]*?)(\/?)>/gi, (match, attrs, selfClose) => {
    if (/\sstyle\s*=\s*["']/i.test(attrs)) {
      return `<img${attrs.replace(/(\sstyle\s*=\s*["'])/i, '$1max-width:100%;height:auto;')}${selfClose}>`
    }
    return `<img${attrs} style="max-width:100%;height:auto;"${selfClose}>`
  })
}

// 段落间距：rich-text 内部不吃外部 class，p 之间不给点间距会糊成一坨。
// 只补给自己没写 style 的标签，不覆盖后端排好的版。
function normalizeParagraphs(html) {
  return html.replace(/<(p|div|li)\b([^>]*)>/gi, (match, tag, attrs) => {
    if (/\sstyle\s*=/i.test(attrs)) {
      return match
    }
    const style = tag.toLowerCase() === 'li' ? 'margin:0 0 8rpx;' : 'margin:0 0 16rpx;'
    return `<${tag}${attrs} style="${style}">`
  })
}

function plainTextToHtml(text) {
  const lines = String(text).split(/\r?\n/)
  const paragraphs = lines
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => `<p style="margin:0 0 16rpx;">${escapeText(line)}</p>`)
  return paragraphs.join('')
}

/**
 * 归一化富文本内容。
 * @param {string} raw 后端返回的原始内容（HTML / 转义 HTML / 纯文本均可）
 * @param {string} [rootStyle] 根节点内联样式，默认按操作指南的正文样式
 * @returns {string} 可直接喂给 <rich-text nodes="..."> 的 HTML；内容为空时返回 ''
 */
function toRichHtml(raw, rootStyle) {
  if (!raw && raw !== 0) {
    return ''
  }
  let html = String(raw).trim()
  if (!html) {
    return ''
  }

  if (looksEscapedHtml(html)) {
    html = decodeEntities(html)
  }

  if (hasHtmlTag(html)) {
    html = html
      .replace(DROP_BLOCKS, '')
      .replace(UNSUPPORTED_BLOCKS, '<$1div')
    html = normalizeParagraphs(normalizeImages(html))
  } else {
    // 纯文本：先把可能残留的实体解出来，再按换行拆段，否则整段会挤成一行。
    html = plainTextToHtml(decodeEntities(html))
  }

  if (!html.trim()) {
    return ''
  }
  return `<div style="${rootStyle || DEFAULT_ROOT_STYLE}">${html}</div>`
}

module.exports = {
  toRichHtml,
  // 导出内部函数便于单测/排查，页面侧只用 toRichHtml。
  decodeEntities,
  plainTextToHtml
}
