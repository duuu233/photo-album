// 图传窗口自适应（utils/device-ble.js uploadImage）。
//
// 现场问题（2026-08-11）：调试台把发包窗口从 10 提到 50、每包字节数与 MTU 也一并调大后，
// 传输**更慢**且频繁停在「传输卡顿：停在第 N 包，正第 5 次重发…」。
//
// 根因是老的窗口逻辑没有拥塞控制：
//   ① 窗口/每包间隔恒等于配置值，卡住只在**当轮**临时缩一点，一有推进立刻弹回满窗；
//   ② 「减速兜底」写成 curPace = Math.min(pace, curPace + 步长)，被配置值封顶，实际永远降不下速；
//   ③ ACK 超时是固定 600ms，设备只是慢（写 Flash / 窗口大排队深）也会被判成丢包并整窗重发。
// 于是窗口越大，「灌满 → 溢出丢包 → 后续整窗作废 → 等满超时 → 整窗重发 → 再灌满」这个循环
// 每转一圈的代价越大 —— 参数调大反而更慢、更容易把重试预算耗光判失败。
//
// 这里用一台「收包缓冲有限、处理有速度上限」的假设备驱动真实的 uploadImage：
//   · 缓冲满时静默丢包（真机溢出行为），按序累计确认，乱序包一律丢弃；
//   · 断言窗口 50 的激进配置能自动收敛到设备吃得下的速率并传完，而不是卡死。
const assert = require('assert')
const protocol = require('../utils/frame-protocol')

const DEVICE_ID = 'DEV-IMG-1'
const SERVICE_UUID = '0000FF00-0000-1000-8000-00805F9B34FB'
const WRITE_UUID = '0000FF01-0000-1000-8000-00805F9B34FB'
const NOTIFY_UUID = '0000FF02-0000-1000-8000-00805F9B34FB'
const DEVICE_MTU = 500

// 假设备：收包进缓冲队列，按固定速度逐包处理并回 0x23 累计确认。
//   bufferDepth：缓冲能压多少包，压满后再来的包直接丢（对应真机「收包缓冲溢出」）
//   processMs：处理（含写 Flash）一包要多久 —— 它才是设备真正的吞吐上限
function createFakeDevice(options) {
  return {
    bufferDepth: options.bufferDepth,
    processMs: options.processMs,
    queue: [],
    expectedSeq: 0, // 下一个要按序收的包号
    dropped: 0, // 因缓冲溢出丢掉的包数
    outOfOrder: 0, // 丢包后到达的乱序包（全部作废，这正是大窗口的代价）
    duplicates: 0, // 重发过来的、已经收过的包
    received: 0,
    started: false,
    ended: false,
    timer: null
  }
}

function installFakeBle(device) {
  let valueListener = null

  const notifyFrame = (cmd, payload) => {
    const value = protocol.buildFrame(cmd, payload)
    setTimeout(() => {
      if (valueListener) {
        valueListener({
          deviceId: DEVICE_ID,
          serviceId: SERVICE_UUID,
          characteristicId: NOTIFY_UUID,
          value
        })
      }
    }, 0)
  }

  const ackFrame = (ackCmd, result, data) =>
    notifyFrame(protocol.CMD.ACK, [ackCmd, result].concat(data || []))

  // 设备侧处理循环：每 processMs 消化一包。按序才收，乱序作废（累计确认语义）。
  const pump = () => {
    if (!device.queue.length) {
      device.timer = null
      return
    }
    const seq = device.queue.shift()
    if (seq === device.expectedSeq) {
      device.expectedSeq++
      device.received++
      notifyFrame(protocol.CMD.IMG_ACK, [
        (device.expectedSeq - 1) & 0xff,
        ((device.expectedSeq - 1) >> 8) & 0xff
      ])
    } else if (seq < device.expectedSeq) {
      device.duplicates++
    } else {
      device.outOfOrder++
    }
    device.timer = setTimeout(pump, device.processMs)
  }

  const handleFrame = value => {
    const parsed = protocol.tryParseFrame(value)
    if (!parsed || !parsed.frame.crcOk) {
      return
    }
    const { cmd, payload } = parsed.frame
    if (cmd === protocol.CMD.IMG_START) {
      device.started = true
      ackFrame(protocol.CMD.IMG_START, 0x00)
      return
    }
    if (cmd === protocol.CMD.IMG_DATA) {
      if (device.queue.length >= device.bufferDepth) {
        device.dropped++ // 缓冲满：这一包在设备侧被静默丢掉
        return
      }
      device.queue.push(protocol.parseImgAck(payload).ackSeq) // 0x21 的 PKT_SEQ 与 0x23 同为首 2 字节小端
      if (!device.timer) {
        device.timer = setTimeout(pump, device.processMs)
      }
      return
    }
    if (cmd === protocol.CMD.IMG_END) {
      device.ended = true
      const mask = new Array(12).fill(0)
      mask[0] = 0x01
      ackFrame(
        protocol.CMD.IMG_END,
        0x00,
        mask.concat([1, 0], [0x00, 0x10, 0x00, 0x00]) // IMG_COUNT=1 + STORAGE_FREE
      )
      return
    }
    if (cmd === protocol.CMD.SET_CONN_INTERVAL || cmd === protocol.CMD.GET_CONN_INTERVAL) {
      ackFrame(cmd, 0x00, [6, 0])
    }
  }

  const storage = {}
  global.wx = {
    getStorageSync: key => (key in storage ? storage[key] : ''),
    setStorageSync: (key, value) => {
      storage[key] = value
    },
    removeStorageSync: key => {
      delete storage[key]
    },
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
    setBLEMTU: ({ success }) => success({ mtu: DEVICE_MTU }),
    getBLEMTU: ({ success }) => success({ mtu: DEVICE_MTU }),
    onBLECharacteristicValueChange: cb => {
      valueListener = cb
    },
    onBLEConnectionStateChange: () => {},
    writeBLECharacteristicValue: ({ value, success }) => {
      success({})
      handleFrame(value)
    }
  }
}

// 一张 200 包的图（够跑出好几轮窗口自适应，又不至于让用例跑太久）
const CHUNK = 489
const TOTAL_PACKETS = 200
const IMAGE = new Uint8Array(CHUNK * TOTAL_PACKETS)
for (let i = 0; i < IMAGE.length; i++) {
  IMAGE[i] = i & 0xff
}

// 2026-08-14 起 adaptive 是 uploadImage 的默认策略（真实投屏与调试台共用）；
// options.adaptive 传 null 表示「整个参数都不传」，用来验真实投屏那条不带参数的调用路径。
async function runTransfer(device, options) {
  installFakeBle(device)
  delete require.cache[require.resolve('../utils/device-ble')]
  const deviceBle = require('../utils/device-ble')
  const upload = {
    screenType: 0x02,
    index: 0,
    width: 680,
    height: 960,
    data: IMAGE,
    chunkSize: CHUNK,
    window: options.window,
    pace: options.pace
  }
  if (options.adaptive !== null) {
    upload.adaptive = options.adaptive !== false
  }
  const summary = await deviceBle.uploadImage(DEVICE_ID, upload)
  if (device.timer) {
    clearTimeout(device.timer)
  }
  return summary.transferStats
}

async function main() {
  // ── 用例 1：设备吃得下 50 包窗口 → 全速跑完，一次退让都不该有 ──────────────
  const fast = createFakeDevice({ bufferDepth: 64, processMs: 0 })
  const fastStats = await runTransfer(fast, { window: 50, pace: 3 })
  assert.strictEqual(fastStats.success, true, '链路干净时必须传完')
  assert.strictEqual(fastStats.totalPackets, TOTAL_PACKETS)
  assert.strictEqual(fastStats.retryEvents, 0, '不丢包就不该有任何退让')
  assert.strictEqual(fastStats.retransmittedPackets, 0, '不丢包就不该有重发')
  assert.strictEqual(fastStats.finalWindow, 50, '一路干净，窗口应始终保持在配置上限')
  // 链路干净时每包间隔只会持平或继续往下探，绝不该被「减速兜底」抬上去
  //（设备跟得上时 ACK 边发边到，窗口一直没填满，本来就轮不到降速探测）
  assert.ok(
    fastStats.finalPace <= fastStats.configuredPace,
    `链路干净时每包间隔不该被抬高（配置 ${fastStats.configuredPace} → 实际 ${fastStats.finalPace}）`
  )

  // ── 用例 2：设备只缓 6 包、每包要 2ms —— 窗口 50 必然打爆缓冲 ────────────────
  // 老逻辑在这里就是「灌满→丢→整窗重发→再灌满」的死循环（重发包数会滚到几倍于总包数，
  // 最终耗光 15 次重试判失败）。新逻辑必须自动把窗口收敛到设备吃得下的档位并传完。
  const slow = createFakeDevice({ bufferDepth: 6, processMs: 2 })
  const slowStats = await runTransfer(slow, { window: 50, pace: 0 })
  assert.strictEqual(slowStats.success, true, '设备吃不下时也必须自动收敛并传完，而不是卡死')
  assert.ok(
    slowStats.finalWindow < 50,
    `窗口应自适应退到设备吃得下的档位（实际收尾 ${slowStats.finalWindow}）`
  )
  assert.ok(
    slowStats.minWindow <= 25,
    `第一次卡顿就应把窗口减半（实际最低 ${slowStats.minWindow}）`
  )
  assert.ok(
    slowStats.finalPace > 0,
    `设备吃不下时每包间隔应退让上去（实际 ${slowStats.finalPace}ms）`
  )
  // 关键回归：重发量必须有界。老逻辑不收敛，重发包数会远超总包数。
  assert.ok(
    slowStats.retransmittedPackets < TOTAL_PACKETS,
    `重发包数应远小于总包数，否则说明还在震荡（实际重发 ${slowStats.retransmittedPackets} / 共 ${TOTAL_PACKETS} 包）`
  )
  assert.ok(
    slowStats.retryEvents <= 8,
    `退让次数应有限、快速收敛（实际 ${slowStats.retryEvents} 次）`
  )
  assert.strictEqual(
    slow.expectedSeq,
    TOTAL_PACKETS,
    '设备侧必须按序完整收齐每一包'
  )

  // ── 用例 3：设备慢但不丢包（缓冲够深）→ 不该被固定 600ms 超时误判成丢包 ──────
  // 每包 3ms、缓冲 200 包：数据都收得到，只是回 ACK 慢。这种情况一次重发都不该发生。
  const laggy = createFakeDevice({ bufferDepth: 256, processMs: 3 })
  const laggyStats = await runTransfer(laggy, { window: 50, pace: 0 })
  assert.strictEqual(laggyStats.success, true)
  assert.strictEqual(
    laggyStats.retransmittedPackets,
    0,
    '设备只是慢、没丢包，不该整窗重发（自适应超时 + 宽限等待要挡住误判）'
  )
  assert.strictEqual(laggy.outOfOrder, 0, '没有丢包就不该产生乱序作废包')

  // ── 用例 4：不传 adaptive（=真实投屏 result.js 那条调用路径）→ 默认就是自适应 ────
  // 2026-08-14：窗口默认由 10 提到 50，必须配套 AIMD，否则大窗口会退化成整窗重发的死循环。
  const projection = createFakeDevice({ bufferDepth: 6, processMs: 2 })
  const projectionStats = await runTransfer(projection, {
    window: 50,
    pace: 0,
    adaptive: null // 整个参数都不传
  })
  assert.strictEqual(
    projectionStats.adaptive,
    true,
    '真实投屏不传 adaptive，默认必须走 AIMD 自适应'
  )
  assert.strictEqual(projectionStats.success, true, '默认策略下设备吃不下也要收敛传完')
  assert.ok(
    projectionStats.finalWindow < 50,
    `默认策略应自适应退窗（实际收尾 ${projectionStats.finalWindow}）`
  )

  // ── 用例 5：显式 adaptive:false 仍能回到 legacy 老策略（保留做对照用）──────────
  const legacy = createFakeDevice({ bufferDepth: 6, processMs: 2 })
  const legacyStats = await runTransfer(legacy, {
    window: 50,
    pace: 0,
    adaptive: false
  })
  assert.strictEqual(legacyStats.adaptive, false, '显式 adaptive:false 才走 legacy 策略')
  assert.strictEqual(legacyStats.success, true)
  assert.strictEqual(
    legacyStats.finalWindow,
    50,
    'legacy 不做窗口自适应：窗口恒等于配置值'
  )
  assert.strictEqual(
    legacyStats.ackGraceWaits,
    0,
    'legacy 没有「宽限一轮再判丢包」这一步'
  )

  console.log('img-transfer-adaptive tests passed')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
