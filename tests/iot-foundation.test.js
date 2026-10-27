// IoT 服务联调基础（2026-10-26，对接进度 STEP 0）：
//   ① 统一错误码：{code,msg,data} 口径；401 要重登、503 只能稍后重试（绝不当 401）、429 带 retryAfter；
//   ② HTTP 客户端：iot 域名 + Header userToken；GET 空参数不拼进 url；401 走老服务同一套登出引导、503 不登出；
//      网络失败只给 GET 静默重试，POST 不重发；
//   ③ WebSocket：Header userToken 握手；连上后自动补订阅；断线 1s、2s… 指数退避重连，重连成功带 reconnect:true
//      提示页面补查；握手 401 停止重连。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const root = path.join(__dirname, '..')
const config = require('../utils/config')
const iotErrors = require('../utils/iot-errors')

let checks = 0
function checked(name) { checks++; console.log('PASS ' + name) }

function load(file, modules, globals) {
  const sandbox = Object.assign({ module: { exports: {} }, require: target => modules[target], console }, globals)
  vm.runInNewContext(fs.readFileSync(path.join(root, file), 'utf8'), sandbox, { filename: path.basename(file) })
  return sandbox.module.exports
}

async function main() {
  // ── ① 错误码 ──
  assert.deepEqual(iotErrors.fromResponse(200, { code: 0, msg: 'ok', data: { online: true } }), { ok: true, data: { online: true } })
  const offline = iotErrors.fromResponse(200, { code: 4041, msg: 'device offline', data: null }).error
  assert.equal(offline.code, 4041)
  assert.equal(offline.message, '设备已离线，请检查设备网络')
  assert.equal(offline.action, 'none')
  const relogin = iotErrors.fromResponse(401, { code: 401, msg: 'unauthorized', data: null }).error
  assert.equal(relogin.code, 401)
  assert.ok(iotErrors.isRelogin(relogin))
  const unavailable = iotErrors.fromResponse(503, { code: 503, msg: 'permission service unavailable', data: null }).error
  assert.equal(unavailable.code, 503)
  assert.ok(!iotErrors.isRelogin(unavailable), '503 是老服务暂不可用，不能当登录失效')
  assert.ok(iotErrors.isRetryable(unavailable))
  assert.equal(iotErrors.fromResponse(403, { code: 403, msg: 'no permission' }).error.message, '无该设备操作权限')
  assert.equal(iotErrors.fromResponse(200, { code: 4040, msg: 'x' }).error.message, '设备不存在')
  assert.equal(iotErrors.fromResponse(200, { code: 4044, msg: 'x' }).error.message, '任务不存在或已过期')
  checked('统一错误码：401 重登、503 稍后重试、4040/4041/4044 各自含义')

  assert.equal(iotErrors.fromResponse(200, { code: 429, msg: 'too many', data: { retryAfter: 12 } }).error.retryAfter, 12)
  const limited = iotErrors.fromResponse(429, { code: 429, msg: 'too many requests' }, { 'Retry-After': '30' }).error
  assert.equal(limited.code, 429)
  assert.equal(limited.retryAfter, 30, 'body 没带 retryAfter 时读 Header Retry-After')
  assert.equal(iotErrors.fromResponse(200, { code: 4999, msg: '奇怪的错' }).error.message, '奇怪的错', '码表外的错误码退回服务端 msg')
  const gateway = iotErrors.fromResponse(502, '<html>bad gateway</html>').error
  assert.equal(gateway.code, 502)
  assert.equal(gateway.action, 'retry')
  assert.equal(iotErrors.fromNetworkFailure('request:fail timeout').message, '网络超时，请稍后再试')
  checked('429 retryAfter、码表外错误码、网关 5xx、网络失败')

  // ── ② HTTP 客户端 ──
  {
    const calls = []
    const responses = []
    let expired = 0
    const toasts = []
    const iot = load('utils/iot-request.js', {
      './config': config,
      './toast': { show: options => toasts.push(options) },
      './request': { expireSession: () => { expired++ } },
      './iot-errors': iotErrors
    }, {
      setTimeout: fn => setImmediate(fn),
      wx: {
        getStorageSync: key => (key === 'token' ? 'tk-1' : ''),
        request(options) {
          calls.push(options)
          const next = responses.shift()
          if (next.fail) options.fail({ errMsg: next.fail })
          else options.success(next)
        }
      }
    })

    responses.push({ statusCode: 200, data: { code: 0, msg: 'ok', data: { online: false } }, header: {} })
    const data = await iot.get('/api/device/online', { deviceNo: 'D0CF13F02FF8', since: undefined })
    assert.deepEqual(JSON.parse(JSON.stringify(data)), { online: false })
    assert.equal(calls[0].url, 'https://iot.boltfox.cn/api/device/online?deviceNo=D0CF13F02FF8', '空的 since 不拼进 url')
    assert.equal(calls[0].header.userToken, 'tk-1')
    checked('GET：iot 域名、Header userToken、空参数不拼')

    responses.push({ statusCode: 401, data: { code: 401, msg: 'unauthorized', data: null }, header: {} })
    await assert.rejects(iot.get('/api/device/info', { deviceNo: 'X' }), error => {
      assert.ok(/^接口\(IoT\)-登录已失效/.test(error.message))
      return true
    })
    assert.equal(expired, 1, '401 走登出引导')

    responses.push({ statusCode: 503, data: { code: 503, msg: 'unavailable', data: null }, header: {} })
    await assert.rejects(iot.get('/api/device/info', { deviceNo: 'X' }, { showError: false }), error => error.code === 503)
    assert.equal(expired, 1, '503 不登出')
    checked('401 登出、503 保留登录态')

    const before = calls.length
    responses.push({ fail: 'request:fail timeout' }, { fail: 'request:fail timeout' }, { statusCode: 200, data: { code: 0, data: 1 }, header: {} })
    assert.equal(await iot.get('/api/device/online', { deviceNo: 'X' }, { showError: false }), 1)
    assert.equal(calls.length - before, 3, 'GET 网络失败静默重试 2 次')

    const beforePost = calls.length
    responses.push({ fail: 'request:fail timeout' })
    await assert.rejects(iot.post('/api/device/refresh', { deviceNo: 'X' }, { showError: false }), error => error.code === 'NETWORK_ERROR')
    assert.equal(calls.length - beforePost, 1, 'POST 有副作用，网络失败不重发')
    assert.equal(calls.at(-1).header['Content-Type'], 'application/json')
    assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1).data)), { deviceNo: 'X' })
    checked('网络失败只给 GET 重试，POST 走 JSON body 不重发')
  }

  // ── ③ WebSocket ──
  {
    const tasks = []
    const timers = []
    const ws = load('utils/iot-ws.js', { './config': config }, {
      setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length },
      clearTimeout: id => { if (id && timers[id - 1]) timers[id - 1].cleared = true },
      setInterval: () => 1,
      clearInterval() {},
      wx: {
        getStorageSync: key => (key === 'token' ? 'tk-1' : ''),
        onAppShow() {},
        connectSocket(options) {
          const task = { options, sent: [], handlers: {}, closed: false }
          ;['onOpen', 'onMessage', 'onError', 'onClose'].forEach(name => { task[name] = fn => { task.handlers[name] = fn } })
          task.send = ({ data }) => task.sent.push(JSON.parse(data))
          task.close = () => { task.closed = true }
          tasks.push(task)
          return task
        }
      }
    })
    const states = []
    const statuses = []
    ws.on('state', event => states.push(JSON.parse(JSON.stringify(event))))
    ws.on('device.status', message => statuses.push(message))
    const runTimer = () => {
      const timer = timers.filter(item => !item.cleared && !item.ran).at(-1)
      timer.ran = true
      timer.fn()
      return timer
    }

    ws.subscribe('D0CF13F02FF8')
    assert.equal(tasks.length, 1, '订阅时未连接则顺带建连')
    assert.equal(tasks[0].options.url, 'wss://iot.boltfox.cn/ws/push')
    assert.equal(tasks[0].options.header.userToken, 'tk-1')
    tasks[0].handlers.onOpen()
    assert.deepEqual(tasks[0].sent, [{ type: 'subscribe', deviceNo: 'D0CF13F02FF8' }], '连上后补发订阅')
    assert.equal(states.at(-1).state, 'open')
    assert.equal(states.at(-1).reconnect, false)
    tasks[0].handlers.onMessage({ data: JSON.stringify({ type: 'device.status', deviceNo: 'D0CF13F02FF8', online: true }) })
    assert.equal(statuses.length, 1)
    checked('Header userToken 握手，连上补订阅，推送按 type 分发')

    tasks[0].handlers.onClose({ code: 1006, reason: '' })
    assert.equal(states.at(-1).state, 'closed')
    assert.equal(states.at(-1).retryIn, 1000)
    runTimer()
    assert.equal(tasks.length, 2)
    tasks[1].handlers.onOpen()
    assert.equal(states.at(-1).reconnect, true, '重连成功带 reconnect:true，页面据此补查')
    assert.deepEqual(tasks[1].sent, [{ type: 'subscribe', deviceNo: 'D0CF13F02FF8' }], '重连后自动重新订阅')
    tasks[1].handlers.onClose({ reason: '' })
    assert.equal(states.at(-1).retryIn, 1000, '连上过一次后退避从 1s 重新算')
    runTimer()
    tasks[2].handlers.onClose({ reason: '' })
    assert.equal(states.at(-1).retryIn, 2000, '连续失败按 1s、2s… 退避')
    checked('断线指数退避重连并重新订阅')

    runTimer()
    tasks[3].handlers.onError({ errMsg: 'Unexpected response code: 401' })
    const pending = timers.filter(item => !item.cleared && !item.ran).length
    tasks[3].handlers.onClose({})
    assert.equal(states.at(-1).reason, 'unauthorized')
    assert.equal(timers.filter(item => !item.cleared && !item.ran).length, pending, '握手 401 不再重连')
    ws.close()
    assert.deepEqual(Array.from(ws.getSubscriptions()), [], 'close 清空订阅')
    checked('握手 401 停止重连，close 清空订阅')
  }

  // ── 查询接口的设备ID不加冒号（2026-10-27 产品口径）──
  {
    const sent = []
    const iotApi = load('utils/iot-api.js', {
      './iot-request': { get: (url, params) => { sent.push([url, params]); return Promise.resolve({}) } }
    })
    await iotApi.getDeviceOnline('E3:48:C2:1E:D4:28', 1000)
    await iotApi.getDeviceInfo('e348c21ed428')
    assert.deepEqual(JSON.parse(JSON.stringify(sent)), [
      ['/api/device/online', { deviceNo: 'E348C21ED428', since: 1000 }],
      ['/api/device/info', { deviceNo: 'E348C21ED428' }]
    ], '带冒号 / 小写都转成 12 位大写不带冒号')
    checked('IoT 查询接口的 deviceNo 去冒号')
  }

  console.log(`iot-foundation: ${checks} groups passed`)
}
main().catch(error => { console.error(error); process.exitCode = 1 })
