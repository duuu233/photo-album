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
    endPayloadBytes: 0, // 收到 END 那一刻的快照（断链复位会把活计数清零）
    endPayloadPackets: 0,
    expectedPayload: options.expectedPayload,
    dropTailPacket: !!options.dropTailPacket, // 模拟收尾真丢包：END 必须报 0x09
    silentHeaderInSession: options.silentHeaderInSession || 0, // 第 N 轮 DFU 不应答头信息
    silentHeaderAlways: !!options.silentHeaderAlways, // 每一轮都不应答头信息
    // 头信息前 N 次回 0x05「设备状态错误」（忙态/上一轮 DFU 没退出），之后才正常受理
    busyHeaderTimes: options.busyHeaderTimes || 0,
    busyHeaderAlways: !!options.busyHeaderAlways,
    // 第 N 轮 DFU 传数据传到一半时，某个信用窗口回 0x05「设备状态错误」
    //（真机现象：反复对同一台设备升级，传输途中冒出「接收数据报错：设备状态错误」）
    dataStateErrorInSession: options.dataStateErrorInSession || 0,
    dataStateErrorAtPacket: options.dataStateErrorAtPacket || DEVICE_PRN * 3,
    headerRejects: 0,
    sessions: 0,
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
      device.sessions += 1
      device.headerSeen = false
      device.payloadBytes = 0
      device.payloadPackets = 0
      notify(withChecksum([0xfc, 0xf1, 0x00, DEVICE_MTU, DEVICE_PRN]))
      return
    }
    if (op === 0xf2) {
      const dataLen = bytes.length - 2 // 去掉操作码与校验字节
      if (!device.headerSeen) {
        if (device.silentHeaderAlways || device.sessions === device.silentHeaderInSession) {
          return // 设备状态没复位：START 应答了，却不回头信息校验结果
        }
        if (device.busyHeaderAlways || device.headerRejects < device.busyHeaderTimes) {
          device.headerRejects += 1
          notify(withChecksum([0xfc, 0xf2, 0x05])) // 此刻不能受理：状态错误
          return
        }
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
        if (
          device.sessions === device.dataStateErrorInSession &&
          device.payloadPackets === device.dataStateErrorAtPacket
        ) {
          notify(withChecksum([0xfc, 0xf2, 0x05])) // 传到一半：此刻不能受理
          return
        }
        notify(withChecksum([0xfc, 0xf2, 0x00]))
      }
      return
    }
    if (op === 0xf3) {
      // 整包校验：total_bytes == bin_size 才算成功，否则 0x09 参数错误
      const ok = device.payloadBytes === device.expectedPayload
      device.endResult = ok ? 0x00 : 0x09
      // 收到 END 这一刻的收包快照：升级收尾（成功或失败）端上一律会断链复位，
      // 而断链会把下面 closeBLEConnection 里的计数清零（真机口径：设备退出 DFU 态）。
      // 用例要断言的是「到底收到了多少包」，所以在这里定格，别在断链之后再去读活计数。
      device.endPayloadPackets = device.payloadPackets
      device.endPayloadBytes = device.payloadBytes
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
  global.__otaListeners = listeners // 个别用例要自己塞一帧应答
  return listeners
}

// 673 包、最后一窗只有 1 包（673 = 3×224 + 1）—— 与现场失败完全同形。
const TOTAL_PACKETS = 673
const PAYLOAD_SIZE = CHUNK * (TOTAL_PACKETS - 1) + 100

// 按 §6.3.4 字段表拼一个合法的 128 字节头信息 + payload。
function buildPackage(payloadSize, overrides = {}) {
  const file = new Uint8Array(HEADER_SIZE + payloadSize)
  const head = file.subarray(0, HEADER_SIZE)
  const magic = overrides.magic === undefined ? 'OTAINFO' : overrides.magic
  for (let i = 0; i < magic.length && i < 7; i++) {
    head[i] = magic.charCodeAt(i)
  }
  head[7] = 0x00
  head[8] = 1 // 头部格式版本
  head[9] = overrides.panel === undefined ? 2 : overrides.panel // 1=3D7 / 2=5D89
  const headerLength = overrides.headerLength === undefined ? HEADER_SIZE : overrides.headerLength
  head[10] = headerLength & 0xff
  head[11] = (headerLength >> 8) & 0xff
  const binSize = overrides.binSize === undefined ? payloadSize : overrides.binSize
  head[12] = binSize & 0xff
  head[13] = (binSize >> 8) & 0xff
  head[14] = (binSize >> 16) & 0xff
  head[15] = (binSize >> 24) & 0xff
  const version = overrides.version === undefined
    ? 'BR1601A02_260702_r8285_5139_5D89_V100'
    : overrides.version
  head[20] = version.length & 0xff
  head[21] = (version.length >> 8) & 0xff
  for (let i = 0; i < version.length; i++) {
    head[24 + i] = version.charCodeAt(i)
  }
  return file.buffer
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
    }, { pace: 0, headerDelayMs: 0 })

    assert.strictEqual(result.confirmed, true)
    assert.strictEqual(result.totalPackets, TOTAL_PACKETS)
    assert.strictEqual(device.endPayloadPackets, TOTAL_PACKETS, '所有数据包都要发出去')
    assert.strictEqual(device.endPayloadBytes, PAYLOAD_SIZE)
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
      await otaBle.upgradeFirmware('DEV-1', { buffer: buildPackage(PAYLOAD_SIZE) }, { pace: 0, headerDelayMs: 0 })
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

  // ④ START 应答正常、却不回 128 字节头信息校验（设备状态没复位）：此刻设备一个 payload 字节
  //    都没收下，断链复位后整轮重来是安全的，用户不该被一句「请确认面板/型号匹配」打发走。
  {
    const device = createFakeDevice({
      expectedPayload: PAYLOAD_SIZE,
      silentHeaderInSession: 1
    })
    installFakeBle(device)
    delete require.cache[require.resolve('../utils/ota-ble')]
    const otaBle = require('../utils/ota-ble')

    const result = await otaBle.upgradeFirmware('DEV-1', {
      buffer: buildPackage(PAYLOAD_SIZE)
    }, { pace: 0, headerTimeout: 120, headerDelayMs: 0, headerAttempts: 2, stateResetWaitMs: 60 })

    assert.strictEqual(result.confirmed, true)
    assert.strictEqual(device.sessions, 2, '第一轮头信息无应答，复位后应重来一轮')
    assert.strictEqual(device.endPayloadBytes, PAYLOAD_SIZE)
  }

  // ⑤ 两轮都不回头信息：如实失败，且提示要指向「断电重启」而不是误导成面板/型号不匹配
  {
    const device = createFakeDevice({
      expectedPayload: PAYLOAD_SIZE,
      silentHeaderAlways: true
    })
    installFakeBle(device)
    delete require.cache[require.resolve('../utils/ota-ble')]
    const otaBle = require('../utils/ota-ble')

    let failed = null
    try {
      await otaBle.upgradeFirmware('DEV-1', {
        buffer: buildPackage(PAYLOAD_SIZE)
      }, { pace: 0, headerTimeout: 120, headerDelayMs: 0, headerAttempts: 2, stateResetWaitMs: 60 })
    } catch (error) {
      failed = error
    }
    assert.ok(failed, '两轮都不应答必须失败')
    assert.ok(/断电重启/.test(failed.message), failed.message)
    assert.strictEqual(device.sessions, 2, '只重试一轮，不无限重来')
  }

  // ⑥ 头信息被回 0x05「设备状态错误」：这是「此刻不能受理」不是「包不对」（包不对回 0x0A~0x0E），
  //    退避重发即可自愈，不该当场判死让用户去重刷。
  {
    const device = createFakeDevice({
      expectedPayload: PAYLOAD_SIZE,
      busyHeaderTimes: 2 // 前两次忙，第三次才受理
    })
    installFakeBle(device)
    delete require.cache[require.resolve('../utils/ota-ble')]
    const otaBle = require('../utils/ota-ble')

    const result = await otaBle.upgradeFirmware('DEV-1', {
      buffer: buildPackage(PAYLOAD_SIZE)
    }, { pace: 0, headerDelayMs: 0, headerRetryDelayMs: 20, headerAttempts: 3 })

    assert.strictEqual(result.confirmed, true)
    assert.strictEqual(device.headerRejects, 2)
    assert.strictEqual(device.sessions, 1, '同一连接内重发即可，不必断链重来')
  }

  // ⑦ 一直回 0x05：两轮连接都过不去，提示必须指向「断电重启」，且说清是设备状态而不是包不对
  {
    const device = createFakeDevice({
      expectedPayload: PAYLOAD_SIZE,
      busyHeaderAlways: true
    })
    installFakeBle(device)
    delete require.cache[require.resolve('../utils/ota-ble')]
    const otaBle = require('../utils/ota-ble')

    let failed = null
    try {
      await otaBle.upgradeFirmware('DEV-1', {
        buffer: buildPackage(PAYLOAD_SIZE)
      }, { pace: 0, headerDelayMs: 0, headerRetryDelayMs: 20, headerAttempts: 2, stateResetWaitMs: 60 })
    } catch (error) {
      failed = error
    }
    assert.ok(failed, '一直状态错误必须失败')
    assert.ok(/断电重启/.test(failed.message), failed.message)
    assert.ok(/状态/.test(failed.message), failed.message)
    assert.strictEqual(device.sessions, 2, '断链复位整轮重来一次后收手')
  }

  // ⑦-2 传数据传到一半被回 0x05「设备状态错误」（2026-08-11 现场）：
  //     这是「此刻不能受理」而不是「数据不对」，必须断链复位后整轮从 START 重来一次，
  //     而不是直接把「电子纸设备接收数据报错：电子纸设备状态错误」甩给用户。
  //     从 START 重来是安全的：START 会重置设备的写入区与 total_bytes。
  {
    const device = createFakeDevice({
      expectedPayload: PAYLOAD_SIZE,
      dataStateErrorInSession: 1
    })
    installFakeBle(device)
    delete require.cache[require.resolve('../utils/ota-ble')]
    const otaBle = require('../utils/ota-ble')

    const result = await otaBle.upgradeFirmware('DEV-1', {
      buffer: buildPackage(PAYLOAD_SIZE)
    }, { pace: 0, headerDelayMs: 0, stateResetWaitMs: 60 })

    assert.strictEqual(result.confirmed, true, '断链复位后重来一轮应当升级成功')
    assert.strictEqual(device.sessions, 2, '传输途中的 0x05 必须触发断链复位 + 整轮重来')
    assert.strictEqual(device.endPayloadPackets, TOTAL_PACKETS)
    assert.strictEqual(device.endPayloadBytes, PAYLOAD_SIZE)
  }

  // ⑦-3 每一轮都在传输途中回 0x05：两轮都过不去时，提示要指向「断电重启」并说清不是包的问题
  {
    const device = createFakeDevice({
      expectedPayload: PAYLOAD_SIZE,
      dataStateErrorInSession: -1 // 占位，下面直接改成「每轮都触发」
    })
    device.dataStateErrorInSession = 0
    installFakeBle(device)
    // 每一轮的第 9 包都回 0x05
    const originalWrite = global.wx.writeBLECharacteristicValue
    global.wx.writeBLECharacteristicValue = params => {
      device.dataStateErrorInSession = device.sessions // 当前轮永远命中
      return originalWrite(params)
    }
    delete require.cache[require.resolve('../utils/ota-ble')]
    const otaBle = require('../utils/ota-ble')

    let failed = null
    try {
      await otaBle.upgradeFirmware('DEV-1', {
        buffer: buildPackage(PAYLOAD_SIZE)
      }, { pace: 0, headerDelayMs: 0, stateResetWaitMs: 60 })
    } catch (error) {
      failed = error
    }
    global.wx.writeBLECharacteristicValue = originalWrite
    assert.ok(failed, '两轮都被回 0x05 必须如实失败')
    assert.ok(/断电重启/.test(failed.message), failed.message)
    assert.ok(!/升级包/.test(failed.message) || /不是升级包的问题/.test(failed.message), failed.message)
    assert.strictEqual(device.sessions, 2, '只重来一轮，不无限重试')
  }

  // ⑧ 头信息回 0x0A~0x0E（包本身不对）：立即停止，不许重发浪费时间，也不许被复位逻辑接管
  {
    const device = createFakeDevice({ expectedPayload: PAYLOAD_SIZE })
    installFakeBle(device)
    delete require.cache[require.resolve('../utils/ota-ble')]
    const otaBle = require('../utils/ota-ble')
    const original = global.wx.writeBLECharacteristicValue
    global.wx.writeBLECharacteristicValue = params => {
      const bytes = Array.from(new Uint8Array(params.value))
      if (bytes[0] === 0xf2 && !device.headerSeen) {
        device.headerSeen = true
        params.success({})
        setTimeout(() => {
          const listeners = global.__otaListeners
          listeners.value({
            deviceId: 'DEV-1',
            serviceId: SERVICE_UUID,
            characteristicId: CONTROL_UUID,
            value: toArrayBuffer(withChecksum([0xfc, 0xf2, 0x0c])) // 固件类型与面板不匹配
          })
        }, 0)
        return
      }
      return original(params)
    }

    let failed = null
    try {
      await otaBle.upgradeFirmware('DEV-1', {
        buffer: buildPackage(PAYLOAD_SIZE)
      }, { pace: 0, headerDelayMs: 0, headerRetryDelayMs: 20, headerAttempts: 3, stateResetWaitMs: 60 })
    } catch (error) {
      failed = error
    }
    global.wx.writeBLECharacteristicValue = original
    assert.ok(failed, '包不对必须失败')
    assert.ok(/固件类型与面板不匹配/.test(failed.message), failed.message)
    assert.strictEqual(device.sessions, 1, '确定性拒绝不该触发复位重来')
  }

  // ⑨ 传错文件/下载截断/刷错面板：必须在发第一帧之前就本地拦住（刷错固件不可逆），
  //    且提示要说清是哪一种，不能笼统报「升级失败」。
  {
    const device = createFakeDevice({ expectedPayload: PAYLOAD_SIZE })
    installFakeBle(device)
    delete require.cache[require.resolve('../utils/ota-ble')]
    const otaBle = require('../utils/ota-ble')

    const reject = async (buffer, opts, pattern) => {
      let failed = null
      try {
        await otaBle.upgradeFirmware('DEV-1', { buffer }, Object.assign({ pace: 0, headerDelayMs: 0 }, opts))
      } catch (error) {
        failed = error
      }
      assert.ok(failed, '本地预检应当拒绝：' + pattern)
      assert.ok(pattern.test(failed.message), failed.message)
      assert.strictEqual(device.sessions, 0, '预检不通过时不该碰蓝牙')
    }

    // 不是 OTA 包（没有 OTAINFO 标识）——最典型的「传错文件」
    await reject(buildPackage(PAYLOAD_SIZE, { magic: '' }), {}, /OTAINFO/)
    // 下载截断：头信息声明的 bin 大小与实际文件对不上
    await reject(buildPackage(PAYLOAD_SIZE, { binSize: PAYLOAD_SIZE + 4096 }), {}, /升级包不完整/)
    // 刷错面板：5D89 的包刷到 3D7 设备
    await reject(buildPackage(PAYLOAD_SIZE, { panel: 2 }), { expectPanel: 1 }, /面板不匹配/)

    // 合法包 + 面板对得上：照常升级，预检不能误伤
    const result = await otaBle.upgradeFirmware('DEV-1', {
      buffer: buildPackage(PAYLOAD_SIZE, { panel: 2 })
    }, { pace: 0, headerDelayMs: 0, expectPanel: 2, expectVersion: 'V1.0.2' })
    assert.strictEqual(result.confirmed, true)
  }

  // ⑦ 屏幕尺寸/screenType → 面板号的换算（判不出必须返回 0，不参与拦截）
  {
    delete require.cache[require.resolve('../utils/ota-ble')]
    const otaBle = require('../utils/ota-ble')
    assert.strictEqual(otaBle.panelOfDevice({ screenType: 2 }), 2)
    assert.strictEqual(otaBle.panelOfDevice({ width: 680, height: 960 }), 2)
    assert.strictEqual(otaBle.panelOfDevice({ width: 960, height: 680 }), 2, '横竖屏不影响')
    assert.strictEqual(otaBle.panelOfDevice({ width: 480, height: 720 }), 1)
    assert.strictEqual(otaBle.panelOfDevice({ name: '没有尺寸的记录' }), 0)
  }

  console.log('ota-dfu-transfer.test.js 通过')
})().catch(error => {
  console.error(error)
  process.exitCode = 1
})
