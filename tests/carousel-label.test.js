// 详情页「轮播设置」右侧值（2026-08-21 产品口径）。
//
// 这一行只回答「开没开」：开着一律「已开启」，不再把顺序/随机这个二选一摆到概览行上；
// 关着（手动模式，或用户明确关过轮播 carouselEnabled=false）维持原来的「未启用」。
// 未连接时整行仍是 '--'（与设备ID/内存/固件版本同一套占位约定），由 loadDetail/断开分支负责，不在此列。
const assert = require('assert')
const path = require('path')

// ── 环境打桩：小程序页面文件要在 wx / Page / getApp 存在时才能 require ──
const wxStub = {
  showLoading() {},
  hideLoading() {},
  showModal() {},
  navigateTo() {},
  getStorageSync() {
    return ''
  },
  setStorageSync() {},
  removeStorageSync() {}
}

global.wx = new Proxy(wxStub, {
  get(target, prop) {
    if (prop in target) {
      return target[prop]
    }
    return options => {
      if (options && typeof options.fail === 'function') {
        options.fail({})
      }
    }
  }
})

global.getApp = () => ({
  globalData: { selectedDevice: null },
  ensureLogin: async () => {},
  setSelectedDevice: () => {}
})

// BLE / 接口整模块打桩：本用例只关心右侧文案，不建真连接、不拉接口。
const deviceBlePath = require.resolve('../utils/device-ble')
require.cache[deviceBlePath] = {
  id: deviceBlePath,
  filename: deviceBlePath,
  loaded: true,
  exports: {
    isConnected: () => false,
    getActiveConnections: () => [],
    disconnect: () => {}
  }
}
const apiPath = require.resolve('../utils/api')
require.cache[apiPath] = {
  id: apiPath,
  filename: apiPath,
  loaded: true,
  exports: {
    getDeviceDetail: async () => null
  }
}

let pageOptions = null
global.Page = options => {
  pageOptions = options
}
require(path.join('..', 'subpackages', 'device', 'detail', 'detail.js'))

// 走「连接成功收尾」这条真实路径生成右侧文案（applyConnectedDevice 里 setData playbackLabel）
function labelAfterConnect(deviceFields) {
  const ctx = Object.create(pageOptions)
  ctx.data = Object.assign({}, pageOptions.data, { id: 'record-1' })
  ctx.setData = function (patch) {
    Object.assign(this.data, patch)
  }
  ctx.applyConnectedDevice(
    Object.assign({ id: 'record-1', name: '相框' }, deviceFields),
    'ble-1',
    { imgCount: 1, capacity: 51, battery: 80 }
  )
  return ctx.data.playbackLabel
}

assert.strictEqual(labelAfterConnect({ playbackMode: 'order' }), '已开启')
assert.strictEqual(labelAfterConnect({ playbackMode: 'random' }), '已开启')
assert.strictEqual(
  labelAfterConnect({ playbackMode: 'random', carouselEnabled: true }),
  '已开启'
)
// 后端没下发播放模式时按「开着」算（与开关默认态一致），同样只说「已开启」
assert.strictEqual(labelAfterConnect({}), '已开启')

assert.strictEqual(labelAfterConnect({ playbackMode: 'manual' }), '未启用')
assert.strictEqual(
  labelAfterConnect({ playbackMode: 'order', carouselEnabled: false }),
  '未启用'
)

console.log('carousel-label tests passed')
