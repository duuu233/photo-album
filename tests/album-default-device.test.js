// 「我的相册」默认选中哪台设备（album/list.js pickDefaultFilter）。
//
// 锁成回归用例是因为这条规则被改丢过一次：2026-08-04 把「设备照片」+「投屏管理」合并成
// 「我的相册」时，只搬过来了设备照片页的默认规则，投屏管理页的「连接中的设备优先」跟着丢了——
// 用户在首页连好设备再进来，看到的却是另一台的照片。规则三档，顺序不能动：
//   ① 保留当前选中(仍在列表) → ② 连接中的设备 → ③ 第一台
//
// 2026-08-17：原来夹在 ②③ 之间的「第一台有照片的设备」随「我的图库」列表接口一起删除。
// 它的判据是图库照片的归属设备，而本页数据源是投屏记录、图库列表已不再拉；要按「哪台有照片」
// 排就得把每台设备的记录都拉一遍。pickDefaultFilter 的入参也因此由 (filters, photos, devices)
// 收成 (filters, devices)。
const assert = require('assert')
const path = require('path')

// 连接态由 utils/active-device 现算（要真实 BLE 会话），这里整模块打桩：
// 只有 connectedIds 里登记的设备ID才算「连接中」。必须在 require 页面文件之前塞进 require.cache。
const activeDevicePath = require.resolve('../utils/active-device')
let connectedIds = []
require.cache[activeDevicePath] = {
  id: activeDevicePath,
  filename: activeDevicePath,
  loaded: true,
  exports: {
    findConnectedDeviceId: device =>
      device && connectedIds.indexOf(String(device.userProductId || device.id || '')) > -1
        ? 'BLE-HANDLE'
        : ''
  }
}

// 小程序页面文件要在 wx / Page / getApp 存在时才能 require：这里只取 Page 注册的方法对象。
global.wx = new Proxy(
  {},
  {
    get: () => (options) => {
      if (options && typeof options.fail === 'function') {
        options.fail({})
      }
    }
  }
)
global.getApp = () => ({ globalData: {} })
let pageOptions = null
global.Page = (options) => {
  pageOptions = options
}
require(path.join('..', 'subpackages', 'album', 'list', 'list.js'))

// 三台设备。筛选项按 userProductId 生成（见 buildDeviceFiltersFromDevices）。
const devices = [
  { userProductId: 'A', name: '客厅相框', deviceNo: 'AA:BB:CC:DD:EE:01' },
  { userProductId: 'B', name: '书房相框', deviceNo: 'AA:BB:CC:DD:EE:02' },
  { userProductId: 'C', name: '房间相册', deviceNo: 'AA:BB:CC:DD:EE:03' }
]

const makeCtx = currentFilter => {
  const ctx = Object.create(pageOptions)
  ctx.data = { currentFilter }
  return ctx
}
const filtersOf = ctx => ctx.buildLatestDeviceFilters(devices)
const pick = (currentFilter, list = devices) => {
  const ctx = makeCtx(currentFilter)
  return ctx.pickDefaultFilter(filtersOf(ctx), list)
}

// ③ 一台都没连：退到设备接口顺序里的第一台
connectedIds = []
assert.strictEqual(pick(''), 'A')

// ② 连接中的设备优先，哪怕它不是设备列表里的第一台
connectedIds = ['C']
assert.strictEqual(pick(''), 'C')

// ② 多台同时连接（单连接下不该出现）：取设备接口顺序里第一台找到的
connectedIds = ['C', 'B']
assert.strictEqual(pick(''), 'B')

// ① 用户已手动选过且那台仍在列表：连接中的设备**不得**覆盖它
//    （onShow 每次都会重跑 loadPhotos，覆盖的话「点进照片再返回」就会跳回连接中的那台）
connectedIds = ['C']
assert.strictEqual(pick('A'), 'A')

// ① 之二：原选中的设备已不在列表（被解绑）→ 重新按 ②③ 挑
connectedIds = ['C']
assert.strictEqual(pick('已解绑的设备ID'), 'C')

// ② 之三：连接中的设备没有后端设备ID（不成筛选项）→ 不能落到下拉里没有的项上，回退第一台
connectedIds = ['']
assert.strictEqual(pick('', devices.concat([{ name: '未登记的设备' }])), 'A')

// ③ 一台设备都没有：返回空串（页面据此不查记录、不查一键清除状态）
connectedIds = []
const emptyCtx = makeCtx('')
assert.strictEqual(emptyCtx.pickDefaultFilter([], []), '')

console.log('album-default-device.test.js 通过')
