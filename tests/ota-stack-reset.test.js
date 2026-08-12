// OTA 收尾必须做「蓝牙栈硬复位」（2026-08-13 第二轮修「升级完还是要重进小程序才连得上」）。
//
// 第一轮（08-12）按「无主连接」修过：连上后任何失败都断链 + 扫描前 releaseStrayConnections 对账。
// 现场复测仍然不行 —— 因为那个对账的判据太窄：releaseStrayConnections 只看得见
// `getConnectedBluetoothDevices` 报得出来的连接，而**服务发现没走完的半连接、设备复位途中
// 微信侧还扣着的连接对象**恰恰不在它的结果里。设备被这种连接占着就不再广播，
// 之后怎么扫都是「未搜索到该电子纸设备」，只有杀掉小程序才恢复。
//
// 所以这一轮直接用「重进小程序」的等价物：wx.closeBluetoothAdapter（官方语义＝断开所有已建立的
// 连接并释放系统资源）→ 等系统收干净 → 重新 openBluetoothAdapter。
//
// 本文件锁四件事：
//  ① 升级成功：收尾要关适配器并重新打开，且 upgradeFirmware **返回之前**就落地
//     （页面一显示「升级成功」用户就会去点连接，不能让适配器还在关闭途中）；
//  ② 升级失败（碰过设备）：同样要关适配器再重开；
//  ③ 升级包阶段失败（没碰过设备）：**绝不能**关适配器——用户已有的连接不该被一次网络抖动拆掉；
//  ④ 硬复位要清空两个模块的会话账本，并把 bluetooth.js 的共享扫描会话拆掉
//     （不拆的话，复位后新的 discoverDevices 会订阅到一条再也收不到广播的死会话，
//      表现还是「怎么扫都搜不到」，等于没修）。
const assert = require('assert')

const OTA_SERVICE = '0000FF10-0000-1000-8000-00805F9B34FB'
const OTA_CONTROL = '0000FF11-0000-1000-8000-00805F9B34FB'
const HEADER_SIZE = 128

function checksum8(bytes) {
  return bytes.reduce((sum, byte) => (sum + byte) & 0xff, 0)
}

function withChecksum(bytes) {
  return bytes.concat([checksum8(bytes)])
}

function toArrayBuffer(bytes) {
  return new Uint8Array(bytes).buffer
}

function freshRequire(path) {
  delete require.cache[require.resolve(path)]
  return require(path)
}

// 一个「一切正常」的 OTA 假设备：START/头信息/数据/END 全回 0x00。
// options.headerResult：把头信息应答改成别的结果码，用来制造「碰过设备之后失败」。
function installOtaWorld(state, options = {}) {
  const listeners = {}
  const notify = bytes => {
    setTimeout(() => {
      if (listeners.value) {
        listeners.value({
          deviceId: 'DEV-OTA',
          serviceId: OTA_SERVICE,
          characteristicId: OTA_CONTROL,
          value: toArrayBuffer(bytes)
        })
      }
    }, 0)
  }
  global.wx = {
    createBLEConnection: ({ success }) => {
      state.connects += 1
      success({})
    },
    closeBLEConnection: ({ deviceId, success }) => {
      state.closes.push(deviceId)
      if (listeners.connection) {
        listeners.connection({ deviceId: deviceId || 'DEV-OTA', connected: false })
      }
      if (success) {
        success({})
      }
    },
    // 本文件的主角：适配器开关。记下调用顺序，末尾断言「关了必须再开」。
    closeBluetoothAdapter: ({ success }) => {
      state.adapter.push('close')
      success({})
    },
    openBluetoothAdapter: ({ success }) => {
      state.adapter.push('open')
      success({})
    },
    stopBluetoothDevicesDiscovery: ({ success }) => success && success({}),
    offBluetoothDeviceFound: () => {},
    getBLEDeviceServices: ({ success }) => success({ services: [{ uuid: OTA_SERVICE }] }),
    getBLEDeviceCharacteristics: ({ success }) =>
      success({
        characteristics: [
          { uuid: OTA_CONTROL, properties: { write: true, writeNoResponse: true, notify: true } }
        ]
      }),
    notifyBLECharacteristicValueChange: ({ success }) => success({}),
    setBLEMTU: ({ success }) => success({ mtu: 251 }),
    getBLEMTU: ({ success }) => success({ mtu: 251 }),
    onBLECharacteristicValueChange: cb => {
      listeners.value = cb
    },
    onBLEConnectionStateChange: cb => {
      listeners.connection = cb
    },
    getStorageSync: () => '',
    setStorageSync: () => {},
    writeBLECharacteristicValue: ({ value, success }) => {
      const bytes = Array.from(new Uint8Array(value))
      success({})
      if (bytes[0] === 0xf1) {
        notify(withChecksum([0xfc, 0xf1, 0x00, 251, 3]))
      } else if (bytes[0] === 0xf2) {
        // 首包是 128 字节头信息（帧长 130），其余是 bin 分片
        const isHeader = bytes.length === HEADER_SIZE + 2
        const result = isHeader
          ? options.headerResult === undefined
            ? 0x00
            : options.headerResult
          : 0x00
        notify(withChecksum([0xfc, 0xf2, result]))
      } else if (bytes[0] === 0xf3) {
        notify(withChecksum([0xfc, 0xf3, 0x00]))
      }
    }
  }
}

// 与 ota-connection-safety.test.js 同款的最小合法升级包
function buildPackage(payloadSize, overrides = {}) {
  const file = new Uint8Array(HEADER_SIZE + payloadSize)
  const head = file.subarray(0, HEADER_SIZE)
  const magic = overrides.magic === undefined ? 'OTAINFO' : overrides.magic
  for (let i = 0; i < magic.length && i < 7; i++) {
    head[i] = magic.charCodeAt(i)
  }
  head[7] = 0x00
  head[8] = 1
  head[9] = 2 // 5D89 面板
  head[10] = HEADER_SIZE & 0xff
  head[11] = (HEADER_SIZE >> 8) & 0xff
  const binSize = overrides.binSize === undefined ? payloadSize : overrides.binSize
  head[12] = binSize & 0xff
  head[13] = (binSize >> 8) & 0xff
  head[14] = (binSize >> 16) & 0xff
  head[15] = (binSize >> 24) & 0xff
  const version = 'BR1601A02_260702_r8285_5139_5D89_V100'
  head[20] = version.length & 0xff
  for (let i = 0; i < version.length; i++) {
    head[24 + i] = version.charCodeAt(i)
  }
  return file.buffer
}

;(async () => {
  // ── ① 升级成功：收尾关适配器 + 重开，且在 upgradeFirmware 返回之前就完成 ────────
  {
    const state = { connects: 0, closes: [], adapter: [] }
    installOtaWorld(state)
    const otaBle = freshRequire('../utils/ota-ble')

    const result = await otaBle.upgradeFirmware(
      'DEV-OTA',
      { buffer: buildPackage(4096) },
      { pace: 0, headerDelayMs: 0 }
    )

    assert.strictEqual(result.confirmed, true, '设备回了 END ACK 0x00，应判为升级成功')
    assert.deepStrictEqual(
      state.adapter,
      ['close', 'open'],
      '升级成功的收尾必须关掉蓝牙适配器再重新打开（＝重进小程序那一下）'
    )
    assert.ok(state.closes.indexOf('DEV-OTA') > -1, '链路本身也照旧断开')
    assert.strictEqual(otaBle.isConnected('DEV-OTA'), false, 'OTA 会话必须作废')
  }

  // ── ② 碰过设备之后失败：同样要硬复位 ─────────────────────────────────
  {
    const state = { connects: 0, closes: [], adapter: [] }
    installOtaWorld(state, { headerResult: 0x0c }) // 固件类型与面板不匹配
    const otaBle = freshRequire('../utils/ota-ble')

    let failure = null
    try {
      await otaBle.upgradeFirmware(
        'DEV-OTA',
        { buffer: buildPackage(4096) },
        { pace: 0, headerDelayMs: 0 }
      )
    } catch (error) {
      failure = error
    }

    assert.ok(failure, '头信息被回 0x0C 必须失败')
    assert.deepStrictEqual(
      state.adapter,
      ['close', 'open'],
      '失败的收尾同样要硬复位——「升级失败后连不上」正是这条路上出的问题'
    )
  }

  // ── ③ 没碰过设备（升级包阶段失败）：一根手指都不许动用户已有的连接 ──────────
  {
    const state = { connects: 0, closes: [], adapter: [] }
    installOtaWorld(state)
    const otaBle = freshRequire('../utils/ota-ble')

    let failure = null
    try {
      await otaBle.upgradeFirmware(
        'DEV-OTA',
        { buffer: buildPackage(4096, { magic: 'NOTOTA' }) },
        { pace: 0, headerDelayMs: 0 }
      )
    } catch (error) {
      failure = error
    }

    assert.ok(failure && failure.deviceUntouched, '这一轮根本没碰过设备')
    assert.deepStrictEqual(state.adapter, [], '包下载/解析失败不得关适配器（会拆掉用户已有的连接）')
    assert.deepStrictEqual(state.closes, [], '也不得断链')
  }

  // ── ④ 硬复位本身：清两个会话池 + 拆掉共享扫描会话 + 关了必须再开 ──────────────
  {
    const state = { connects: 0, closes: [], adapter: [] }
    installOtaWorld(state)
    // 扫描侧：起一路真实的共享扫描会话，复位后它必须被拆掉，否则后来的 discoverDevices
    // 会订阅到这条收不到任何广播的死会话（这正是「重进小程序才好」的另一半原因）
    global.wx.startBluetoothDevicesDiscovery = ({ success }) => success({})
    global.wx.onBluetoothDeviceFound = () => {}
    global.wx.getConnectedBluetoothDevices = ({ success }) => success({ devices: [] })

    const deviceBle = freshRequire('../utils/device-ble')
    const otaBle = freshRequire('../utils/ota-ble')
    const bluetooth = freshRequire('../utils/bluetooth')

    // 两个模块各持一条会话（device-ble 的 FF00 与 ota-ble 的 FF10）
    await deviceBle.ensureConnection('DEV-FF00').catch(() => {})
    await otaBle.upgradeFirmware(
      'DEV-OTA',
      { buffer: buildPackage(4096) },
      { pace: 0, headerDelayMs: 0 }
    )

    state.adapter.length = 0
    const scan = bluetooth.discoverDevices({ timeout: 50, allowAll: true })
    assert.strictEqual(bluetooth.isDiscovering(), true, '前置条件：这一刻确实有一路共享扫描在跑')

    await deviceBle.resetBluetoothStack('单测')

    assert.deepStrictEqual(state.adapter, ['close', 'open'], '硬复位＝关适配器后必须重新打开')
    assert.strictEqual(bluetooth.isDiscovering(), false, '共享扫描会话必须被拆掉')
    assert.strictEqual(deviceBle.hasAnyActiveConnection(), false, 'device-ble 会话账本要清空')
    assert.strictEqual(otaBle.hasAnyActiveConnection(), false, 'ota-ble 会话账本要清空')
    await scan // 订阅者仍按自己的 timeout 正常结算，不能悬着
  }

  // ── ⑤ 复位后全局通知监听必须「先 off 再 on」，且复位后还能照常再升一次 ──────────
  // 关适配器之后 wx.onBLE* 的回调还在不在没有保证：丢了＝连上却收不到任何应答；
  // 而不 off 直接再 on 一次，每帧通知会被派发两遍（解帧缓冲灌两份，此后全部指令超时）。
  // 两种错法都比原来的毛病更严重，所以这条必须锁死。
  {
    const state = { connects: 0, closes: [], adapter: [] }
    installOtaWorld(state)
    const handlers = { value: [], conn: [] }
    const world = global.wx
    const onValue = world.onBLECharacteristicValueChange
    const onConn = world.onBLEConnectionStateChange
    world.onBLECharacteristicValueChange = cb => {
      handlers.value.push(cb)
      onValue(cb) // 仍然接到假设备上，帧照常送达
    }
    world.offBLECharacteristicValueChange = cb => {
      handlers.value = handlers.value.filter(item => item !== cb)
    }
    world.onBLEConnectionStateChange = cb => {
      handlers.conn.push(cb)
      onConn(cb)
    }
    world.offBLEConnectionStateChange = cb => {
      handlers.conn = handlers.conn.filter(item => item !== cb)
    }

    const deviceBle = freshRequire('../utils/device-ble')
    const otaBle = freshRequire('../utils/ota-ble')

    // 第一轮升级（会在收尾里做一次硬复位 → 顺带重挂监听）
    const first = await otaBle.upgradeFirmware(
      'DEV-OTA',
      { buffer: buildPackage(4096) },
      { pace: 0, headerDelayMs: 0 }
    )
    assert.strictEqual(first.confirmed, true)

    assert.strictEqual(
      new Set(handlers.value).size,
      handlers.value.length,
      '同一个回调绝不能注册两遍——每帧通知会被派发两次，解帧缓冲当场废掉'
    )
    assert.ok(handlers.value.length <= 2, `两个模块各一份监听，实际 ${handlers.value.length} 份`)
    assert.ok(handlers.conn.length <= 2, `连接状态监听同理，实际 ${handlers.conn.length} 份`)

    // 复位之后照常还能再升一次：这一条真正证明「重挂之后通知还通」
    const second = await otaBle.upgradeFirmware(
      'DEV-OTA',
      { buffer: buildPackage(4096) },
      { pace: 0, headerDelayMs: 0 }
    )
    assert.strictEqual(second.confirmed, true, '硬复位之后必须还能正常收发 —— 否则监听就是丢了')
    assert.strictEqual(deviceBle.hasAnyActiveConnection(), false)
  }

  console.log('ota-stack-reset.test.js 全部通过')
})().catch(error => {
  console.error(error)
  process.exit(1)
})
