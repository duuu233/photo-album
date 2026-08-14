// 大包不可用自动降级（utils/device-ble.js uploadImage → IMG_CHUNK_UNSUPPORTED → 安全档重传 + 按机档案）。
//
// 2026-08-14 真机回归暴露的两种故障形态，客户端都必须自愈：
//   A. 零推进：一包都不确认——老固件帧解析器认不了 >244 字节整帧（6.8.2 原始上限），或安卓栈
//      虚报 MTU、大包被链路静默丢弃。3 轮等待（≈2.5s）即降级。
//   B. 中途卡死（本轮真机实录：停在第 17 包）：大包解析没问题，但固件在持续大包流下接收任务
//      卡死，窗口退到 1/间隔 16ms 也一包不推进。连续 5 轮无推进即降级（0x20 重发会让设备复位
//      接收状态，安全档从头重传）。
// 两种形态都要把设备记入持久档案（imgSafeChunkDevices）：卡死后设备常整个失联（「电子纸设备
// 未连接」），断开重连即新会话——不持久化的话下一次投屏又会拿大包把设备再撞死一次。
const assert = require('assert')
const protocol = require('../utils/frame-protocol')

const SERVICE_UUID = '0000FF00-0000-1000-8000-00805F9B34FB'
const WRITE_UUID = '0000FF01-0000-1000-8000-00805F9B34FB'
const NOTIFY_UUID = '0000FF02-0000-1000-8000-00805F9B34FB'

const STACK_MTU = 500 // BLE 栈层照样协商出大 MTU（应用层能力另说——这正是坑所在）
const APP_FRAME_MAX = 244 // 6.8.2 原始整帧上限 = 236 数据 + 8 开销

// mode:
//   'oldParser'：整帧 >244 字节直接丢弃（形态 A：零推进）
//   'wedge'    ：大包能收能确认，但按序收满 wedgeAfter 个大包后接收任务卡死、从此不回任何 0x23；
//                收到新的 0x20 IMG_START 会复位接收状态（形态 B：中途卡死，可被重发 0x20 救活）
function createFakeDevice(deviceId, mode, options) {
  return {
    deviceId,
    mode,
    wedgeAfter: (options && options.wedgeAfter) || 18,
    wedged: false,
    expectedSeq: 0,
    received: 0,
    bigReceived: 0,
    oversizedDropped: 0
  }
}

// sharedStorage：跨「重装假蓝牙栈 + 重新 require device-ble」保留的本地存储，
// 用来模拟真机上的「断开重连/杀进程重开」——按机档案必须能穿越会话。
function installFakeBle(device, sharedStorage) {
  let valueListener = null

  const notifyFrame = (cmd, payload) => {
    const value = protocol.buildFrame(cmd, payload)
    setTimeout(() => {
      if (valueListener) {
        valueListener({
          deviceId: device.deviceId,
          serviceId: SERVICE_UUID,
          characteristicId: NOTIFY_UUID,
          value
        })
      }
    }, 0)
  }

  const ackFrame = (ackCmd, result, data) =>
    notifyFrame(protocol.CMD.ACK, [ackCmd, result].concat(data || []))

  const handleFrame = value => {
    const isBig = value.byteLength > APP_FRAME_MAX
    if (device.mode === 'oldParser' && isBig) {
      device.oversizedDropped++ // 老固件第一道闸：超过解析缓冲整帧丢弃，任何指令都不回
      return
    }
    const parsed = protocol.tryParseFrame(value)
    if (!parsed || !parsed.frame.crcOk) {
      return
    }
    const { cmd, payload } = parsed.frame
    if (cmd === protocol.CMD.IMG_START) {
      device.expectedSeq = 0
      device.wedged = false // 新 0x20 复位接收状态：卡死可被「从头重传」救活
      ackFrame(protocol.CMD.IMG_START, 0x00)
      return
    }
    if (cmd === protocol.CMD.IMG_DATA) {
      if (device.wedged) {
        return // 接收任务已卡死：数据包全部石沉大海
      }
      const seq = protocol.parseImgAck(payload).ackSeq
      if (seq === device.expectedSeq) {
        device.expectedSeq++
        device.received++
        if (isBig) {
          device.bigReceived++
        }
        notifyFrame(protocol.CMD.IMG_ACK, [
          (device.expectedSeq - 1) & 0xff,
          ((device.expectedSeq - 1) >> 8) & 0xff
        ])
        // 形态 B：按序吃满 wedgeAfter 个大包后，接收任务卡死（真机实录 ≈ 第 18 个）
        if (device.mode === 'wedge' && isBig && device.bigReceived >= device.wedgeAfter) {
          device.wedged = true
        }
      }
      return
    }
    if (cmd === protocol.CMD.IMG_END) {
      const mask = new Array(12).fill(0)
      mask[0] = 0x01
      ackFrame(
        protocol.CMD.IMG_END,
        0x00,
        mask.concat([1, 0], [0x00, 0x10, 0x00, 0x00])
      )
      return
    }
    if (cmd === protocol.CMD.SET_CONN_INTERVAL || cmd === protocol.CMD.GET_CONN_INTERVAL) {
      ackFrame(cmd, 0x00, [6, 0])
    }
  }

  global.wx = {
    getStorageSync: key => (key in sharedStorage ? sharedStorage[key] : ''),
    setStorageSync: (key, value) => {
      sharedStorage[key] = value
    },
    removeStorageSync: key => {
      delete sharedStorage[key]
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
    setBLEMTU: ({ success }) => success({ mtu: STACK_MTU }),
    getBLEMTU: ({ success }) => success({ mtu: STACK_MTU }),
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

function freshDeviceBle() {
  delete require.cache[require.resolve('../utils/device-ble')]
  return require('../utils/device-ble')
}

// 40 个大包的图：足够触发探测，又让降级后的重传（÷236 → 83 包）跑得快
const IMAGE = new Uint8Array(489 * 40)
for (let i = 0; i < IMAGE.length; i++) {
  IMAGE[i] = i & 0xff
}

function upload(deviceBle, deviceId, index) {
  // 走真实投屏那条调用路径：不传 chunkSize/window/pace/adaptive，全部吃默认值
  return deviceBle.uploadImage(deviceId, {
    screenType: 0x02,
    index,
    width: 680,
    height: 960,
    data: IMAGE
  })
}

async function main() {
  // ═══ 形态 A：老固件零推进（整帧 >244 一律丢弃）═══════════════════════════════
  const storageA = {}
  const oldFw = createFakeDevice('DEV-OLDFW-1', 'oldParser')
  installFakeBle(oldFw, storageA)
  let deviceBle = freshDeviceBle()

  const first = (await upload(deviceBle, oldFw.deviceId, 0)).transferStats
  assert.strictEqual(first.success, true, '降级后必须传完，而不是 15 次重试后判失败')
  assert.strictEqual(first.paramFallback, true, '必须是走安全档重传成功的')
  assert.strictEqual(first.chunkSize, 236, '安全档每包 236 字节')
  assert.strictEqual(first.window, 10, '安全档窗口 10 包')
  assert.strictEqual(
    oldFw.received,
    Math.ceil(IMAGE.length / 236),
    '设备按 236 字节分包完整收齐'
  )
  assert.ok(oldFw.oversizedDropped >= 1, '首次尝试的大包确实被设备丢弃过（测试前提自检）')

  // 同一条连接的第二张：安全档已写回会话，从头就按 236 分包，不再重付探测
  oldFw.expectedSeq = 0
  oldFw.received = 0
  const second = (await upload(deviceBle, oldFw.deviceId, 1)).transferStats
  assert.strictEqual(second.success, true)
  assert.strictEqual(second.chunkSize, 236, '会话已记住安全档：第二张直接按 236 分包')
  assert.strictEqual(second.paramFallback, false, '第二张不该再经历「先撞墙再降级」')
  assert.strictEqual(second.ackGraceWaits, 0, '第二张不该再有零推进等待')

  // 持久档案：断开重连（新会话、模块重载，本地存储保留）后第一张就直接走安全档
  assert.ok(
    storageA.imgSafeChunkDevices && storageA.imgSafeChunkDevices[oldFw.deviceId],
    '触发降级后必须把设备记入持久档案'
  )
  const oldFwAgain = createFakeDevice('DEV-OLDFW-1', 'oldParser')
  installFakeBle(oldFwAgain, storageA) // 同一份存储 = 同一台手机
  deviceBle = freshDeviceBle()
  const reconnected = (await upload(deviceBle, oldFwAgain.deviceId, 0)).transferStats
  assert.strictEqual(reconnected.success, true)
  assert.strictEqual(reconnected.safeProfile, true, '档案命中：直接按安全档传')
  assert.strictEqual(reconnected.paramFallback, false, '没有再经历撞墙探测')
  assert.strictEqual(reconnected.chunkSize, 236)
  assert.strictEqual(
    oldFwAgain.oversizedDropped,
    0,
    '重连后一个大包都不该再发出去（这正是防止把设备再撞失联的关键）'
  )

  // ═══ 形态 B：中途卡死（真机实录：前 18 个大包正常确认后接收任务卡死）═══════════
  const storageB = {}
  const wedgeFw = createFakeDevice('DEV-WEDGE-1', 'wedge', { wedgeAfter: 18 })
  installFakeBle(wedgeFw, storageB)
  deviceBle = freshDeviceBle()

  const wedged = (await upload(deviceBle, wedgeFw.deviceId, 0)).transferStats
  assert.strictEqual(
    wedged.success,
    true,
    '中途卡死必须被识别并降级传完，而不是耗满 15 次重试判失败'
  )
  assert.strictEqual(wedged.paramFallback, true, '走的是安全档重传')
  assert.strictEqual(wedged.chunkSize, 236)
  assert.ok(
    wedgeFw.bigReceived >= 18,
    `卡死前确实收进过大包（实际 ${wedgeFw.bigReceived} 个，测试前提自检）`
  )
  assert.strictEqual(
    wedgeFw.received - wedgeFw.bigReceived,
    Math.ceil(IMAGE.length / 236),
    '安全档重传从第 0 包从头收齐（0x20 已复位设备接收状态）'
  )
  assert.ok(
    storageB.imgSafeChunkDevices && storageB.imgSafeChunkDevices[wedgeFw.deviceId],
    '中途卡死同样记入持久档案'
  )

  console.log('img-chunk-fallback tests passed')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
