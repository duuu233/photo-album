// 投屏预览页「同时加入轮播」（2026-10-27，docs/wifi/V1.4对接实现报告反馈追加内容.md 第二节）：
//   ① WiFi 版进页查 GET /api/device/strategy：running=true 才显示开关，默认关；running=false / 查询失败不显示；
//   ② 打开开关后点投屏，pendingProjection.addToCarousel=true（结果页据此每张带 addToCarousel）；没开轮播时一律 false；
//   ③ 蓝牙版不查轮播，仍走预热连接；
//   ④ 模板：开关挂在 carouselRunning 下。
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const writes = []
let strategyReply = { running: true }
const strategyCalls = []
global.wx = {
  getStorageSync: () => ({}),
  setStorageSync: (key, data) => writes.push([key, JSON.parse(JSON.stringify(data))]),
  showLoading() {},
  hideLoading() {}
}
global.Page = () => {}

function stub(request, exports) {
  const filename = require.resolve(request)
  require.cache[filename] = { id: filename, filename, loaded: true, exports }
}

let connects = 0
stub('../utils/system', { getLayoutMetrics: () => ({}) })
stub('../utils/active-device', { ensureDeviceConnected: async () => { connects++; return 'BLE-1' } })
stub('../utils/toast', { warn() {} })
stub('../utils/iot-api', {
  getStrategy: async (deviceNo, options) => {
    strategyCalls.push({ deviceNo, showError: options && options.showError })
    if (strategyReply instanceof Error) throw strategyReply
    return strategyReply
  }
})

const createPreviewPage = require('../subpackages/projection/preview/preview-page')
const options = createPreviewPage()

function page() {
  const instance = Object.create(options)
  instance.data = JSON.parse(JSON.stringify(options.data))
  instance.setData = (patch, callback) => {
    Object.assign(instance.data, patch)
    if (callback) callback()
  }
  instance._states = {}
  instance._unloaded = false
  return instance
}

const wifiDevice = { id: 'W1', name: 'WiFi相框', broadcastId: 'IJ_*', productDeviceId: 'D0:CF:13:F0:2F:F8' }
const bleDevice = { id: 'B1', name: '蓝牙相框', broadcastId: 'EF6-370', deviceNo: 'AABBCCDDEE01' }

async function main() {
  const log = console.warn
  console.warn = () => {}
  try {
    {
      const p = page()
      assert.equal(p.data.carouselRunning, false, '默认不显示')
      assert.equal(p.data.addToCarousel, false, '默认关')
      p.warmupPreview(wifiDevice)
      await p._carouselCheck
      assert.deepEqual(strategyCalls, [{ deviceNo: 'D0:CF:13:F0:2F:F8', showError: false }], 'WiFi 版静默查一次轮播')
      assert.equal(p.data.carouselRunning, true, '轮播中显示开关')
      assert.equal(connects, 0, 'WiFi 版不预热蓝牙')
      p.persistPending([])
      assert.equal(writes.pop()[1].addToCarousel, false, '没打开开关：不加入')
      p.toggleAddToCarousel({ detail: { value: true } })
      p.persistPending([])
      assert.equal(writes.pop()[1].addToCarousel, true, '打开开关：交给结果页加入轮播')
      console.log('PASS 轮播中显示开关，打开后投屏带 addToCarousel')
    }
    {
      strategyReply = { running: false, configured: true }
      const p = page()
      p.warmupPreview(wifiDevice)
      await p._carouselCheck
      assert.equal(p.data.carouselRunning, false, '未开轮播不显示')
      p.setData({ addToCarousel: true })
      p.persistPending([])
      assert.equal(writes.pop()[1].addToCarousel, false, '未开轮播时一律不加入')
      strategyReply = Object.assign(new Error('接口(IoT)-服务暂不可用'), { code: 503 })
      const q = page()
      q.warmupPreview(wifiDevice)
      await q._carouselCheck
      assert.equal(q.data.carouselRunning, false, '查询失败按未开轮播处理')
      console.log('PASS 未开轮播 / 查询失败不显示开关')
    }
    {
      strategyCalls.length = 0
      const p = page()
      p.warmupPreview(bleDevice)
      await p._warmup
      assert.equal(strategyCalls.length, 0, '蓝牙版不查轮播')
      assert.equal(connects, 1, '蓝牙版照旧预热连接')
      console.log('PASS 蓝牙版不受影响')
    }
    {
      const root = path.join(__dirname, '..')
      const tpl = fs.readFileSync(path.join(root, 'subpackages/projection/preview/preview.wxml'), 'utf8')
      assert.ok(/class="carousel-toggle" wx:if="\{\{carouselRunning\}\}"/.test(tpl), '开关挂在 carouselRunning 下')
      assert.ok(/<text>同时加入轮播<\/text>/.test(tpl))
      assert.ok(/checked="\{\{addToCarousel\}\}"[^>]*bindchange="toggleAddToCarousel"/.test(tpl))
      assert.ok(tpl.indexOf('carousel-toggle') < tpl.indexOf('preview-submit'), '在「开始投屏」上方')
      console.log('PASS 模板')
    }
  } finally {
    console.warn = log
  }
  console.log('preview-carousel-toggle: 4 groups passed')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
