// WiFi 版休眠设置（2026-10-27，docs/wifi/V1.4对接实现报告反馈.md 第二节）utils/wifi-sleep + 页面：
//   ① 回显：未设置 →「未开启休眠」、表单默认关闭；周期 / 一次性 / 关闭按接口回填与说明（周期跨午夜写「次日」）；
//   ② 提交：关闭只传 mode=0；周期两个 HH:mm 不能相同；一次性 yyyy-MM-dd HH:mm，开始早于结束、结束不能已过；只传本地时间；
//   ③ 页面已注册，WiFi 详情有「休眠设置」入口，关闭要先确认，4041 补查给离线 / 休眠提示。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const root = path.join(__dirname, '..')
const s = require('../utils/wifi-sleep')

let checks = 0
function checked(name) { checks++; console.log('PASS ' + name) }
const plain = value => JSON.parse(JSON.stringify(value))
const now = new Date(2026, 9, 27, 21, 0)

{
  assert.equal(s.summary({ configured: false }), '未开启休眠')
  assert.equal(s.summary(null), '未开启休眠')
  assert.equal(s.summary({ configured: true, mode: 2, sleepTime: '22:00', wakeTime: '07:00' }), '周期休眠：每天 22:00 ~ 次日 07:00')
  assert.equal(s.summary({ configured: true, mode: 2, sleepTime: '13:00', wakeTime: '14:00' }), '周期休眠：每天 13:00 ~ 14:00')
  assert.equal(s.summary({ configured: true, mode: 1, beginTime: '2026-10-28 22:00', endTime: '2026-10-29 07:00' }), '一次性休眠：2026-10-28 22:00 ~ 2026-10-29 07:00')
  assert.equal(s.summary({ configured: true, mode: 0 }), '已关闭休眠')
  const def = s.formFromSleep({ configured: false }, now)
  assert.equal(def.mode, 0, '从未设置：表单默认关闭')
  assert.deepEqual([def.beginDate, def.beginTime, def.endDate, def.endTime], ['2026-10-27', '22:00', '2026-10-28', '07:00'], '一次性默认今晚到明早')
  const daily = s.formFromSleep({ configured: true, mode: 2, sleepTime: '23:30', wakeTime: '06:45' }, now)
  assert.deepEqual([daily.mode, daily.sleepTime, daily.wakeTime], [2, '23:30', '06:45'])
  const once = s.formFromSleep({ configured: true, mode: 1, beginTime: '2026-11-01 20:00', endTime: '2026-11-02 08:00' }, now)
  assert.deepEqual([once.mode, once.beginDate, once.beginTime, once.endDate, once.endTime], [1, '2026-11-01', '20:00', '2026-11-02', '08:00'])
  checked('回显：说明与表单')
}
{
  assert.deepEqual(plain(s.buildPayload('D0CF13F02FF8', { mode: 0 }, now).payload), { deviceNo: 'D0CF13F02FF8', mode: 0 }, '关闭只传 mode=0')
  assert.deepEqual(plain(s.buildPayload('X', { mode: 2, sleepTime: '22:00', wakeTime: '07:00' }, now).payload), { deviceNo: 'X', mode: 2, sleepTime: '22:00', wakeTime: '07:00' })
  assert.equal(s.buildPayload('X', { mode: 2, sleepTime: '22:00', wakeTime: '22:00' }, now).error, '休眠时间和唤醒时间不能相同')
  const once = { mode: 1, beginDate: '2026-10-28', beginTime: '22:00', endDate: '2026-10-29', endTime: '07:00' }
  assert.deepEqual(plain(s.buildPayload('X', once, now).payload), { deviceNo: 'X', mode: 1, beginTime: '2026-10-28 22:00', endTime: '2026-10-29 07:00' }, '本地时间原样拼，不转 UTC')
  assert.equal(s.buildPayload('X', Object.assign({}, once, { endDate: '2026-10-28', endTime: '21:00' }), now).error, '开始时间必须早于结束时间')
  assert.equal(s.buildPayload('X', Object.assign({}, once, { beginDate: '2026-10-26', endDate: '2026-10-27', endTime: '20:00' }), now).error, '结束时间已过，请重新选择')
  checked('提交参数与校验')
}
{
  const app = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'))
  const device = app.subpackages.find(item => item.root === 'subpackages/device')
  assert.ok(device.pages.includes('wifi-sleep/wifi-sleep') && device.pages.includes('wifi-messages/wifi-messages'), '两页已注册')
  const page = fs.readFileSync(path.join(root, 'subpackages/device/wifi-sleep/wifi-sleep.js'), 'utf8')
  assert.ok(/iotApi\.getSleep/.test(page) && /iotApi\.setSleep/.test(page))
  assert.ok(/sleep\.MODE_OFF[\s\S]*?wx\.showModal/.test(page), '关闭先确认')
  assert.ok(/Number\(error\.code\) !== 4041/.test(page), '4041 补查')
  const detail = fs.readFileSync(path.join(root, 'subpackages/device/wifi-detail/wifi-detail.wxml'), 'utf8')
  assert.ok(/bindtap="openSleep"/.test(detail) && /bindtap="openMessages"/.test(detail), 'WiFi 详情有两个入口')
  assert.ok(/wx:if="\{\{unreadCount\}\}" class="wifi-detail-badge"/.test(detail), '消息中心未读角标')
  checked('页面注册与详情入口')
}
console.log(`wifi-sleep: ${checks} groups passed`)
