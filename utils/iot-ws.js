// IoT 服务 WebSocket 推送客户端（WiFi 版设备：play.result / device.status / ota.result / notification.new）。
//
// 接口文档口径（2026-10-26）：
//   · 地址 config.iotWsURL；握手鉴权读 Header `userToken`（与 HTTP 同一个登录 token）。
//     握手失败不会建立连接：401 = 需要重新登录，503 = 老服务暂时不可用、稍后重试；
//   · 客户端发 subscribe / unsubscribe（按 deviceNo）与 ping；**订阅成功后才收得到该设备的推送**；
//   · 服务端 90 秒收不到任何消息会断开，这里每 30 秒发一次 ping；
//   · 断线重连按 1s、2s、4s… 指数退避、上限 30s；**断线期间的事件会丢**，所以重连成功时
//     state 事件带 reconnect:true，页面据此用 REST 补查一次状态（投屏状态、在线状态等）。
//
// 单例、按需连接：只有调用 connect() / subscribe() 才会建连（App 启动不自动连，BLE 版用户用不到它）。
// 已订阅的设备在重连后自动重新订阅。退出登录时 app.clearSession 会调 close()。
const config = require('./config')
const debugLog = require('./debug-log')

// 联调日志（开发版 / 体验版左下角浮窗）：单测沙箱里可能没有 debug-log，取不到就不记；心跳 ping / pong 不记
function trace() {
  if (debugLog && typeof debugLog.add === 'function') {
    debugLog.add.apply(null, arguments)
  }
}

const HEARTBEAT_MS = 30000
const RETRY_BASE_MS = 1000
const RETRY_MAX_MS = 30000

let task = null
let state = 'idle' // idle / connecting / open / closed
let wanted = false // 调用方要求保持连接：为 true 时断线自动重连
let everOpened = false
let retryAttempt = 0
let retryTimer = null
let heartbeatTimer = null
let lastErrMsg = ''
let appShowHooked = false
const subscriptions = new Set()
const listeners = {}

function on(type, handler) {
  if (!listeners[type]) {
    listeners[type] = new Set()
  }
  listeners[type].add(handler)
  return () => off(type, handler)
}

function off(type, handler) {
  if (listeners[type]) {
    listeners[type].delete(handler)
  }
}

function emit(type, payload) {
  ;(listeners[type] ? Array.from(listeners[type]) : []).forEach(handler => {
    try {
      handler(payload)
    } catch (error) {
      // 页面回调自身的异常不能打断推送分发
      console.warn('[iot-ws] listener error', type, error)
    }
  })
}

function setState(next, extra) {
  state = next
  trace(`[WS] 状态 → ${next}`, extra || '')
  emit('state', Object.assign({ state: next }, extra))
}

function send(message) {
  if (state !== 'open' || !task) {
    return false
  }
  if (message && message.type !== 'ping') {
    trace('[WS] 发 →', message)
  }
  task.send({ data: JSON.stringify(message) })
  return true
}

function startHeartbeat() {
  stopHeartbeat()
  heartbeatTimer = setInterval(() => send({ type: 'ping' }), HEARTBEAT_MS)
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
}

// 握手被拒的原因只能从 errMsg / close reason 里认（各端措辞不同，如安卓「Unexpected response code: 401」）
function classifyClose(reason) {
  const text = String(reason || '')
  if (/\b401\b/.test(text)) {
    return 'unauthorized'
  }
  if (/\b503\b/.test(text)) {
    return 'unavailable'
  }
  return 'closed'
}

function scheduleReconnect() {
  if (!wanted || retryTimer) {
    return 0
  }
  const wait = Math.min(RETRY_BASE_MS * Math.pow(2, retryAttempt), RETRY_MAX_MS)
  retryAttempt += 1
  retryTimer = setTimeout(() => {
    retryTimer = null
    open()
  }, wait)
  return wait
}

function handleClosed(current, reason) {
  if (task !== current) {
    return // 已被 close() 或新连接替换的旧连接，忽略
  }
  task = null
  stopHeartbeat()
  const kind = classifyClose(reason)
  if (kind === 'unauthorized') {
    // 401：token 失效，重连也没用；登录态由 HTTP 层（iot-request 的 401）统一引导重登
    wanted = false
    setState('closed', { reason: kind, message: reason || '' })
    return
  }
  const retryIn = scheduleReconnect()
  setState('closed', { reason: kind, message: reason || '', retryIn })
}

function hookAppShow() {
  if (appShowHooked || !wx.onAppShow) {
    return
  }
  appShowHooked = true
  // 回到前台：后台期间微信可能已把连接断掉，不必等退避计时，立刻重连
  wx.onAppShow(() => {
    if (wanted && !task) {
      clearTimeout(retryTimer)
      retryTimer = null
      retryAttempt = 0
      open()
    }
  })
}

function open() {
  if (task) {
    return
  }
  const token = wx.getStorageSync('token') || ''
  if (!token) {
    wanted = false
    setState('closed', { reason: 'no-token', message: '未登录' })
    return
  }
  lastErrMsg = ''
  setState('connecting')
  let current = null
  current = wx.connectSocket({
    url: config.iotWsURL,
    header: { userToken: token },
    fail(error) {
      // 推到下一拍：个别基础库同步回调 fail，此时 current / task 还没赋上
      setTimeout(() => handleClosed(current, (error && error.errMsg) || 'connectSocket fail'), 0)
    }
  })
  task = current
  current.onOpen(() => {
    if (task !== current) {
      return
    }
    const reconnect = everOpened
    everOpened = true
    retryAttempt = 0
    startHeartbeat()
    setState('open', { reconnect })
    subscriptions.forEach(deviceNo => send({ type: 'subscribe', deviceNo }))
  })
  current.onMessage(res => {
    let message = null
    try {
      message = JSON.parse(res.data)
    } catch (error) {
      return
    }
    if (!message || !message.type) {
      return
    }
    if (message.type !== 'pong') {
      trace('[WS] 收 ←', message)
    }
    emit('message', message)
    emit(message.type, message)
  })
  current.onError(error => {
    lastErrMsg = (error && error.errMsg) || ''
  })
  current.onClose(res => {
    handleClosed(current, (res && res.reason) || lastErrMsg)
  })
}

// 要求保持连接：已连 / 连接中直接返回；断线后自动重连，直到 close()
function connect() {
  wanted = true
  hookAppShow()
  open()
}

// 主动断开并清空订阅（退出登录、调试台「断开」）
function close() {
  wanted = false
  clearTimeout(retryTimer)
  retryTimer = null
  retryAttempt = 0
  stopHeartbeat()
  subscriptions.clear()
  if (task) {
    const current = task
    task = null
    try {
      current.close({})
    } catch (error) {
      // 已断开的连接 close 会报错，忽略
    }
    setState('closed', { reason: 'manual' })
  }
}

// 订阅某台设备的推送：记下来（重连后自动补订），已连上就立即发；未连则顺带发起连接
function subscribe(deviceNo) {
  const id = String(deviceNo || '').trim()
  if (!id) {
    return
  }
  subscriptions.add(id)
  if (!send({ type: 'subscribe', deviceNo: id })) {
    connect()
  }
}

function unsubscribe(deviceNo) {
  const id = String(deviceNo || '').trim()
  if (!id) {
    return
  }
  subscriptions.delete(id)
  send({ type: 'unsubscribe', deviceNo: id })
}

module.exports = {
  connect,
  close,
  subscribe,
  unsubscribe,
  ping: () => send({ type: 'ping' }),
  on,
  off,
  getState: () => state,
  getSubscriptions: () => Array.from(subscriptions)
}
