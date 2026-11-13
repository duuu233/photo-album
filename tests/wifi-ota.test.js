// WiFi 版固件升级（2026-11-02，docs/前端对接文档20261031.md）utils/wifi-ota + subpackages/device/wifi-ota：
//   ① 版本比对：x.y.z 数字段比较；当前版本旧格式「M H:3 F:…」/ 空 → 无法判断；目标为空 → 已是最新；包地址非 http(s) → invalid；
//   ② 四步状态：SENT / DOWNLOADING / FLASHING 转圈推进，VERIFYING 四步全勾（成功终点、非终态），
//      FAILED / TIMEOUT 在当前那一步打叉、后续不再执行，未知值不白屏；
//   ③ 本地记录：独立 key ota_inflight:{deviceNo}、带 type:'ota'，类型不对不认；终态 / 4044 清，VERIFYING / 查询失败保留；
//   ④ 4045 一律、4000（OTA 接口上的「已有升级任务进行中」）按进行中处理，4000 文案明显是别的错误时按普通失败；
//   ⑤ 页面：下发成功立即存 msgid → 第 1 步；WS ota.result 按 msgid 推进；失败在当前步打叉；4045 切「设备正在升级」；
//      重进页面有 VERIFYING 记录 → 不进步骤页、不提示升级；有 FLASHING 记录 → 直接接着展示步骤；
//   ⑥ 消息类型 OTA_SUCCESS / OTA_FAILED 有文案；页面已注册、详情页有入口、接口路径对。
//   ⑦ 进度条（2026-11-12）：progress 20/40/60/80 抬上限、显示值匀速走到 19/39/59/79 停住等下一档数值，
//      状态推进（DOWNLOADING / FLASHING）不放开分档（2026-11-13）；固件不上报（没有数值就进入 FLASHING）走到 98 停住；
//      VERIFYING 到 100；失败停住；收到过的最大进度存进本地记录，重进接着走；文案用当前那一步的步骤文案。
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
const fpga = require('../utils/fpga-firmware')
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
    assert.equal(ota.parseProgress(40), 40)
    assert.equal(ota.parseProgress('60'), 60)
    assert.equal(ota.parseProgress(null), null, 'null = 固件不上报')
    assert.equal(ota.parseProgress(undefined), null, '老服务端不带该字段')
    assert.equal(ota.parseProgress('abc'), null)
    assert.equal(ota.parseProgress(130), 100)
    assert.equal(ota.progressCap('SENT', null), 19, '没收到进度：停在 19')
    assert.equal(ota.progressCap('DOWNLOADING', 20), 39)
    assert.equal(ota.progressCap('DOWNLOADING', 40), 59)
    assert.equal(ota.progressCap('DOWNLOADING', 60), 79)
    assert.equal(ota.progressCap('DOWNLOADING', 80), 98, '80 之后最多 98，等 VERIFYING')
    assert.equal(ota.progressCap('DOWNLOADING', null), 19, '进入下载但 20 还没到：仍停 19 等 20')
    assert.equal(ota.progressCap('DOWNLOADING', 0), 19)
    assert.equal(ota.progressCap('FLASHING', 40), 59, '写入阶段也要等 60：状态不放开分档')
    assert.equal(ota.progressCap('FLASHING', 60), 79, '79 等 80')
    assert.equal(ota.progressCap('FLASHING', 80), 98)
    assert.equal(ota.progressCap('FLASHING', null), 98, '没有任何数值就进入写入：固件不上报，走到 98')
    assert.equal(ota.progressCap('VERIFYING', 80), 100)
    assert.equal(ota.progressCap('SUCCESS', null), 100)
    assert.equal(ota.activeStep(ota.stepsFor('DOWNLOADING')), 1)
    assert.equal(ota.activeStep(ota.stepsFor('VERIFYING')), 3, '全勾为最后一步')
    assert.equal(ota.activeStep(ota.stepsFor('TIMEOUT', 2)), 2, '打叉那一步')
    checked('进度条上限与文案')
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
    const state = { toasts: [], started: [], subs: [], handlers: {}, intervals: 0, modals: [], timers: [], cleared: [] }
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
      'wifi-ota': ota,
      // 2026-11-13 渲染固件安装（mode=fpga）多了这个依赖；纯逻辑 + 本地存储，直接用真实模块
      'fpga-firmware': fpga
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
      setInterval: (fn, ms) => { state.intervals++; state.timers.push({ id: state.intervals, fn, ms }); return state.intervals },
      clearInterval: id => state.cleared.push(id),
      console: { log() {}, warn() {} }
    }, { filename: 'wifi-ota.js' })
    const page = { ...definition, data: plain(definition.data), setData(values) { Object.assign(this.data, plain(values)) } }
    const emit = (type, payload) => (state.handlers[type] || []).forEach(fn => fn(payload))
    // 进度条计时器走 n 下（轮询计时器不动）
    const tick = n => {
      for (let i = 0; i < n; i++) {
        state.timers.filter(timer => timer.ms === ota.PROGRESS_TICK_MS && state.cleared.indexOf(timer.id) === -1).forEach(timer => timer.fn())
      }
    }
    return { page, state, emit, tick }
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
    // 优雅刷新升级（2026-11-13，原名渲染固件管理）：mode=fpga 不比对版本，安装目标来自列表页；下发 type=fpga、version=目标版本；
    // 进度、四步与固件升级一致，只换文字并带出简介；设备不上报 FPGA 版本，不显示当前版本；本地记录带 otaType，重进按它选文字
    Object.keys(storage).forEach(key => delete storage[key])
    fpga.saveTarget('9', { version: 'v1.02', intro: '修复刷新闪烁', url: 'https://oss/fpga.bin' })
    const { page, state, emit } = loadPage({ info: { status: 'ONLINE', online: true, firmwareVersion: '0.6.1', shadow: { fpgaVersion: 'v1.01' } } })
    page.onLoad({ id: '9', mode: 'fpga' })
    await flush()
    assert.equal(page.data.navTitle, '优雅刷新升级')
    assert.equal(page.data.phase, 'available', '不比对版本，直接可安装')
    assert.equal(page.data.showCurrent, false, '设备不上报 FPGA 版本，不显示当前版本')
    assert.equal(page.data.latestVersion, 'v1.02')
    assert.equal(page.data.targetLabel, '安装版本')
    assert.equal(page.data.intro, '修复刷新闪烁', '带出简介')
    assert.equal(page.data.confirmText, '立即安装')
    page.startUpgrade()
    await flush()
    assert.deepEqual(state.started, [{ deviceNo: '3844BE2E5220', url: 'https://oss/fpga.bin', type: 'fpga', version: 'v1.02' }], '复用 /api/device/ota，type=fpga')
    assert.equal(storage['ota_inflight:3844BE2E5220'].otaType, 'fpga')
    assert.equal(page.data.title, '设备正在安装优雅刷新固件')
    assert.deepEqual(statuses(page), ['loading', 'pending', 'pending', 'pending'], '四步与固件升级一致')
    otaReplies['555'] = { status: 'VERIFYING', progress: 100 }
    emit('ota.result', { msgid: '555', status: 'VERIFYING', progress: 100 })
    await flush()
    assert.equal(page.data.title, '安装完成')
    assert.equal(page.data.steps[3].text, '安装完成')
    assert.equal(page.data.intro, '修复刷新闪烁', '进度页也带出简介')

    // 从固件升级入口重进：按记录里的类型显示安装文字
    const again = loadPage({ info: { status: 'ONLINE', online: true, firmwareVersion: '0.6.1' } })
    otaReplies['555'] = { status: 'DOWNLOADING', progress: 20 }
    again.page.onLoad({ id: '9' })
    await flush()
    assert.equal(again.page.data.navTitle, '优雅刷新升级')
    assert.equal(again.page.data.title, '设备正在安装优雅刷新固件')

    // 没有安装目标：提示回列表重新选择
    Object.keys(storage).forEach(key => delete storage[key])
    const none = loadPage({ info: { status: 'ONLINE', online: true } })
    none.page.onLoad({ id: '9', mode: 'fpga' })
    await flush()
    assert.equal(none.page.data.phase, 'error')
    assert.ok(/优雅刷新升级/.test(none.page.data.hint))

    // 普通固件升级入口文字不变
    const main = loadPage({ info: { status: 'ONLINE', online: true, firmwareVersion: '0.6.1' } })
    main.page.onLoad({ id: '9' })
    await flush()
    assert.equal(main.page.data.navTitle, '固件升级')
    assert.equal(main.page.data.confirmText, '立即升级')
    assert.equal(main.page.data.showCurrent, true, '普通固件升级照常显示当前版本')

    // 4047：今日升级次数已达上限（多语种），不进步骤页、不存记录
    Object.keys(storage).forEach(key => delete storage[key])
    fpga.saveTarget('9', { version: 'v1.02', intro: '', url: 'https://oss/fpga.bin' })
    const limited = loadPage({ info: { status: 'ONLINE', online: true }, startError: codeError(4047) })
    limited.page.onLoad({ id: '9', mode: 'fpga' })
    await flush()
    limited.page.startUpgrade()
    await flush()
    assert.equal(limited.state.toasts.at(-1), '今日升级次数已达上限')
    assert.equal(limited.page.data.phase, 'available', '停在当前页，可明天再装')
    assert.equal(storage['ota_inflight:3844BE2E5220'], undefined)
    assert.equal(fpga.limitText('en'), "You've reached today's upgrade limit")
    assert.equal(fpga.limitText('zh-Hant'), '今日升級次數已達上限')
    assert.equal(fpga.limitText('ja'), '本日のアップデート回数の上限に達しました')
    assert.equal(fpga.limitText('xx'), '今日升级次数已达上限', '认不出的语种按简中')

    assert.equal(fpga.isFpgaRender(' FPGA16 '), true)
    assert.equal(fpga.isFpgaRender('esp32'), false)
    assert.deepEqual(fpga.normalizeVersions([
      { id: 1, versionNumber: 'v1.01', verify: 1, grade: 1, downloadPath: 'https://a', versionDesc: '一' },
      { id: 2, versionNumber: 'v1.02', verify: 0, grade: 9 },
      { id: 3, versionNumber: 'v1.03', grade: 5, remark: '三' }
    ]).map(item => [item.version, item.intro]), [['v1.03', '三'], ['v1.01', '一']], '未启用不显示、按权重排、简介字段兜底')
    assert.equal(fpga.listApiReady(), false, '用户端列表接口待后端提供')
    assert.ok(/wifiInfo|showFpga/.test(read('subpackages/device/wifi-info/wifi-info.js')) && /fpgaFirmware\.isFpgaRender\(renderMode\)/.test(read('subpackages/device/wifi-info/wifi-info.js')), '设备信息页按渲染模式显示入口')
    assert.ok(/wx:if="\{\{showFpga\}\}"[\s\S]*?优雅刷新升级/.test(read('subpackages/device/wifi-info/wifi-info.wxml')))
    assert.equal(read('subpackages/device/wifi-info/wifi-info.js').indexOf('fpgaVersion'), -1, '设备信息页不显示 FPGA 版本号')
    assert.equal(read('subpackages/device/wifi-fpga/wifi-fpga.wxml').indexOf('currentVersion'), -1, '列表页不显示设备当前版本')
    assert.ok(JSON.parse(read('app.json')).subpackages.find(item => item.root === 'subpackages/device').pages.includes('wifi-fpga/wifi-fpga'), '页面已注册')
    checked('页面：优雅刷新升级（mode=fpga）')
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
    // ⑦ 进度条：示例时间线 SENT → 20 → 40 → 60 → 80 → VERIFYING
    Object.keys(storage).forEach(key => delete storage[key])
    const { page, emit, tick } = loadPage({ info: { status: 'ONLINE', online: true, firmwareVersion: '0.6.1' } })
    page.onLoad({ id: '9' })
    await flush()
    page.startUpgrade()
    await flush()
    assert.equal(page.data.progress, 0, '刚下发为 0')
    assert.equal(page.data.progressText, '已下发，等待设备响应')
    tick(5)
    assert.equal(page.data.progress, 5, '匀速前进')
    tick(50)
    assert.equal(page.data.progress, 19, '没收到进度停在 19')
    const report = async (status, progress) => {
      otaReplies['555'] = { status, progress }
      emit('ota.result', { msgid: '555', status, progress })
      await flush()
    }
    await report('DOWNLOADING', null)
    tick(50)
    assert.equal(page.data.progress, 19, '进入下载但 20 还没到：19 继续等 20')
    await report('DOWNLOADING', 20)
    assert.equal(page.data.progressText, '设备下载固件中', '文案对应步骤文案')
    tick(50)
    assert.equal(page.data.progress, 39, '39 没收到 40 停住')
    await report('DOWNLOADING', 40)
    tick(3)
    assert.equal(page.data.progress, 42, '收到 40 后从 39 继续匀速前进')
    tick(50)
    assert.equal(page.data.progress, 59)
    assert.equal(storage['ota_inflight:3844BE2E5220'].progress, 40, '收到过的最大进度存进本地记录')
    await report('DOWNLOADING', null)
    tick(50)
    assert.equal(page.data.progress, 59, '收到过进度后偶发的 null 不放开到 98')
    await report('DOWNLOADING', 60)
    tick(50)
    assert.equal(page.data.progress, 79)
    await report('FLASHING', 60)
    tick(50)
    assert.equal(page.data.progress, 79, '进入写入也要等 80：79 停住')
    await report('FLASHING', 80)
    tick(100)
    assert.equal(page.data.progress, 98, '80 之后停在 98 等 VERIFYING')
    await report('VERIFYING', 100)
    assert.equal(page.data.phase, 'verifying')
    tick(10)
    assert.equal(page.data.progress, 100, 'VERIFYING 到 100')
    assert.equal(page.data.progressText, '升级完成')

    // 固件不上报进度：下载阶段停 19，没有任何数值就进入写入 → 匀速走到 98 停住
    Object.keys(storage).forEach(key => delete storage[key])
    const silent = loadPage({ info: { status: 'ONLINE', online: true, firmwareVersion: '0.6.1' } })
    silent.page.onLoad({ id: '9' })
    await flush()
    silent.page.startUpgrade()
    await flush()
    otaReplies['555'] = { status: 'DOWNLOADING', progress: null }
    silent.emit('ota.result', { msgid: '555', status: 'DOWNLOADING', progress: null })
    await flush()
    silent.tick(200)
    assert.equal(silent.page.data.progress, 19, '下载阶段为 null 不算不上报，停 19')
    otaReplies['555'] = { status: 'FLASHING', progress: null }
    silent.emit('ota.result', { msgid: '555', status: 'FLASHING', progress: null })
    await flush()
    silent.tick(200)
    assert.equal(silent.page.data.progress, 98, '不上报进度停在 98')

    // 失败停在当时的位置
    otaReplies['555'] = { status: 'FAILED', progress: null }
    silent.emit('ota.result', { msgid: '555', status: 'FAILED' })
    await flush()
    silent.tick(10)
    assert.equal(silent.page.data.phase, 'failed')
    assert.equal(silent.page.data.progress, 98, '失败停住')

    // 重进页面：从记录里的最大进度接着走
    Object.keys(storage).forEach(key => delete storage[key])
    ota.saveInflight('3844BE2E5220', '888', { status: 'DOWNLOADING', lastStep: 1, progress: 40 })
    otaReplies['888'] = { status: 'DOWNLOADING', progress: 60 }
    const resumed = loadPage({ info: { status: 'ONLINE', online: true, firmwareVersion: '0.6.1' } })
    resumed.page.onLoad({ id: '9' })
    await flush()
    assert.equal(resumed.page.data.progress, 60, '从收到过的最大进度开始')
    resumed.tick(50)
    assert.equal(resumed.page.data.progress, 79)

    const tpl = read('subpackages/device/wifi-ota/wifi-ota.wxml')
    assert.ok(/wx:if="\{\{showSteps\}\}" class="ota-progress glass-panel/.test(tpl), '进度条与步骤同时显示')
    assert.ok(/class="ota-progress__text">\{\{progressText\}\}</.test(tpl) && /width: \{\{progress\}\}%;/.test(tpl))
    assert.ok(tpl.indexOf('ota-progress') < tpl.indexOf('class="provision-steps'), '进度条在步骤上方')
    checked('页面：进度条分档匀速、19/39/59/79 等下一档、不上报停 98、VERIFYING 到 100、失败停住、重进接着走')
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
    // 2026-11-13：启动时的强制升级弹窗撤掉，固件升级判断改到 utils/firmware-gate.js（列表页 / 首页现查那一支）。
    // 判据跟着挪过去：弹升级提示前先看本地有没有进行中的升级；详情页走红点结果（otaHasUpdate，进行中时本就不亮）
    const gateJs = read('utils/firmware-gate.js')
    assert.ok(/wifiOta\.readInflight/.test(gateJs), '弹升级提示前先看进行中的升级')
    assert.ok(!/checkForcedFirmwareUpgrade/.test(read('app.js')), '启动时不再弹强制升级')
    checked('注册与入口')
  }
  console.log(`wifi-ota: ${checks} groups passed`)
}
main().catch(error => { console.error(error); process.exitCode = 1 })
