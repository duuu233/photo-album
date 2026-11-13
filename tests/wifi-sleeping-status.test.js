// WiFi 版休眠状态（2026-10-27，docs/wifi/休眠状态对接说明.md）utils/wifi-status：
//   ① status=ONLINE / SLEEPING / OFFLINE 映射为 online / sleeping / offline，缺 status 按 online 回退
//      （不认识的值 2026-10-29 起按状态未知降级）；
//   ② 卡片字段：休眠中显示「休眠中」，电量 / 信号同离线不显示；
//   ③ 投屏入口 ensureOnline：休眠中提示「设备休眠中，唤醒后可操作」并拦下，离线仍是离线提示，查不到放行；
//   ④ 各页模板 / 样式：休眠中有单独的蓝色，详情页与我的设备卡的投屏入口按 blockedTip 拦。
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const root = path.join(__dirname, '..')

let checks = 0
function checked(name) { checks++; console.log('PASS ' + name) }

// battery → device-ble 加载时会碰 wx：给个空壳
global.wx = new Proxy({}, { get: () => () => {} })
const toasts = []
const stubModule = (request, exports) => {
  const filename = require.resolve(request)
  require.cache[filename] = { id: filename, filename, loaded: true, children: [], paths: [], exports }
}
let onlineReply = null
let infoReply = null
stubModule('../utils/iot-api', {
  getDeviceInfo: async () => { if (infoReply instanceof Error) throw infoReply; return infoReply },
  getDeviceOnline: async () => { if (onlineReply instanceof Error) throw onlineReply; return onlineReply }
})
stubModule('../utils/toast', { show: options => toasts.push(options.title) })
const wifiStatus = require('../utils/wifi-status')

async function main() {
  {
    const s = wifiStatus.deviceState
    assert.equal(s({ online: true, status: 'ONLINE' }), 'online')
    assert.equal(s({ online: false, status: 'SLEEPING' }), 'sleeping')
    assert.equal(s({ online: false, status: 'OFFLINE' }), 'offline')
    assert.equal(s({ online: false, status: 'sleeping' }), 'sleeping', '大小写容错')
    assert.equal(s({ online: true }), 'online', '缺 status 按 online 回退')
    assert.equal(s({ online: false }), 'offline')
    // 2026-10-29 起改口径（docs/wifi/前端对接20261029.md 一.4：未识别的新枚举值按「未知状态」降级）：
    // 原先按 online 回退，现在 status 有值但不认识 → unknown；缺 status 仍按 online 回退（上面两条）
    assert.equal(s({ online: true, status: 'WHATEVER' }), 'unknown', '不认识的值按状态未知降级')
    assert.equal(s(null), 'offline')
    checked('status 映射与按 online 回退')
  }
  {
    infoReply = { online: false, status: 'SLEEPING', shadow: { battery: 85, wifiRssi: -50 } }
    const sleeping = await wifiStatus.fetchFields({ productDeviceId: 'D0:CF:13:F0:2F:F8' })
    assert.equal(sleeping.wifiStatus, 'sleeping')
    assert.equal(sleeping.wifiStatusText, '休眠中')
    assert.equal(sleeping.wifiBatteryText, '', '休眠中不显示电量（同离线）')
    assert.equal(sleeping.wifiSignalLevel, 0)
    infoReply = { online: true, shadow: { battery: 85, wifiRssi: -50 } }
    const legacy = await wifiStatus.fetchFields({ productDeviceId: 'D0CF13F02FF8' })
    assert.equal(legacy.wifiStatus, 'online', '旧服务端无 status 仍是在线')
    assert.equal(legacy.wifiBatteryText, '85%')
    checked('卡片字段：休眠中')
  }
  {
    toasts.length = 0
    onlineReply = { online: false, status: 'SLEEPING' }
    assert.equal(await wifiStatus.ensureOnline({ productDeviceId: 'X' }), false)
    assert.deepEqual(toasts, ['设备休眠中，唤醒后可操作'], '休眠中不提示检查网络')
    toasts.length = 0
    onlineReply = { online: false, status: 'OFFLINE' }
    assert.equal(await wifiStatus.ensureOnline({ productDeviceId: 'X' }), false)
    assert.deepEqual(toasts, ['设备已离线，请检查设备网络'])
    toasts.length = 0
    onlineReply = { online: false }
    assert.equal(await wifiStatus.ensureOnline({ productDeviceId: 'X' }), false, '缺 status 的离线照旧拦')
    onlineReply = { online: true, status: 'ONLINE' }
    assert.equal(await wifiStatus.ensureOnline({ productDeviceId: 'X' }), true)
    onlineReply = new Error('503')
    assert.equal(await wifiStatus.ensureOnline({ productDeviceId: 'X' }), true, '查不到放行')
    assert.equal(wifiStatus.blockedTip('unknown'), '')
    assert.equal(wifiStatus.blockedTip('online'), '')
    checked('投屏入口：休眠中拦下并提示')
  }
  {
    const read = file => fs.readFileSync(path.join(root, file), 'utf8')
    assert.ok(/\.device-status\.wifi-status\.is-sleeping\s*\{/.test(read('pages/home/home.wxss')), '首页卡休眠色')
    assert.ok(/\.wifi-state\.is-sleeping\s*\{/.test(read('subpackages/device/list/list.wxss')), '我的设备卡休眠色')
    assert.ok(/\.wifi-detail-state\.is-sleeping\s*\{/.test(read('subpackages/device/wifi-detail/wifi-detail.wxss')), '详情页休眠色')
    // 2026-11-14 有意改口径：入口改走 requireOnline（内部先按 blockedTip 拦已知不可操作的状态，状态未知再现查、只放行在线），
    // 原「按 blockedTip 拦」的判据随之挪到 requireOnline 上，见下面「点击入口要在线」一组
    assert.ok(/wifiStatus\.requireOnline\(device, device\.wifiStatus\)/.test(read('subpackages/device/list/list.js')), '我的设备投屏按已知状态拦')
    const detail = read('subpackages/device/wifi-detail/wifi-detail.js')
    assert.ok(/wifiStatus\.requireOnline\(this\.data\.device, this\.data\.status\)/.test(detail), '详情页投屏按已知状态拦')
    assert.ok(/wifiStatus\.deviceState\(info\)/.test(detail), '详情页状态走同一套映射')
    // 配网第 4 步只认 online=true，SLEEPING 不算成功
    assert.ok(/if \(res && res\.online\)/.test(read('utils/wifi-provision.js')), '配网轮询只认 online')
    checked('各页样式与入口')
  }
  {
    // V1.4 更新说明三：设备主动关机 → status=SHUTDOWN，灰色「已关机」，入口提示开机后可操作
    assert.equal(wifiStatus.deviceState({ online: false, status: 'SHUTDOWN' }), 'shutdown')
    assert.equal(wifiStatus.deviceState({ online: false, status: 'shutdown' }), 'shutdown', '大小写容错')
    infoReply = { online: false, status: 'SHUTDOWN', shadow: { battery: 85, wifiRssi: -50 } }
    const fields = await wifiStatus.fetchFields({ productDeviceId: 'D0CF13F02FF8' })
    assert.equal(fields.wifiStatus, 'shutdown')
    assert.equal(fields.wifiStatusText, '已关机')
    assert.equal(fields.wifiBatteryText, '', '已关机不显示电量')
    assert.equal(fields.wifiSignalLevel, 0)
    toasts.length = 0
    onlineReply = { online: false, status: 'SHUTDOWN' }
    assert.equal(await wifiStatus.ensureOnline({ productDeviceId: 'X' }), false)
    assert.deepEqual(toasts, ['设备已关机，开机后可操作'])
    assert.equal(wifiStatus.blockedTip('shutdown'), '设备已关机，开机后可操作')
    const read = file => fs.readFileSync(path.join(root, file), 'utf8')
    assert.ok(/\.is-shutdown \.meta-wifi-icon/.test(read('subpackages/device/list/list.wxss')), '我的设备卡已关机图标变灰')
    checked('已关机 SHUTDOWN')
  }
  {
    // 点击入口要在线（2026-11-14 产品要求）：WiFi 版投屏、轮播设置、固件升级、优雅刷新升级点击时只放行在线
    toasts.length = 0
    let calls = 0
    onlineReply = { online: true, status: 'ONLINE' }
    const counting = { productDeviceId: 'X' }
    const origin = require('../utils/iot-api').getDeviceOnline
    require('../utils/iot-api').getDeviceOnline = async (...args) => { calls++; return origin(...args) }
    assert.equal(await wifiStatus.requireOnline(counting, 'offline'), false, '已知离线直接拦')
    assert.equal(await wifiStatus.requireOnline(counting, 'local'), false, '本地模式拦')
    assert.equal(await wifiStatus.requireOnline(counting, 'sleeping'), false)
    assert.equal(await wifiStatus.requireOnline(counting, 'shutdown'), false)
    assert.deepEqual(toasts, [wifiStatus.OFFLINE_TIP, wifiStatus.LOCAL_TIP, wifiStatus.SLEEPING_TIP, wifiStatus.SHUTDOWN_TIP])
    assert.equal(calls, 0, '已知不可操作不发请求')
    assert.equal(await wifiStatus.requireOnline(counting, 'online'), true, '已知在线直接放行')
    assert.equal(calls, 0)
    assert.equal(await wifiStatus.requireOnline(counting, 'online', { fresh: true }), true, 'fresh：现查在线放行')
    assert.equal(calls, 1, 'fresh 时现查一次')
    toasts.length = 0
    onlineReply = { online: false, status: 'OFFLINE' }
    assert.equal(await wifiStatus.requireOnline(counting, 'online', { fresh: true }), false, 'fresh：现查离线拦下')
    assert.deepEqual(toasts, [wifiStatus.OFFLINE_TIP])
    toasts.length = 0
    onlineReply = new Error('503')
    assert.equal(await wifiStatus.requireOnline(counting, 'unknown'), false, '状态未知现查也查不到：拦下')
    assert.deepEqual(toasts, [wifiStatus.NOT_ONLINE_TIP])
    onlineReply = { online: true, status: 'ONLINE' }
    assert.equal(await wifiStatus.requireOnline(counting, 'loading'), true, '查询中现查在线放行')
    require('../utils/iot-api').getDeviceOnline = origin

    const read = file => fs.readFileSync(path.join(root, file), 'utf8')
    const detail = read('subpackages/device/wifi-detail/wifi-detail.js')
    assert.ok(/async openOta\(\) \{\s*if \(!this\.data\.device \|\| !\(await wifiStatus\.requireOnline\(this\.data\.device, this\.data\.status, \{ fresh: true \}\)\)\)/.test(detail), '固件升级：点击现查在线')
    assert.ok(/async openSlideshow\(\) \{\s*if \(!this\.data\.device \|\| !\(await wifiStatus\.requireOnline\(this\.data\.device, this\.data\.status\)\)\)/.test(detail), '轮播设置：点击要在线')
    assert.ok(/async startProjection\(\) \{\s*if \(!this\.data\.device \|\| !\(await wifiStatus\.requireOnline\(/.test(detail), '投屏：点击要在线')
    assert.ok(/async openFpga\(\) \{\s*if \(!this\._device \|\| !\(await wifiStatus\.requireOnline\(this\._device, this\._state, \{ fresh: true \}\)\)\)/.test(read('subpackages/device/wifi-info/wifi-info.js')), '优雅刷新升级：点击现查在线')
    assert.ok(/async continueProjection\(\) \{\s*if \(!this\.device \|\| !\(await wifiStatus\.requireOnline\(this\.device, '', \{ fresh: true \}\)\)\)/.test(read('subpackages/projection/wifi-result/wifi-result.js')), '结果页继续投屏：点击现查在线')
    assert.ok(/wifiStatus\.requireOnline\(current, '', \{ fresh: true \}\)/.test(read('pages/home/home.js')), '首页拍照 / 相册（WiFi 版）：点击现查在线')
    assert.ok(/status !== 'online'/.test(read('subpackages/device/wifi-tf/wifi-tf.js')), 'TF卡切换：开启前现查只放行在线（原有）')
    for (const fn of ['clearCopies', 'showUnbindConfirm', 'showDeleteConfirm']) {
      const body = detail.slice(detail.indexOf(`  ${fn}() {`), detail.indexOf('\n  },', detail.indexOf(`  ${fn}() {`)))
      assert.ok(body.length > 0 && !/requireOnline|blockedTip/.test(body), `${fn}：不判断在线`)
    }
    checked('点击入口要在线')
  }
  console.log(`wifi-sleeping-status: ${checks} groups passed`)
}
main().catch(error => { console.error(error); process.exitCode = 1 })
