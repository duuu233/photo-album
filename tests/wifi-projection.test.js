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
      ;[30, 100].forEach(p => opts.onProgress(p))
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
    console: { log() {}, warn() {} }
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
    const { run, log } = setup()
    const result = await run()
    assert.equal(result.status, 'SENT')
    assert.equal(result.message, '已发送，屏幕即将刷新')
    assert.equal(result.msgid, 'm1')
    assert.equal(result.binUrl, 'https://oss/a.bin', '带回 binUrl 供写相册记录')
    assert.deepEqual(plain(log.plays[0]), { deviceNo: 'E348C21ED428', filePath: 'wxfile://a.png', type: '1', showError: false, refresh: true }, 'deviceNo 去冒号、type 原样、静默、默认刷屏')
    const order = log.stages.map(item => item.split(':')[0]).filter((item, i, all) => item !== all[i - 1])
    assert.deepEqual(order, ['UPLOADING', 'PROCESSING', 'SENT'], `阶段顺序：${order}`)
    assert.ok(log.stages.includes('UPLOADING:30'), '上传进度真实透出')
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
  }
  {
    // 结果页：按真实源码装配，projectOne / 写相册记录用桩
    let definition
    const calls = { plays: [], records: [], renderModeLookups: 0, screenTypeLookups: 0 }
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
      'fold-adapt': { adapt: value => value },
      dithering: { typeForDevice: () => '0' },
      'wifi-projection': {
        projectOne: async opts => {
          const n = calls.plays.length
          calls.plays.push({ file: opts.filePath, type: opts.type, refresh: opts.refresh, addToCarousel: opts.addToCarousel, renderMode: opts.renderMode })
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
    vm.runInNewContext(fs.readFileSync(path.join(root, 'subpackages/projection/wifi-result/wifi-result.js'), 'utf8'), {
      require: target => modules[target.split('/').at(-1)],
      Page: value => { definition = value },
      wx: {
        getStorageSync: () => pending,
        getAccountInfoSync: () => ({ miniProgram: { envVersion: 'release' } }),
        setKeepScreenOn() {}
      },
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
    failIndex.value = -1
    page.retryFailed()
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.deepEqual(calls.plays.slice(3).map(item => [item.file, item.refresh]), [['wxfile://3.png', true]], '重试只投没成功的，本轮最后一张刷屏')
    assert.equal(page.data.items[2].status, 'SENT')
    assert.equal(page.data.stageText, '已发送 3 张，屏幕即将刷新')
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
  }
  {
    const tpl = fs.readFileSync(path.join(root, 'subpackages/projection/wifi-result/wifi-result.wxml'), 'utf8')
    assert.ok(/wx:if="\{\{showLog\}\}" class="projection-log"/.test(tpl), '日志面板按 showLog 显示')
    assert.ok(/bindtap="copyLogs"/.test(tpl), '可复制')
    const page = fs.readFileSync(path.join(root, 'subpackages/projection/wifi-result/wifi-result.js'), 'utf8')
    assert.ok(/envVersion !== 'release'/.test(page), '正式版不显示')
    assert.ok(/onLog: text => this\.appendLog\(text\)/.test(page), '投屏过程接进页面日志')
    assert.ok(/接口宽高 \$\{d\.width/.test(page) && /verticalRotation/.test(page), '记设备宽高与旋转字段（排查横竖向）')
    const css = fs.readFileSync(path.join(root, 'subpackages/projection/wifi-result/wifi-result.wxss'), 'utf8')
    assert.ok(/\.wifi-result-row\.is-SENT/.test(css) && /\.wifi-result-row\.is-UPLOADED/.test(css), 'SENT / UPLOADED 按成功配色')
    checked('结果页：开发版 / 体验版日志面板，可复制')
  }
  console.log(`wifi-projection: ${checks} groups passed`)
}
main().catch(error => { console.error(error); process.exitCode = 1 })
