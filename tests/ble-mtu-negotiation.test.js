// 建连时的 MTU 协商与分包大小（utils/device-ble.js establishConnection → negotiateMtu / chunkFromMtu）。
//
// 2026-08-14：真实投屏建连的请求值由 247 提到 500（配套每包 489 字节）。风险是「有的安卓栈对超出
// 自身上限的请求不降级、直接报错」——真那样就该退回老的 247，而不是掉到系统默认 MTU 23 把图传拖死。
// 这里用假蓝牙栈把三种机型行为各跑一遍，锁住「协商到多少 → 每包分多少字节」这条链。
const assert = require('assert')

const DEVICE_ID = 'DEV-MTU-1'
const SERVICE_UUID = '0000FF00-0000-1000-8000-00805F9B34FB'
const WRITE_UUID = '0000FF01-0000-1000-8000-00805F9B34FB'
const NOTIFY_UUID = '0000FF02-0000-1000-8000-00805F9B34FB'

// behavior.setMtu(requested)：返回协商到的 MTU，返回 0 表示这次 setBLEMTU 直接失败（走 fail 回调）
// behavior.readMtu：getBLEMTU 读回的值（0 表示读不到，让 device-ble 走 185 兜底）
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
      const negotiated = behavior.setMtu(mtu)
      if (negotiated) {
        success({ mtu: negotiated })
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
  // ── 用例 1：设备/手机都吃得下 500 → 每包 489 字节（08-14 起的默认口径）─────────
  const full = await connectWith({ setMtu: mtu => mtu, readMtu: 0 })
  assert.strictEqual(full.session.mtu, 500, '默认应请求并协商到 MTU 500')
  assert.strictEqual(full.session.dataChunk, 489, 'MTU 500 → 每包 489 字节（489+8=497=500-3）')
  assert.deepStrictEqual(full.requests, [500], '一次就成，不该有多余的重协商')

  // ── 用例 2：安卓栈把请求降级到自己的上限（返回实际协商值）→ 按实际值收缩 ────────
  const capped = await connectWith({ setMtu: () => 247, readMtu: 0 })
  assert.strictEqual(capped.session.mtu, 247)
  assert.strictEqual(capped.session.dataChunk, 236, '顶不到 500 时退回老的 236 字节分包')

  // ── 用例 3：安卓栈对 500 直接报错（不降级）→ 按 247 再请求一次，不能掉到系统默认 ──
  const strict = await connectWith({
    setMtu: mtu => (mtu > 247 ? 0 : mtu), // >247 一律失败
    readMtu: 23 // 若不回退，就会读到系统默认的 23
  })
  assert.deepStrictEqual(strict.requests, [500, 247], '500 失败后必须按 247 回退请求一次')
  assert.strictEqual(strict.session.mtu, 247)
  assert.strictEqual(strict.session.dataChunk, 236)

  // ── 用例 4：iOS —— setBLEMTU 不支持，只能读回系统协商值 ────────────────────
  const ios = await connectWith({ setMtu: () => 0, readMtu: 185 })
  assert.strictEqual(ios.session.mtu, 185, 'iOS 读回系统协商到的实际 MTU')
  assert.strictEqual(ios.session.dataChunk, 174, 'MTU 185 → 每包 174 字节（MTU-11）')

  // ── 用例 5：两条路都拿不到值 → 对 iOS 安全的 185 兜底，绝不按 500 硬发 ─────────
  const blind = await connectWith({ setMtu: () => 0, readMtu: 0 })
  assert.strictEqual(blind.session.mtu, 185, '读不到就用保守兜底值')
  assert.strictEqual(blind.session.dataChunk, 174)

  console.log('ble-mtu-negotiation tests passed')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
