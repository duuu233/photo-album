// 2026-11-05 轮播服务端化（docs/wifi/前端对接文档20261105.md）中轮播页以外的部分：
//   ① utils/time-zone：只认 IANA 名（UTC+8 不算）、手机时区（系统 / Intl / 按偏移兜底）、分组搜索；
//      展示 2026-11-05（20261105-1 第 2 条）起按语种「国家 / 城市」、不带 UTC 偏移、列表每行一段文字（原「Asia/Shanghai（UTC+8）」断言随之改写）；
//   ② 消息类型 CAROUSEL_NOT_SENT「轮播未发送成功」，内容带未发送的时刻；
//   ③ WiFi 投屏结果页与蓝牙版一样两个按钮：成功「继续投屏」（11-06 前叫「再投一张」）（当前页弹拍照 / 相册）/ 有失败「重试未成功的」+「返回首页」；
//   ④ 配网「设备正在连接云端」等待窗口 120 秒（轮询次数断言在 wifi-provision.test.js）。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const root = path.join(__dirname, '..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')
const tz = require('../utils/time-zone')
const messages = require('../utils/wifi-messages')

let checks = 0
function checked(name) { checks++; console.log('PASS ' + name) }

{
  assert.equal(tz.isIana('Asia/Shanghai'), true)
  assert.equal(tz.isIana('America/Argentina/Buenos_Aires'), true)
  assert.equal(tz.isIana('Etc/GMT-8'), true)
  assert.equal(tz.isIana('UTC+8'), false, '固定偏移不算')
  assert.equal(tz.isIana(''), false)
  assert.equal(tz.detect({ systemInfo: 'Asia/Tokyo', intlZone: 'Asia/Seoul' }), 'Asia/Tokyo', '系统给了 IANA 名优先')
  assert.equal(tz.detect({ systemInfo: '', intlZone: 'Europe/Paris' }), 'Europe/Paris', '其次 Intl')
  assert.equal(tz.detect({ systemInfo: 'GMT+8', intlZone: '', offsetMinutes: 480 }), 'Asia/Shanghai', '都取不到：UTC+8 落到 Asia/Shanghai')
  assert.equal(tz.detect({ systemInfo: '', intlZone: '', offsetMinutes: -660 }), 'Etc/GMT+11', '候选里没有同偏移：Etc/GMT±N（符号相反）')
  assert.equal(tz.offsetText(480), 'UTC+8')
  assert.equal(tz.offsetText(-300), 'UTC-5')
  assert.equal(tz.offsetText(330), 'UTC+5:30')
  // 20261105-1：展示去掉 UTC+8，按语种显示；提交值仍是 IANA 名（展示与提交两套数据）
  assert.equal(tz.label('Asia/Shanghai', 'zh-Hans'), '中国 / 北京')
  assert.equal(tz.label('Asia/Shanghai', 'zh-Hant'), '中國 / 北京')
  assert.equal(tz.label('America/New_York', 'en'), 'USA / New York')
  assert.equal(tz.label('Asia/Tokyo', 'ja'), '日本 / 東京')
  assert.equal(tz.label('Asia/Shanghai'), '中国 / 北京', '不传语种：取当前语种，取不到按简体中文')
  assert.equal(tz.label('Asia/Shanghai', 'fr'), '中国 / 北京', '不认识的语种按简体中文')
  assert.ok(!/UTC/.test(tz.ZONES.map(zone => tz.label(zone.id, 'zh-Hans')).join('')), '候选展示不带 UTC 偏移')
  assert.equal(tz.label('Etc/GMT-8'), 'Etc/GMT-8', '不在候选里的原样显示 IANA 名')
  tz.LANGS.forEach(lang => tz.ZONES.forEach(zone => assert.ok(tz.label(zone.id, lang), `${zone.id} 缺 ${lang} 译名`)))
  const summer = new Date(Date.UTC(2026, 6, 1, 12))
  const winter = new Date(Date.UTC(2026, 0, 1, 12))
  assert.equal(tz.offsetOf('America/New_York', winter), -300)
  assert.ok([-240, -300].indexOf(tz.offsetOf('America/New_York', summer)) > -1, '夏令时按当前时刻算（Intl 可用为 -4，不可用回退标准 -5）')
  const all = tz.options('', 'Asia/Shanghai')
  assert.equal(all.length, tz.ZONES.length, '全部候选')
  assert.equal(all[0].id, 'Asia/Shanghai')
  assert.equal(all[0].showGroup, true)
  assert.equal(all[0].label, '中国 / 北京')
  assert.equal(all[1].group, '中国', '港澳台并进「中国」组（展示已是「中国 / 香港」）')
  assert.deepEqual(Object.keys(all[0]).sort(), ['group', 'id', 'label', 'showGroup'], '每行只有一段展示文字，没有右侧副标题')
  assert.equal(tz.options('', 'Asia/Shanghai', 'en')[0].group, 'China', '分组名按语种')
  assert.deepEqual(tz.options('东京').map(row => row.id), ['Asia/Tokyo'], '中文城市可搜')
  assert.deepEqual(tz.options('new_york').map(row => row.id), ['America/New_York'], '不区分大小写')
  assert.deepEqual(tz.options('美洲').map(row => row.id).length, 4, '分组名可搜')
  assert.deepEqual(tz.options('北京').map(row => row.id), ['Asia/Shanghai'], '按展示文案可搜')
  assert.deepEqual(tz.options('tokyo', '', 'zh-Hans').map(row => row.id), ['Asia/Tokyo'], '别的语种译名也能搜')
  const custom = tz.options('', 'Asia/Kolkata')
  assert.equal(custom[0].id, 'Asia/Kolkata', '回显值不在候选里放最前「当前」')
  assert.equal(custom[0].group, '当前')
  assert.equal(custom[0].label, 'Asia/Kolkata')
  assert.equal(tz.options('xyz').length, 0)
  checked('时区：IANA 校验、手机时区、按语种展示、搜索')
}
{
  assert.equal(messages.TYPE_TEXT.CAROUSEL_NOT_SENT, '轮播未发送成功')
  const item = messages.toItem({ id: 9, type: 'CAROUSEL_NOT_SENT', category: 'BUSINESS', payload: '{"time":"18:00"}' })
  assert.equal(item.title, '轮播未发送成功')
  assert.equal(item.categoryText, '业务')
  assert.equal(item.detail, '18:00 的轮播图片未发送成功，请检查设备网络状态')
  assert.equal(messages.detailText('CAROUSEL_NOT_SENT', { scheduledAt: '2026-11-05 08:30:00' }), '08:30 的轮播图片未发送成功，请检查设备网络状态', '带日期只取时分')
  assert.equal(messages.detailText('CAROUSEL_NOT_SENT', {}), '轮播图片未发送成功，请检查设备网络状态', '取不到时刻只给后半句')
  checked('消息：CAROUSEL_NOT_SENT')
}
{
  const tpl = read('subpackages/projection/wifi-result/wifi-result.wxml')
  assert.ok(/wx:if="\{\{retryable && total\}\}" class="wifi-result-primary"[^>]*bindtap="retryFailed">重试未成功的</.test(tpl), '有失败：重试未成功的')
  // 2026-11-06 有意改口径：成功按钮文案「再投一张」→「继续投屏」（同蓝牙版结果页），按钮位置与绑定不变
  assert.ok(/wx:elif="\{\{canContinue\}\}" class="wifi-result-primary"[^>]*bindtap="continueProjection">继续投屏</.test(tpl), '成功：继续投屏')
  assert.equal(tpl.indexOf('>再投一张<'), -1, '不再叫「再投一张」')
  assert.ok(/class="wifi-result-secondary"[^>]*bindtap="backHome">返回首页</.test(tpl), '第二个按钮：返回首页')
  assert.equal(tpl.indexOf('bindtap="finish"'), -1, '不再有「完成」')
  assert.ok(/wx:if="\{\{showMediaSheet\}\}"/.test(tpl) && /bindtap="chooseCamera"/.test(tpl) && /bindtap="chooseAlbum"/.test(tpl), '拍照 / 相册弹层')
  const page = read('subpackages/projection/wifi-result/wifi-result.js')
  assert.ok(/chooseCamera\(\) \{\n    return this\.pickAndContinue\(/.test(page) && /chooseAlbum\(\) \{\n    return this\.pickAndContinue\(/.test(page), '选图等到进预览（锁不提前放开）')
  assert.ok(/wx\.setStorageSync\('pendingProjection', \{ device: Object\.assign\(\{\}, this\.device, \{ isWifi: true \}\), images \}\)/.test(page), '同一台设备')
  assert.ok(/wx\.redirectTo\(\{ url: '\/subpackages\/projection\/preview\/preview' \}\)/.test(page), '进预览页构图')
  assert.ok(/wx\.switchTab\(\{ url: '\/pages\/home\/home' \}\)/.test(page), '返回首页')
  const css = read('subpackages/projection/wifi-result/wifi-result.wxss')
  assert.ok(/\.wifi-result-secondary \{/.test(css) && /\.media-mask \{/.test(css) && /\.cancel-action \{/.test(css), '按钮与弹层样式')
  checked('WiFi 投屏结果页：两个按钮 + 继续投屏')
}
{
  assert.ok(/const ONLINE_TIMEOUT_MS = 120000/.test(read('utils/wifi-provision.js')), '配网等待设备上云 120 秒')
  checked('配网等待窗口 120 秒')
}
console.log(`wifi-carousel-server: ${checks} groups passed`)
