// WiFi 版固件升级（2026-11-02，docs/前端对接文档20261031.md）utils/wifi-ota + subpackages/device/wifi-ota：
//   ① 版本比对：x.y.z 数字段比较；当前版本旧格式「M H:3 F:…」/ 空 → 无法判断；目标为空 → 已是最新；包地址非 http(s) → invalid；
//   ② 四步状态：SENT / DOWNLOADING / FLASHING 转圈推进，VERIFYING 四步全勾（成功终点、非终态），
//      FAILED / TIMEOUT 在当前那一步打叉、后续不再执行，未知值不白屏；
//   ③ 本地记录：独立 key ota_inflight:{deviceNo}、带 type:'ota'，类型不对不认；终态 / 4044 清，VERIFYING / 查询失败保留；
//   ④ 4045 一律、4000（OTA 接口上的「已有升级任务进行中」）按进行中处理，4000 文案明显是别的错误时按普通失败；
//   ⑤ 页面：下发成功立即存 msgid → 第 1 步；WS ota.result 按 msgid 推进；失败在当前步打叉；4045 切「设备正在升级」；
//      重进页面有 VERIFYING 记录 → 不进步骤页、不提示升级；有 FLASHING 记录 → 直接接着展示步骤；
//   ⑥ 消息类型 OTA_SUCCESS / OTA_FAILED 有文案；页面已注册、详情页有入口、接口路径对。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const root = path.join(__dirname, '..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')

let checks = 0
function checked(name) { checks++; console.log('PASS ' + name) }
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)) }
const plain = value => JSON.parse(JSON.stringify(value))

const storage = {}
const wxBase = {
  getStorageSync: key => storage[key],
  setStorageSync: (key, value) => { storage[key] = plain(value) },
  removeStorageSync: key => { delete storage[key] }
}
global.wx = new Proxy(wxBase, { get: (target, key) => (key in target ? target[key] : () => {}) })

const stubModule = (request, exports) => {
  const filename = require.resolve(request)
  require.cache[filename] = { id: filename, filename, loaded: true, children: [], paths: [], exports }
}
const otaReplies = {}
const otaCalls = []
const iotApiStub = {
  getOtaStatus: async msgid => {
    otaCalls.push(msgid)
    const reply = otaReplies[msgid]
    if (reply instanceof Error) throw reply
    return reply
  }
}
stubModule('../utils/iot-api', iotApiStub)
const ota = require('../utils/wifi-ota')
const codeError = (code, serverMessage) => Object.assign(new Error(`接口(IoT)-${code}`), { code, serverMessage: serverMessage || '' })

async function main() {
  {
    assert.equal(ota.evaluate('0.6.1', '0.6.2', 'https://x/fw.bin').state, 'available')
    assert.equal(ota.evaluate('0.6.10', '0.6.9', 'https://x/fw.bin').state, 'latest', '按数字段比，不按字符串')
    assert.equal(ota.evaluate('0.6.2', '0.6.2', 'https://x/fw.bin').state, 'latest')
    assert.equal(ota.evaluate('M H:3 F:0.6.1', '0.6.2', 'https://x/fw.bin').state, 'unknown', '旧格式按无法判断')
    assert.equal(ota.evaluate('', '0.6.2', 'https://x/fw.bin').state, 'unknown', '没上报过按无法判断')
    assert.equal(ota.evaluate('0.6.1', '', '').state, 'latest', '后台没配升级包')
    assert.equal(ota.evaluate('0.6.1', '0.6.2', 'ftp://x/fw.bin').state, 'invalid', '包地址只收 http / https')
    assert.equal(ota.evaluate('0.6.1', 'EF6_370_V102', 'http://x/fw.bin').state, 'available', '目标非 x.y.z 时不同即新版本')
    assert.equal(ota.evaluate('v0.6.1', '0.6.1', 'http://x').state, 'latest', '允许 v 前缀')
    checked('版本比对')
  }
  {
    const statuses = view => view.steps.map(step => step.status)
    assert.deepEqual(statuses(ota.stepsFor('SENT')), ['loading', 'pending', 'pending', 'pending'])
    assert.deepEqual(statuses(ota.stepsFor('DOWNLOADING')), ['done', 'loading', 'pending', 'pending'])
    assert.deepEqual(statuses(ota.stepsFor('FLASHING')), ['done', 'done', 'loading', 'pending'])
    const verifying = ota.stepsFor('VERIFYING')
    assert.deepEqual(statuses(verifying), ['done', 'done', 'done', 'done'], 'VERIFYING 四步全勾')
    assert.equal(verifying.phase, 'verifying')
    assert.equal(ota.isFinal('VERIFYING'), false, 'VERIFYING 不是终态')
    assert.deepEqual(statuses(ota.stepsFor('FAILED', 0)), ['fail', 'pending', 'pending', 'pending'], '第 1 步也可能失败')
    assert.deepEqual(statuses(ota.stepsFor('TIMEOUT', 2)), ['done', 'done', 'fail', 'pending'], '当前步打叉，后续不执行')
    assert.equal(ota.stepsFor('FAILED', 1).phase, 'failed')
    assert.equal(ota.failTitle('TIMEOUT'), '升级超时')
    assert.equal(ota.failTitle('FAILED'), '升级失败')
    assert.equal(ota.stepsFor('UPLOADED', 1).phase, 'unknown', '未知值降级')
    assert.deepEqual(ota.STEP_TEXTS.length, 4)
    checked('四步状态')
  }
  {
    assert.equal(ota.storageKey('38:44:be:2e:52:20'), 'ota_inflight:3844BE2E5220', '独立 key，设备号去冒号大写')
    ota.saveInflight('3844BE2E5220', '1793425086943534', { version: '0.6.2' })
    assert.equal(storage['ota_inflight:3844BE2E5220'].type, 'ota', '带类型标识')
    assert.equal(ota.readInflight('3844BE2E5220').msgid, '1793425086943534')
    storage['ota_inflight:AAAA'] = { deviceNo: 'AAAA', type: 'play', msgid: '1' }
    assert.equal(ota.readInflight('AAAA'), null, '不是 ota 类型的记录不认')

    otaReplies['1793425086943534'] = { status: 'VERIFYING' }
    let res = await ota.refreshInflight('3844BE2E5220')
    assert.ok(res.record, 'VERIFYING 保留记录')
    assert.equal(storage['ota_inflight:3844BE2E5220'].status, 'VERIFYING')
    assert.equal(storage['ota_inflight:3844BE2E5220'].lastStep, 3)

    otaReplies['1793425086943534'] = codeError('NETWORK_ERROR')
    res = await ota.refreshInflight('3844BE2E5220')
    assert.ok(res.record && res.error, '查询失败保留记录')

    otaReplies['1793425086943534'] = { status: 'SUCCESS' }
    res = await ota.refreshInflight('3844BE2E5220')
    assert.equal(res.record, null)
    assert.equal(storage['ota_inflight:3844BE2E5220'], undefined, '终态清记录')

    ota.saveInflight('3844BE2E5220', '2', {})
    otaReplies['2'] = codeError(4044)
    res = await ota.refreshInflight('3844BE2E5220')
    assert.equal(res.record, null)
    assert.equal(storage['ota_inflight:3844BE2E5220'], undefined, '4044 清记录')
    checked('本地记录')
  }
  {
    assert.equal(ota.isBusyError(codeError(4045)), true)
    assert.equal(ota.isBusyError(codeError(4000, '已有升级任务进行中')), true)
    assert.equal(ota.isBusyError(codeError(4000)), true, '4000 无文案按文档口径视为进行中')
    assert.equal(ota.isBusyError(codeError(4000, 'url 只允许 http/https')), false, '4000 明确是参数问题时按普通失败')
    assert.equal(ota.isBusyError(codeError(5000)), false)
    checked('进行中错误码')
  }

  // ── 页面（vm 沙箱，依赖按文件名注入） ──
  const wifiStatus = require('../utils/wifi-status')
  function loadPage(setup) {
    let definition
    const state = { toasts: [], started: [], subs: [], handlers: {}, intervals: 0, modals: [] }
    const modules = {
      api: { getDeviceDetail: async () => ({ id: '9', productDeviceId: '38:44:BE:2E:52:20', newVersionNo: '0.6.2', downloadPath: 'https://oss/fw.bin' }) },
      'iot-api': {
        getDeviceInfo: async () => setup.info,
        getOtaStatus: iotApiStub.getOtaStatus,
        startOta: async payload => {
          state.started.push(plain(payload))
          if (setup.startError) throw setup.startError
          return { msgid: '555' }
        }
      },
      'iot-ws': {
        on: (type, fn) => { (state.handlers[type] = state.handlers[type] || []).push(fn); return () => {} },
        subscribe: no => state.subs.push(no),
        unsubscribe() {},
        getSubscriptions: () => []
      },
      toast: { show: value => state.toasts.push(value.title), warn: value => state.toasts.push(value.title) },
      system: { getLayoutMetrics: () => ({}) },
      'fold-adapt': { adapt: value => value },
      'wifi-status': wifiStatus,
      'wifi-ota': ota
    }
    vm.runInNewContext(read('subpackages/device/wifi-ota/wifi-ota.js'), {
      require: target => modules[target.split('/').at(-1)],
      Page: value => { definition = value },
      wx: {
        showModal: options => { state.modals.push(options.content); options.success({ confirm: true }) },
        showLoading() {},
        hideLoading() {},
        navigateBack() {}
      },
      setInterval: () => { state.intervals++; return state.intervals },
      clearInterval() {},
      console: { log() {}, warn() {} }
    }, { filename: 'wifi-ota.js' })
    const page = { ...definition, data: plain(definition.data), setData(values) { Object.assign(this.data, plain(values)) } }
    const emit = (type, payload) => (state.handlers[type] || []).forEach(fn => fn(payload))
    return { page, state, emit }
  }
  const statuses = page => page.data.steps.map(step => step.status)

  {
    Object.keys(storage).forEach(key => delete storage[key])
    const { page, state, emit } = loadPage({ info: { status: 'ONLINE', online: true, firmwareVersion: '0.6.1' } })
    page.onLoad({ id: '9' })
    await flush()
    assert.equal(page.data.phase, 'available')
    assert.equal(page.data.currentVersion, '0.6.1')
    assert.equal(page.data.latestVersion, '0.6.2')
    page.startUpgrade()
    await flush()
    assert.deepEqual(state.started, [{ deviceNo: '3844BE2E5220', url: 'https://oss/fw.bin', type: 'main', version: '0.6.2' }], '下发参数')
    assert.equal(storage['ota_inflight:3844BE2E5220'].msgid, '555', '下发成功立即保存 msgid')
    assert.equal(storage['ota_inflight:3844BE2E5220'].type, 'ota')
    assert.equal(page.data.phase, 'running')
    assert.deepEqual(statuses(page), ['loading', 'pending', 'pending', 'pending'])
    assert.ok(state.intervals > 0, '开始轮询')

    otaReplies['555'] = { status: 'DOWNLOADING', elapsedSeconds: 30 }
    emit('ota.result', { msgid: '999', status: 'FAILED' })
    assert.equal(page.data.phase, 'running', '别的 msgid 不认')
    emit('ota.result', { msgid: '555', status: 'DOWNLOADING' })
    await flush()
    assert.deepEqual(statuses(page), ['done', 'loading', 'pending', 'pending'])
    assert.ok(/已进行 30 秒/.test(page.data.hint), 'elapsedSeconds 做进度提示')

    otaReplies['555'] = { status: 'FAILED' }
    emit('ota.result', { msgid: '555', status: 'FAILED' })
    await flush()
    assert.equal(page.data.phase, 'failed')
    assert.equal(page.data.title, '升级失败')
    assert.deepEqual(statuses(page), ['done', 'fail', 'pending', 'pending'], '在当前步打叉')
    assert.equal(storage['ota_inflight:3844BE2E5220'], undefined, '终态清记录')
    checked('页面：下发、推进与失败')
  }
  {
    Object.keys(storage).forEach(key => delete storage[key])
    const { page, state, emit } = loadPage({ info: { status: 'ONLINE', online: true, firmwareVersion: '0.6.1' } })
    page.onLoad({ id: '9' })
    await flush()
    page.startUpgrade()
    await flush()
    otaReplies['555'] = { status: 'VERIFYING' }
    emit('ota.result', { msgid: '555', status: 'VERIFYING' })
    await flush()
    assert.equal(page.data.phase, 'verifying')
    assert.equal(page.data.title, '升级完成')
    assert.ok(/等待设备重启/.test(page.data.hint))
    assert.deepEqual(statuses(page), ['done', 'done', 'done', 'done'])
    assert.ok(storage['ota_inflight:3844BE2E5220'], 'VERIFYING 保留记录，等终态再清')
    assert.equal(state.toasts.length, 0)

    // 重进页面：VERIFYING 记录 → 不进步骤页、不提示升级（设备版本此时还是旧的）
    const again = loadPage({ info: { status: 'ONLINE', online: true, firmwareVersion: '0.6.1' } })
    again.page.onLoad({ id: '9' })
    await flush()
    assert.equal(again.page.data.phase, 'busy')
    assert.equal(again.page.data.showSteps, false)
    assert.ok(/等待设备重启/.test(again.page.data.title))
    checked('页面：VERIFYING 成功终点与重进不重复提示')
  }
  {
    Object.keys(storage).forEach(key => delete storage[key])
    ota.saveInflight('3844BE2E5220', '777', { status: 'DOWNLOADING', lastStep: 1 })
    otaReplies['777'] = { status: 'FLASHING' }
    const { page, state } = loadPage({ info: { status: 'ONLINE', online: true, firmwareVersion: '0.6.1' } })
    page.onLoad({ id: '9' })
    await flush()
    assert.equal(page.data.phase, 'running', '有进行中记录直接进步骤页')
    assert.deepEqual(statuses(page), ['done', 'done', 'loading', 'pending'])
    assert.equal(state.started.length, 0)
    assert.ok(state.intervals > 0)
    checked('页面：重进按本地 msgid 恢复进度')
  }
  {
    Object.keys(storage).forEach(key => delete storage[key])
    const { page, state } = loadPage({ info: { status: 'ONLINE', online: true, firmwareVersion: '0.6.1' }, startError: codeError(4045) })
    page.onLoad({ id: '9' })
    await flush()
    page.startUpgrade()
    await flush()
    assert.equal(page.data.phase, 'busy', '4045 切到升级进行中')
    assert.deepEqual(state.toasts, ['设备正在升级，请稍候'], '不显示成普通失败')
    assert.equal(storage['ota_inflight:3844BE2E5220'], undefined)

    const offline = loadPage({ info: { status: 'OFFLINE', online: false, firmwareVersion: '0.6.1' } })
    offline.page.onLoad({ id: '9' })
    await flush()
    offline.page.startUpgrade()
    await flush()
    assert.equal(offline.state.started.length, 0, '离线不下发')
    assert.deepEqual(offline.state.toasts, [wifiStatus.OFFLINE_TIP])

    const old = loadPage({ info: { status: 'ONLINE', online: true, firmwareVersion: 'M H:3 F:0.6.1' } })
    old.page.onLoad({ id: '9' })
    await flush()
    assert.equal(old.page.data.phase, 'unknown', '旧格式版本按无法判断，不报错')
    checked('页面：进行中错误码、离线与无法判断')
  }
  {
    const m = require('../utils/wifi-messages')
    assert.equal(m.toItem({ id: 1, type: 'OTA_SUCCESS', payload: { version: '0.6.2', baseVersion: '0.6.1' } }).title, '固件升级成功')
    assert.equal(m.toItem({ id: 1, type: 'OTA_SUCCESS', payload: { version: '0.6.2', baseVersion: '0.6.1' } }).detail, '0.6.1 → 0.6.2')
    assert.equal(m.toItem({ id: 2, type: 'OTA_FAILED', payload: { version: '0.6.2', baseVersion: '0.6.1', reason: 'timeout' } }).detail, '0.6.1 → 0.6.2，升级超时')
    assert.equal(m.toItem({ id: 3, type: 'OTA_SUCCESS', payload: { version: '0.6.2', reason: 'corrected' } }).detail, '目标版本 0.6.2', 'corrected 按升级成功展示')
    checked('消息类型')
  }
  {
    const app = JSON.parse(read('app.json'))
    const device = app.subpackages.find(item => item.root === 'subpackages/device')
    assert.ok(device.pages.indexOf('wifi-ota/wifi-ota') > -1, '页面已注册')
    const tpl = read('subpackages/device/wifi-detail/wifi-detail.wxml')
    assert.ok(/bindtap="openOta"[\s\S]*?固件升级/.test(tpl), '详情页有固件升级入口')
    assert.ok(/wx:if="\{\{otaHasUpdate\}\}"/.test(tpl), '有新版本红点')
    const api = read('utils/iot-api.js')
    assert.ok(api.indexOf("'/api/device/ota'") > -1 && api.indexOf("'/api/device/ota/status'") > -1, '接口路径')
    assert.ok(/@import "\.\.\/wifi-provision\/wifi-provision\.wxss"/.test(read('subpackages/device/wifi-ota/wifi-ota.wxss')), '与配网页同一形态')
    const appJs = read('app.js')
    assert.ok(/wifiOta\.readInflight/.test(appJs), '启动强制升级提示前先看进行中的升级')
    checked('注册与入口')
  }
  console.log(`wifi-ota: ${checks} groups passed`)
}
main().catch(error => { console.error(error); process.exitCode = 1 })
