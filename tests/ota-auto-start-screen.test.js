// 从详情页「立刻更新」进升级页（auto=1）时，底部按钮区**一帧都不许出现**（2026-08-13 需求 2）。
//
// 现场表述：「OTA 检测到新版本跳转升级页面后，页面下方闪现『立即升级』和『取消』按钮」。
// 成因不是动画也不是布局：loadFirmware 拉完版本先按「发现新版本」这一屏落地
//（screenStatus='ready' → wxml 里 screenStatus!=='progress' 就画按钮区，且 showPrimary=true），
// 80ms 后 runUpgrade 才把画面切成进行中 —— 那 80ms 就是用户看到的一闪。
// auto=1 这条路根本不需要用户再按一次，所以直接以进行中画面落地。
//
// 反面用例同样要锁住：**没有 auto** 时（app.js 强制升级弹窗那条路）按钮必须照常出现，
// 否则用户进了升级页却没有任何可点的东西。
const assert = require('assert')
const path = require('path')

// BLE 侧整模块打桩：本用例不碰蓝牙，设备当前没连着（未连接不影响 canUpgrade，只改按钮文案）
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

// 设备详情接口打桩：有可用新版本 + 合法 .bin 下载地址 → 走到「发现新版本」
const apiPath = require.resolve('../utils/api')
require.cache[apiPath] = {
  id: apiPath,
  filename: apiPath,
  loaded: true,
  exports: {
    getDeviceDetail: async id => ({
      id,
      userProductId: id,
      productDeviceId: 'E9:48:C2:1E:D4:28',
      name: '测试相框',
      isUpdate: 1,
      newVersionNo: 'V1.0.2',
      firmwareVersion: 'V1.0.1',
      downloadPath: 'https://example.com/fw/BR1601A02_V1.0.2_OTA.bin'
    })
  }
}

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
  globalData: { selectedDevice: null },
  ensureLogin: async () => {},
  setSelectedDevice: () => {}
})

let pageOptions = null
global.Page = options => {
  pageOptions = options
}
require(path.join('..', 'subpackages', 'device', 'ota', 'ota.js'))

function makePage(autoStart) {
  const ctx = Object.create(pageOptions)
  ctx.data = Object.assign({}, pageOptions.data, { id: 'record-1' })
  ctx.setData = function (patch) {
    Object.assign(this.data, patch)
  }
  ctx._autoStart = autoStart
  ctx._autoStartConsumed = false
  // 自动开始的那一跳在本用例里不需要真跑（它会去连蓝牙）：只验落地的这一屏
  ctx.runUpgrade = async () => {}
  return ctx
}

;(async () => {
  // ── auto=1：直接落在进行中画面，按钮区不出现 ──────────────────────────
  {
    const ctx = makePage(true)
    await ctx.loadFirmware()

    assert.strictEqual(ctx.data.state, 'available', '前置条件：确实检测到了可用新版本')
    assert.strictEqual(ctx.data.canUpgrade, true)
    // wxml：`wx:if="{{screenStatus !== 'progress'}}"` 才画 .ota-actions（主按钮 + 「返回」）。
    // 所以「进行中」是唯一能让整块按钮区都不出现的画面 —— 只把 showPrimary 关掉还留着「返回」，
    // 用户看到的仍是一闪。
    assert.strictEqual(
      ctx.data.screenStatus,
      'progress',
      'auto=1 落地就该是进行中画面，否则底部按钮区会闪一帧'
    )
    assert.strictEqual(ctx.data.showPrimary, false, '主按钮不出现')
    assert.strictEqual(ctx.data.progressPercent, 0, '进度从 0 起，接着 runUpgrade 往下走')
  }

  // ── 无 auto（强制升级弹窗那条路）：按钮照常出现 ────────────────────────
  {
    const ctx = makePage(false)
    await ctx.loadFirmware()

    assert.strictEqual(ctx.data.screenStatus, 'ready', '手动进来要停在「发现新版本」等用户按')
    assert.strictEqual(ctx.data.showPrimary, true, '主按钮必须在，否则进了升级页没得可点')
    assert.strictEqual(ctx.data.actionText, '连接并升级')
  }

  console.log('ota-auto-start-screen.test.js 全部通过')
})().catch(error => {
  console.error(error)
  process.exit(1)
})
