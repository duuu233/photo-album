// 建连时的 MTU 协商与分包大小（utils/device-ble.js establishConnection → negotiateMtu / chunkFromMtu）。
//
// 2026-08-14：真实投屏建连的请求值由 247 提到 500（配套每包 489 字节）。两类真机风险都要锁住：
//   ① 有的安卓栈对超出自身上限的请求**不降级、直接报错**——该退回老的 247，不能掉到系统默认 23；
//   ② 有的安卓栈在「服务/特征刚发现完」这一刻接受 setBLEMTU 并回调成功，但 ATT MTU 交换其实
//     还没落定，回调/getBLEMTU 给的都是**虚高的请求值**。按它分包（497 字节整帧）会被链路静默
//     丢弃，表现为「前十几包侥幸过去、之后彻底卡死」——正是 2026-08-14 真实投屏的现场故障。
//     修复：建连时协商两次（间隔 120ms）并**取小**，第二次读到的才是链路真正落定的值。
//     （调试台一直是「建连 → 连上后再 renegotiateMtu」两步，所以同一台设备在调试台就是快的。）
const assert = require('assert')

const DEVICE_ID = 'DEV-MTU-1'
const SERVICE_UUID = '0000FF00-0000-1000-8000-00805F9B34FB'
const WRITE_UUID = '0000FF01-0000-1000-8000-00805F9B34FB'
const NOTIFY_UUID = '0000FF02-0000-1000-8000-00805F9B34FB'

// behavior.setMtu(requested)：返回 setBLEMTU 成功回调里的 mtu 值，返回 0 表示这次调用直接失败。
// behavior.readMtu：getBLEMTU 读回的值（0 表示读不到，让 device-ble 走 185 兜底）。
// 两者要按被模拟的机型行为**自洽地**给：读回值代表链路真实协商结果。
function installFakeBle(behavior) {
  const requests = []
  global.wx = {
    getStorageSync: () => '',
    setStorageSync: () => {},
    removeStorageSync: () => {},
    getDeviceInfo: () => ({ platform: 'android' }),
    createBLEConnection: ({ success }) => success({}),
    closeBLEConnection: ({ success }) => success && success({}),
    getBLEDeviceServices: ({ success }) => success({ services: [{ uuid: SERVICE_UUID }] }),
    getBLEDeviceCharacteristics: ({ success }) =>
      success({
        characteristics: [
          { uuid: WRITE_UUID, properties: { write: false, writeNoResponse: true } },
          { uuid: NOTIFY_UUID, properties: { notify: true } }
        ]
      }),
    notifyBLECharacteristicValueChange: ({ success }) => success({}),
    onBLECharacteristicValueChange: () => {},
    onBLEConnectionStateChange: () => {},
    setBLEMTU: ({ mtu, success, fail }) => {
      requests.push(mtu)
      const claimed = behavior.setMtu(mtu)
      if (claimed) {
        success({ mtu: claimed })
      } else {
        fail({ errMsg: 'setBLEMTU:fail' })
      }
    },
    getBLEMTU: ({ success, fail }) =>
      behavior.readMtu ? success({ mtu: behavior.readMtu }) : fail({ errMsg: 'getBLEMTU:fail' })
  }
  return requests
}

async function connectWith(behavior) {
  const requests = installFakeBle(behavior)
  delete require.cache[require.resolve('../utils/device-ble')]
  const deviceBle = require('../utils/device-ble')
  const session = await deviceBle.ensureConnection(DEVICE_ID)
  return { session, requests }
}

async function main() {
  // ── 用例 1：设备/手机都吃得下 500，读回一致 → 每包 489 字节（08-14 起的默认口径）─────
  const full = await connectWith({ setMtu: mtu => mtu, readMtu: 500 })
  assert.strictEqual(full.session.mtu, 500, '默认应请求并协商到 MTU 500')
  assert.strictEqual(full.session.dataChunk, 489, 'MTU 500 → 每包 489 字节（489+8=497=500-3）')
  assert.deepStrictEqual(
    full.requests,
    [500, 500],
    '建连协商两次并复核（第二次才是链路落定值）'
  )

  // ── 用例 1b：读回失败（老基础库无 getBLEMTU 返回）→ 信 setBLEMTU 的返回值 ────────────
  const noRead = await connectWith({ setMtu: mtu => mtu, readMtu: 0 })
  assert.strictEqual(noRead.session.mtu, 500, '读不回时用 setBLEMTU 的返回值')
  assert.strictEqual(noRead.session.dataChunk, 489)

  // ── 用例 2：安卓栈把请求降级到自己的上限（返回实际协商值）→ 按实际值收缩 ────────────
  const capped = await connectWith({ setMtu: () => 247, readMtu: 247 })
  assert.strictEqual(capped.session.mtu, 247)
  assert.strictEqual(capped.session.dataChunk, 236, '顶不到 500 时退回老的 236 字节分包')

  // ── 用例 3：安卓栈对 500 直接报错（不降级）→ 按 247 再请求一次，不能掉到系统默认 ──────
  const strict = await connectWith({
    setMtu: mtu => (mtu > 247 ? 0 : mtu), // >247 一律失败
    readMtu: 247 // 回退请求成功后，链路真实协商在 247
  })
  assert.deepStrictEqual(
    strict.requests,
    [500, 247, 500, 247],
    '两轮协商，每轮都是「500 失败 → 按 247 回退请求」'
  )
  assert.strictEqual(strict.session.mtu, 247)
  assert.strictEqual(strict.session.dataChunk, 236)

  // ── 用例 4：虚高机型（08-14 真实投屏故障形态）──────────────────────────────────
  // 第一轮协商 setBLEMTU/getBLEMTU 都回显虚高的 500（ATT 交换未落定），120ms 后第二轮才
  // 读到链路真值 247。信了虚高值就会写出 497 字节的包被静默丢弃、传十几包后彻底卡死。
  let round = 0
  const liar = await connectWith({
    setMtu: mtu => (++round <= 1 ? mtu : 247), // 第一轮回显请求值，之后是真值
    get readMtu() {
      return round <= 1 ? 500 : 247
    }
  })
  assert.strictEqual(
    liar.session.mtu,
    247,
    '两轮取小 → 按链路真值 247 分包，绝不按虚高的 500'
  )
  assert.strictEqual(liar.session.dataChunk, 236)

  // ── 用例 5：iOS —— setBLEMTU 不支持，只能读回系统协商值 ────────────────────────────
  const ios = await connectWith({ setMtu: () => 0, readMtu: 185 })
  assert.strictEqual(ios.session.mtu, 185, 'iOS 读回系统协商到的实际 MTU')
  assert.strictEqual(ios.session.dataChunk, 174, 'MTU 185 → 每包 174 字节（MTU-11）')

  // ── 用例 6：两条路都拿不到值 → 对 iOS 安全的 185 兜底，绝不按 500 硬发 ───────────────
  const blind = await connectWith({ setMtu: () => 0, readMtu: 0 })
  assert.strictEqual(blind.session.mtu, 185, '读不到就用保守兜底值')
  assert.strictEqual(blind.session.dataChunk, 174)

  console.log('ble-mtu-negotiation tests passed')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
