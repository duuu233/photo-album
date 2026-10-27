// WiFi 版配网流程（2026-10-26 STEP 2；2026-10-27 按 docs/wifi/设备入网流程.md 2.2 调整）：
//   ① 正常：手机网络 → IoT 取 MQTT 参数 → BluFi 下发 WiFi → mqtt_config → 国家码 01 → 「连接 WiFi」→ 释放蓝牙
//      → 第 3 步老服务绑定 → 第 4 步带 since 轮询在线 → 成功（绑定必须先于在线查询）；
//   ② MQTT 参数接口失败 / 不完整 / 401：停在第 2 步，不连设备；mqtt_config result 非 0 / 超时停在第 2 步，不再发后续指令；
//   ③ 国家码：pending=1 优先、result=0 通过；result 非 0 换新 msgid 重试一次，仍失败继续；超时不重试、继续；
//   ④ 绑定失败停在第 3 步，不开始轮询；
//   ⑤ 在线轮询：503 / 403 继续轮询，60s 等不到 online 停在第 4 步（一直 503 提示稍后重试）；401 直接停；
//   ⑥ 手机没网停在第 1 步；任何结束路径都释放蓝牙会话；
//   ⑦ 配网日志：每一步与结果都有记录，WiFi 密码与 MQTT 密码不进日志。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const root = path.join(__dirname, '..')

let checks = 0
function checked(name) { checks++; console.log('PASS ' + name) }

function setup(options = {}) {
  const log = { steps: [], writes: [], requests: [], binds: [], onlineCalls: [], closed: 0, lines: [], order: [] }
  const handlers = {}
  let clock = 1000000
  let msgSeq = 0
  const onlineReplies = (options.online || [{ online: true }]).slice()
  // 每个 action 的回执队列：Error 表示等不到回执；最后一个重复使用
  const acks = Object.assign({ mqtt_config: [{ result: 0 }], wifi_set_country_code: [{ result: 0 }] }, options.acks || {})
  const session = {
    async configureSta(ssid, password) {
      log.writes.push(['sta', ssid, password])
      log.order.push('sta')
      ;(handlers.frame || []).forEach(fn => fn({ dir: 'tx', isData: true, subtype: 0x02, length: 8, hex: '09 00 01 04 48 6F 6D 65' }))
      ;(handlers.frame || []).forEach(fn => fn({ dir: 'tx', isData: true, subtype: 0x03, length: 12, hex: '0D 00 02 08 70 61 35 35 77 6F 72 64' }))
    },
    on(type, fn) { (handlers[type] = handlers[type] || []).push(fn); return () => {} },
    info() { return { serviceId: 'FFFF', frameLimit: 244 } },
    async connectWifi() { log.writes.push(['connect']); log.order.push('connect') },
    async request(action, data, timeout, msgid) {
      log.requests.push([action, data, msgid, timeout])
      log.order.push(action)
      ;(handlers.frame || []).forEach(fn => fn({ dir: 'tx', isData: true, subtype: 0x13, length: 60, hex: '4D 00 05 38 7B 22 70 77 64 22 3A 22 53 65 63 72 65 74' }))
      const queue = acks[action]
      const next = queue.length > 1 ? queue.shift() : queue[0]
      if (next instanceof Error) throw next
      return next
    },
    close() { log.closed++; log.order.push('close') }
  }
  const modules = {
    './api': {
      async bindWifiDevice(args) { log.binds.push(args); log.order.push('bind'); if (options.bindError) throw new Error(options.bindError); return { id: '88', name: 'WiFi相框' } }
    },
    './iot-api': {
      async getProvisioningMqtt(opts) {
        log.order.push('mqtt-fetch')
        log.mqttFetchOptions = opts
        if (options.mqttFetch instanceof Error) throw options.mqttFetch
        return options.mqttFetch !== undefined ? options.mqttFetch : { host: 'mqtt.example.com', port: 11883, usr: 'dev-user', pwd: 'Secret#Pwd' }
      },
      async getDeviceOnline(deviceNo, since) {
        log.onlineCalls.push([deviceNo, since])
        log.order.push('online')
        const next = onlineReplies.length > 1 ? onlineReplies.shift() : onlineReplies[0]
        if (next instanceof Error || (next && next.code)) throw next
        return next
      }
    },
    './config': { iotBaseURL: 'https://iot.example.com' },
    './blufi': {
      STA_STATE: { CONNECTED: 0, FAIL: 1 },
      DATA: { STA_PASSWORD: 0x03, CUSTOM: 0x13 },
      newMsgid: () => `175610840017${String(++msgSeq).padStart(4, '0')}`,
      async connect(id) { log.connectedTo = id; if (options.connectError) throw new Error('connect fail'); return session }
    },
    './bluetooth': { async openAdapter() {}, async whenScanStopped() {} }
  }
  const sandbox = {
    module: { exports: {} },
    require: target => modules[target],
    console: { log() {}, warn() {} },
    Date: { now: () => clock },
    setTimeout: (fn, ms) => { clock += ms || 0; setImmediate(fn); return 1 },
    wx: { getNetworkType: ({ success }) => success({ networkType: options.network || 'wifi' }) }
  }
  vm.runInNewContext(fs.readFileSync(path.join(root, 'utils/wifi-provision.js'), 'utf8'), sandbox, { filename: 'wifi-provision.js' })
  const provision = sandbox.module.exports
  const job = {
    bleDeviceId: 'ble-1', deviceNo: 'E348C21ED428', name: 'IJ_E348C21ED428',
    product: { productId: 21, productName: 'WiFi相框', sizeModel: '13.3寸' },
    ssid: '我家WiFi', password: 'pa55word'
  }
  const run = () => provision.run(job, { onStep: (i, s) => log.steps.push(`${i}:${s}`), onLog: text => log.lines.push(text) })
  return { log, run, provision, startClock: 1000000 }
}

const timeout = () => new Error('设备未应答')
const countryTries = ctx => ctx.log.requests.filter(item => item[0] === 'wifi_set_country_code')

async function main() {
  {
    const { log, run, startClock } = setup()
    const result = await run()
    assert.equal(result.device.id, '88')
    assert.deepEqual(log.steps, ['0:loading', '0:done', '1:loading', '1:done', '2:loading', '2:done', '3:loading', '3:done'])
    assert.equal(log.connectedTo, 'ble-1', '用搜索时拿到的蓝牙句柄连设备')
    assert.deepEqual(log.writes, [['sta', '我家WiFi', 'pa55word'], ['connect']], '先下发 WiFi，三条指令发完再让设备连接')
    assert.deepEqual(log.requests.map(item => item[0]), ['mqtt_config', 'wifi_set_country_code'])
    assert.deepEqual(JSON.parse(JSON.stringify(log.requests[0][1])), { host: 'mqtt.example.com', port: 11883, usr: 'dev-user', pwd: 'Secret#Pwd' }, '下发接口取到的 MQTT 参数（含真实密码）')
    assert.equal(log.mqttFetchOptions.showError, false, '取 MQTT 参数静默，错误由配网页展示')
    assert.deepEqual(JSON.parse(JSON.stringify(log.requests[1][1])), { country: '01' }, '小程序国家码固定 01')
    assert.ok(log.requests[1][2], '国家码带 msgid')
    assert.equal(log.requests[1][3], 5000, '回执超时 5 秒')
    assert.deepEqual(log.order, ['mqtt-fetch', 'sta', 'mqtt_config', 'wifi_set_country_code', 'connect', 'close', 'bind', 'online'],
      '取 MQTT 参数 → WiFi → mqtt_config → 国家码 → 连接 → 释放蓝牙 → 绑定 → 轮询在线')
    assert.equal(log.binds.length, 1)
    assert.equal(log.binds[0].deviceNo, 'E348C21ED428')
    assert.equal(log.binds[0].productId, 21, '绑定用搜索时查到的产品')
    assert.deepEqual(log.onlineCalls[0], ['E348C21ED428', startClock], 'since = 本次配网开始时间')
    checked('正常配网：四步依次通过，蓝牙指令都在第 2 步，先绑定再带 since 轮询在线')

    const all = log.lines.join('\n')
    for (const marker of ['开始配网', '① 检查手机网络', '② 设备网络配置', '③ 设备连接 WiFi', '④ 设备连接云端', '配网成功']) {
      assert.ok(all.indexOf(marker) > -1, `日志里要有「${marker}」`)
    }
    // 每个接口都记「接口【名称】」「参数」「返回」，名称按当日文档
    for (const marker of [
      '微信接口【获取网络类型】wx.getNetworkType',
      '返回 {"networkType":"wifi"}',
      '蓝牙接口【连接设备 BluFi 会话】blufi.connect',
      '参数 {"deviceId":"ble-1"}',
      '蓝牙指令【下发WiFi参数】',
      '【Set Opmode 设置工作模式】',
      '参数 {"opmode":1,"ssid":"我家WiFi","password":"8 位（已隐藏）"}',
      '接口【配网 MQTT 参数】GET https://iot.example.com/api/device/provisioning/mqtt',
      '返回 {"host":"mqtt.example.com","port":11883,"usr":"dev-user","pwd":"（已隐藏）"}',
      '蓝牙指令【设置 MQTT 配置信息】action=mqtt_config',
      '蓝牙指令【设置WiFi国家码】action=wifi_set_country_code',
      '参数 {"msgid":"1756108400170002","data":{"country":"01"}}',
      '返回 {"result":0}',
      '蓝牙指令【Connect to AP 连接WiFi】',
      '已释放蓝牙连接',
      '接口【在线状态】GET',
      '/api/device/online（设备入网流程 6.1',
      '参数 {"deviceNo":"E348C21ED428","since":1000000}',
      '返回 {"online":true}',
      // 按设备入网流程第二节的编号打的标签（只标 App 实际执行的步骤，参数都是运行时拿到的）
      '【流程③】', '【流程④】', '【流程⑤】', '【流程⑥】',
      '【流程⑭】老服务绑定：deviceNo=E348C21ED428，productId=21', '【流程⑮】轮询在线：deviceNo=E348C21ED428'
    ]) {
      assert.ok(all.indexOf(marker) > -1, `日志里要有「${marker}」`)
    }
    assert.ok(all.indexOf('【流程⑭】') < all.indexOf('【流程⑮】'), '日志里绑定在轮询之前')
    // 流程文档里的示例数据 App 拿不到，不写进日志（2026-10-26 产品：模拟数据不要，只打能拿到的参数）
    for (const fake of ['XT_ESP_', '1234567890', 'mqtt.boltfox.cn', 'xt-boltstar-device', '蓝灯', 'EMQX', '【流程⑦】', '【流程⑯】']) {
      assert.equal(all.indexOf(fake), -1, `日志不该有流程示例数据「${fake}」`)
    }
    assert.equal(all.indexOf('Secret#Pwd'), -1, 'MQTT 密码不进日志')
    assert.ok(/WiFi「我家WiFi」，密码 8 位/.test(all), '记 WiFi 名称与密码位数')
    assert.equal(all.indexOf('pa55word'), -1, '密码原文不进日志')
    assert.ok(/密码帧（12 字节，内容已隐藏）/.test(all), '密码帧打码')
    assert.equal(all.indexOf('70 61 35 35 77 6F 72 64'), -1, '密码帧十六进制也不进日志')
    assert.ok(/蓝牙发 → 09 00 01 04 48 6F 6D 65/.test(all), '其它帧照常记原文')
    checked('配网日志：每一步有记录，密码不进日志')
  }
  {
    const { log, run } = setup()
    await run()
    assert.ok(log.requests[0][2] && log.requests[0][2] !== log.requests[1][2], 'mqtt_config 与国家码各带自己的 msgid')
    assert.equal(log.requests[0][3], 5000, 'mqtt_config 回执超时 5 秒')
    const mqttLog = log.lines.join('\n')
    assert.equal(mqttLog.indexOf('53 65 63 72 65 74'), -1, '承载 mqtt_config 的帧原文不进日志')
    assert.ok(/自定义数据帧（60 字节，内容已隐藏/.test(mqttLog))
    assert.ok(/"pwd":"（已隐藏）"/.test(mqttLog), '参数里 pwd 打码')

    const failed = setup({ acks: { mqtt_config: [{ result: 5 }] } })
    await assert.rejects(failed.run(), error => error.step === 1 && /错误码 5/.test(error.message))
    assert.deepEqual(failed.log.requests.map(item => item[0]), ['mqtt_config'], 'mqtt_config 失败就不再发国家码')
    assert.equal(failed.log.writes.some(item => item[0] === 'connect'), false, '也不让设备去连接')
    assert.equal(failed.log.binds.length, 0)
    assert.ok(failed.log.closed >= 1)

    const silent = setup({ acks: { mqtt_config: [timeout()] } })
    await assert.rejects(silent.run(), error => error.step === 1 && /未响应网络配置/.test(error.message))
    assert.equal(silent.log.binds.length, 0)
    checked('mqtt_config：先于国家码，result 非 0 / 超时停在第 2 步')
  }
  {
    const down = setup({ mqttFetch: Object.assign(new Error('服务暂时不可用，请稍后重试'), { code: 503, statusCode: 503, action: 'retry' }) })
    await assert.rejects(down.run(), error => error.step === 1 && /获取设备网络配置失败/.test(error.message))
    assert.equal(down.log.connectedTo, undefined, '取不到 MQTT 参数不连设备、不下发 WiFi')
    assert.deepEqual(down.log.writes, [])
    assert.ok(down.log.lines.some(line => /失败 HTTP 503 code 503/.test(line)), '失败原因记进日志')

    const relogin = setup({ mqttFetch: Object.assign(new Error('401'), { code: 401, action: 'relogin' }) })
    await assert.rejects(relogin.run(), error => error.step === 1 && /重新登录/.test(error.message))

    for (const broken of [null, {}, { host: 'h', port: 11883, usr: 'u' }, { host: 'h', port: 'x', usr: 'u', pwd: 'p' }]) {
      const incomplete = setup({ mqttFetch: broken })
      await assert.rejects(incomplete.run(), error => error.step === 1 && /获取设备网络配置失败/.test(error.message), JSON.stringify(broken))
      assert.deepEqual(incomplete.log.writes, [], `参数不完整不动设备：${JSON.stringify(broken)}`)
    }
    const stringPort = setup({ mqttFetch: { host: ' h ', port: '11883', usr: 'u', pwd: 'p' } })
    await stringPort.run()
    assert.deepEqual(JSON.parse(JSON.stringify(stringPort.log.requests[0][1])), { host: 'h', port: 11883, usr: 'u', pwd: 'p' }, 'port 转数字、host 去空白')
    checked('MQTT 参数接口：失败 / 401 / 不完整都停在第 2 步且不动设备')
  }
  {
    const pending = setup({ acks: { wifi_set_country_code: [{ result: 3, pending: 1 }] } })
    await pending.run()
    assert.equal(countryTries(pending).length, 1, 'pending=1 优先于 result，不重试')
    assert.ok(pending.log.lines.some(line => /暂缓执行/.test(line)))

    const rejected = setup({ acks: { wifi_set_country_code: [{ result: 3 }] } })
    await rejected.run()
    const tries = countryTries(rejected)
    assert.equal(tries.length, 2, 'result 非 0 重试一次')
    assert.notEqual(tries[0][2], tries[1][2], '重试换新的 msgid')
    assert.ok(rejected.log.steps.includes('3:done'), '重试仍失败也继续配网')

    const retried = setup({ acks: { wifi_set_country_code: [{ result: 3 }, { result: 0 }] } })
    await retried.run()
    assert.equal(countryTries(retried).length, 2, '第二次成功')

    const noAck = setup({ acks: { wifi_set_country_code: [timeout()] } })
    await noAck.run()
    assert.equal(countryTries(noAck).length, 1, '等不到回执不重试')
    assert.ok(noAck.log.steps.includes('3:done'), '国家码超时不阻塞配网')
    checked('国家码：pending 优先、失败换 msgid 重试一次、超时都不阻塞')
  }
  {
    const bindFail = setup({ bindError: '服务异常' })
    await assert.rejects(bindFail.run(), error => error.step === 2 && /设备绑定失败：服务异常/.test(error.message))
    assert.equal(bindFail.log.onlineCalls.length, 0, '绑定失败不开始轮询')
    assert.ok(bindFail.log.closed >= 1, '蓝牙已在第 2 步结束时释放')
    checked('绑定失败停在第 3 步，不开始轮询')
  }
  {
    const unavailable = Object.assign(new Error('503'), { code: 503, action: 'retry' })
    const forbidden = Object.assign(new Error('403'), { code: 403, action: 'none' })
    const flaky = setup({ online: [unavailable, forbidden, { online: false }, { online: true }] })
    await flaky.run()
    assert.equal(flaky.log.onlineCalls.length, 4, '503 / 403 / 未上线都继续轮询')
    assert.deepEqual(flaky.log.order.filter(item => item === 'bind' || item === 'online'), ['bind', 'online', 'online', 'online', 'online'], '只绑一次，之后轮询')

    const never = setup({ online: [{ online: false }] })
    await assert.rejects(never.run(), error => error.step === 3 && /联网超时/.test(error.message))
    assert.ok(never.log.lines.some(line => /配网失败（第 4 步）：设备联网超时/.test(line)), '失败原因记进日志')
    assert.ok(never.log.onlineCalls.length >= 25 && never.log.onlineCalls.length <= 31, `约 60s / 2s 轮询：${never.log.onlineCalls.length} 次`)

    const down = setup({ online: [unavailable] })
    await assert.rejects(down.run(), error => error.step === 3 && /服务暂时不可用，请稍后重试/.test(error.message))

    const relogin = setup({ online: [Object.assign(new Error('401'), { code: 401, action: 'relogin' })] })
    await assert.rejects(relogin.run(), error => error.step === 3 && /重新登录/.test(error.message))
    assert.equal(relogin.log.onlineCalls.length, 1, '登录失效不再轮询')
    checked('第 4 步：503/403 继续轮询、60s 超时（一直 503 提示稍后重试）、401 停止')
  }
  {
    const offline = setup({ network: 'none' })
    await assert.rejects(offline.run(), error => error.step === 0)
    assert.equal(offline.log.connectedTo, undefined, '手机没网不去连设备')
    const unreachable = setup({ connectError: true })
    await assert.rejects(unreachable.run(), error => error.step === 1 && /靠近设备/.test(error.message))
    checked('手机没网停在第 1 步，连不上设备停在第 2 步')
  }
  {
    const { provision } = setup()
    provision.setTarget({ bleDeviceId: 'b', deviceNo: 'E348C21ED428' })
    assert.equal(provision.getJob(), null, '还没填 WiFi 时没有可执行的配网')
    provision.setCredentials({ ssid: 's', password: 'p' })
    assert.equal(provision.getJob().password, 'p')
    provision.setTarget({ bleDeviceId: 'c' })
    assert.equal(provision.getJob(), null, '换了设备要重新填 WiFi')
    checked('页面交接：选设备 → 填 WiFi → 可执行')
  }
  console.log(`wifi-provision: ${checks} groups passed`)
}
main().catch(error => { console.error(error); process.exitCode = 1 })
