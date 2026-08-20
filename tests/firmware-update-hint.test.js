// 详情页「固件升级」行的展示与版本判定（2026-08-20 产品规则）。
//
// 右侧只显示**设备实际在跑的固件版本号**——就是调试台「读固件版本」那条路（0x03 GET_SW_VER，
// 详情页由 deviceInfo.read 一并读回、落在 device.firmwareVersion）；读不到（未连接/0x03 失败）
// 时按本页占位约定回落 '--'（接口不下发设备在跑的版本，拿 newVersionNo 顶上就是显示假版本）。
//
// 有没有新版本改由箭头旁的红点（firmwareHasUpdate）表达：设备当前版本与接口 newVersionNo
// **不一样** 且 downloadPath 是有效 .bin 下载地址才亮；读不到当前版本时退回后端 isUpdate 标志
// （2026-08-11 定的「不连蓝牙也能查版本」能力）。
//
// 这里同时钉住「红点」与「点击固件升级」两处结论一致：两边共用 evaluateFirmwareUpdate + 同一套
// unknown 回落，否则会出现红点亮着、点进去却弹「当前固件已是最新版本」的自相矛盾。
const assert = require('assert')
const path = require('path')

// ── 环境打桩：小程序页面文件要在 wx / Page / getApp 存在时才能 require ──
const modals = []
const navigations = []

const wxStub = {
  showLoading() {},
  hideLoading() {},
  showModal(options) {
    modals.push(options)
  },
  navigateTo(options) {
    navigations.push(options && options.url)
  },
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
    // 其余 API 一律当作「调用即失败」，页面代码里都有 fail 分支
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

// BLE 侧整模块打桩：本用例只关心版本比较，不建真连接。
const deviceBlePath = require.resolve('../utils/device-ble')
require.cache[deviceBlePath] = {
  id: deviceBlePath,
  filename: deviceBlePath,
  loaded: true,
  exports: {
    isConnected: () => false,
    getActiveConnections: () => []
  }
}

// 详情接口打桩：每个用例改 latestDetail 即可（接口本就不返回设备实际固件版本）。
let latestDetail = null
const apiPath = require.resolve('../utils/api')
require.cache[apiPath] = {
  id: apiPath,
  filename: apiPath,
  loaded: true,
  exports: {
    getDeviceDetail: async () => latestDetail
  }
}

let pageOptions = null
global.Page = options => {
  pageOptions = options
}
require(path.join('..', 'subpackages', 'device', 'detail', 'detail.js'))

function newCtx(data) {
  const ctx = Object.create(pageOptions)
  ctx.data = Object.assign({}, pageOptions.data, { id: 'record-1' }, data || {})
  ctx.setData = function (patch) {
    Object.assign(this.data, patch)
  }
  return ctx
}

// 走「连接成功收尾」这条真实路径生成右侧展示：info.firmwareVersion 就是 0x03 读回的值。
// 返回 { version, dot }：version=右侧版本号文案，dot=箭头旁红点是否亮。
function hintAfterConnect(deviceFields, firmwareVersion) {
  const ctx = newCtx()
  ctx.applyConnectedDevice(
    Object.assign({ id: 'record-1', name: '相框' }, deviceFields),
    'ble-1',
    { firmwareVersion, imgCount: 1, capacity: 51, battery: 80 }
  )
  return { version: ctx.data.firmwareVersionText, dot: ctx.data.firmwareHasUpdate }
}

;(async () => {
  const PKG = 'https://example.com/fw/BR1601A02_V1.0.2_OTA.bin'

  // ① 右侧显示的是**设备当前在跑的版本**，不是接口的 newVersionNo；
  //    版本号不同 + downloadPath 是有效 .bin → 红点亮
  assert.deepStrictEqual(
    hintAfterConnect({ newVersionNo: 'V1.0.2', downloadPath: PKG }, 'V1.0.1'),
    { version: 'V1.0.1', dot: true }
  )

  // ② 版本号相同（大小写/空格不敏感）→ 不亮红点，哪怕后台还挂着 isUpdate=1
  assert.deepStrictEqual(
    hintAfterConnect(
      {
        isUpdate: 1,
        newVersionNo: ' v1.0.1 ',
        downloadPath: 'https://example.com/fw/BR1601A02_V1.0.1_OTA.bin'
      },
      'V1.0.1'
    ),
    { version: 'V1.0.1', dot: false }
  )

  // ③ 版本号不同但下载地址缺失 / 不是 .bin → 点进去只会弹原因说明、升不了级，红点不亮
  assert.deepStrictEqual(
    hintAfterConnect({ newVersionNo: 'V1.0.2', downloadPath: '' }, 'V1.0.1'),
    { version: 'V1.0.1', dot: false }
  )
  assert.deepStrictEqual(
    hintAfterConnect(
      { newVersionNo: 'V1.0.2', downloadPath: 'https://example.com/fw/notice.html' },
      'V1.0.1'
    ),
    { version: 'V1.0.1', dot: false }
  )

  // ④ 已连接但 0x03 没读到版本：版本号回落 '--'（不许拿 newVersionNo 冒充设备在跑的版本）；
  //    红点退回后端 isUpdate 标志——这里没给 isUpdate，故不亮
  assert.deepStrictEqual(
    hintAfterConnect({ newVersionNo: 'V1.0.2', downloadPath: PKG }, ''),
    { version: '--', dot: false }
  )

  // ⑤ 已连接、0x03 读不到版本，但后台 isUpdate=1 且包有效 → 版本号 '--'，红点照亮
  //    （与点击流程的 unknown 回落同源，见用例 ⑨）
  assert.deepStrictEqual(
    hintAfterConnect(
      { isUpdate: 1, newVersionNo: 'V1.0.2', downloadPath: PKG },
      ''
    ),
    { version: '--', dot: true }
  )

  // ⑥ 未连接（详情接口刚拉回来、没有活动会话）→ 版本号 '--'；后台说有更新就亮红点
  latestDetail = {
    id: 'record-1',
    userProductId: 'record-1',
    name: '相框',
    isUpdate: 1,
    newVersionNo: 'V1.0.2',
    downloadPath: PKG
  }
  const offline = newCtx()
  await offline.loadDetail()
  assert.strictEqual(offline.data.firmwareVersionText, '--')
  assert.strictEqual(offline.data.firmwareHasUpdate, true)

  // ── 点击「固件升级」的结论必须与红点同源 ──
  async function tap(deviceFirmwareVersion, detail) {
    modals.length = 0
    latestDetail = detail
    const ctx = newCtx({
      device: {
        id: 'record-1',
        name: '相框',
        connected: true,
        deviceId: 'ble-1',
        firmwareVersion: deviceFirmwareVersion
      }
    })
    await ctx.goOtaUpgrade()
    return { modal: modals[modals.length - 1] || {}, ctx }
  }

  const pkg = PKG

  // ⑦ 后台 isUpdate=0，但设备版本与 newVersionNo 不同且包有效 → 照样给升级二次确认
  const differ = await tap('V1.0.1', {
    isUpdate: 0,
    newVersionNo: 'V1.0.2',
    downloadPath: pkg
  })
  assert.strictEqual(differ.modal.content, '检测到新版本：V1.0.2，是否升级')
  assert.strictEqual(differ.modal.confirmText, '立刻更新')
  // 点击时刚拉到的接口数据要顺手刷新红点；版本号仍是设备在跑的那个，不受接口影响
  assert.strictEqual(differ.ctx.data.firmwareHasUpdate, true)
  assert.strictEqual(differ.ctx.data.firmwareVersionText, 'V1.0.1')

  // ⑧ 后台 isUpdate=1，但版本号一致 → 已是最新，不进升级页，红点也不亮
  const same = await tap('V1.0.2', {
    isUpdate: 1,
    newVersionNo: 'V1.0.2',
    downloadPath: pkg
  })
  assert.strictEqual(same.modal.content, '当前固件已是最新版本')
  assert.strictEqual(same.ctx.data.firmwareHasUpdate, false)
  assert.strictEqual(same.ctx.data.firmwareVersionText, 'V1.0.2')

  // ⑨ 版本号不同但地址不是 .bin → 如实说明原因，不当作「已是最新」把问题咽下去；红点不亮
  const badUrl = await tap('V1.0.1', {
    isUpdate: 1,
    newVersionNo: 'V1.0.2',
    downloadPath: 'https://example.com/fw/notice.html'
  })
  assert.strictEqual(
    badUrl.modal.content,
    '固件下载地址不是有效的 .bin 文件，请稍后重试。'
  )
  assert.strictEqual(badUrl.ctx.data.firmwareHasUpdate, false)

  // ⑩ 读不到设备当前版本（未连接也能查版本，2026-08-11 定的能力不能丢）：
  //    退回后端 isUpdate 标志——有更新照常放行、红点亮，无更新提示已是最新。
  const unknownWithFlag = await tap('', {
    isUpdate: 1,
    newVersionNo: 'V1.0.2',
    downloadPath: pkg
  })
  assert.strictEqual(unknownWithFlag.modal.content, '检测到新版本：V1.0.2，是否升级')
  assert.strictEqual(unknownWithFlag.ctx.data.firmwareVersionText, '--')
  assert.strictEqual(unknownWithFlag.ctx.data.firmwareHasUpdate, true)

  const unknownNoFlag = await tap('', {
    isUpdate: 0,
    newVersionNo: 'V1.0.2',
    downloadPath: pkg
  })
  assert.strictEqual(unknownNoFlag.modal.content, '当前固件已是最新版本')

  console.log('firmware-update-hint.test.js 通过')
})()
