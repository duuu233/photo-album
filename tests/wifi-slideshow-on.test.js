// WiFi 版轮播开启中标记（2026-11-02）：
//   ① wifi-status.fetchSlideshowRunning：strategy.running → true / false，查不到（错误 / 接口缺失）→ null（调用方保持原样），设备号原样交给 iot-api；
//   ② 我的设备 WiFi 卡、WiFi 详情的「轮播设置」：开启中显示图标右上角绿点 +「轮播中」标签，未开启不显示；
//   ③ 列表重拉时沿用上次的标记（不闪），详情进页查一次。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const root = path.join(__dirname, '..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')

let checks = 0
function checked(name) { checks++; console.log('PASS ' + name) }

global.wx = new Proxy({}, { get: () => () => {} })
const stubModule = (request, exports) => {
  const filename = require.resolve(request)
  require.cache[filename] = { id: filename, filename, loaded: true, children: [], paths: [], exports }
}
let reply = null
const calls = []
stubModule('../utils/iot-api', {
  getStrategy: async (deviceNo, options) => {
    calls.push([deviceNo, options && options.showError])
    if (reply instanceof Error) throw reply
    return reply
  }
})
const wifiStatus = require('../utils/wifi-status')

async function main() {
  {
    reply = { configured: true, running: true }
    assert.equal(await wifiStatus.fetchSlideshowRunning({ productDeviceId: 'E3:48:C2:1E:D4:28' }), true)
    assert.deepEqual(calls[0], ['E3:48:C2:1E:D4:28', false], '静默查询，设备号交给 iot-api 去冒号')
    reply = { configured: true, running: false }
    assert.equal(await wifiStatus.fetchSlideshowRunning({ deviceNo: 'X' }), false)
    reply = null
    assert.equal(await wifiStatus.fetchSlideshowRunning({ deviceNo: 'X' }), false, '没有数据按未开启')
    reply = Object.assign(new Error('接口(IoT)-服务暂时不可用'), { code: 503 })
    assert.equal(await wifiStatus.fetchSlideshowRunning({ deviceNo: 'X' }), null, '查不到返回 null，保持原样')
    checked('轮播状态查询')
  }
  {
    const list = read('subpackages/device/list/list.wxml')
    assert.ok(/openWifiSlideshow[\s\S]*?wx:if="\{\{item\.wifiSlideshowOn\}\}" class="slideshow-on-dot"[\s\S]*?wx:if="\{\{item\.wifiSlideshowOn\}\}" class="slideshow-on-tag">轮播中</.test(list), '列表 WiFi 卡轮播中标记')
    const detail = read('subpackages/device/wifi-detail/wifi-detail.wxml')
    assert.ok(/openSlideshow[\s\S]*?wx:if="\{\{slideshowOn\}\}" class="slideshow-on-dot"[\s\S]*?wx:if="\{\{slideshowOn\}\}" class="slideshow-on-tag">轮播中</.test(detail), '详情轮播中标记')
    ;['subpackages/device/list/list.wxss', 'subpackages/device/wifi-detail/wifi-detail.wxss'].forEach(file => {
      const css = read(file)
      assert.ok(/\.slideshow-icon-wrap \{[^}]*position: relative/.test(css), `${file} 图标容器相对定位`)
      assert.ok(/\.slideshow-on-dot \{[^}]*position: absolute/.test(css), `${file} 绿点压在图标右上角`)
      assert.ok(/\.slideshow-on-tag \{/.test(css), `${file} 轮播中标签`)
    })
    checked('模板与样式')
  }
  {
    const listJs = read('subpackages/device/list/list.js')
    assert.ok(/wifiSlideshowOn: !!previous\.wifiSlideshowOn/.test(listJs), '重拉列表沿用上次标记')
    assert.ok(/this\.refreshWifiStatus\(\)\s*\n\s*this\.refreshWifiSlideshow\(\)/.test(listJs), '拉完列表查轮播状态')
    const detailJs = read('subpackages/device/wifi-detail/wifi-detail.js')
    assert.ok(/this\.refreshSlideshow\(\)/.test(detailJs) && /fetchSlideshowRunning/.test(detailJs), '详情进页查轮播状态')
    checked('刷新时机')
  }
  console.log(`wifi-slideshow-on: ${checks} groups passed`)
}
main().catch(error => { console.error(error); process.exitCode = 1 })
