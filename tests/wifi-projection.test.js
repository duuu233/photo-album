// WiFi 版投屏（2026-10-27，对接进度 STEP 3）utils/wifi-projection.projectOne：
//   ① 上传进度 → 图片处理中 → SENT → WS DOWNLOADING / FLASHING / SUCCESS，阶段只进不退；deviceNo 去冒号、type 原样；
//   ② WS 事件早于 HTTP 响应：按 msgid 缓存后补认；
//   ③ 接口 status=FAILED / 上传报错（4041 等）直接失败，不再等；
//   ④ 没有 WS 时靠 GET /api/device/play/status 轮询走完；
//   ⑤ TIMEOUT 等 3 秒修正窗口：迟到的 corrected SUCCESS 算成功；仍超时则 TIMEOUT；
//   ⑥ 90 秒无终态 → 结果未知（4044 为任务已过期）；失败原因按 reason 翻译；
//   ⑦ 自己订阅的设备结束后退订，原本就订阅着的不动。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const root = path.join(__dirname, '..')

let checks = 0
function checked(name) { checks++; console.log('PASS ' + name) }

function setup(options = {}) {
  let clock = 1000000
  const log = { stages: [], plays: [], statusCalls: 0, subscribed: [], unsubscribed: [] }
  const handlers = {}
  const emit = (type, payload) => (handlers[type] || []).slice().forEach(fn => fn(payload))
  const statusReplies = (options.status || []).slice()
  const ws = {
    on(type, fn) { (handlers[type] = handlers[type] || []).push(fn); return () => { handlers[type] = handlers[type].filter(item => item !== fn) } },
    subscribe(id) { log.subscribed.push(id) },
    unsubscribe(id) { log.unsubscribed.push(id) },
    getSubscriptions: () => options.alreadySubscribed ? ['E348C21ED428'] : []
  }
  const api = {
    async play(deviceNo, filePath, type, opts) {
      log.plays.push({ deviceNo, filePath, type, showError: opts.showError })
      ;[30, 100].forEach(p => opts.onProgress(p))
      ;(options.earlyEvents || []).forEach(event => emit('play.result', event))
      if (options.playError) throw options.playError
      return options.response || { msgid: 'm1', status: 'SENT' }
    },
    async getPlayStatus(msgid) {
      log.statusCalls++
      const next = statusReplies.length > 1 ? statusReplies.shift() : statusReplies[0]
      if (typeof next === 'function') return next(emit)
      if (next instanceof Error || (next && next.code)) throw next
      return next || { msgid, status: 'SENT' }
    }
  }
  const sandbox = {
    module: { exports: {} },
    require: target => ({ './iot-api': api, './iot-ws': ws })[target],
    Date: { now: () => clock },
    setTimeout: (fn, ms) => { clock += ms || 0; setImmediate(fn); return 1 },
    clearTimeout() {},
    console: { log() {}, warn() {} }
  }
  vm.runInNewContext(fs.readFileSync(path.join(root, 'utils/wifi-projection.js'), 'utf8'), sandbox, { filename: 'wifi-projection.js' })
  const projection = sandbox.module.exports
  const run = () => projection.projectOne({
    deviceNo: 'E3:48:C2:1E:D4:28', filePath: 'wxfile://a.png', type: '1',
    onStage: info => log.stages.push(`${info.stage}:${info.progress}`)
  })
  return { run, log, emit, projection }
}

const ev = (status, extra) => Object.assign({ type: 'play.result', msgid: 'm1', deviceNo: 'E348C21ED428', status, corrected: false }, extra)

async function main() {
  {
    // 状态查询里推 WS 事件，模拟设备推进
    let step = 0
    const { run, log } = setup({
      // 每轮查询设备推进一档：查询结果与 WS 推送一起到（终态只走 WS）
      status: [emit => {
        step++
        if (step === 1) { emit('play.result', ev('DOWNLOADING')); return { msgid: 'm1', status: 'DOWNLOADING' } }
        if (step === 2) { emit('play.result', ev('FLASHING')); return { msgid: 'm1', status: 'FLASHING' } }
        emit('play.result', ev('SUCCESS'))
        return { msgid: 'm1', status: 'FLASHING' }
      }]
    })
    const result = await run()
    assert.equal(result.status, 'SUCCESS')
    assert.equal(result.message, '投屏成功')
    assert.deepEqual(JSON.parse(JSON.stringify(log.plays[0])), { deviceNo: 'E348C21ED428', filePath: 'wxfile://a.png', type: '1', showError: false }, 'deviceNo 去冒号、type 原样、静默')
    const order = log.stages.map(item => item.split(':')[0]).filter((item, i, all) => item !== all[i - 1])
    assert.deepEqual(order, ['UPLOADING', 'PROCESSING', 'SENT', 'DOWNLOADING', 'FLASHING', 'SUCCESS'], `阶段顺序：${order}`)
    assert.ok(log.stages.includes('UPLOADING:30'), '上传进度真实透出')
    assert.deepEqual(log.subscribed, ['E348C21ED428'])
    assert.deepEqual(log.unsubscribed, ['E348C21ED428'], '自己订阅的结束后退订')
    checked('正常投屏：上传 → 处理中 → 已下发 → 下载 → 刷屏 → 成功')
  }
  {
    const { run, log } = setup({ earlyEvents: [ev('FLASHING'), ev('SUCCESS')], alreadySubscribed: true })
    const result = await run()
    assert.equal(result.status, 'SUCCESS', 'WS 事件早于 HTTP 响应也能认上')
    assert.equal(log.statusCalls, 0, '缓存里已有终态就不用查')
    assert.deepEqual(log.unsubscribed, [], '原本就订阅着的不退订')
    checked('WS 事件早于接口响应：按 msgid 缓存后补认')
  }
  {
    const failed = setup({ response: { msgid: 'm1', status: 'FAILED' } })
    const result = await failed.run()
    assert.equal(result.status, 'FAILED')
    assert.equal(failed.log.statusCalls, 0, '接口直接 FAILED 不再等')
    const offline = setup({ playError: Object.assign(new Error('接口(IoT)-设备已离线，请检查设备网络'), { code: 4041 }) })
    const res2 = await offline.run()
    assert.equal(res2.status, 'FAILED')
    assert.equal(res2.message, '设备已离线，请检查设备网络', '错误码文案去掉前缀')
    checked('接口返回 FAILED / 上传报错直接失败')
  }
  {
    const { run } = setup({ status: [{ status: 'DOWNLOADING' }, { status: 'FLASHING' }, { status: 'SUCCESS' }] })
    const result = await run()
    assert.equal(result.status, 'SUCCESS', '没有 WS 也能靠状态查询走完')
    const legacy = setup({ response: { msgid: 'm1', status: 'DOWNLOADING' }, status: [{ status: 'SUCCESS' }] })
    assert.equal((await legacy.run()).status, 'SUCCESS', '兼容旧版初始状态 DOWNLOADING')
    checked('状态查询兜底')
  }
  {
    let calls = 0
    const corrected = setup({ status: [emit => { calls++; if (calls === 1) return { status: 'TIMEOUT' }; return { status: 'SUCCESS', corrected: true } }] })
    const result = await corrected.run()
    assert.equal(result.status, 'SUCCESS', 'TIMEOUT 后修正为成功')
    assert.equal(result.corrected, true)
    const stuck = setup({ status: [{ status: 'TIMEOUT' }] })
    const res2 = await stuck.run()
    assert.equal(res2.status, 'TIMEOUT')
    assert.equal(res2.message, '投屏超时')
    assert.ok(stuck.log.statusCalls >= 2, '超时后等 3 秒再查一次确认')
    checked('TIMEOUT：3 秒修正窗口，迟到成功算成功')
  }
  {
    const never = setup({ status: [{ status: 'FLASHING' }] })
    const res = await never.run()
    assert.equal(res.status, 'UNKNOWN', '90 秒无终态按结果未知')
    const expired = setup({ status: [Object.assign(new Error('task not found'), { code: 4044 })] })
    const res2 = await expired.run()
    assert.equal(res2.status, 'UNKNOWN')
    assert.equal(res2.message, '任务已过期，结果未知')
    const storage = setup({ earlyEvents: [ev('FAILED', { reason: 'PLAY_STORAGE_ERROR' })] })
    const res3 = await storage.run()
    assert.equal(res3.status, 'FAILED')
    assert.equal(res3.message, '设备存储异常', '失败原因按 reason 翻译')
    const late = setup({ earlyEvents: [ev('SUCCESS'), ev('FLASHING')] })
    await late.run()
    const tail = late.log.stages.at(-1).split(':')[0]
    assert.equal(tail, 'SUCCESS', '终态后迟到的低档位不回退')
    checked('结果未知 / 任务过期 / 失败原因 / 只进不退')
  }
  console.log(`wifi-projection: ${checks} groups passed`)
}
main().catch(error => { console.error(error); process.exitCode = 1 })
