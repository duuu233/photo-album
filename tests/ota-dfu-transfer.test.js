// OTA/DFU 传输收尾与设备状态复位（utils/ota-ble.js）。
//
// 真机实测（2026-08-11）：
//   第一次升级 →「OTA 传输中断：已发送 673/673 包后，电子纸设备未在 1.5s 内应答（疑似丢包）」
//   之后每次升级 →「OTA 启动被拒绝：设备状态错误（ACK=FC F1 05 F2）」
//
// 两条根因，本文件各锁一条：
//  ① 收尾窗口：设备按 PRN 信用窗口每收满 prn 包才回一次 DATA ACK，而最后一批往往凑不满
//     （673 包 / PRN=3 → 最后一窗只有 1 包）。旧实现对每一批都强等 ACK，于是**数据明明已全部发出**，
//     却在最后一包上超时判失败。收尾窗口的 ACK 必须按可选处理，直接发 END，由 END(0xF3) 的
//     total_bytes/CRC32 校验裁决成败。
//  ② 上一轮 DFU 半途中断后设备状态机还停在升级态，复用同一条 GATT 连接再 START 必被回 0x05；
//     失败后必须断链，并在遇到 0x05 时断链复位后自动重试一次，否则用户只能靠重启设备解套。
//
// 这里用一台「按信用窗口应答」的假设备驱动真实的 upgradeFirmware 主流程（不改协议层实现）。
const assert = require('assert')

const SERVICE_UUID = '0000FF10-0000-1000-8000-00805F9B34FB'
const CONTROL_UUID = '0000FF11-0000-1000-8000-00805F9B34FB'
const HEADER_SIZE = 128
const DEVICE_MTU = 251
const DEVICE_PRN = 3
const CHUNK = 244 // chunkFromMtu(251) = min(244, 251-3-2)

function checksum8(bytes) {
  return bytes.reduce((sum, byte) => (sum + byte) & 0xff, 0)
}

function withChecksum(bytes) {
  return bytes.concat([checksum8(bytes)])
}

function toArrayBuffer(bytes) {
  return new Uint8Array(bytes).buffer
}

// 假设备：只在收满一个 PRN 窗口时回 DATA ACK（真机行为），END 时校验累计字节数。
function createFakeDevice(options = {}) {
  return {
    dfu: !!options.startInDfu, // 上一轮没走完，设备还停在升级态 → START 回 0x05
    headerSeen: false,
    payloadBytes: 0,
    payloadPackets: 0,
    expectedPayload: options.expectedPayload,
    dropTailPacket: !!options.dropTailPacket, // 模拟收尾真丢包：END 必须报 0x09
    startAcks: 0,
    endResult: null
  }
}

function installFakeBle(device) {
  const listeners = { value: null, connection: null }
  const notify = bytes => {
    setTimeout(() => {
      if (listeners.value) {
        listeners.value({
          deviceId: 'DEV-1',
          serviceId: SERVICE_UUID,
          characteristicId: CONTROL_UUID,
          value: toArrayBuffer(bytes)
        })
      }
    }, 0)
  }

  const handleFrame = bytes => {
    const op = bytes[0]
    if (op === 0xf1) {
      device.startAcks += 1
      if (device.dfu) {
        notify(withChecksum([0xfc, 0xf1, 0x05])) // 设备状态错误
        return
      }
      device.dfu = true
      device.headerSeen = false
      device.payloadBytes = 0
      device.payloadPackets = 0
      notify(withChecksum([0xfc, 0xf1, 0x00, DEVICE_MTU, DEVICE_PRN]))
      return
    }
    if (op === 0xf2) {
      const dataLen = bytes.length - 2 // 去掉操作码与校验字节
      if (!device.headerSeen) {
        device.headerSeen = true
        assert.strictEqual(dataLen, HEADER_SIZE, '首个 DATA 包必须是 128 字节头信息')
        notify(withChecksum([0xfc, 0xf2, 0x00]))
        return
      }
      device.payloadPackets += 1
      const isTail = device.payloadBytes + dataLen >= device.expectedPayload
      if (device.dropTailPacket && isTail) {
        return // 这一包在空口丢了：设备没收到，也不会应答
      }
      device.payloadBytes += dataLen
      // 信用窗口：收满 PRN 包才回一次 ACK；不足一窗的收尾包不应答。
      if (device.payloadPackets % DEVICE_PRN === 0) {
        notify(withChecksum([0xfc, 0xf2, 0x00]))
      }
      return
    }
    if (op === 0xf3) {
      // 整包校验：total_bytes == bin_size 才算成功，否则 0x09 参数错误
      const ok = device.payloadBytes === device.expectedPayload
      device.endResult = ok ? 0x00 : 0x09
      device.dfu = false
      notify(withChecksum([0xfc, 0xf3, device.endResult]))
    }
  }

  global.wx = {
    createBLEConnection: ({ success }) => success({}),
    closeBLEConnection: ({ deviceId, success }) => {
      // 真机口径：断链后设备退出 DFU 状态，下次 START 才能重新开始
      device.dfu = false
      device.headerSeen = false
      device.payloadBytes = 0
      device.payloadPackets = 0
      if (listeners.connection) {
        listeners.connection({ deviceId: deviceId || 'DEV-1', connected: false })
      }
      if (success) {
        success({})
      }
    },
    getBLEDeviceServices: ({ success }) => success({ services: [{ uuid: SERVICE_UUID }] }),
    getBLEDeviceCharacteristics: ({ success }) =>
      success({
        characteristics: [
          {
            uuid: CONTROL_UUID,
            properties: { write: true, writeNoResponse: true, notify: true }
          }
        ]
      }),
    notifyBLECharacteristicValueChange: ({ success }) => success({}),
    setBLEMTU: ({ success }) => success({ mtu: DEVICE_MTU }),
    getBLEMTU: ({ success }) => success({ mtu: DEVICE_MTU }),
    onBLECharacteristicValueChange: cb => {
      listeners.value = cb
    },
    onBLEConnectionStateChange: cb => {
      listeners.connection = cb
    },
    writeBLECharacteristicValue: ({ value, success }) => {
      const bytes = Array.from(new Uint8Array(value))
      success({})
      handleFrame(bytes)
    }
  }
  return listeners
}

// 673 包、最后一窗只有 1 包（673 = 3×224 + 1）—— 与现场失败完全同形。
const TOTAL_PACKETS = 673
const PAYLOAD_SIZE = CHUNK * (TOTAL_PACKETS - 1) + 100
function buildPackage(payloadSize) {
  return new Uint8Array(HEADER_SIZE + payloadSize).buffer
}

;(async () => {
  // ① 收尾窗口收不到 DATA ACK 属预期，必须继续发 END 并按 END 结果判定成功
  {
    const device = createFakeDevice({ expectedPayload: PAYLOAD_SIZE })
    installFakeBle(device)
    delete require.cache[require.resolve('../utils/ota-ble')]
    const otaBle = require('../utils/ota-ble')

    const result = await otaBle.upgradeFirmware('DEV-1', {
      buffer: buildPackage(PAYLOAD_SIZE)
    }, { pace: 0 })

    assert.strictEqual(result.confirmed, true)
    assert.strictEqual(result.totalPackets, TOTAL_PACKETS)
    assert.strictEqual(device.payloadPackets, TOTAL_PACKETS, '所有数据包都要发出去')
    assert.strictEqual(device.payloadBytes, PAYLOAD_SIZE)
    assert.strictEqual(device.endResult, 0x00)
  }

  // ② 收尾包真丢了：END 的整包校验必须把它抓住，绝不能因为「收尾窗口不等 ACK」而误报成功
  {
    const device = createFakeDevice({
      expectedPayload: PAYLOAD_SIZE,
      dropTailPacket: true
    })
    installFakeBle(device)
    delete require.cache[require.resolve('../utils/ota-ble')]
    const otaBle = require('../utils/ota-ble')

    let failed = null
    try {
      await otaBle.upgradeFirmware('DEV-1', { buffer: buildPackage(PAYLOAD_SIZE) }, { pace: 0 })
    } catch (error) {
      failed = error
    }
    assert.ok(failed, '收尾丢包必须失败')
    assert.ok(/整包校验失败/.test(failed.message), failed.message)
    assert.strictEqual(device.endResult, 0x09)
  }

  // ③ 设备还停在上一轮 DFU 状态（START 回 0x05）：断链复位后自动重试一次即可继续升级，
  //    不该让用户从此每次都撞 0x05、只能去重启设备。
  {
    const device = createFakeDevice({
      expectedPayload: PAYLOAD_SIZE,
      startInDfu: true
    })
    installFakeBle(device)
    delete require.cache[require.resolve('../utils/ota-ble')]
    const otaBle = require('../utils/ota-ble')

    const result = await otaBle.upgradeFirmware('DEV-1', {
      buffer: buildPackage(PAYLOAD_SIZE)
    }, { pace: 0, stateResetWaitMs: 60 })

    assert.strictEqual(result.confirmed, true)
    // 复位前的 START 会被拒 1~2 次（doStart 对另一个 objType 也各给一次机会），
    // 关键是复位重连后还有一次并且成功了。
    assert.ok(device.startAcks >= 2, `复位后应重发 START，实际发了 ${device.startAcks} 次`)
  }

  console.log('ota-dfu-transfer.test.js 通过')
})().catch(error => {
  console.error(error)
  process.exitCode = 1
})
