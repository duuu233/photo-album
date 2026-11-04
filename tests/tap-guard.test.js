// 防重复点击（utils/tap-guard.js，2026-11-04）：执行中忽略、执行完冷却、不同 key / 页面互不影响、异常也放锁、挂住兜底；
// 以及所有「投屏」相关按钮都已接入、调用链 return 到底（锁才能覆盖到进预览页为止）。
// 运行：node tests/tap-guard.test.js
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const tapGuard = require('../utils/tap-guard')

const root = path.join(__dirname, '..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')

let checks = 0
function checked(name) { checks++; console.log('PASS ' + name) }

const realNow = Date.now
let clock = 1000000
Date.now = () => clock

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

async function main() {
  {
    const page = {}
    let calls = 0
    const pending = deferred()
    const first = tapGuard.run(page, 'projection', () => { calls++; return pending.promise })
    assert.equal(calls, 1, '第一次照常执行，同步部分立即执行')
    assert.equal(await tapGuard.run(page, 'projection', () => { calls++ }), undefined)
    assert.equal(calls, 1, '执行中（如连接设备、选图）再点被忽略')
    assert.equal(tapGuard.isLocked(page, 'projection'), true)
    tapGuard.run(page, 'pick', () => { calls++ })
    assert.equal(calls, 2, '不同 key 互不影响')
    tapGuard.run({}, 'projection', () => { calls++ })
    assert.equal(calls, 3, '不同页面实例互不影响')
    pending.resolve('done')
    assert.equal(await first, 'done', '返回原方法的结果')
    tapGuard.run(page, 'projection', () => { calls++ })
    assert.equal(calls, 3, '刚结束仍在冷却（挡跳转转场期间的连点）')
    clock += tapGuard.COOLDOWN_MS
    tapGuard.run(page, 'projection', () => { calls++ })
    assert.equal(calls, 4, '冷却过后可以再点')
    checked('执行中忽略、执行完冷却')
  }
  {
    const page = {}
    assert.throws(() => tapGuard.run(page, 'k', () => { throw new Error('sync') }), /sync/, '同步异常照常抛出')
    clock += tapGuard.COOLDOWN_MS
    let ran = false
    tapGuard.run(page, 'k', () => { ran = true })
    assert.equal(ran, true, '同步异常后放锁')
    clock += tapGuard.COOLDOWN_MS
    await assert.rejects(tapGuard.run(page, 'k', () => Promise.reject(new Error('async'))), /async/)
    clock += tapGuard.COOLDOWN_MS
    ran = false
    tapGuard.run(page, 'k', () => { ran = true })
    assert.equal(ran, true, '异步失败后放锁')
    checked('异常也放锁')
  }
  {
    const page = {}
    tapGuard.run(page, 'k', () => new Promise(() => {}))
    let ran = false
    clock += tapGuard.MAX_HOLD_MS - 1
    tapGuard.run(page, 'k', () => { ran = true })
    assert.equal(ran, false)
    clock += 1
    tapGuard.run(page, 'k', () => { ran = true })
    assert.equal(ran, true, '挂住超过上限不再拦，按钮不会永久失灵')
    checked('挂住兜底')
  }
  {
    const definition = {
      data: {},
      async start(e) { this.seen = e; return 'ok' },
      other() {}
    }
    assert.equal(tapGuard.wrap(definition, { start: 'projection' }), definition)
    const page = Object.create(definition)
    assert.equal(await page.start('evt'), 'ok', '带锁版本保留 this / 参数 / 返回值')
    assert.equal(page.seen, 'evt')
    assert.throws(() => tapGuard.wrap({}, { startt: 'projection' }), /startt/, '方法名写错直接报错')
    checked('wrap')
  }
  {
    // 所有「投屏」相关按钮：页面注册处的锁表
    const expect = {
      'pages/home/home.js': "{ tapCameraEntry: 'projection', tapAlbumEntry: 'projection' }",
      'subpackages/device/list/list.js': "{ startProjection: 'projection', startWifiProjection: 'projection', chooseCamera: 'pick', chooseAlbum: 'pick' }",
      'subpackages/device/detail/detail.js': "{ startProjection: 'projection', chooseCamera: 'pick', chooseAlbum: 'pick' }",
      'subpackages/device/wifi-detail/wifi-detail.js': "{ startProjection: 'projection', chooseCamera: 'pick', chooseAlbum: 'pick' }",
      'subpackages/gallery/detail/detail.js': "{ onProject: 'projection', onDevicePickerConfirm: 'projection' }",
      'subpackages/ai/chat/chat.js': "{ projectImage: 'projection', onDevicePickerConfirm: 'projection' }",
      'subpackages/album/list/list.js': "{ retryProjection: 'projection' }",
      'subpackages/projection/records/records.js': "{ retryProjection: 'projection' }",
      'subpackages/projection/result/result.js': "{ continueProjection: 'projection', retry: 'projection', chooseCamera: 'pick', chooseAlbum: 'pick' }",
      'subpackages/projection/wifi-result/wifi-result.js': "{ retryFailed: 'projection' }",
      'subpackages/projection/preview/preview.js': "{ confirmProjection: 'projection' }"
    }
    Object.keys(expect).forEach(file => {
      const source = read(file)
      assert.ok(/require\('(\.\.\/)+utils\/tap-guard'\)/.test(source), `${file} 引入 tap-guard`)
      assert.ok(source.indexOf('tapGuard.wrap(') > -1 && source.indexOf(expect[file] + ')') > -1, `${file} 锁表`)
    })
    // 调用链要 return 到底，否则锁在选图 / 连接 / 下载完成前就放开了
    const home = read('pages/home/home.js')
    assert.ok(/return this\.chooseCamera\(\)/.test(home) && /return this\.chooseAlbum\(\)/.test(home), '首页拍照 / 相册入口等选图结束')
    ;['subpackages/device/list/list.js', 'subpackages/device/detail/detail.js', 'subpackages/device/wifi-detail/wifi-detail.js'].forEach(file => {
      const source = read(file)
      assert.ok(/chooseCamera\(\) \{\n    return this\.pickAndProject\(/.test(source) && /chooseAlbum\(\) \{\n    return this\.pickAndProject\(/.test(source), `${file} 选图等到进预览`)
    })
    const result = read('subpackages/projection/result/result.js')
    assert.ok(/chooseCamera\(\) \{\n    return this\.pickAndContinue\(/.test(result) && /chooseAlbum\(\) \{\n    return this\.pickAndContinue\(/.test(result))
    const gallery = read('subpackages/gallery/detail/detail.js')
    assert.equal((gallery.match(/return this\.startProjection\(device\)/g) || []).length, 2, '官方图库：已连接直投与弹层确认都等投屏流程结束')
    const chat = read('subpackages/ai/chat/chat.js')
    assert.ok(/return this\.startProjection\(device, url\)/.test(chat) && /return this\.startProjection\(device, this\._pendingProjectImage\)/.test(chat))
    assert.equal((chat.match(/return this\.openProjectionPreview\(/g) || []).length, 2, 'AI 对话：连接 / 下载完成前不放锁')
    checked('投屏相关按钮全部接入')
  }
  Date.now = realNow
  console.log(`tap-guard: ${checks} groups passed`)
}
main().catch(error => { Date.now = realNow; console.error(error); process.exitCode = 1 })
