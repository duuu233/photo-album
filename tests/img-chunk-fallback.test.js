// 大包零推进自动降级（utils/device-ble.js uploadImage → IMG_CHUNK_UNSUPPORTED → 安全档重传）。
//
// 2026-08-14 真机回归暴露的故障模式：链路 MTU 协商到 500、按 489 字节分包，但设备**一包都不确认**
// ——老固件的帧解析器认不了 >244 字节的整帧（6.8.2 原始上限 236+8），或部分安卓栈虚报 MTU、
// 大包在链路上被静默丢弃。修复前的表现：AIMD 再怎么退窗口也救不回来（问题不在速率在包本身），
// 15 次重试 ≈ 半分钟后抛「图传中断」，真实投屏整单失败回滚，设备常随之断连 →「电子纸设备未连接」。
// 修复后：3 轮零推进（≈2.5s）即断定「认不了这种包」，自动按 08-14 之前的安全档
// （每包 236 字节 / 窗口 10）从头重传，并把安全档写回会话——同连接后续图传直接用小包。
const assert = require('assert')
const protocol = require('../utils/frame-protocol')

const DEVICE_ID = 'DEV-OLDFW-1'
const SERVICE_UUID = '0000FF00-0000-1000-8000-00805F9B34FB'
const WRITE_UUID = '0000FF01-0000-1000-8000-00805F9B34FB'
const NOTIFY_UUID = '0000FF02-0000-1000-8000-00805F9B34FB'

// 模拟「BLE 栈支持 MTU 500、但应用层帧解析器只认 ≤244 字节整帧」的老固件：
// MTU 协商会成功（栈层行为），0x21 大包却在应用层被整帧丢弃、永远不确认。
const STACK_MTU = 500
const APP_FRAME_MAX = 244 // 6.8.2 原始整帧上限 = 236 数据 + 8 开销

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

  const handleFrame = value => {
    // 老固件的第一道闸：整帧超过解析缓冲直接丢弃，任何指令都不回
    if (value.byteLength > APP_FRAME_MAX) {
      device.oversizedDropped++
      return
    }
    const parsed = protocol.tryParseFrame(value)
    if (!parsed || !parsed.frame.crcOk) {
      return
    }
    const { cmd, payload } = parsed.frame
    if (cmd === protocol.CMD.IMG_START) {
      device.expectedSeq = 0
      ackFrame(protocol.CMD.IMG_START, 0x00)
      return
    }
    if (cmd === protocol.CMD.IMG_DATA) {
      const seq = protocol.parseImgAck(payload).ackSeq
      if (seq === device.expectedSeq) {
        device.expectedSeq++
        device.received++
        notifyFrame(protocol.CMD.IMG_ACK, [
          (device.expectedSeq - 1) & 0xff,
          ((device.expectedSeq - 1) >> 8) & 0xff
        ])
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

// 40 个大包的图：足够触发零推进探测，又让降级后的重传（÷236 → 83 包）跑得快
const IMAGE = new Uint8Array(489 * 40)
for (let i = 0; i < IMAGE.length; i++) {
  IMAGE[i] = i & 0xff
}

async function main() {
  const device = { expectedSeq: 0, received: 0, oversizedDropped: 0 }
  installFakeBle(device)
  delete require.cache[require.resolve('../utils/device-ble')]
  const deviceBle = require('../utils/device-ble')

  // 走真实投屏那条调用路径：不传 chunkSize/window/pace/adaptive，全部吃默认值。
  // 会话按 MTU 500 建立 → dataChunk 489 → 大包全被老固件丢弃 → 零推进 → 自动降级安全档。
  const summary = await deviceBle.uploadImage(DEVICE_ID, {
    screenType: 0x02,
    index: 0,
    width: 680,
    height: 960,
    data: IMAGE
  })
  const stats = summary.transferStats
  assert.strictEqual(stats.success, true, '降级后必须传完，而不是 15 次重试后判失败')
  assert.strictEqual(stats.paramFallback, true, '必须是走安全档重传成功的')
  assert.strictEqual(stats.chunkSize, 236, '安全档每包 236 字节')
  assert.strictEqual(stats.window, 10, '安全档窗口 10 包')
  assert.strictEqual(
    device.received,
    Math.ceil(IMAGE.length / 236),
    '设备按 236 字节分包完整收齐'
  )
  assert.ok(
    device.oversizedDropped >= 1,
    '首次尝试的大包确实被设备丢弃过（测试前提自检）'
  )

  // 同一条连接的第二张：安全档已写回会话，从头就按 236 分包，不再重付 ~2.5s 的零推进探测
  device.expectedSeq = 0
  device.received = 0
  const second = await deviceBle.uploadImage(DEVICE_ID, {
    screenType: 0x02,
    index: 1,
    width: 680,
    height: 960,
    data: IMAGE
  })
  const secondStats = second.transferStats
  assert.strictEqual(secondStats.success, true)
  assert.strictEqual(
    secondStats.chunkSize,
    236,
    '会话已记住安全档：第二张直接按 236 分包'
  )
  assert.strictEqual(
    secondStats.paramFallback,
    false,
    '第二张不该再经历「先撞墙再降级」'
  )
  assert.strictEqual(secondStats.ackGraceWaits, 0, '第二张不该再有零推进等待')

  console.log('img-chunk-fallback tests passed')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
