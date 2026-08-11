// 详情页「固件升级」行的版本判定（2026-08-12 产品规则）。
//
// 规则：先读设备实际在跑的固件版本——就是调试台「读固件版本」那条路（0x03 GET_SW_VER，
// 详情页由 deviceInfo.read 一并读回、落在 device.firmwareVersion）——再与设备详情接口下发的
// newVersionNo 比较：**不一样** 且 downloadPath 是有效 .bin 下载地址 → 右侧提示「有版本可更新」，
// 反之「已是最新版本」；读不到当前固件版本（未连接/0x03 失败）时按本页占位约定回落 '--'。
//
// 这里同时钉住「右侧文案」与「点击固件升级」两处结论一致：两边共用 evaluateFirmwareUpdate，
// 否则会出现右边写着「有版本可更新」、点进去却弹「当前固件已是最新版本」的自相矛盾。
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

// 走「连接成功收尾」这条真实路径生成右侧文案：info.firmwareVersion 就是 0x03 读回的值。
function hintAfterConnect(deviceFields, firmwareVersion) {
  const ctx = newCtx()
  ctx.applyConnectedDevice(
    Object.assign({ id: 'record-1', name: '相框' }, deviceFields),
    'ble-1',
    { firmwareVersion, imgCount: 1, capacity: 51, battery: 80 }
  )
  return ctx.data.firmwareUpdateText
}

;(async () => {
  // ① 版本号不同 + downloadPath 是有效 .bin → 有版本可更新
  assert.strictEqual(
    hintAfterConnect(
      {
        newVersionNo: 'V1.0.2',
        downloadPath: 'https://example.com/fw/BR1601A02_V1.0.2_OTA.bin'
      },
      'V1.0.1'
    ),
    '有版本可更新'
  )

  // ② 版本号相同（大小写/空格不敏感）→ 已是最新版本，哪怕后台还挂着 isUpdate=1
  assert.strictEqual(
    hintAfterConnect(
      {
        isUpdate: 1,
        newVersionNo: ' v1.0.1 ',
        downloadPath: 'https://example.com/fw/BR1601A02_V1.0.1_OTA.bin'
      },
      'V1.0.1'
    ),
    '已是最新版本'
  )

  // ③ 版本号不同但下载地址缺失 / 不是 .bin → 不能说「可更新」，按已是最新展示
  assert.strictEqual(
    hintAfterConnect({ newVersionNo: 'V1.0.2', downloadPath: '' }, 'V1.0.1'),
    '已是最新版本'
  )
  assert.strictEqual(
    hintAfterConnect(
      { newVersionNo: 'V1.0.2', downloadPath: 'https://example.com/fw/notice.html' },
      'V1.0.1'
    ),
    '已是最新版本'
  )

  // ④ 已连接但 0x03 没读到版本：无从比较，回落 '--'，不许谎称「已是最新版本」
  assert.strictEqual(
    hintAfterConnect(
      {
        newVersionNo: 'V1.0.2',
        downloadPath: 'https://example.com/fw/BR1601A02_V1.0.2_OTA.bin'
      },
      ''
    ),
    '--'
  )

  // ⑤ 未连接（详情接口刚拉回来、没有活动会话）→ '--'
  latestDetail = {
    id: 'record-1',
    userProductId: 'record-1',
    name: '相框',
    isUpdate: 1,
    newVersionNo: 'V1.0.2',
    downloadPath: 'https://example.com/fw/BR1601A02_V1.0.2_OTA.bin'
  }
  const offline = newCtx()
  await offline.loadDetail()
  assert.strictEqual(offline.data.firmwareUpdateText, '--')

  // ── 点击「固件升级」的结论必须与右侧文案同源 ──
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

  const pkg = 'https://example.com/fw/BR1601A02_V1.0.2_OTA.bin'

  // ⑥ 后台 isUpdate=0，但设备版本与 newVersionNo 不同且包有效 → 照样给升级二次确认
  const differ = await tap('V1.0.1', {
    isUpdate: 0,
    newVersionNo: 'V1.0.2',
    downloadPath: pkg
  })
  assert.strictEqual(differ.modal.content, '检测到新版本：V1.0.2，是否升级')
  assert.strictEqual(differ.modal.confirmText, '立刻更新')
  // 点击时刚拉到的接口数据要顺手刷新右侧文案
  assert.strictEqual(differ.ctx.data.firmwareUpdateText, '有版本可更新')

  // ⑦ 后台 isUpdate=1，但版本号一致 → 已是最新，不进升级页
  const same = await tap('V1.0.2', {
    isUpdate: 1,
    newVersionNo: 'V1.0.2',
    downloadPath: pkg
  })
  assert.strictEqual(same.modal.content, '当前固件已是最新版本')
  assert.strictEqual(same.ctx.data.firmwareUpdateText, '已是最新版本')

  // ⑧ 版本号不同但地址不是 .bin → 如实说明原因，不当作「已是最新」把问题咽下去
  const badUrl = await tap('V1.0.1', {
    isUpdate: 1,
    newVersionNo: 'V1.0.2',
    downloadPath: 'https://example.com/fw/notice.html'
  })
  assert.strictEqual(
    badUrl.modal.content,
    '固件下载地址不是有效的 .bin 文件，请稍后重试。'
  )

  // ⑨ 读不到设备当前版本（未连接也能查版本，2026-08-11 定的能力不能丢）：
  //    退回后端 isUpdate 标志——有更新照常放行，无更新提示已是最新。
  const unknownWithFlag = await tap('', {
    isUpdate: 1,
    newVersionNo: 'V1.0.2',
    downloadPath: pkg
  })
  assert.strictEqual(unknownWithFlag.modal.content, '检测到新版本：V1.0.2，是否升级')
  assert.strictEqual(unknownWithFlag.ctx.data.firmwareUpdateText, '--')

  const unknownNoFlag = await tap('', {
    isUpdate: 0,
    newVersionNo: 'V1.0.2',
    downloadPath: pkg
  })
  assert.strictEqual(unknownNoFlag.modal.content, '当前固件已是最新版本')

  console.log('firmware-update-hint.test.js 通过')
})()
