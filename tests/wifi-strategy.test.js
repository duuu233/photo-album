// WiFi 版轮播设置（2026-10-27，docs/wifi/XT相框通讯协议_V1.4_更新说明.md 1.5 / 第五节）utils/wifi-strategy + 页面：
//   ① 保存参数：间隔模式带 beginTime / endTime / timingTime（秒），固定时间带 updateDays / updateTimeList（去重排序）；
//   ② imgUrls 按选择顺序；一张不选不让保存（空数组服务端回 4000）；按相册顺序全选不带 imgUrls（= 全部相册）；最多 200；
//      保存后立即播放的第一张：选中的第一张，全部相册取相册第一张（实现报告反馈六）；
//   ③ 回显：configured=false 用默认值；固定时间 / 随机 / 轮播后休眠回填；间隔分钟数落到最近档位；
//   ④ 回显选择：null = 全部相册（页面全选），[] = 已全部失效（提示重新选择），部分删除给提示，相册里不存在的跳过；
//   ⑤ 选图：点选追加到末尾、再点取消，超上限不改；全选保留已选顺序、再点清空；
//   ⑥ 页面已注册，入口在我的设备 / WiFi 详情（取代「刷新状态」）。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const root = path.join(__dirname, '..')
const s = require('../utils/wifi-strategy')

let checks = 0
function checked(name) { checks++; console.log('PASS ' + name) }
const plain = value => JSON.parse(JSON.stringify(value))

{
  const form = Object.assign({}, s.DEFAULT_FORM, { beginTime: '08:00', endTime: '20:00', intervalMinutes: 5 })
  const a = s.buildPayload('D0CF13F02FF8', form, ['u2', 'u1'], ['u1', 'u2', 'u3'])
  assert.deepEqual(plain(a.payload), {
    deviceNo: 'D0CF13F02FF8', updateType: 2, mode: 1, idle: 1,
    beginTime: '08:00', endTime: '20:00', timingTime: 300, imgUrls: ['u2', 'u1']
  }, '间隔模式：秒 + 按选择顺序的 imgUrls')
  const fixed = Object.assign({}, s.DEFAULT_FORM, { updateType: 1, updateDays: 2, updateTimeList: ['15:00', '11:00', '11:00', 'bad'], mode: 2, idle: 0 })
  const album = ['u1', 'u2', 'u3']
  const b = s.buildPayload('D0CF13F02FF8', fixed, ['u1', 'u2', 'u3'], album)
  assert.deepEqual(plain(b.payload), {
    deviceNo: 'D0CF13F02FF8', updateType: 1, mode: 2, idle: 0, updateDays: 2, updateTimeList: ['11:00', '15:00']
  }, '固定时间：去重排序；按相册顺序全选不带 imgUrls（全部相册）')
  assert.deepEqual(plain(s.buildPayload('x', fixed, ['u3', 'u1', 'u2'], album).payload.imgUrls), ['u3', 'u1', 'u2'], '全选但换了顺序：按顺序提交')
  assert.equal(s.buildPayload('x', fixed, [], album).error, '请至少选择一张照片', '不选不让保存，绝不提交空数组')
  assert.equal(s.buildPayload('x', Object.assign({}, fixed, { updateTimeList: [] }), ['u1'], album).error, '请至少添加一个更新时间')
  assert.equal(s.buildPayload('x', Object.assign({}, fixed, { updateDays: 366 }), ['u1'], album).error, '每隔天数需在 1~365 之间')
  assert.equal(s.buildPayload('x', Object.assign({}, form, { beginTime: '' }), ['u1'], album).error, '请选择轮播开始和结束时间')
  const many = Array.from({ length: 230 }, (v, i) => `u${i}`)
  assert.equal(s.buildPayload('x', form, many, many.concat('extra')).payload.imgUrls.length, 200, '最多 200')
  assert.equal(s.firstImageUrl(a.payload, album), 'u2', '保存后先播选中的第一张')
  assert.equal(s.firstImageUrl(b.payload, album), 'u1', '全部相册取相册第一张')
  checked('保存参数：两种模式、imgUrls 顺序、不选不让存、全部相册、第一张')
}
{
  const def = s.formFromStrategy({ configured: false })
  assert.equal(def.updateType, 2)
  assert.equal(def.intervalMinutes, 60)
  const f = s.formFromStrategy({ configured: true, updateType: 1, updateDays: 3, updateTimeList: ['15:00', '09:30'], mode: 2, idle: 0 })
  assert.deepEqual(plain(f).updateTimeList, ['09:30', '15:00'])
  assert.equal(f.updateType, 1)
  assert.equal(f.updateDays, 3)
  assert.equal(f.mode, 2)
  assert.equal(f.idle, 0)
  const g = s.formFromStrategy({ configured: true, beginTime: '07:00', endTime: '23:00', intervalMinutes: 7, mode: 1, idle: 1 })
  assert.equal(g.updateType, 2, '缺 updateType 按间隔')
  assert.equal(g.beginTime, '07:00')
  assert.equal(g.intervalMinutes, 5, '7 分钟落到最近档位 5')
  assert.equal(s.formFromStrategy({ configured: true, timingTime: 600 }).intervalMinutes, 10, '只有 timingTime 秒时换算分钟')
  assert.equal(s.intervalLabel(120), '2 小时')
  assert.equal(s.intervalLabel(15), '15 分钟')
  checked('回显表单')
}
{
  const album = ['a', 'b', 'c']
  assert.deepEqual(plain(s.selectionFromStrategy({ imgUrls: null }, album)), { selected: ['a', 'b', 'c'], hint: '' }, 'null = 全部相册，页面全选')
  assert.equal(s.selectionFromStrategy({ imgUrls: [] }, album).hint, '之前选择的照片已全部删除，请重新选择')
  const part = s.selectionFromStrategy({ imgUrls: ['c', 'x', 'a'] }, album)
  assert.deepEqual(plain(part.selected), ['c', 'a'], '保持原顺序，跳过相册里没有的')
  assert.equal(part.hint, '之前选择的照片有 1 张已删除')
  assert.equal(s.selectionFromStrategy({ imgUrls: ['x'] }, album).hint, '之前选择的照片已不在「我的上传」中')
  assert.deepEqual(plain(s.selectionFromStrategy(null, album)), { selected: [], hint: '' }, '查询失败不选')
  checked('回显选择')
}
{
  let r = s.toggleSelection([], 'b')
  r = s.toggleSelection(r.selected, 'a')
  assert.deepEqual(plain(r.selected), ['b', 'a'], '按点选顺序')
  r = s.toggleSelection(r.selected, 'b')
  assert.deepEqual(plain(r.selected), ['a'], '再点取消')
  const full = Array.from({ length: 200 }, (v, i) => `u${i}`)
  const over = s.toggleSelection(full, 'z')
  assert.equal(over.overflow, true)
  assert.equal(over.selected.length, 200)
  assert.deepEqual(plain(s.toggleAll(['c'], ['a', 'b', 'c'])), ['c', 'a', 'b'], '全选保留已选顺序再按网格补齐')
  assert.deepEqual(plain(s.toggleAll(['a', 'b', 'c'], ['a', 'b', 'c'])), [], '已全选再点清空')
  checked('选图：单选 / 多选 / 全选')
}
{
  const app = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'))
  const device = app.subpackages.find(item => item.root === 'subpackages/device')
  assert.ok(device.pages.includes('wifi-slideshow/wifi-slideshow'), '页面已注册')
  const page = fs.readFileSync(path.join(root, 'subpackages/device/wifi-slideshow/wifi-slideshow.js'), 'utf8')
  assert.ok(/Page\(fold\.adapt\(/.test(page), '折叠屏适配')
  assert.ok(/iotApi\.getStrategy/.test(page) && /iotApi\.setStrategy/.test(page) && /iotApi\.stopStrategy/.test(page))
  assert.ok(/strategy\.buildPayload/.test(page), '保存走 buildPayload（不传空数组）')
  assert.ok(/refresh: true/.test(page) && /strategy\.firstImageUrl/.test(page), '保存后立即 refresh=true 投第一张')
  const detail = fs.readFileSync(path.join(root, 'subpackages/device/wifi-detail/wifi-detail.wxml'), 'utf8')
  assert.ok(/bindtap="openSlideshow"/.test(detail) && /<text>轮播设置<\/text>/.test(detail), 'WiFi 详情：轮播设置')
  assert.equal(detail.indexOf('refreshTap'), -1, 'WiFi 详情不再有刷新状态按钮')
  const bleDetail = fs.readFileSync(path.join(root, 'subpackages/device/detail/detail.wxml'), 'utf8')
  assert.ok(/catchtap="toggleConnection"/.test(bleDetail), '蓝牙版详情的连接按钮不动')
  checked('页面注册与入口')
}
console.log(`wifi-strategy: ${checks} groups passed`)
