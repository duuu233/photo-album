// WiFi 版投屏（2026-10-27，对接进度 STEP 3；V1.4 更新说明第二节起「不等 ack」）utils/wifi-projection.projectOne：
//   ① 上传进度 → 图片处理中 → 接口返回 SENT 即结束：提示「已发送，屏幕即将刷新」，不查 /play/status、不等 WS；
//   ② refresh=false：formData 带 refresh=false，返回 UPLOADED（只上传不刷屏），带回 binUrl；
//   ③ 接口 status=FAILED / 上传报错直接失败；旧版初始状态 DOWNLOADING 按 SENT；没给 status 按 refresh 推断；
//   ④ 4041 补查在线状态：SLEEPING / SHUTDOWN 给对应提示，其余 / 补查失败仍是离线文案；
//   ⑤ 投屏日志：接口三行、阶段变化、结论（带 binUrl），不记 token；
//   ⑥ iot-api.play：refresh=false 才带 refresh 字段，默认不带（服务端默认 true）；
//   ⑦ 结果页：多张时本轮最后一张 refresh=true、其余 false；每张拿 binUrl 写相册记录，写失败只注明不算投屏失败；重试同样「最后一张刷屏」。
//   ⑧ 同时加入轮播（2026-10-27 追加内容第二节）：iot-api.play 只在 addToCarousel=true 时带字段；projectOne 透传并交回
//      carouselUpdated；结果页每张都带，有一张 carouselUpdated=false 就追加「未成功加入轮播，请前往轮播设置添加」；
//      预览页只在轮播运行中显示开关，开关状态经 pendingProjection.addToCarousel 交给结果页。
//   ⑨ 渲染模式 renderMode（2026-10-28）：iot-api.play 有值才带、原样传；projectOne 透传；结果页按设备取一次（api.resolveRenderMode），
//      每张都带，重试不再查。
//   ⑩ 进度条（2026-10-29）：上传折算到 0~50%，处理阶段按时间爬向 99、不到 100；100% 只在 SENT / UPLOADED 时给出，失败停在原处；
//      结果页写相册记录时不改文案（100% 只显示「已发送，屏幕即将刷新」）。
//   ⑪ 相册记录存原图（2026-11-06）：投屏用图已按设备 verticalRotation 转过（IJ_101 竖向 180°，「我的上传」显示倒置），
//      记录改传预览页备份的原图 _origSrc（云端先下载），长边缩到设备长边；没有 _origSrc / 下载失败才退回投屏图；投屏本身仍用转过的图。
//   ⑫ 幂等键 Idempotency-Key（2026-11-13，服务端 deviceNo + 键去重 10 分钟、失败不缓存）：一张图一个键，Header 带、不进表单；
//      「重试未成功的」同一张、同样刷屏方式复用原键，刷屏方式变了换新键；新进入结果页全部新键；4090 = 首次请求处理中。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const root = path.join(__dirname, '..')

let checks = 0
function checked(name) { checks++; console.log('PASS ' + name) }
const plain = value => JSON.parse(JSON.stringify(value))

function setup(options = {}) {
  const log = { stages: [], plays: [], statusCalls: 0 }
  const api = {
    async play(deviceNo, filePath, type, opts) {
      log.plays.push({ deviceNo, filePath, type, showError: opts.showError, refresh: opts.refresh })
      if (opts.addToCarousel) log.plays[log.plays.length - 1].addToCarousel = true
      if (opts.renderMode) log.plays[log.plays.length - 1].renderMode = opts.renderMode
      if (opts.idempotencyKey) log.plays[log.plays.length - 1].idempotencyKey = opts.idempotencyKey
      ;[30, 100].forEach(p => opts.onProgress(p))
      if (options.delayMs) await new Promise(resolve => setTimeout(resolve, options.delayMs))
      if (options.playError) throw options.playError
      return options.response || { msgid: 'm1', status: 'SENT', binUrl: 'https://oss/a.bin', binSize: 10 }
    },
    async getPlayStatus() {
      log.statusCalls++
      throw new Error('V1.4 起不该再查投屏状态')
    }
  }
  if (options.onlineReply !== undefined) {
    api.getDeviceOnline = async deviceNo => {
      log.onlineCalls = (log.onlineCalls || []).concat(deviceNo)
      if (options.onlineReply instanceof Error) throw options.onlineReply
      return options.onlineReply
    }
  }
  const sandbox = {
    module: { exports: {} },
    require: target => ({ './iot-api': api })[target],
    console: { log() {}, warn() {} },
    setInterval,
    clearInterval
  }
  vm.runInNewContext(fs.readFileSync(path.join(root, 'utils/wifi-projection.js'), 'utf8'), sandbox, { filename: 'wifi-projection.js' })
  const projection = sandbox.module.exports
  const run = extra => projection.projectOne(Object.assign({
    deviceNo: 'E3:48:C2:1E:D4:28', filePath: 'wxfile://a.png', type: '1',
    onStage: info => log.stages.push(`${info.stage}:${info.progress}`)
  }, extra))
  return { run, log, projection }
}

async function main() {
  {
    // ⑫ 幂等键（2026-11-13）：newPlayKey 为 UUID 形状、互不相同；projectOne 原样透传给 iot-api.play
    const { run, log, projection } = setup()
    const keys = Array.from({ length: 50 }, () => projection.newPlayKey())
    assert.ok(keys.every(key => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(key) && key.length <= 64), keys[0])
    assert.equal(new Set(keys).size, keys.length)
    await run({ idempotencyKey: 'k-abc' })
    assert.equal(log.plays[0].idempotencyKey, 'k-abc')
    await run({})
    assert.equal(log.plays[1].idempotencyKey, undefined, '不传就不带')
    checked('projectOne：幂等键生成与透传')
  }
  {
    const { run, log } = setup()
    const result = await run()
    assert.equal(result.status, 'SENT')
    assert.equal(result.message, '已发送，屏幕即将刷新')
    assert.equal(result.msgid, 'm1')
    assert.equal(result.binUrl, 'https://oss/a.bin', '带回 binUrl 供写相册记录')
    assert.deepEqual(plain(log.plays[0]), { deviceNo: 'E348C21ED428', filePath: 'wxfile://a.png', type: '1', showError: false, refresh: true }, 'deviceNo 去冒号、type 原样、静默、默认刷屏')
    const order = log.stages.map(item => item.split(':')[0]).filter((item, i, all) => item !== all[i - 1])
    assert.deepEqual(order, ['UPLOADING', 'PROCESSING', 'SENT'], `阶段顺序：${order}`)
    assert.ok(log.stages.includes('UPLOADING:15'), '上传进度折算到前半段（真实 30% → 15%）')
    assert.ok(log.stages.includes('PROCESSING:50'), '上传完进入处理，停在 50% 起爬')
    assert.equal(log.stages.at(-1), 'SENT:100', '100% 只给 SENT')
    assert.ok(log.stages.filter(item => !item.startsWith('SENT')).every(item => Number(item.split(':')[1]) < 100), '上传 / 处理阶段都不到 100%')
    assert.equal(log.statusCalls, 0, '不再轮询投屏状态')
    checked('返回 SENT 即结束：已发送，屏幕即将刷新')
  }
  {
    const { run, log } = setup()
    await run({ renderMode: ' fpga16 ' })
    assert.equal(log.plays[0].renderMode, 'fpga16', 'renderMode 透传给接口')
    await run({ renderMode: '' })
    assert.equal(log.plays[1].renderMode, undefined, '空 renderMode 不传')
    checked('projectOne：renderMode 透传')
  }
  {
    const { run, log } = setup({ response: { msgid: null, status: 'UPLOADED', binUrl: 'https://oss/b.bin' } })
    const result = await run({ refresh: false })
    assert.equal(log.plays[0].refresh, false, 'refresh=false 透传给接口')
    assert.equal(result.status, 'UPLOADED')
    assert.equal(result.message, '已上传')
    assert.equal(result.msgid, '', 'msgid=null 不当任务号')
    assert.equal(result.binUrl, 'https://oss/b.bin')
    checked('refresh=false：只上传，UPLOADED')
  }
  {
    const { run, log } = setup({ response: { msgid: 'm1', status: 'SENT', binUrl: 'https://oss/a.bin', carouselUpdated: false } })
    const result = await run({ addToCarousel: true })
    assert.equal(log.plays[0].addToCarousel, true, 'addToCarousel 透传给接口')
    assert.equal(result.carouselUpdated, false, '交回 carouselUpdated')
    assert.equal(result.status, 'SENT', '没加进轮播不影响投屏')
    const plainRun = setup()
    assert.equal((await plainRun.run()).carouselUpdated, null, '没给 carouselUpdated → null')
    assert.equal('addToCarousel' in plainRun.log.plays[0], false, '默认不加入轮播')
    checked('addToCarousel：透传、交回 carouselUpdated')
  }
  {
    const { run, log } = setup({ delayMs: 700 })
    const result = await run()
    const processing = log.stages.filter(item => item.startsWith('PROCESSING')).map(item => Number(item.split(':')[1]))
    assert.ok(processing.length > 1 && processing.at(-1) > 50, `处理阶段进度随时间往上爬：${processing}`)
    assert.ok(processing.every((value, i) => value < 99 && (i === 0 || value >= processing[i - 1])), '只增不减、不到 99')
    assert.equal(result.status, 'SENT')
    assert.equal(log.stages.at(-1), 'SENT:100')
    const after = log.stages.length
    await new Promise(resolve => setTimeout(resolve, 450))
    assert.equal(log.stages.length, after, '接口返回后停表，不再报进度')
    const failed = setup({ delayMs: 450, playError: Object.assign(new Error('接口(IoT)-图片过大'), { code: 4130 }) })
    await failed.run()
    const last = failed.log.stages.at(-1)
    assert.ok(last.startsWith('PROCESSING') && Number(last.split(':')[1]) < 100, `报错停在原处：${last}`)
    const failedStatus = setup({ response: { msgid: 'm1', status: 'FAILED' } })
    await failedStatus.run()
    assert.equal(failedStatus.log.stages.at(-1), 'FAILED:50', '接口 FAILED 不到 100%')
    checked('进度条：处理阶段渐近爬升，成功才到 100%，失败停在原处')
  }
  {
    const failed = setup({ response: { msgid: 'm1', status: 'FAILED' } })
    assert.equal((await failed.run()).status, 'FAILED')
    const legacy = setup({ response: { msgid: 'm1', status: 'DOWNLOADING', binUrl: 'u' } })
    assert.equal((await legacy.run()).status, 'SENT', '旧版初始状态 DOWNLOADING 按 SENT')
    const bare = setup({ response: { binUrl: 'u' } })
    assert.equal((await bare.run()).status, 'SENT', '没给 status、刷屏 → SENT')
    const bare2 = setup({ response: { binUrl: 'u' } })
    assert.equal((await bare2.run({ refresh: false })).status, 'UPLOADED', '没给 status、只上传 → UPLOADED')
    const offline = setup({ playError: Object.assign(new Error('接口(IoT)-设备已离线，请检查设备网络'), { code: 4041 }) })
    const res = await offline.run()
    assert.equal(res.status, 'FAILED')
    assert.equal(res.message, '设备已离线，请检查设备网络', '错误码文案去掉前缀')
    checked('FAILED / 上传报错 / 旧版状态兼容')
  }
  {
    const offlineError = () => Object.assign(new Error('接口(IoT)-设备已离线，请检查设备网络'), { code: 4041 })
    const sleeping = setup({ playError: offlineError(), onlineReply: { online: false, status: 'SLEEPING' } })
    assert.equal((await sleeping.run()).message, '设备休眠中，唤醒后可操作', '休眠中不提示检查网络')
    assert.deepEqual(sleeping.log.onlineCalls, ['E348C21ED428'], '补查用去冒号的设备号')
    const shutdown = setup({ playError: offlineError(), onlineReply: { online: false, status: 'SHUTDOWN' } })
    assert.equal((await shutdown.run()).message, '设备已关机，开机后可操作', '已关机')
    const off = setup({ playError: offlineError(), onlineReply: { online: false, status: 'OFFLINE' } })
    assert.equal((await off.run()).message, '设备已离线，请检查设备网络', '真离线仍是离线文案')
    const broken = setup({ playError: offlineError(), onlineReply: new Error('网络') })
    assert.equal((await broken.run()).message, '设备已离线，请检查设备网络', '补查失败按离线')
    const other = setup({ playError: Object.assign(new Error('接口(IoT)-图片过大'), { code: 4130 }), onlineReply: { online: false, status: 'SLEEPING' } })
    assert.equal((await other.run()).message, '图片过大', '非 4041 不补查')
    assert.equal(other.log.onlineCalls, undefined)
    checked('4041 补查：休眠中 / 已关机改提示')
  }
  {
    const lines = []
    const { run } = setup()
    await run({ onLog: text => lines.push(text) })
    const all = lines.join('\n')
    assert.ok(/^开始投屏：设备 E348C21ED428，type=1，refresh=true，文件 wxfile:\/\/a\.png/.test(lines[0]), '第一行是本次投屏概要')
    assert.ok(all.includes('接口【投屏】POST /api/device/play'), '记接口')
    assert.ok(all.includes('参数 {"deviceNo":"E348C21ED428","type":"1","refresh":true,"file":"wxfile://a.png"}'), '记参数')
    assert.ok(/返回 \{"msgid":"m1","status":"SENT"/.test(all), '记返回')
    assert.ok(all.includes('上传进度 25%') && all.includes('上传进度 100%') && !all.includes('上传进度 50%'), '进度只记 25% 档位')
    assert.ok(all.includes('阶段 → SENT（已发送，屏幕即将刷新）'), '记阶段变化')
    assert.equal(lines.filter(line => line.startsWith('阶段 → UPLOADING')).length, 1, '同一阶段只记一次')
    assert.ok(/^结束：SENT（已发送，屏幕即将刷新），msgid=m1，binUrl=https:\/\/oss\/a\.bin$/.test(lines.at(-1)), '最后一行是结论')
    assert.equal(/userToken/i.test(all), false, '不记 token')
    const failed = []
    const err = Object.assign(new Error('设备已离线'), { code: 4041, statusCode: 200, serverMessage: 'device offline' })
    await setup({ playError: err }).projection.projectOne({ deviceNo: 'E348C21ED428', filePath: 'wxfile://b.png', type: '0', onLog: text => failed.push(text) })
    assert.ok(failed.some(line => /^失败 HTTP 200 code 4041 服务端：device offline，设备已离线/.test(line)), '失败记 HTTP / 业务码 / 服务端原文')
    checked('投屏日志：接口参数返回、阶段、结论')
  }
  {
    const uploads = []
    const sandbox = {
      module: { exports: {} },
      require: target => ({ './iot-request': { upload: (url, opts) => { uploads.push({ url, opts }); return Promise.resolve({}) } } })[target]
    }
    vm.runInNewContext(fs.readFileSync(path.join(root, 'utils/iot-api.js'), 'utf8'), sandbox, { filename: 'iot-api.js' })
    const iotApi = sandbox.module.exports
    await iotApi.play('E3:48:C2:1E:D4:28', 'wxfile://a.png', 0, {})
    await iotApi.play('E3:48:C2:1E:D4:28', 'wxfile://a.png', 0, { refresh: false })
    assert.deepEqual(plain(uploads[0].opts.formData), { deviceNo: 'E348C21ED428', type: '0' }, '默认不带 refresh（服务端默认 true）')
    assert.deepEqual(plain(uploads[1].opts.formData), { deviceNo: 'E348C21ED428', type: '0', refresh: 'false' }, 'refresh=false 才带')
    await iotApi.play('E3:48:C2:1E:D4:28', 'wxfile://a.png', 0, { refresh: false, addToCarousel: true })
    await iotApi.play('E3:48:C2:1E:D4:28', 'wxfile://a.png', 0, { addToCarousel: false })
    assert.deepEqual(plain(uploads[2].opts.formData), { deviceNo: 'E348C21ED428', type: '0', refresh: 'false', addToCarousel: 'true' }, 'addToCarousel 与 refresh 独立')
    assert.deepEqual(plain(uploads[3].opts.formData), { deviceNo: 'E348C21ED428', type: '0' }, 'addToCarousel=false 不带')
    await iotApi.play('E3:48:C2:1E:D4:28', 'wxfile://a.png', 0, { renderMode: 'esp32' })
    await iotApi.play('E3:48:C2:1E:D4:28', 'wxfile://a.png', 0, { renderMode: '' })
    assert.deepEqual(plain(uploads[4].opts.formData), { deviceNo: 'E348C21ED428', type: '0', renderMode: 'esp32' }, 'renderMode 原样带')
    assert.deepEqual(plain(uploads[5].opts.formData), { deviceNo: 'E348C21ED428', type: '0' }, '空 renderMode 不带')
    checked('iot-api.play：refresh / addToCarousel / renderMode 字段')
    // ⑫ 幂等键（2026-11-13）：有键才带 Header Idempotency-Key，不放进表单字段
    await iotApi.play('E3:48:C2:1E:D4:28', 'wxfile://a.png', 0, { idempotencyKey: 'k-1' })
    assert.deepEqual(plain(uploads[6].opts.header), { 'Idempotency-Key': 'k-1' })
    assert.deepEqual(plain(uploads[6].opts.formData), { deviceNo: 'E348C21ED428', type: '0' }, '键不进表单')
    assert.equal(uploads[5].opts.header, undefined, '没键不带头')
    const iotErrors = require('../utils/iot-errors')
    const busy = iotErrors.fromResponse(200, { code: 4090, msg: 'idempotent request in progress' }, {})
    assert.equal(busy.error.message, '处理中，请稍后重试', '4090：同一键首次请求还在处理中')
    checked('iot-api.play：幂等键 Header；4090 文案')
  }
  {
    // 结果页：按真实源码装配，projectOne / 写相册记录用桩
    let definition
    const calls = { plays: [], records: [], renderModeLookups: 0, screenTypeLookups: 0, keySeq: 0 }
    const failIndex = { value: -1 }
    const carouselFailIndex = { value: -1 }
    const modules = {
      api: {
        resolveRenderMode: async device => {
          calls.renderModeLookups++
          assert.equal(device.productDeviceId, 'E3:48:C2:1E:D4:28', '按当前设备查渲染模式')
          return 'fpga16'
        },
        resolveScreenType: async device => {
          calls.screenTypeLookups++
          assert.equal(device.productDeviceId, 'E3:48:C2:1E:D4:28', '按当前设备查屏幕方向')
          return '1'
        },
        addWifiAlbumRecord: async data => {
          calls.records.push(data)
          if (data.filePath === 'wxfile://2.png' && calls.records.length === 2) throw new Error('上传失败')
          return { img: `https://img/${calls.records.length}`, imgBle: data.imgBle }
        }
      },
      system: { getLayoutMetrics: () => ({}) },
      'tap-guard': require('../utils/tap-guard'),
      'fold-adapt': { adapt: value => value },
      dithering: { typeForDevice: () => '0' },
      'wifi-projection': {
        newPlayKey: () => `key-${++calls.keySeq}`,
        projectOne: async opts => {
          const n = calls.plays.length
          calls.plays.push({ file: opts.filePath, type: opts.type, refresh: opts.refresh, addToCarousel: opts.addToCarousel, renderMode: opts.renderMode, key: opts.idempotencyKey })
          // 与真实 projectOne 一样先报上传中、处理中（步骤卡跟着推进）
          opts.onStage({ stage: 'UPLOADING', text: '图片上传中', progress: 10 })
          opts.onStage({ stage: 'PROCESSING', text: '图片处理中', progress: 60 })
          if (n === failIndex.value) return { status: 'FAILED', message: '投屏失败' }
          const carouselUpdated = opts.addToCarousel ? n !== carouselFailIndex.value : null
          return opts.refresh
            ? { status: 'SENT', message: '已发送，屏幕即将刷新', binUrl: `https://oss/${n}.bin`, carouselUpdated }
            : { status: 'UPLOADED', message: '已上传', binUrl: `https://oss/${n}.bin`, carouselUpdated }
        }
      },
      config: { iotBaseURL: 'https://iot' }
    }
    const pending = {
      device: { id: '7', userProductId: '7', productDeviceId: 'E3:48:C2:1E:D4:28', name: '客厅' },
      images: [1, 2, 3].map(i => ({ tempFilePath: `wxfile://${i}.png` }))
    }
    const downloads = []
    const wxStub = {
      getStorageSync: () => pending,
      getAccountInfoSync: () => ({ miniProgram: { envVersion: 'release' } }),
      setKeepScreenOn() {},
      // ⑪ 原图是云端地址时先下载；地址里带 fail 的模拟下载失败
      downloadFile({ url, success, fail }) {
        downloads.push(url)
        if (/fail/.test(url)) fail({ errMsg: 'downloadFile:fail' })
        else success({ statusCode: 200, tempFilePath: `wxfile://dl-${url.split('/').at(-1)}` })
      }
    }
    vm.runInNewContext(fs.readFileSync(path.join(root, 'subpackages/projection/wifi-result/wifi-result.js'), 'utf8'), {
      require: target => modules[target.split('/').at(-1)],
      Page: value => { definition = value },
      wx: wxStub,
      console: { log() {}, warn() {} }
    }, { filename: 'wifi-result.js' })
    const page = { ...definition, data: plain(definition.data), setData(values) { Object.keys(values).forEach(key => {
      const m = /^items\[(\d+)\]$/.exec(key)
      if (m) this.data.items[Number(m[1])] = values[key]
      else this.data[key] = values[key]
    }) } }
    failIndex.value = 2 // 第三张（本轮最后一张）失败
    page.onLoad()
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.deepEqual(calls.plays.map(item => item.refresh), [false, false, true], '前 N-1 张只上传，最后一张刷屏')
    assert.deepEqual(calls.records.map(item => item.imgBle), ['https://oss/0.bin', 'https://oss/1.bin'], '成功的每张都拿 binUrl 写相册记录')
    assert.equal(calls.records[0].userProductId, '7')
    assert.deepEqual(page.data.items.map(item => item.status), ['UPLOADED', 'UPLOADED', 'FAILED'])
    assert.equal(page.data.items[1].text, '已上传（未存入我的上传）', '写记录失败只注明，不算投屏失败')
    assert.equal(page.data.successCount, 2)
    assert.equal(page.data.retryable, true)
    assert.equal(page.data.stageText, '成功 2 张，1 张未成功')
    // 投屏步骤（2026-11-12）：第三张在「图片处理中」失败 → 前两步勾、第 3 步打叉、第 4 步不执行
    const stepStatuses = target => target.data.steps.map(step => step.status)
    assert.deepEqual(page.data.steps.map(step => step.text), ['准备投屏', '图片上传中', '图片处理中', '已发送，屏幕即将刷新'], '四步对应进度文案')
    assert.deepEqual(stepStatuses(page), ['done', 'done', 'fail', 'pending'], '失败在当时那一步打叉')
    assert.equal(page.data.items[2].failStep, 2)
    assert.equal(/正在存入我的上传/.test(fs.readFileSync(path.join(root, 'subpackages/projection/wifi-result/wifi-result.js'), 'utf8')), false, '写相册记录时不改文案')
    failIndex.value = -1
    page.retryFailed()
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.deepEqual(calls.plays.slice(3).map(item => [item.file, item.refresh]), [['wxfile://3.png', true]], '重试只投没成功的，本轮最后一张刷屏')
    assert.equal(new Set(calls.plays.slice(0, 3).map(item => item.key)).size, 3, '幂等键：一张图一个')
    assert.equal(calls.plays[3].key, calls.plays[2].key, '幂等键：「重试未成功的」同一张、同样刷屏方式复用原键')
    assert.equal(page.data.items[2].status, 'SENT')
    assert.equal(page.data.stageText, '已发送 3 张，屏幕即将刷新')
    assert.deepEqual(stepStatuses(page), ['done', 'done', 'done', 'done'], '全部成功四步全勾')
    assert.equal(page.data.retryable, false)
    assert.ok(calls.plays.every(item => item.addToCarousel === false), '没勾同时加入轮播：都不带')
    assert.equal(page.data.carouselTip, '')
    assert.ok(calls.plays.every(item => item.renderMode === 'fpga16'), '每张都带产品的 renderMode（含重试）')
    assert.equal(calls.renderModeLookups, 1, '渲染模式一次进页面只查一次，重试复用')
    assert.ok(calls.plays.every(item => item.type === '1'), 'type 取产品屏幕方向 screenType，不按分辨率（2026-10-28）')
    assert.equal(calls.screenTypeLookups, 1, '屏幕方向一次进页面只查一次，重试复用')
    checked('结果页：最后一张刷屏、写相册记录、重试')

    // 勾了「同时加入轮播」：每张都带；第二张没加进去 → 结束后追加提示
    calls.plays.length = 0
    calls.records.length = 0
    pending.addToCarousel = true
    carouselFailIndex.value = 1
    const page2 = { ...definition, data: plain(definition.data), setData: page.setData }
    page2.onLoad()
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.deepEqual(calls.plays.map(item => [item.refresh, item.addToCarousel]), [[false, true], [false, true], [true, true]], '每张都带 addToCarousel，与 refresh 独立')
    assert.equal(calls.records.length, 3, '相册记录照常写')
    assert.equal(page2.data.carouselTip, '未成功加入轮播，请前往轮播设置添加')
    calls.plays.length = 0
    carouselFailIndex.value = -1
    const page3 = { ...definition, data: plain(definition.data), setData: page.setData }
    page3.onLoad()
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(page3.data.carouselTip, '', 'carouselUpdated=true 不额外提示')
    const resultTpl = fs.readFileSync(path.join(root, 'subpackages/projection/wifi-result/wifi-result.wxml'), 'utf8')
    assert.ok(/wx:if="\{\{phase === 'done' && carouselTip\}\}"/.test(resultTpl), '结果下方追加一行')
    checked('结果页：同时加入轮播，未加入时提示')

    // ⑫ 幂等键：新进入本页是新操作，全部新键；中间那张（原本只上传）失败、重试时成了本轮最后一张要刷屏 → 换新键，
    // 否则若首次其实已处理，会拿回「只上传未刷屏」的旧结果
    calls.plays.length = 0
    pending.addToCarousel = false
    failIndex.value = 1
    const pageKeys = { ...definition, data: plain(definition.data), setData: page.setData }
    pageKeys.onLoad()
    await new Promise(resolve => setTimeout(resolve, 20))
    const firstKeys = calls.plays.map(item => item.key)
    assert.ok(firstKeys.length === 3 && firstKeys.every(key => /^key-\d+$/.test(key)), '每张都带键')
    assert.equal(pageKeys.data.items[1].status, 'FAILED')
    failIndex.value = -1
    pageKeys.retryFailed()
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.deepEqual(calls.plays.slice(3).map(item => [item.file, item.refresh]), [['wxfile://2.png', true]])
    assert.notEqual(calls.plays[3].key, firstKeys[1], '刷屏方式变了：换新键')
    assert.ok(!firstKeys.includes(calls.plays[3].key))
    checked('结果页：幂等键按「图 + 刷屏方式」复用，新操作新键')

    // ⑪ 相册记录存原图：投屏仍用转过的成品，记录 img 用 _origSrc（本地直用 / 云端下载 / 下载失败退回投屏图）
    calls.plays.length = 0
    calls.records.length = 0
    pending.addToCarousel = false
    pending.images = [
      { tempFilePath: 'wxfile://baked-1.png', _origSrc: 'wxfile://orig-1.jpg' },
      { tempFilePath: 'wxfile://baked-2.png', _origSrc: 'https://img/orig-2.jpg' },
      { tempFilePath: 'wxfile://baked-3.png', _origSrc: 'https://img/fail-3.jpg' },
      { tempFilePath: 'wxfile://raw-4.png' }
    ]
    const page4 = { ...definition, data: plain(definition.data), setData: page.setData }
    page4.onLoad()
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.deepEqual(calls.plays.map(item => item.file), ['wxfile://baked-1.png', 'wxfile://baked-2.png', 'wxfile://baked-3.png', 'wxfile://raw-4.png'], '投屏仍用预览页导出（已按设备旋转角转过）的图')
    assert.deepEqual(calls.records.map(item => item.filePath), ['wxfile://orig-1.jpg', 'wxfile://dl-orig-2.jpg', 'wxfile://baked-3.png', 'wxfile://raw-4.png'], '记录 img 用原图：本地直用、云端先下载、下载失败或无备份退回投屏图')
    assert.deepEqual(downloads, ['https://img/orig-2.jpg', 'https://img/fail-3.jpg'])
    // 逐张列表缩略图同样用原图（2026-11-06：投屏图转过 180° 时缩略图是倒的）
    assert.deepEqual(page4.data.items.map(item => item.src), ['wxfile://orig-1.jpg', 'https://img/orig-2.jpg', 'https://img/fail-3.jpg', 'wxfile://raw-4.png'], '缩略图用原图，与「我的上传」同方位')
    assert.deepEqual(calls.records.map(item => item.imgBle), ['https://oss/0.bin', 'https://oss/1.bin', 'https://oss/2.bin', 'https://oss/3.bin'], 'imgBle 仍是本次投屏的 binUrl')

    // 原图长边大于设备长边才缩（与蓝牙版 compressForUpload 同口径：不改比例、质量 90）
    const compressCalls = []
    wxStub.getImageInfo = ({ src, success }) => success(src === 'wxfile://orig-1.jpg' ? { width: 3000, height: 4000 } : { width: 480, height: 720 })
    wxStub.compressImage = opts => { compressCalls.push(plain({ src: opts.src, quality: opts.quality, w: opts.compressedWidth, h: opts.compressedHeight })); opts.success({ tempFilePath: `wxfile://small-${compressCalls.length}.jpg` }) }
    calls.plays.length = 0
    calls.records.length = 0
    pending.device = Object.assign({}, pending.device, { width: 480, height: 720 })
    pending.images = [
      { tempFilePath: 'wxfile://baked-1.png', _origSrc: 'wxfile://orig-1.jpg' },
      { tempFilePath: 'wxfile://baked-5.png', _origSrc: 'wxfile://orig-5.jpg' }
    ]
    const page5 = { ...definition, data: plain(definition.data), setData: page.setData }
    page5.onLoad()
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.deepEqual(compressCalls, [{ src: 'wxfile://orig-1.jpg', quality: 90, w: 540, h: 720 }], '只缩超过设备长边的原图，按比例缩到 720')
    assert.deepEqual(calls.records.map(item => item.filePath), ['wxfile://small-1.jpg', 'wxfile://orig-5.jpg'], '不大于设备长边的原样上传')
    delete wxStub.getImageInfo
    delete wxStub.compressImage
    const resultSrc = fs.readFileSync(path.join(root, 'subpackages/projection/wifi-result/wifi-result.js'), 'utf8')
    assert.ok(/this\.saveAlbumRecord\(this\.images\[index\], filePath, result\.binUrl\)/.test(resultSrc), '写记录时带上本张 image（取 _origSrc）')
    // 逐张文案跟进度条阶段走（2026-11-06）：「图片上传中 / 图片处理中」对应「上传中 / 处理中」，不再叫「投屏中」
    assert.equal(/text: '投屏中'/.test(resultSrc), false, '进行中不再叫投屏中')
    assert.ok(/itemStageText\('图片上传中'\)/.test(resultSrc) && /setItem\(index, \{ text: itemStageText\(text\) \}\)/.test(resultSrc), '列表文案跟阶段')
    checked('结果页：相册记录存原图，不存按设备旋转角转过的投屏图；列表缩略图原图、文案跟阶段')
  }
  {
    // 2026-11-12 起去掉页面下方的黑底投屏日志面板（原「开发版 / 体验版显示、可复制」），过程只打控制台，
    // 开发版 / 体验版用左下角「日志」浮窗看；排查横竖向用的设备宽高与旋转字段照记
    const tpl = fs.readFileSync(path.join(root, 'subpackages/projection/wifi-result/wifi-result.wxml'), 'utf8')
    assert.equal(/projection-log|copyLogs|showLog/.test(tpl), false, '页面上不再有投屏日志面板')
    const page = fs.readFileSync(path.join(root, 'subpackages/projection/wifi-result/wifi-result.js'), 'utf8')
    assert.equal(/onLog: text => this\.appendLog|setClipboardData|logAnchor/.test(page), false, '不再往页面写日志、不再复制')
    assert.ok(/console\.log\('\[WiFi投屏\]', text\)/.test(page), '页面日志改打控制台')
    assert.ok(/接口宽高 \$\{d\.width/.test(page) && /verticalRotation/.test(page), '记设备宽高与旋转字段（排查横竖向）')
    const css = fs.readFileSync(path.join(root, 'subpackages/projection/wifi-result/wifi-result.wxss'), 'utf8')
    assert.equal(/\.projection-log/.test(css), false, '日志面板样式一并删掉')
    assert.ok(/\.wifi-result-row\.is-SENT/.test(css) && /\.wifi-result-row\.is-UPLOADED/.test(css), 'SENT / UPLOADED 按成功配色')
    checked('结果页：去掉黑底投屏日志面板，日志只打控制台')
  }
  {
    // 2026-11-12：投屏步骤卡，样式与交互同配网状态页（白圈序号 / 转圈 / 勾 / 叉）
    const tpl = fs.readFileSync(path.join(root, 'subpackages/projection/wifi-result/wifi-result.wxml'), 'utf8')
    assert.ok(/<view wx:if="\{\{total <= 1\}\}" class="cast-steps glass-panel">/.test(tpl), '步骤卡只在单张投屏显示，批量不显示（2026-11-13）')
    assert.ok(/class="cast-steps glass-panel">\s*<view wx:for="\{\{steps\}\}" wx:key="key" class="cast-step is-\{\{item\.status\}\}">/.test(tpl), '四步按 steps 渲染')
    assert.ok(/item\.status === 'loading'[^>]*class="step-icon__spinner"/.test(tpl) && /class="step-icon__no">\{\{index \+ 1\}\}</.test(tpl), '进行中转圈、未开始显示序号')
    const css = fs.readFileSync(path.join(root, 'subpackages/projection/wifi-result/wifi-result.wxss'), 'utf8')
    assert.ok(/\.cast-step \{[^}]*height: 96rpx;/.test(css), '行高同配网页 96rpx')
    assert.ok(/\.cast-step\.is-done \.step-icon \{\s*background: linear-gradient\(135deg, #ff8338, #ff621f\);/.test(css), '通过：橙色实心勾')
    assert.ok(/\.cast-step\.is-fail \.step-icon \{\s*background: #e5533d;/.test(css), '失败：红色实心叉')
    assert.ok(/animation: castStepSpin 0\.8s linear infinite;/.test(css) && /@keyframes castStepSpin/.test(css), '转圈动画')
    checked('结果页：投屏步骤卡同配网步骤样式')
  }
  {
    // 2026-11-06：逐张列表最多露 4 行，多出的框内上下滑动；当前那张自动滚到
    const tpl = fs.readFileSync(path.join(root, 'subpackages/projection/wifi-result/wifi-result.wxml'), 'utf8')
    assert.ok(/class="wifi-result-list glass-panel">\s*<scroll-view scroll-y[^>]*class="wifi-result-list__scroll"[^>]*scroll-into-view="\{\{listAnchor\}\}"/.test(tpl), '列表行包在 scroll-view 里，跟 listAnchor')
    assert.ok(/id="wifi-row-\{\{index\}\}" class="wifi-result-row/.test(tpl), '行带锚点 id')
    const css = fs.readFileSync(path.join(root, 'subpackages/projection/wifi-result/wifi-result.wxss'), 'utf8')
    assert.ok(/\.wifi-result-list__scroll \{\s*max-height: 384rpx;/.test(css), '最多 4 行（4 × 96rpx）')
    assert.ok(/\.wifi-result-row \{[^}]*height: 96rpx;/.test(css), '行高仍为 96rpx（与 384rpx 对应）')
    const page = fs.readFileSync(path.join(root, 'subpackages/projection/wifi-result/wifi-result.js'), 'utf8')
    assert.ok(/this\.setData\(\{ current: index, progress: 0, stageText: '图片上传中', listAnchor: `wifi-row-\$\{index\}` \}\)/.test(page), '每张开始时滚到那一行')
    checked('结果页：逐张列表最多 4 行可滑动')
  }
  console.log(`wifi-projection: ${checks} groups passed`)
}
main().catch(error => { console.error(error); process.exitCode = 1 })
