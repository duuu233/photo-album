// 联调日志（2026-10-27）：开发版 / 体验版每个页面左下角都有「日志」浮窗（components/debug-log），点开看、一键复制。
// 正式版（envVersion=release）整套不生效：不收集、不显示，console 也不包装。
//
// 来源：
//   · app.js 启动时 install()：包装 console.log / info / warn / error，原样输出到控制台的同时记一份——
//     项目里已有的 [WiFi投屏]、[WiFi状态]、[相册删除] 等日志不用改就都能看到；
//   · 网络层（utils/request.js、utils/iot-request.js、utils/iot-ws.js）各记一行请求 / 推送摘要；
//   · 浮窗组件在页面显示时记一行「页面 → 路由」。
// 只在内存里留最近 LIMIT 行，不落 Storage；token、密码类字段在入库前统一打码（redact）。
const LIMIT = 500
const MAX_LINE = 2000

let lines = []
let seq = 0
let installed = false
let enabledCache = null
const listeners = []

function enabled() {
  if (enabledCache === null) {
    try {
      enabledCache = typeof wx !== 'undefined' && wx.getAccountInfoSync().miniProgram.envVersion !== 'release'
    } catch (error) {
      enabledCache = false
    }
  }
  return enabledCache
}

// token / 密码类字段打码：JSON 字符串值（"pwd":"a,b c" 整段到右引号）、JSON 非字符串值、
// query / 文本（userToken=xx、token: xx）、Header（Bearer xx）都认。键名含 token 的（aiToken 等）一并打码
const SECRET_KEYS = '[A-Za-z]*token|Authorization|Authentication|pwd|password|passwd|secret'
const JSON_STRING = new RegExp(`("(?:${SECRET_KEYS})"\\s*:\\s*")(?:\\\\.|[^"\\\\])*"`, 'gi')
const JSON_OTHER = new RegExp(`("(?:${SECRET_KEYS})"\\s*:\\s*)(?!["\\s])[^,}\\]\\s]+`, 'gi')
const PLAIN = new RegExp(`(\\b(?:${SECRET_KEYS})\\s*[=:]\\s*)(?!["\\s*])(?:Bearer\\s+)?[^&\\s,"'}]+`, 'gi')
function redact(text) {
  return String(text)
    .replace(JSON_STRING, '$1***"')
    .replace(JSON_OTHER, '$1***')
    .replace(PLAIN, '$1***')
    .replace(/Bearer\s+(?!\*\*\*)[A-Za-z0-9._\-]+/g, 'Bearer ***')
}

function stringify(value) {
  if (typeof value === 'string') {
    return value
  }
  // Error（按形状认，跨上下文的 Error 也算）：只要 message；业务错误对象 { code, message } 走下面的 JSON，保留 code
  if (value && typeof value.message === 'string' && typeof value.stack === 'string') {
    return value.message || String(value)
  }
  if (value && typeof value === 'object' && value.errMsg && Object.keys(value).length <= 2) {
    return value.errMsg
  }
  try {
    return JSON.stringify(value)
  } catch (error) {
    return String(value)
  }
}

function pad(n, len) {
  return String(n).padStart(len || 2, '0')
}

function timeText() {
  const now = new Date()
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`
}

// 记一行（参数同 console.log，多个按空格拼）
function add() {
  if (!enabled()) {
    return
  }
  let text = Array.prototype.map.call(arguments, stringify).join(' ')
  if (text.length > MAX_LINE) {
    text = `${text.slice(0, MAX_LINE)}…（截断，共 ${text.length} 字）`
  }
  seq += 1
  lines.push({ id: `dl${seq}`, text: `${timeText()} ${redact(text)}` })
  if (lines.length > LIMIT) {
    lines = lines.slice(-LIMIT)
  }
  listeners.slice().forEach(fn => {
    try {
      fn()
    } catch (error) {
      // 浮窗刷新出错不影响业务
    }
  })
}

// 包装 console：控制台照常输出，同时记进日志。warn / error 加前缀便于一眼找到
function install() {
  if (installed || !enabled() || typeof console === 'undefined') {
    return
  }
  installed = true
  const prefixes = { log: '', info: '', warn: '[warn]', error: '[error]' }
  Object.keys(prefixes).forEach(level => {
    const original = console[level]
    if (typeof original !== 'function') {
      return
    }
    console[level] = function () {
      original.apply(console, arguments)
      const args = Array.prototype.slice.call(arguments)
      add.apply(null, prefixes[level] ? [prefixes[level]].concat(args) : args)
    }
  })
}

function getLines() {
  return lines.slice()
}

function count() {
  return lines.length
}

function text() {
  return lines.map(line => line.text).join('\n')
}

function clear() {
  lines = []
  listeners.slice().forEach(fn => fn())
}

// 订阅变化，返回取消函数
function subscribe(fn) {
  listeners.push(fn)
  return () => {
    const at = listeners.indexOf(fn)
    if (at > -1) {
      listeners.splice(at, 1)
    }
  }
}

module.exports = {
  LIMIT,
  enabled,
  redact,
  add,
  install,
  getLines,
  count,
  text,
  clear,
  subscribe
}
