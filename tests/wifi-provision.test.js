// WiFi 版配网流程（2026-10-26，对接进度 STEP 2）：
//   ① 正常：手机网络 → BluFi 下发 STA/名称/密码 → 连 WiFi 收到「已连上」→ 老服务绑定 → 带 since 轮询在线 → 成功；
//      没有 MQTT 配置时不发 mqtt_config；
//   ② 配了 MQTT 配置：发 mqtt_config，result 非 0 停在第 2 步；
//   ③ 设备报 WiFi 连接失败：停在第 3 步；等不到 WiFi 状态报告：放行，交给第 4 步；
//   ④ 在线轮询：503 / 403 继续轮询，60s 等不到 online 停在第 4 步；401 直接停；
//   ⑤ 手机没网停在第 1 步；任何结束路径都释放蓝牙会话。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const root = path.join(__dirname, '..')

let checks = 0
function checked(name) { checks++; console.log('PASS ' + name) }

function setup(options = {}) {
  const log = { steps: [], writes: [], requests: [], binds: [], onlineCalls: [], closed: 0 }
  let clock = 1000000
  const onlineReplies = (options.online || [{ online: true }]).slice()
  const session = {
    async configureSta(ssid, password) { log.writes.push(['sta', ssid, password]) },
    async connectWifi() { log.writes.push(['connect']) },
    async request(action, data) { log.requests.push([action, data]); return options.mqttAck || { result: 0 } },
    waitFor() { return Promise.resolve(options.wifiState === undefined ? { staState: 0 } : options.wifiState) },
    close() { log.closed++ }
  }
  const modules = {
    './api': {
      async bindWifiDevice(args) { log.binds.push(args); if (options.bindError) throw new Error(options.bindError); return { id: '88', name: 'WiFi相框' } }
    },
    './iot-api': {
      async getDeviceOnline(deviceNo, since) {
        log.onlineCalls.push([deviceNo, since])
        const next = onlineReplies.length > 1 ? onlineReplies.shift() : onlineReplies[0]
        if (next instanceof Error || (next && next.code)) throw next
        return next
      }
    },
    './config': { iotMqttConfig: options.mqtt || null },
    './blufi': {
      STA_STATE: { CONNECTED: 0, FAIL: 1 },
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
  const run = () => provision.run(job, { onStep: (i, s) => log.steps.push(`${i}:${s}`) })
  return { log, run, provision, startClock: 1000000 }
}

async function main() {
  {
    const { log, run, startClock } = setup()
    const result = await run()
    assert.equal(result.device.id, '88')
    assert.deepEqual(log.steps, ['0:loading', '0:done', '1:loading', '1:done', '2:loading', '2:done', '3:loading', '3:done'])
    assert.equal(log.connectedTo, 'ble-1', '用搜索时拿到的蓝牙句柄连设备')
    assert.deepEqual(log.writes, [['sta', '我家WiFi', 'pa55word'], ['connect']], '先下发 WiFi，再让设备连接')
    assert.deepEqual(log.requests, [], '没有 MQTT 配置时不发 mqtt_config')
    assert.equal(log.binds.length, 1)
    assert.equal(log.binds[0].deviceNo, 'E348C21ED428')
    assert.equal(log.binds[0].productId, 21, '绑定用搜索时查到的产品')
    assert.deepEqual(log.onlineCalls[0], ['E348C21ED428', startClock], 'since = 本次配网开始时间')
    assert.ok(log.closed >= 1, '蓝牙会话已释放')
    checked('正常配网：四步依次通过，绑定后带 since 轮询在线')
  }
  {
    const { log, run } = setup({ mqtt: { host: 'mqtt.example.com', port: 1883, usr: 'u', pwd: 'p' } })
    await run()
    assert.equal(log.requests[0][0], 'mqtt_config')
    assert.equal(log.requests[0][1].host, 'mqtt.example.com')
    const failed = setup({ mqtt: { host: 'h' }, mqttAck: { result: 5 } })
    await assert.rejects(failed.run(), error => error.step === 1 && /错误码 5/.test(error.message))
    assert.ok(failed.log.closed >= 1)
    checked('配了 MQTT 配置才下发，result 非 0 停在第 2 步')
  }
  {
    const failed = setup({ wifiState: { staState: 1 } })
    await assert.rejects(failed.run(), error => error.step === 2 && /WiFi名称和密码/.test(error.message))
    assert.equal(failed.log.binds.length, 0, 'WiFi 都没连上就不绑定')
    const silent = setup({ wifiState: null })
    await silent.run()
    assert.ok(silent.log.steps.includes('2:done'), '等不到 WiFi 状态报告时放行，由在线轮询裁决')
    checked('WiFi 明确失败停在第 3 步，没有报告则放行')
  }
  {
    const unavailable = Object.assign(new Error('503'), { code: 503, action: 'retry' })
    const forbidden = Object.assign(new Error('403'), { code: 403, action: 'none' })
    const flaky = setup({ online: [unavailable, forbidden, { online: false }, { online: true }] })
    await flaky.run()
    assert.equal(flaky.log.onlineCalls.length, 4, '503 / 403 / 未上线都继续轮询')

    const never = setup({ online: [{ online: false }] })
    await assert.rejects(never.run(), error => error.step === 3 && /联网超时/.test(error.message))
    assert.ok(never.log.onlineCalls.length >= 25 && never.log.onlineCalls.length <= 31, `约 60s / 2s 轮询：${never.log.onlineCalls.length} 次`)

    const relogin = setup({ online: [Object.assign(new Error('401'), { code: 401, action: 'relogin' })] })
    await assert.rejects(relogin.run(), error => error.step === 3 && /重新登录/.test(error.message))
    assert.equal(relogin.log.onlineCalls.length, 1, '登录失效不再轮询')

    const bindFail = setup({ bindError: '服务异常' })
    await assert.rejects(bindFail.run(), error => error.step === 3 && /设备绑定失败：服务异常/.test(error.message))
    checked('在线轮询：503/403 继续、60s 超时、401 停止；绑定失败停在第 4 步')
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
