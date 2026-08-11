// OTA 升级页必须补齐设备的完整 6 字节身份（subpackages/device/ota/ota.js mergeSelectedDevice）。
//
// 实测故障（2026-08-11）：点固件升级必报
// 「电子纸设备-当前电子纸设备记录缺少完整的6字节电子纸设备ID，请删除后重新绑定」。
// 根因不是设备真的缺 ID：升级页用 getUserProductDetail 重拉记录，而详情接口本就不返回设备 ID，
// 页面又只从 selectedDevice 继承 deviceId/bleDeviceId（不含 productDeviceId/deviceNo）、也不查
// 身份登记表 —— 于是 this.data.device 永远没有稳定身份：
//   · findConnectedDeviceId 遇到空 serials 直接返回 ''（设备连着也显示未连接、电量不刷）；
//   · 点升级走 ensureConnectedForAction → ensureDeviceConnected 开头的身份闸 → 报上面那句话。
// 2026-08-11 给升级页加了「升级前就地自动扫连」之后，这个缺口从「显示不准」变成「必然报错」。
const assert = require('assert')
const path = require('path')

const deviceIdentity = require('../utils/device-identity')
const activeDevice = require('../utils/active-device')

const deviceA = 'E9:48:C2:1E:D4:28' // 当前选中的那一台（不是升级页这台）
const deviceC = 'E9:48:C2:1E:D4:2A' // 升级页这台

// BLE 侧整模块打桩：本用例的场景就是「设备当前没连着」，活动会话为空。
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

// 设备详情接口打桩：**故意不返回任何设备 ID**，这正是线上行为（见 client-api-matrix「设备详情」）。
const apiPath = require.resolve('../utils/api')
require.cache[apiPath] = {
  id: apiPath,
  filename: apiPath,
  loaded: true,
  exports: {
    getDeviceDetail: async id => ({
      id,
      userProductId: id,
      name: 'C 的相框',
      isUpdate: 1,
      newVersionNo: 'V1.0.2',
      firmwareVersion: 'V1.0.1',
      downloadPath: 'https://example.com/fw/BR1601A02_V1.0.2_OTA.bin'
    })
  }
}

// 小程序页面文件要在 wx / Page / getApp 存在时才能 require：这里只取 Page 注册的方法对象。
global.wx = new Proxy(
  {},
  {
    get: () => options => {
      if (options && typeof options.fail === 'function') {
        options.fail({})
      }
    }
  }
)
global.getApp = () => ({
  globalData: { selectedDevice: { userProductId: 'record-a', productDeviceId: deviceA } },
  ensureLogin: async () => {},
  setSelectedDevice: () => {}
})
let pageOptions = null
global.Page = options => {
  pageOptions = options
}
require(path.join('..', 'subpackages', 'device', 'ota', 'ota.js'))

// 身份登记表里有这台设备的完整 ID（首页拉设备列表 rememberMany、或上次连接成功时登记）。
deviceIdentity.clear()
deviceIdentity.rememberMany([
  { userProductId: 'record-a', productDeviceId: deviceA },
  { userProductId: 'record-c', productDeviceId: deviceC }
])

const ctx = Object.create(pageOptions)
ctx.data = Object.assign({}, pageOptions.data, { id: 'record-c' })
ctx.setData = function (patch) {
  Object.assign(this.data, patch)
}

;(async () => {
  await ctx.loadFirmware()

  const device = ctx.data.device
  assert.ok(device, '升级页应加载到设备记录')
  // 详情接口没下发设备 ID，也没在 selectedDevice 里（选中的是 A）：身份只能来自登记表。
  assert.strictEqual(device.productDeviceId, deviceC)
  assert.strictEqual(device.deviceNo, deviceC)
  // 绝不能继承成当前选中设备(A)的身份 —— OTA 写错设备不可逆。
  assert.notStrictEqual(device.productDeviceId, deviceA)
  // ensureDeviceConnected/connectBoundDevice 开头的身份闸看的就是这个：
  // 有完整 ID 才放行去扫描重连，没有才报「请删除后重新绑定」。
  assert.ok(activeDevice.stableDeviceId(device))
  // 有升级包时按钮必须可按（未连接只是改文案，不再是拦截理由）
  assert.strictEqual(ctx.data.canUpgrade, true)
  assert.strictEqual(ctx.data.actionText, '连接并升级')

  // 未登记、也不是当前选中的那台：身份仍如实缺失，交由身份闸拦截，不得凭空捏造。
  deviceIdentity.clear()
  const bare = Object.create(pageOptions)
  bare.data = Object.assign({}, pageOptions.data, { id: 'record-unknown' })
  bare.setData = ctx.setData
  await bare.loadFirmware()
  assert.ok(!activeDevice.stableDeviceId(bare.data.device))

  console.log('ota-device-identity.test.js 通过')
})()
