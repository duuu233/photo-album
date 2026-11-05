// WiFi 版轮播设置（2026-10-27，docs/wifi/XT相框通讯协议_V1.4_更新说明.md 1.5 / 第五节）utils/wifi-strategy + 页面：
//   ① 保存参数：间隔模式带 beginTime / endTime / timingTime（秒），固定时间带 updateDays / updateTimeList（去重排序）；
//   ② imgUrls 按选择顺序；一张不选不让保存（空数组服务端回 4000）；按相册顺序全选不带 imgUrls（= 全部相册）；
//      最多 100（2026-10-27 追加内容第一节，原 200）：超过不让存，4000 给明确提示；
//      保存后立即播放的第一张：选中的第一张，全部相册取相册第一张（实现报告反馈六）；
//   ③ 回显：configured=false 用默认值；固定时间 / 随机 / 轮播后休眠回填；间隔分钟数落到最近档位；
//   ④ 回显选择：null = 全部相册（页面全选），[] = 已全部失效（提示重新选择），部分删除给提示，相册里不存在的跳过；
//   ⑤ 选图：点选追加到末尾、再点取消，超上限不改（已选的仍可取消）；全选保留已选顺序、超过 100 只选前 100，再点清空；
//      回显 null 且相册超过 100 张只选前 100 并提示；页面显示「已选 X/100」、选满置灰；
//   ⑥ 页面已注册，入口在我的设备 / WiFi 详情（取代「刷新状态」）。
// 2026-11-05 轮播服务端化（docs/wifi/前端对接文档20261105.md）后的口径变化，相关断言已按新规则改写并就地注明：
//   · 必传 timeZone；间隔档位 10 分钟起（600~86400 秒），起止默认 00:00~24:00、结束可选 24:00；
//   · idle 废弃不再传、页面去掉「轮播后休眠」；间隔 / 固定两组参数都带（切换不清空另一方）；
//   · 保存后不再额外 /api/device/play 投第一张（设备收到轮播会立刻自动刷屏），firstImageUrl 已删除；
//   · 高级卡片（工作日 / 周末 / 纪念日）与「至少一张照片」见文件末尾两组。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const root = path.join(__dirname, '..')
const s = require('../utils/wifi-strategy')

let checks = 0
function checked(name) { checks++; console.log('PASS ' + name) }
const plain = value => JSON.parse(JSON.stringify(value))

{
  // 2026-11-05：间隔最小 10 分钟（原用例 5 分钟 = 300 秒已不合法，改用 10 分钟 = 600 秒）；带 timeZone；
  // idle 废弃不再传；两组参数都带（另一方合法才带，这里固定那组是默认的 08:00 / 每 1 天）
  const form = Object.assign({}, s.DEFAULT_FORM, { timeZone: 'Asia/Shanghai', beginTime: '08:00', endTime: '20:00', intervalMinutes: 10 })
  const a = s.buildPayload('D0CF13F02FF8', form, ['u2', 'u1'], ['u1', 'u2', 'u3'])
  assert.deepEqual(plain(a.payload), {
    deviceNo: 'D0CF13F02FF8', updateType: 2, timeZone: 'Asia/Shanghai', mode: 1,
    beginTime: '08:00', endTime: '20:00', timingTime: 600, updateTimeList: ['08:00'], updateDays: 1, imgUrls: ['u2', 'u1']
  }, '间隔模式：秒 + 按选择顺序的 imgUrls + 时区，固定那组也带上')
  const fixed = Object.assign({}, s.DEFAULT_FORM, { timeZone: 'Asia/Shanghai', updateType: 1, updateDays: 2, updateTimeList: ['15:00', '11:00', '11:00', 'bad'], mode: 2, idle: 0 })
  const album = ['u1', 'u2', 'u3']
  const b = s.buildPayload('D0CF13F02FF8', fixed, ['u1', 'u2', 'u3'], album)
  assert.deepEqual(plain(b.payload), {
    deviceNo: 'D0CF13F02FF8', updateType: 1, timeZone: 'Asia/Shanghai', mode: 2, updateDays: 2, updateTimeList: ['11:00', '15:00'],
    beginTime: '00:00', endTime: '24:00', timingTime: 3600
  }, '固定时间：去重排序；按相册顺序全选不带 imgUrls（全部相册）；表单里残留 idle 也不传')
  assert.equal('idle' in b.payload, false, 'idle 已废弃，不再传')
  assert.deepEqual(plain(s.buildPayload('x', fixed, ['u3', 'u1', 'u2'], album).payload.imgUrls), ['u3', 'u1', 'u2'], '全选但换了顺序：按顺序提交')
  assert.equal(s.buildPayload('x', fixed, [], album).error, '请至少选择一张照片', '不选不让保存，绝不提交空数组')
  // 2026-11-05：文案改为「时间点」（固定时间点的校验与高级卡片共用）
  assert.equal(s.buildPayload('x', Object.assign({}, fixed, { updateTimeList: [] }), ['u1'], album).error, '请至少添加一个时间点')
  assert.equal(s.buildPayload('x', Object.assign({}, fixed, { updateDays: 366 }), ['u1'], album).error, '每隔天数需在 1~365 之间')
  assert.equal(s.buildPayload('x', Object.assign({}, form, { beginTime: '' }), ['u1'], album).error, '请选择轮播开始和结束时间')
  assert.equal(s.buildPayload('x', Object.assign({}, form, { intervalMinutes: 5 }), ['u1'], album).error, '轮播间隔需在 10 分钟到 24 小时之间', '9 分钟 / 5 分钟不能提交')
  assert.equal(s.buildPayload('x', Object.assign({}, form, { intervalMinutes: 1440 }), ['u1'], album).payload.timingTime, 86400, '24 小时可以')
  assert.equal(s.buildPayload('x', Object.assign({}, form, { beginTime: '00:00', endTime: '24:00' }), ['u1'], album).payload.endTime, '24:00', '结束可选 24:00')
  assert.equal(s.buildPayload('x', Object.assign({}, form, { beginTime: '22:00', endTime: '06:00' }), ['u1'], album).payload.beginTime, '22:00', '跨天窗口可以')
  assert.equal(s.buildPayload('x', Object.assign({}, form, { beginTime: '08:00', endTime: '08:00' }), ['u1'], album).error, '开始和结束时间不能相同')
  assert.equal(s.buildPayload('x', Object.assign({}, form, { timeZone: '' }), ['u1'], album).error, '请选择时区', '必传时区')
  assert.equal(s.buildPayload('x', Object.assign({}, form, { timeZone: 'UTC+8' }), ['u1'], album).error, '请选择时区', '不传固定偏移')
  const switched = s.buildPayload('x', Object.assign({}, fixed, { updateType: 2, intervalMinutes: 30 }), ['u1'], album).payload
  assert.deepEqual([switched.updateType, switched.timingTime, switched.updateDays].concat(plain(switched.updateTimeList)), [2, 1800, 2, '11:00', '15:00'], '切到间隔：固定那组照样带上（切换不清空另一方）')
  assert.equal(s.MAX_IMG_URLS, 100, '上限 100')
  const hundred = Array.from({ length: 100 }, (v, i) => `u${i}`)
  assert.equal(s.buildPayload('x', form, hundred, hundred.concat('extra')).payload.imgUrls.length, 100, '正好 100 张可以存')
  const many = Array.from({ length: 101 }, (v, i) => `u${i}`)
  assert.equal(s.buildPayload('x', form, many, many.concat('extra')).error, '最多选择 100 张，请先取消部分照片', '超过 100 不让存')
  const e4000 = Object.assign(new Error('接口(IoT)-参数错误'), { code: 4000, serverMessage: 'imgUrls 最多 100 个' })
  assert.equal(s.saveErrorText(e4000, { imgUrls: hundred }), '轮播照片最多 100 张，请先取消部分照片后再保存', '4000 且已满：明确提示上限')
  assert.equal(s.saveErrorText(e4000, { imgUrls: ['u1'] }), '保存失败：imgUrls 最多 100 个', '4000 其余：带服务端原文')
  assert.equal(s.saveErrorText(Object.assign(new Error('x'), { code: 4000 }), {}), '保存失败：轮播设置有误，请检查后重试')
  assert.equal(s.saveErrorText(Object.assign(new Error('x'), { code: 4041 }), {}), '', '其他错误交回页面')
  // 2026-11-05：保存后设备会立刻自动刷屏，不再额外投第一张，firstImageUrl 已删除（原断言「先播选中的第一张 / 全部相册取第一张」随之作废）
  assert.equal(s.firstImageUrl, undefined, '不再计算保存后要投的第一张')
  checked('保存参数：两种模式、时区、间隔范围、imgUrls 顺序、不选不让存、全部相册')
}
{
  const def = s.formFromStrategy({ configured: false }, 'Asia/Tokyo')
  assert.equal(def.updateType, 2)
  assert.equal(def.intervalMinutes, 60)
  assert.deepEqual([def.beginTime, def.endTime], ['00:00', '24:00'], '没配置过：起止默认 00:00~24:00（与服务端不传时的默认一致）')
  assert.equal(def.timeZone, 'Asia/Tokyo', '没配置过：用手机时区')
  const f = s.formFromStrategy({ configured: true, updateType: 1, updateDays: 3, updateTimeList: ['15:00', '09:30'], mode: 2, idle: 0, timeZone: 'America/New_York' }, 'Asia/Shanghai')
  assert.deepEqual(plain(f).updateTimeList, ['09:30', '15:00'])
  assert.equal(f.updateType, 1)
  assert.equal(f.updateDays, 3)
  assert.equal(f.mode, 2)
  // 2026-11-05：idle 废弃，原「轮播后休眠回填」断言改为不再回填
  assert.equal('idle' in f, false, 'idle 不再回填')
  assert.equal(f.timeZone, 'America/New_York', '时区以服务端回传为准')
  assert.equal(s.formFromStrategy({ configured: true, timeZone: 'UTC+8' }, 'Asia/Shanghai').timeZone, 'Asia/Shanghai', '回传非 IANA 名用手机时区')
  assert.equal(s.formFromStrategy({ configured: true, endTime: '24:00' }).endTime, '24:00', '回显 24:00')
  const g = s.formFromStrategy({ configured: true, beginTime: '07:00', endTime: '23:00', intervalMinutes: 7, mode: 1 })
  assert.equal(g.updateType, 2, '缺 updateType 按间隔')
  assert.equal(g.beginTime, '07:00')
  // 2026-11-05：档位去掉 1 / 5 分钟，原「7 分钟落到 5」改为落到最小档 10
  assert.equal(g.intervalMinutes, 10, '7 分钟落到最近档位 10')
  assert.deepEqual(plain(s.INTERVAL_OPTIONS), [10, 15, 30, 60, 120, 180, 360, 720, 1440], '间隔候选 10 分钟 ~ 24 小时')
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
  const big = Array.from({ length: 130 }, (v, i) => `p${i}`)
  const whole = s.selectionFromStrategy({ imgUrls: null }, big)
  assert.equal(whole.selected.length, 100, 'null 且相册超过 100：只选前 100')
  assert.equal(whole.selected[99], 'p99')
  assert.ok(/最多选择 100 张/.test(whole.hint), '并说明')
  checked('回显选择')
}
{
  let r = s.toggleSelection([], 'b')
  r = s.toggleSelection(r.selected, 'a')
  assert.deepEqual(plain(r.selected), ['b', 'a'], '按点选顺序')
  r = s.toggleSelection(r.selected, 'b')
  assert.deepEqual(plain(r.selected), ['a'], '再点取消')
  const full = Array.from({ length: 100 }, (v, i) => `u${i}`)
  const over = s.toggleSelection(full, 'z')
  assert.equal(over.overflow, true)
  assert.equal(over.selected.length, 100)
  assert.equal(s.isFull(full), true)
  const back = s.toggleSelection(full, 'u5')
  assert.equal(back.overflow, false, '选满后已选的仍可取消')
  assert.equal(back.selected.length, 99)
  assert.equal(s.toggleSelection(back.selected, 'z').overflow, false, '取消一张后可以继续选')
  const big = Array.from({ length: 130 }, (v, i) => `p${i}`)
  const all = s.toggleAll([], big)
  assert.equal(all.length, 100, '全选超过 100 只选前 100')
  assert.deepEqual(plain(all.slice(0, 2)), ['p0', 'p1'])
  assert.equal(s.isAllSelected(all, big), true, '选满算全选（按钮给取消全选）')
  assert.deepEqual(plain(s.toggleAll(all, big)), [], '再点清空')
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
  // 2026-11-05：下发轮播后设备立刻自动刷屏，保存后不再 /api/device/play 投第一张；原「refresh=true 投第一张 / 带 renderMode / type 取屏幕方向」
  // 三条断言守的是那次额外投屏，随之改为守「保存后不投屏」
  assert.ok(!/wifiProjection|projectOne|refresh: true|firstImageUrl/.test(page), '保存后不再额外投第一张')
  assert.ok(/屏幕即将刷新/.test(page), '保存成功提示屏幕即将刷新')
  assert.ok(/strategy\.buildPayload\(this\.deviceNo\(\), this\.data\.form, this\.selected, this\.albumUrls\(\), this\.advanced\)/.test(page), '保存带上高级卡片')
  assert.ok(/this\.reloadConfig\(\)/.test(page), '保存成功后重新拉配置（以服务端为准）')
  assert.ok(/strategy\.saveErrorText\(error, built\.payload\)/.test(page), '4000 走明确提示')
  assert.ok(/最多选择 \$\{strategy\.MAX_IMG_URLS\} 张，请先取消部分照片/.test(page), '选满点未选的提示')
  const tpl = fs.readFileSync(path.join(root, 'subpackages/device/wifi-slideshow/wifi-slideshow.wxml'), 'utf8')
  assert.ok(/已选 \{\{selectedCount\}\}\/\{\{maxCount\}\}/.test(tpl), '显示已选 X/100')
  assert.ok(/item\.disabled \? 'is-disabled'/.test(tpl), '选满后未选的置灰')
  assert.equal(tpl.indexOf('toggleIdle'), -1, '去掉「轮播后休眠」开关')
  assert.equal(tpl.indexOf('轮播后休眠'), -1)
  assert.ok(/bindtap="openZoneSheet"/.test(tpl) && /\{\{timeZoneLabel\}\}/.test(tpl), '时区控件')
  assert.ok(/mode="multiSelector" range="\{\{endTimeColumns\}\}"/.test(tpl), '结束时间可选 24:00')
  assert.ok(/下次刷新：\{\{nextRefresh\}\}/.test(tpl), '下次刷新一行')
  assert.ok(/wx:if="\{\{baseHint\}\}" class="ws-base-hint"/.test(tpl), '基础配置旁的提示')
  assert.ok(/bindtap="toggleAdvanced"/.test(tpl) && /<block wx:if="\{\{advancedOpen\}\}">/.test(tpl), '高级设置展开 / 收起')
  assert.ok(/当天独占/.test(tpl) && /bindtap="addAnniversary"/.test(tpl), '纪念日卡片')
  const css = fs.readFileSync(path.join(root, 'subpackages/device/wifi-slideshow/wifi-slideshow.wxss'), 'utf8')
  assert.ok(/\.ws-tile\.is-disabled\s*\{[^}]*opacity/.test(css), '置灰样式')
  assert.ok(/\.ws-base-hint\s*\{[^}]*color: #8a9099/.test(css), '提示灰字')
  const detail = fs.readFileSync(path.join(root, 'subpackages/device/wifi-detail/wifi-detail.wxml'), 'utf8')
  assert.ok(/bindtap="openSlideshow"/.test(detail) && /<text>轮播设置<\/text>/.test(detail), 'WiFi 详情：轮播设置')
  assert.equal(detail.indexOf('refreshTap'), -1, 'WiFi 详情不再有刷新状态按钮')
  const bleDetail = fs.readFileSync(path.join(root, 'subpackages/device/detail/detail.wxml'), 'utf8')
  assert.ok(/catchtap="toggleConnection"/.test(bleDetail), '蓝牙版详情的连接按钮不动')
  checked('页面注册与入口')
}
{
  // 2026-11-05 高级卡片（对接文档第三、四、七节）
  const album = ['a', 'b', 'c']
  const base = Object.assign({}, s.DEFAULT_FORM, { timeZone: 'Asia/Shanghai' })
  const adv = s.advancedFromStrategy({
    weekday: { enabled: true, updateTimeList: ['18:00', '08:00'], mode: 2, imgUrls: ['c', 'x'] },
    weekend: null,
    anniversaries: [
      { monthDay: '10-20', beginTime: '00:00', endTime: '24:00', timingTime: 3600, imgUrls: ['b'] },
      { monthDay: '05-20', updateTimeList: ['00:00'] },
      { monthDay: '10-20', imgUrls: ['a'] },
      { monthDay: '13-01' }
    ]
  }, album)
  assert.equal(adv.weekday.enabled, true)
  assert.deepEqual(plain(adv.weekday.updateTimeList), ['08:00', '18:00'])
  assert.equal(adv.weekday.mode, 2)
  assert.deepEqual(plain(adv.weekday.selected), ['c'], '卡片图片组：相册里没有的跳过')
  assert.equal(adv.weekday.hint, '之前选择的照片有 1 张已删除')
  assert.equal(adv.weekend.enabled, false, 'null = 未启用')
  assert.deepEqual(adv.anniversaries.map(card => card.monthDay), ['05-20', '10-20'], '纪念日去重、去非法、按日期排序')
  assert.deepEqual(plain(adv.anniversaries[0].selected), ['a', 'b', 'c'], '卡片没有 imgUrls 按全部相册全选')
  assert.equal(adv.anniversaries[1].intervalMinutes, 60, 'timingTime 秒换算分钟')
  assert.equal(s.advancedCount(adv), 3, '高级设置（3 项）：启用的工作日 + 2 条纪念日')

  const built = s.buildPayload('D0', Object.assign({}, base, { updateType: 1 }), ['a'], album, adv).payload
  assert.deepEqual(plain(built.weekday), {
    enabled: true, mode: 2, updateTimeList: ['08:00', '18:00'], beginTime: '00:00', endTime: '24:00', timingTime: 3600, imgUrls: ['c']
  }, '工作日：两组都带、图片组明确提交')
  assert.equal(built.weekend, null, '周末没配置过传 null')
  assert.deepEqual(built.anniversaries.map(card => card.monthDay), ['05-20', '10-20'])
  assert.deepEqual(plain(built.anniversaries[0].imgUrls), ['a', 'b', 'c'], '卡片全选也明确提交，不省略 imgUrls')
  assert.equal('enabled' in built.anniversaries[0], false, '纪念日没有 enabled')

  const noPhoto = Object.assign({}, adv, { weekday: Object.assign({}, adv.weekday, { selected: [] }) })
  assert.equal(s.buildPayload('D0', base, ['a'], album, noPhoto).error, '工作日：请至少选择一张照片', '启用的卡片必须至少一张')
  const offWithPhotos = Object.assign({}, adv, { weekday: Object.assign({}, adv.weekday, { enabled: false }) })
  const kept = s.buildPayload('D0', base, ['a'], album, offWithPhotos).payload.weekday
  assert.equal(kept.enabled, false, '停用但配置过：带 enabled=false 保留参数')
  assert.deepEqual(plain(kept.imgUrls), ['c'])
  const offNoPhoto = Object.assign({}, adv, { weekday: Object.assign({}, adv.weekday, { enabled: false, selected: [] }) })
  assert.equal(s.buildPayload('D0', base, ['a'], album, offNoPhoto).payload.weekday, null, '停用且没选照片：null，不传空数组')
  const dup = Object.assign({}, adv, { anniversaries: [adv.anniversaries[0], Object.assign({}, adv.anniversaries[1], { monthDay: '05-20' })] })
  assert.equal(s.buildPayload('D0', base, ['a'], album, dup).error, '纪念日 05月20日 重复，请修改日期', 'monthDay 重复前端拦截')
  const badCard = Object.assign({}, adv, { weekday: Object.assign({}, adv.weekday, { intervalMinutes: 5 }) })
  assert.equal(s.buildPayload('D0', base, ['a'], album, badCard).error, '工作日：轮播间隔需在 10 分钟到 24 小时之间', '卡片间隔同样 10 分钟起')
  assert.ok(s.buildPayload('D0', base, [], album, adv).error === '请至少选择一张照片', '基础配置也必须至少一张')
  // 不做跨卡片时间重叠校验：工作日与基础配置同一时间点也能保存
  const overlap = s.buildPayload('D0', Object.assign({}, base, { updateType: 1, updateTimeList: ['08:00'] }), ['a'], album, adv)
  assert.ok(overlap.payload, '时间点跨卡片重复不拦')

  assert.equal(s.baseHint(adv), '工作日已启用独立配置，本配置在工作日不生效')
  assert.equal(s.baseHint(Object.assign({}, adv, { weekday: { enabled: false }, weekend: { enabled: true } })), '周末已启用独立配置，本配置在周末不生效')
  assert.equal(s.baseHint(Object.assign({}, adv, { weekend: { enabled: true } })), '工作日与周末均已启用，本配置将不会生效')
  assert.equal(s.baseHint(Object.assign({}, adv, { weekday: { enabled: false } })), '', '只有纪念日不提示')
  checked('高级卡片：回显、提交、至少一张、重复日期、三档提示')
}
{
  assert.equal(s.isMonthDay('02-29'), true, '02-29 可选（闰年生效）')
  assert.equal(s.isMonthDay('02-30'), false)
  assert.equal(s.isMonthDay('4-1'), false)
  assert.equal(s.monthDayLabel('10-20'), '10月20日')
  assert.equal(s.nextFreeMonthDay(['11-05', '11-06'], '11-05'), '11-07', '新增纪念日跳过已占用的日子')
  assert.equal(s.nextFreeMonthDay(['12-31'], '12-31'), '01-01', '跨年')
  assert.deepEqual(plain(s.endTimeIndex('24:00')), [24, 0])
  assert.equal(s.endTimeFromIndex([24, 30]), '24:00', '选 24 时分钟归零')
  assert.equal(s.endTimeFromIndex([8, 5]), '08:05')
  assert.equal(s.END_TIME_COLUMNS[0].length, 25, '时 00~24')
  assert.equal(s.nextRefreshText('2026-11-05 10:41:20'), '2026-11-05 10:41', '下次刷新去掉秒')
  assert.equal(s.nextRefreshText(null), '')
  checked('纪念日日期、结束时间 24:00、下次刷新')
}
console.log(`wifi-strategy: ${checks} groups passed`)
