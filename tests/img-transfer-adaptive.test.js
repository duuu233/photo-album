// 图传窗口自适应（utils/device-ble.js uploadImage）。
//
// 现场问题一（2026-08-11）：调试台把发包窗口从 10 提到 50、每包字节数与 MTU 也一并调大后，
// 传输**更慢**且频繁停在「传输卡顿：停在第 N 包，正第 5 次重发…」。
//
// 根因是老的窗口逻辑没有拥塞控制：
//   ① 窗口/每包间隔恒等于配置值，卡住只在**当轮**临时缩一点，一有推进立刻弹回满窗；
//   ② 「减速兜底」写成 curPace = Math.min(pace, curPace + 步长)，被配置值封顶，实际永远降不下速；
//   ③ ACK 超时是固定 600ms，设备只是慢（写 Flash / 窗口大排队深）也会被判成丢包并整窗重发。
// 于是窗口越大，「灌满 → 溢出丢包 → 后续整窗作废 → 等满超时 → 整窗重发 → 再灌满」这个循环
// 每转一圈的代价越大 —— 参数调大反而更慢、更容易把重试预算耗光判失败。
//
// 现场问题二（2026-08-14，参数升为真实投屏默认后的真机回归）：AIMD 本身也有三处把「偶发丢包」
// 放大成「持续慢」的毛病：
//   ④ 窗口没有丢包记忆——减半收敛到设备吃得下的档位后，每 2 个干净窗口就 +6 往回涨，涨过设备
//     缓冲又溢出，每次溢出付出「宽限+超时+整窗重发」≈1~2s，一张几百包的图反复撞墙几十次；
//   ⑤ 每包间隔退让翻倍到几十 ms 后，只按每 6 个干净窗口 -0.5ms 的速度慢探，基本一整张图回不来；
//   ⑥ 每次重试后宽限额度被重置，同一个卡点每一轮都白付一次双倍超时的宽限。
// 修复：capWindow 丢包记忆（类 TCP ssthresh，超时后窗口最多涨回丢包点减半值，每 8 个干净窗口
// 才 +1 上探）、pace 每 2 个干净窗口砍半回落、宽限每个卡点只付一次、收敛结果记到会话
// (session.tunedWindow) 供同连接下一张直接使用。
//
// 这里用一台「收包缓冲有限、处理有速度上限」的假设备驱动真实的 uploadImage：
//   · 缓冲满时静默丢包（真机溢出行为），按序累计确认，乱序包一律丢弃；
//   · ackEvery 可选：按真机口径「每 N 包才回一次 0x23」（性能档案实测固件为每 10 包一回），
//     处理完积压后补报一次当前进度（尾部冲刷），别让小窗口死锁。
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
//   ackEvery：每按序收多少包回一次 0x23（缺省 1=每包都回；真机口径 10）
function createFakeDevice(options) {
  return {
    bufferDepth: options.bufferDepth,
    processMs: options.processMs,
    ackEvery: options.ackEvery || 1,
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

// 传下一张前把假设备的单张传输状态清零（连接/会话保持不动）
function resetFakeDevice(device) {
  if (device.timer) {
    clearTimeout(device.timer)
  }
  device.queue = []
  device.expectedSeq = 0
  device.dropped = 0
  device.outOfOrder = 0
  device.duplicates = 0
  device.received = 0
  device.started = false
  device.ended = false
  device.timer = null
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

  const notifyImgAck = () =>
    notifyFrame(protocol.CMD.IMG_ACK, [
      (device.expectedSeq - 1) & 0xff,
      ((device.expectedSeq - 1) >> 8) & 0xff
    ])

  // 设备侧处理循环：每 processMs 消化一包。按序才收，乱序作废（累计确认语义）。
  // 0x23 按 ackEvery 的节奏回；处理完积压后补报一次当前进度（尾部冲刷）。
  const pump = () => {
    if (!device.queue.length) {
      device.timer = null
      return
    }
    const seq = device.queue.shift()
    if (seq === device.expectedSeq) {
      device.expectedSeq++
      device.received++
      if (
        device.expectedSeq % device.ackEvery === 0 ||
        device.queue.length === 0
      ) {
        notifyImgAck()
      }
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

// 装好假蓝牙栈并拿到一份全新的 device-ble（会话从零开始）
function setupBle(device) {
  installFakeBle(device)
  delete require.cache[require.resolve('../utils/device-ble')]
  return require('../utils/device-ble')
}

// 在已建立的会话上传一张。options.adaptive 传 null 表示「整个参数都不传」，
// 用来验真实投屏那条不带参数的调用路径（2026-08-14 起默认即 AIMD 自适应）。
async function transferOnce(deviceBle, device, options) {
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

async function runTransfer(device, options) {
  return transferOnce(setupBle(device), device, options)
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
  assert.strictEqual(
    fastStats.finalWindowCap,
    50,
    '没丢过包，丢包记忆(cap)应保持在配置上限'
  )
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
    slowStats.finalWindowCap < 50,
    `丢包记忆应钉在设备吃得下的档位附近（实际 cap ${slowStats.finalWindowCap}）`
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

  // ── 用例 4：真机口径复现（2026-08-14 现场问题）——缓冲 10 包 + 每 10 包才回一次 0x23 ──
  // 这正是「窗口 50 默认值」在老 AIMD 下慢好几倍的组合：溢出丢包后窗口减半收敛，
  // 但每 2 个干净窗口就 +6 涨回去，涨过缓冲又溢出，每次溢出 ≈1~2s——一张图撞墙几十次。
  // 丢包记忆(capWindow)修复后：收敛一次就钉住，只按每 8 个干净窗口 +1 小步上探，
  // 全程退让次数必须收敛到个位数。
  const cadence = createFakeDevice({ bufferDepth: 10, processMs: 5, ackEvery: 10 })
  const cadenceBle = setupBle(cadence)
  const cadenceStats = await transferOnce(cadenceBle, cadence, { window: 50, pace: 3 })
  assert.strictEqual(cadenceStats.success, true, '真机口径下必须收敛并传完')
  assert.strictEqual(cadence.expectedSeq, TOTAL_PACKETS, '设备侧按序完整收齐')
  assert.ok(
    cadenceStats.retryEvents <= 8,
    `丢包记忆必须止住「涨回→再溢出」的反复撞墙（实际退让 ${cadenceStats.retryEvents} 次）`
  )
  // cap 收敛到的具体档位取决于 pace 与设备处理速度的比值（发得慢时在途包少，可持续窗口
  // 可以大于缓冲深度），只锁「不涨回配置上限」——涨回去就说明丢包记忆失效、还会再溢出。
  assert.ok(
    cadenceStats.finalWindowCap < 50,
    `cap 不应涨回配置上限（实际 ${cadenceStats.finalWindowCap}）`
  )
  assert.ok(
    cadenceStats.retransmittedPackets < TOTAL_PACKETS,
    `重发包数必须有界（实际 ${cadenceStats.retransmittedPackets}）`
  )

  // ── 用例 4b：同一条连接的第二张 —— 从上一张收敛出的稳态窗口出发，不再重新撞墙 ──────
  resetFakeDevice(cadence)
  const secondStats = await transferOnce(cadenceBle, cadence, { window: 50, pace: 3 })
  assert.strictEqual(secondStats.success, true)
  assert.ok(
    secondStats.retryEvents <= 2,
    `第二张应直接从 tunedWindow 稳态出发，几乎不再退让（实际 ${secondStats.retryEvents} 次）`
  )

  // ── 用例 5：不传 adaptive（=真实投屏 result.js 那条调用路径）→ 默认就是自适应 ────
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

  // ── 用例 6：显式 adaptive:false 仍能回到 legacy 老策略（保留做对照用）──────────
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
