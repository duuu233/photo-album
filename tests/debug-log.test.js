// 联调日志浮窗（2026-10-27）utils/debug-log + components/debug-log：
//   ① 正式版不收集；开发版 / 体验版收集，超过 500 行只留最近的；
//   ② token / 密码打码：JSON 字符串值（含逗号空格）、非字符串值、query、Bearer；普通字段不动；
//   ③ install 包装 console：原输出照旧，同时入库；warn / error 带前缀；
//   ④ 每个注册页面都放了 <debug-log>（preview-demo 复用 preview 模板），组件已全局注册；
//   ⑤ 网络层记请求摘要（老服务 / IoT / WS）。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const root = path.join(__dirname, '..')

let checks = 0
function checked(name) { checks++; console.log('PASS ' + name) }

function load(envVersion, consoleImpl) {
  const sandbox = {
    module: { exports: {} },
    wx: { getAccountInfoSync: () => ({ miniProgram: { envVersion } }) },
    console: consoleImpl || { log() {}, info() {}, warn() {}, error() {} }
  }
  vm.runInNewContext(fs.readFileSync(path.join(root, 'utils/debug-log.js'), 'utf8'), sandbox, { filename: 'debug-log.js' })
  return sandbox.module.exports
}

{
  const release = load('release')
  release.add('x')
  assert.equal(release.count(), 0, '正式版不收集')
  const dev = load('trial')
  let notified = 0
  const off = dev.subscribe(() => notified++)
  for (let i = 0; i < 520; i++) dev.add('line', i)
  assert.equal(dev.count(), 500, '只留 500 行')
  assert.ok(/ line 519$/.test(dev.getLines().at(-1).text), '保留最近的，带时间前缀')
  assert.equal(notified, 520)
  off()
  dev.add('after')
  assert.equal(notified, 520, '取消订阅后不再通知')
  dev.clear()
  assert.equal(dev.count(), 0)
  checked('正式版不收集；上限 500 行；订阅 / 清空')
}
{
  const { redact } = load('develop')
  assert.equal(redact('{"host":"mqtt","usr":"dev","pwd":"a,b c\\"d"}'), '{"host":"mqtt","usr":"dev","pwd":"***"}', '密码整段打码（含逗号空格转义引号）')
  assert.equal(redact('/Client/x?userToken=abc123&lang=zh'), '/Client/x?userToken=***&lang=zh')
  assert.equal(redact('{"Authorization":"Bearer eyJ.abc","tokenBalance":12,"aiToken":"k"}'), '{"Authorization":"***","tokenBalance":12,"aiToken":"***"}', 'tokenBalance 这类普通字段不动')
  assert.equal(redact('{"pwd":12345,"x":1}'), '{"pwd":***,"x":1}')
  assert.equal(redact('Authentication: Bearer abc.def'), 'Authentication: ***')
  assert.equal(redact('{"userToken":"ut","jwtToken":"jt","nickName":"n"}'), '{"userToken":"***","jwtToken":"***","nickName":"n"}')
  const dev = load('develop')
  dev.add('登录返回', { userToken: 'secret-ut', nickName: 'n' })
  assert.equal(dev.text().indexOf('secret-ut'), -1, '入库前就打码')
  checked('token / 密码打码')
}
{
  const printed = []
  const fakeConsole = { log: (...a) => printed.push(['log', ...a]), info() {}, warn: (...a) => printed.push(['warn', ...a]), error: (...a) => printed.push(['error', ...a]) }
  const dev = load('develop', fakeConsole)
  dev.install()
  dev.install()
  fakeConsole.log('[WiFi投屏]', '开始')
  fakeConsole.warn('[WiFi状态] 查询失败', 403)
  fakeConsole.error(new Error('炸了'))
  assert.equal(printed.length, 3, '控制台照常输出，重复 install 不重复包')
  const lines = dev.getLines().map(line => line.text.slice(13))
  assert.deepEqual(lines, ['[WiFi投屏] 开始', '[warn] [WiFi状态] 查询失败 403', '[error] 炸了'])
  const releaseConsole = { log() {}, info() {}, warn() {}, error() {} }
  const original = releaseConsole.log
  load('release', releaseConsole).install()
  assert.equal(releaseConsole.log, original, '正式版不包装 console')
  checked('install 包装 console')
}
{
  const app = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'))
  assert.equal(app.usingComponents['debug-log'], '/components/debug-log/debug-log', '全局注册')
  const pages = app.pages.slice()
  app.subpackages.forEach(pkg => pkg.pages.forEach(page => pages.push(`${pkg.root}/${page}`)))
  const missing = pages.filter(page => {
    const wxml = fs.readFileSync(path.join(root, `${page}.wxml`), 'utf8')
    return !/<debug-log><\/debug-log>/.test(wxml) && !/<include src="\.\.\/preview\/preview\.wxml"/.test(wxml)
  })
  assert.deepEqual(missing, [], '每个页面都有日志浮窗')
  const appJs = fs.readFileSync(path.join(root, 'app.js'), 'utf8')
  assert.ok(appJs.indexOf('debugLog.install()') > -1 && appJs.indexOf('debugLog.install()') < appJs.indexOf("require('./utils/api')"), 'app.js 最先 install')
  const tpl = fs.readFileSync(path.join(root, 'components/debug-log/debug-log.wxml'), 'utf8')
  assert.ok(/wx:if="\{\{enabled\}\}"/.test(tpl), '正式版不渲染')
  assert.ok(/catchtap="copy"/.test(tpl) && /catchtap="clear"/.test(tpl) && /catchtap="toggle"/.test(tpl), '复制 / 清空 / 开关')
  const css = fs.readFileSync(path.join(root, 'components/debug-log/debug-log.wxss'), 'utf8')
  assert.ok(/\.debug-log-pill\s*\{[^}]*position: fixed;[^}]*left: 16rpx;/.test(css), '左下角浮动')
  checked('每个页面都有浮窗，组件全局注册')
}
{
  const read = file => fs.readFileSync(path.join(root, file), 'utf8')
  assert.ok(/debugLog\.add\(`\[HTTP\] \$\{method\} \$\{options\.url\}/.test(read('utils/request.js')), '老服务请求摘要（路径不带公共 query）')
  assert.ok(/trace\(label/.test(read('utils/iot-request.js')), 'IoT 请求摘要')
  assert.ok(/trace\('\[WS\] 收 ←'/.test(read('utils/iot-ws.js')), 'WS 推送')
  checked('网络层记请求摘要')
}
console.log(`debug-log: ${checks} groups passed`)
