// 预览页「开始投屏」后的批量投屏收尾刷屏(0x24)口径（2026-08-20 修正）：
//   ① 中途张一律不刷屏——部分固件收到 0x24 会断蓝牙，批量传输中途刷屏会让后续图片传输失败；
//   ② 刷屏时机是「整个投屏流程结束」——全部传完、中途某张失败、用户中断都算收尾，
//      不是「第一张上传成功就去刷」；
//   ③ 刷的索引是本批**第一张成功写入设备**的真实槽位（不是最后一张、也不是刚失败那张）；
//   ④ 槽位 0 是相框第一个位置、是合法值，不能被当成假值跳过刷屏；
//   ⑤ 一张都没成功（设备上没有本批的图）才完全不刷；
//   ⑥ 索引恒取**设备侧**槽位——由 0x01 读回的 IMG_MASK 现算的 firstFreeIndex，
//      绝不用后端记录接口回的 imgIndex（后端那份是我们写上去的账，不是设备事实）。
//
// ⚠️ 2026-08-20 起收尾刷屏有总开关 FINAL_REFRESH_ENABLED，**当前默认关闭**（真机测试用，
//    存储键 finalRefreshEnabled 可覆盖）。所以用例分两拨：前 5 组显式把开关打开，验上面那套
//    刷屏口径；最后一组验关闭态——整批传完也一条 0x24 都不发。开关改回 true 时本文件无需改动。
const assert = require('assert')
const protocol = require('../utils/frame-protocol')

// ── 桩：wx ─────────────────────────────────────────────────
const storage = {}
const wxBase = {
  getStorageSync: key => storage[key],
  setStorageSync: (key, value) => {
    storage[key] = value
  },
  removeStorageSync: key => {
    delete storage[key]
  },
  getDeviceInfo: () => ({}),
  getAppBaseInfo: () => ({}),
  getNetworkType: options => {
    options && options.success && options.success({ networkType: 'wifi' })
  }
}
global.wx = new Proxy(wxBase, {
  get: (target, key) =>
    key in target
      ? target[key]
      : options => {
          if (options && typeof options.fail === 'function') {
            options.fail({})
          }
        }
})
global.getApp = () => ({ globalData: {} })

// ── 桩：被 result.js require 的工具模块 ─────────────────────
const stubModule = (request, exports) => {
  const filename = require.resolve(request)
  require.cache[filename] = {
    id: filename,
    filename,
    loaded: true,
    children: [],
    paths: [],
    exports
  }
}

// 调用轨迹：按真实发生顺序记下 BLE 侧动作，用来断言「刷屏发生在整单收尾」而不是中途
let trace = []
let uploadPlan = [] // 每张的结果：true=图传成功，Error=图传失败
let deviceMask = new Array(12).fill(0) // 设备 0x01 回的 IMG_MASK：槽位事实的唯一来源
const deviceBle = {
  isConnected: () => true,
  readTransferInfo: () =>
    Promise.resolve({
      screenType: 0x01,
      width: 4, // 4×4÷2 = 8 字节六色 4bpp 帧，够跑完校验闸
      height: 4,
      capacity: 8,
      imgCount: 0,
      imgMask: deviceMask // 设备为空时第一张落 0 号槽（0 是合法值）
    }),
  optimizeConnectionIntervalForTransfer: () => Promise.resolve({}),
  prepareImageTransfer: () => Promise.resolve(null),
  uploadImage: (deviceId, options) => {
    trace.push(`upload:${options.index}`)
    const planned = uploadPlan[options.imageIndex]
    return planned instanceof Error
      ? Promise.reject(planned)
      : Promise.resolve({ transferStats: {} })
  },
  deleteImage: (deviceId, indexes) => {
    trace.push(`rollback:${indexes.join(',')}`)
    return Promise.resolve()
  },
  refreshScreen: (deviceId, index) => {
    trace.push(`refresh:${index}`)
    return Promise.resolve()
  },
  applyIdleConnectionInterval: () => Promise.resolve()
}
stubModule('../utils/device-ble', deviceBle)
stubModule('../utils/active-device', {
  findConnectedDeviceId: () => 'BLE-1',
  ensureDeviceConnected: () => Promise.resolve('BLE-1')
})
stubModule('../utils/api', {
  // 故意回一个与设备真实槽位不同的 imgIndex：刷屏索引若哪天改从后端取，用例 ⑤ 立刻红
  editUserProductImgRecord: () => Promise.resolve({ imgIndex: 9 })
})
stubModule('../utils/dithering', {})
stubModule('../utils/media', {})
stubModule('../utils/toast', { warn: () => {}, error: () => {}, success: () => {} })
stubModule('../utils/system', { getNavBarMetrics: () => ({}) })
stubModule('../utils/fold-adapt', { adapt: options => options })

let pageOptions = null
global.Page = options => {
  pageOptions = options
}
require('../subpackages/projection/result/result.js')

// ── 驱动一次真实投屏主流程 ─────────────────────────────────
const runProjection = async (imageCount, plan, usedSlots = [], refreshEnabled = true) => {
  trace = []
  uploadPlan = plan
  deviceMask = protocol.indexesToMask(usedSlots)
  // 存储值优先于代码默认值：用例自己决定收尾刷屏开关的状态，不受默认值改动影响
  storage.finalRefreshEnabled = refreshEnabled
  storage.pendingProjection = {
    device: { deviceId: 'BLE-1', id: 'D1', name: '相框', width: 4, height: 4 },
    images: Array.from({ length: imageCount }, (_, i) => ({
      tempFilePath: `local-${i}.jpg`
    }))
  }
  const ctx = Object.create(pageOptions)
  ctx.data = {}
  ctx.setData = () => {}
  // 进度条与整单汇总不是本用例的关注点，替成空实现，免得把 smooth-progress 的定时器拖进测试
  const animator = {
    reset: () => {},
    jumpTo: () => {},
    setTarget: () => {},
    freeze: () => {},
    dispose: () => {}
  }
  ctx.ensureProgressAnimator = () => animator
  ctx.reportProjectionPerformance = () => {}
  // 网络出帧/建记录整段跳过：本用例只验 BLE 侧的刷屏时机与索引
  ctx.acquireFrame = () =>
    Promise.resolve({
      frameData: new Uint8Array(8),
      taskId: 't1',
      upirId: 'u1',
      prepared: null,
      timings: {}
    })
  const finished = []
  ctx.finishProjection = (device, options) => {
    finished.push(options)
  }
  await ctx.runRealProjection()
  // 刷屏是 fire-and-forget：让已排上的微任务跑完再断言
  await new Promise(resolve => setImmediate(resolve))
  return { trace, finished: finished[0] || {} }
}

// 跑测试时静音页面日志，只留断言失败
const consoleLog = console.log
const consoleWarn = console.warn
const consoleError = console.error
const mute = () => {
  console.log = () => {}
  console.warn = () => {}
  console.error = () => {}
}
const unmute = () => {
  console.log = consoleLog
  console.warn = consoleWarn
  console.error = consoleError
}

;(async () => {
  // ① 三张全部成功：中途一次不刷，收尾只刷一次，刷的是第一张的槽位 0
  mute()
  let r = await runProjection(3, [true, true, true])
  unmute()
  assert.deepStrictEqual(r.trace, [
    'upload:0',
    'upload:1',
    'upload:2',
    'refresh:0'
  ])
  assert.strictEqual(r.finished.uploaded, 3)

  // ② 中途失败（第 2 张挂）：失败那张先回滚 0x12，随后整单收尾仍按第一张成功的槽位刷一次。
  //    这正是 2026-08-20 修正的场景——此前只有「最后一张传完」才刷，前面已经写进设备的图
  //    留在设备里，屏上却还停在投屏前那张。
  mute()
  r = await runProjection(3, [true, new Error('电子纸设备-图传中断'), true])
  unmute()
  assert.deepStrictEqual(r.trace, [
    'upload:0',
    'upload:1',
    'rollback:1',
    'refresh:0'
  ])
  assert.strictEqual(r.finished.uploaded, 1) // 部分成功
  assert.strictEqual(r.finished.failCount, 1)

  // ③ 第一张就失败：设备上没有本批任何一张图 → 一次刷屏都不能发
  mute()
  r = await runProjection(2, [new Error('电子纸设备-图传中断'), true])
  unmute()
  assert.deepStrictEqual(r.trace, ['upload:0', 'rollback:0'])
  assert.strictEqual(r.finished.uploaded, 0)

  // ④ 单张投屏：口径不变，传完刷自己的槽位
  mute()
  r = await runProjection(1, [true])
  unmute()
  assert.deepStrictEqual(r.trace, ['upload:0', 'refresh:0'])

  // ⑤ 索引只认设备事实：设备上 0、1 号槽已被占（0x01 的 IMG_MASK 说了算）→ 本批第一张落 2 号槽，
  //    收尾就刷 2 号。后端记账接口这时回的是 imgIndex=9，绝不能被拿去刷屏。
  mute()
  r = await runProjection(2, [true, true], [0, 1])
  unmute()
  assert.deepStrictEqual(r.trace, ['upload:2', 'upload:3', 'refresh:2'])

  // ⑥ 开关关闭（2026-08-20 起的默认态）：三张全部传完也一条 0x24 都不发，设备显示保持不变；
  //    图传/回滚/成功判定不受影响。
  mute()
  r = await runProjection(3, [true, true, true], [], false)
  unmute()
  assert.deepStrictEqual(r.trace, ['upload:0', 'upload:1', 'upload:2'])
  assert.strictEqual(r.finished.uploaded, 3)

  console.log('projection-final-refresh: 6 组用例通过')
})().catch(error => {
  unmute()
  console.error(error)
  process.exit(1)
})
