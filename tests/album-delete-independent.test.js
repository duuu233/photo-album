// 「我的相册」删除的两半互不阻断（2026-08-20 口径）+ **设备繁忙整批中止**（2026-08-24 例外）：
//   顺序仍是「先发设备删除指令(0x12) → 再调投屏记录删除接口」，但**任一半失败都不影响另一半**：
//   ① 设备侧回 Flash 写入失败/传输中断/断连超时 → 记录照删（改前是整批中止，记录一条都不删，
//      用户回相册看见照片还在、再点还是同样的报错）；
//   ② 记录接口失败 → 不回滚设备（设备上的图已经删掉了）；
//   ③ 两边结果最后合并成一条提示：谁失败说谁，都失败都说，都成功才是「已删除」；
//   ④ 「图片不存在/掩码不一致」(0x05/0x07)仍算良性——设备上本来就没有，不当失败报；
//   ⑤ **设备繁忙(0x0B) 是唯一的中止分支**（2026-08-24）：无论出现在 0x01 回读还是 0x12 应答上，
//      都只提示「当前电子纸设备繁忙，请稍后重试」，**设备侧与记录侧一律不动、列表不刷新**——
//      繁忙代表指令被主动拒绝、根本没执行，稍后重试即可，不该先把记录删掉留一张幽灵图。
const assert = require('assert')

const storage = {}
const wxBase = {
  getStorageSync: key => storage[key],
  setStorageSync: (key, value) => {
    storage[key] = value
  },
  showLoading: () => {},
  hideLoading: () => {}
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

let trace = [] // 按真实发生顺序记两半的调用，用来断言「先设备、再记录」且都被执行
let deleteImageResult = null // null=成功，Error=失败
let maskReadError = null // 非空 = 0x01 回读失败（用来造「回读时就繁忙」）
let recordResult = { total: 1, failed: 0 }
let toasts = []
let reloaded = 0 // loadPhotos 调用次数：中止分支不该刷新列表

stubModule('../utils/device-ble', {
  deleteImage: (deviceId, slots) => {
    trace.push(`device:${slots.join(',')}`)
    return deleteImageResult
      ? Promise.reject(deleteImageResult)
      : Promise.resolve()
  }
})
stubModule('../utils/device-info', {
  // 0x01 回读：0、1 号槽都还在设备上，两张都要真发 0x12
  read: () =>
    maskReadError
      ? Promise.reject(maskReadError)
      : Promise.resolve({ imgMask: [0x03].concat(new Array(11).fill(0)) })
})
stubModule('../utils/api', {
  deleteProjectionRecords: ids => {
    trace.push(`records:${ids.join(',')}`)
    return recordResult.failed === -1
      ? Promise.reject(new Error('接口炸了'))
      : Promise.resolve(recordResult)
  }
})
stubModule('../utils/toast', {
  warn: options => toasts.push(options.title),
  show: options => toasts.push(options.title),
  error: options => toasts.push(options.title)
})
stubModule('../utils/active-device', {
  friendlyConnectMessage: message => message || '连接失败'
})
stubModule('../utils/media', {})
stubModule('../utils/system', { getNavBarMetrics: () => ({}) })
stubModule('../utils/upload-limit', { getBatchLimit: () => 10 })
stubModule('../utils/fold-adapt', { adapt: options => options })

let pageOptions = null
global.Page = options => {
  pageOptions = options
}
require('../subpackages/album/list/list.js')

const record = (id, imgIndex) => ({
  id,
  imgIndex,
  userProductId: 'D1',
  deviceName: '相框'
})

const runDelete = async ({ deviceError, records, maskError }) => {
  trace = []
  toasts = []
  reloaded = 0
  maskReadError = maskError || null
  deleteImageResult = deviceError || null
  recordResult = records || { total: 2, failed: 0 }
  const ctx = Object.create(pageOptions)
  const photos = [record('a', '0'), record('b', '1')]
  ctx.data = {
    selectedMap: { a: true, b: true },
    filteredPhotos: photos,
    showDeleteConfirm: true,
    deleteClosing: false
  }
  ctx.setData = patch => Object.assign(ctx.data, patch)
  ctx.records = photos
  ctx.ensureConnectedDevice = () => Promise.resolve({ deviceId: 'BLE-1', id: 'D1' })
  ctx.loadPhotos = () => {
    reloaded += 1
  }
  await ctx.confirmDeleteSelected()
  return { trace, toasts, reloaded, selectedMap: ctx.data.selectedMap }
}

const consoleLog = console.log
const consoleWarn = console.warn
const mute = () => {
  console.log = () => {}
  console.warn = () => {}
}
const unmute = () => {
  console.log = consoleLog
  console.warn = consoleWarn
}

;(async () => {
  // ① 都成功：先设备后记录，提示「已删除」
  mute()
  let r = await runDelete({})
  unmute()
  assert.deepStrictEqual(r.trace, ['device:0,1', 'records:a,b'])
  assert.deepStrictEqual(r.toasts, ['已删除'])

  // ② 设备侧真失败（Flash 写入失败这类非良性、非繁忙结果码）：**记录照删**，提示带设备原因
  mute()
  r = await runDelete({ deviceError: new Error('电子纸设备-Flash 写入失败') })
  unmute()
  assert.deepStrictEqual(r.trace, ['device:0,1', 'records:a,b']) // 改前这里只有 device
  assert.strictEqual(r.toasts.length, 1)
  assert.ok(r.toasts[0].indexOf('投屏记录已删除') === 0)
  assert.ok(r.toasts[0].indexOf('Flash 写入失败') > 0)

  // ③ 记录接口失败：设备指令照发在前，不回滚
  mute()
  r = await runDelete({ records: { total: 2, failed: 2 } })
  unmute()
  assert.deepStrictEqual(r.trace, ['device:0,1', 'records:a,b'])
  assert.deepStrictEqual(r.toasts, ['照片已删除，投屏记录未全部删除，请稍后重试'])

  // ④ 两半都失败：两个调用都发生过，提示把两件事都说清楚
  mute()
  r = await runDelete({
    deviceError: new Error('电子纸设备-指令 0x12 应答超时'),
    records: { failed: -1 } // 接口直接抛
  })
  unmute()
  assert.deepStrictEqual(r.trace, ['device:0,1', 'records:a,b'])
  assert.ok(r.toasts[0].indexOf('电子纸设备与投屏记录都未删除成功') === 0)

  // ⑤ 良性结果码（图片不存在）：设备上本来就没有，不当失败报，仍是「已删除」
  mute()
  r = await runDelete({ deviceError: new Error('电子纸设备-图片不存在') })
  unmute()
  assert.deepStrictEqual(r.trace, ['device:0,1', 'records:a,b'])
  assert.deepStrictEqual(r.toasts, ['已删除'])

  // ⑥ 设备繁忙(0x0B) 在 0x12 应答上：整批中止——**记录接口一次都不调**，列表不刷新、选中态保留
  mute()
  r = await runDelete({
    deviceError: new Error('电子纸设备-当前电子纸设备繁忙，请稍后重试')
  })
  unmute()
  assert.deepStrictEqual(r.trace, ['device:0,1'], '繁忙时不得调投屏记录删除接口')
  assert.deepStrictEqual(r.toasts, ['当前电子纸设备繁忙，请稍后重试'])
  assert.strictEqual(r.reloaded, 0, '繁忙中止不刷新列表')
  assert.deepStrictEqual(r.selectedMap, { a: true, b: true }, '选中态保留，供直接重试')

  // ⑥' 结果码版（错误对象挂 resultCode=0x0B，文案随便）：同样中止
  mute()
  r = await runDelete({
    deviceError: Object.assign(new Error('电子纸设备-未知结果码 0x0b'), {
      resultCode: 0x0b
    })
  })
  unmute()
  assert.deepStrictEqual(r.trace, ['device:0,1'])
  assert.deepStrictEqual(r.toasts, ['当前电子纸设备繁忙，请稍后重试'])

  // ⑦ 繁忙出现在更早的 0x01 掩码回读上：连 0x12 都不发，两半都不动
  mute()
  r = await runDelete({
    maskError: new Error('电子纸设备-当前电子纸设备繁忙，请稍后重试')
  })
  unmute()
  assert.deepStrictEqual(r.trace, [], '回读繁忙时设备指令与记录接口都不该发生')
  assert.deepStrictEqual(r.toasts, ['当前电子纸设备繁忙，请稍后重试'])
  assert.strictEqual(r.reloaded, 0)

  // ⑧ 0x01 回读因别的原因失败（非繁忙）：口径不变，按选中槽位原样下发并照常删记录
  mute()
  r = await runDelete({ maskError: new Error('电子纸设备-指令 0x01 应答超时') })
  unmute()
  assert.deepStrictEqual(r.trace, ['device:0,1', 'records:a,b'])
  assert.deepStrictEqual(r.toasts, ['已删除'])

  console.log('album-delete-independent: 9 组用例通过')
})().catch(error => {
  unmute()
  console.error(error)
  process.exit(1)
})
