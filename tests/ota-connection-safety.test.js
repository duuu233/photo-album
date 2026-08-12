// OTA 之后「设备连不上/读不到」的连接安全网（2026-08-12）。
//
// 现场：升级失败后设备就连不上了，**退出小程序重新进入又正常**。
// 这个「重进就好」是关键线索：storage 缓存（bleDirectConnCache / deviceIdentityMap / selectedDevice）
// 跨重启保留，重进并不会清它们；重进真正清掉的只有两样——各模块的内存会话，以及
// **微信持有的全部 BLE 物理连接**。所以问题必然出在「一条还连着、但本机账本上没有的无主连接」：
// 设备是单连接，被它占着时不再广播，此后任何入口都是「未搜索到该电子纸设备」，
// 而 disconnectAll/disconnectOthers 都按账本遍历，谁也关不掉它。
//
// 本文件锁四件事：
//  ① 扫描连上之后 0x01 读不回来（设备刚被中断的 DFU 折腾过时最常见）必须断链，不能留下占用连接；
//  ② releaseStrayConnections 要能把「微信连着、账上没有」的连接释放掉，且不碰正在用的会话；
//  ③ 升级包准备阶段（下载/读文件/解析头信息）失败**不得**断链清缓存——设备根本没被碰过；
//  ④ 真的碰过设备之后的失败，照旧断链复位（回归保护，别把 ③ 做过头）。
const assert = require('assert')

const MAIN_SERVICE = '0000FF00-0000-1000-8000-00805F9B34FB'
const WRITE_CHAR = '0000FF01-0000-1000-8000-00805F9B34FB'
const NOTIFY_CHAR = '0000FF02-0000-1000-8000-00805F9B34FB'
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

;(async () => {
  // ── ① 连上了但 0x01 读超时：必须断链 ────────────────────────────────
  // 这一步之前只在 DEVICE_ID_MISMATCH 时断链，而「指令 0x1 应答超时」走的不是那条分支：
  // 于是链路留着、账本却已清空 → 设备被自己占住不广播 → 之后每次点连接都是「未搜索到」。
  {
    delete require.cache[require.resolve('../utils/active-device')]
    const deviceBle = freshRequire('../utils/device-ble')
    const bluetooth = freshRequire('../utils/bluetooth')
    const permission = freshRequire('../utils/permission')
    const connCache = freshRequire('../utils/device-conn-cache')

    const disconnected = []
    const scanned = []
    deviceBle.getActiveConnections = () => []
    deviceBle.isConnected = () => false
    deviceBle.ensureConnection = async () => ({ ready: true })
    deviceBle.readTransferInfo = async () => {
      throw new Error('指令 0x1 应答超时')
    }
    deviceBle.disconnect = id => disconnected.push(id)
    deviceBle.releaseStrayConnections = async () => []
    permission.getCurrentLocation = async () => ({ latitude: 0, longitude: 0 })
    bluetooth.openAdapter = async () => true
    bluetooth.whenScanStopped = async () => {}
    bluetooth.discoverDevices = async () => {
      scanned.push(Date.now())
      return [{ deviceId: 'WX-HANDLE-1', deviceNo: 'E948C21ED428', screenType: 2, RSSI: -50 }]
    }
    connCache.get = () => ''
    connCache.put = () => {}
    connCache.remove = () => {}

    global.wx = {
      showLoading: () => {},
      hideLoading: () => {},
      showToast: () => {},
      getStorageSync: () => '',
      setStorageSync: () => {}
    }

    const activeDevice = require('../utils/active-device')
    let failure = null
    try {
      await activeDevice.ensureDeviceConnected({
        id: '1',
        userProductId: '1',
        productDeviceId: 'E9:48:C2:1E:D4:28',
        deviceNo: 'E9:48:C2:1E:D4:28'
      })
    } catch (error) {
      failure = error
    }

    assert.ok(failure, '0x01 读不回来时连接必须失败')
    assert.strictEqual(scanned.length, 2, '两轮重扫都要走到')
    assert.deepStrictEqual(
      disconnected,
      ['WX-HANDLE-1', 'WX-HANDLE-1'],
      '每一轮失败都必须释放这条链路，否则设备被占住不再广播（只能杀掉小程序才恢复）'
    )
  }

  // ── ② 无主连接清道夫：只关「账上没有」的那条 ────────────────────────
  {
    const closed = []
    const listeners = {}
    global.wx = {
      createBLEConnection: ({ success }) => success({}),
      closeBLEConnection: ({ deviceId, success }) => {
        closed.push(deviceId)
        if (success) {
          success({})
        }
      },
      getBLEDeviceServices: ({ success }) => success({ services: [{ uuid: MAIN_SERVICE }] }),
      getBLEDeviceCharacteristics: ({ success }) =>
        success({
          characteristics: [
            { uuid: WRITE_CHAR, properties: { writeNoResponse: true } },
            { uuid: NOTIFY_CHAR, properties: { notify: true } }
          ]
        }),
      notifyBLECharacteristicValueChange: ({ success }) => success({}),
      setBLEMTU: ({ success }) => success({ mtu: 247 }),
      getBLEMTU: ({ success }) => success({ mtu: 247 }),
      onBLECharacteristicValueChange: cb => {
        listeners.value = cb
      },
      onBLEConnectionStateChange: cb => {
        listeners.connection = cb
      },
      getStorageSync: () => '',
      setStorageSync: () => {},
      getConnectedBluetoothDevices: ({ success }) =>
        success({
          devices: [{ deviceId: 'DEV-IN-USE' }, { deviceId: 'DEV-STRAY' }]
        })
    }

    const deviceBle = freshRequire('../utils/device-ble')
    await deviceBle.ensureConnection('DEV-IN-USE') // 正在用的会话，清道夫不得动它
    const released = await deviceBle.releaseStrayConnections()

    assert.deepStrictEqual(released, ['DEV-STRAY'], '只释放账上没有的那条无主连接')
    assert.strictEqual(closed.indexOf('DEV-IN-USE'), -1, '正在用的连接绝不能被误关')
    assert.strictEqual(deviceBle.isConnected('DEV-IN-USE'), true)
  }

  // ── ③④ OTA 收尾：碰没碰过设备，收尾力度不同 ─────────────────────────
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

  // OTA 假设备：START 正常应答，头信息回 0x0C（面板不匹配）→ 明确失败、不重试。
  function installOtaBle(state) {
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
      getBLEDeviceServices: ({ success }) => success({ services: [{ uuid: OTA_SERVICE }] }),
      getBLEDeviceCharacteristics: ({ success }) =>
        success({
          characteristics: [
            {
              uuid: OTA_CONTROL,
              properties: { write: true, writeNoResponse: true, notify: true }
            }
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
          notify(withChecksum([0xfc, 0xf2, 0x0c])) // 固件类型与面板不匹配
        }
      }
    }
  }

  // ③ 升级包阶段就失败（这里用「不是 OTA 包」）：一个字节都没发给设备，
  //    绝不能因此断掉用户已有的连接、也不该给错误扣「电子纸设备-」的帽子。
  {
    const state = { connects: 0, closes: [] }
    installOtaBle(state)
    const otaBle = freshRequire('../utils/ota-ble')

    let failure = null
    try {
      await otaBle.upgradeFirmware('DEV-OTA', {
        buffer: buildPackage(4096, { magic: 'NOTOTA' })
      }, { pace: 0, headerDelayMs: 0 })
    } catch (error) {
      failure = error
    }

    assert.ok(failure, '不是 OTA 包必须失败')
    assert.strictEqual(failure.deviceUntouched, true, '要标出「没碰过设备」，页面据此跳过记录级复位')
    assert.strictEqual(failure.code, 'OTA_PACKAGE_FAILED')
    assert.ok(/^升级包无效/.test(failure.message), '错误来源是升级包，不该扣「电子纸设备-」前缀')
    assert.strictEqual(state.connects, 0, '根本不该连蓝牙')
    assert.deepStrictEqual(state.closes, [], '不得断掉用户已有的连接')
  }

  // ④ 已经和设备握过手之后失败：照旧断链复位（否则设备 DFU 状态机停在半途，下次 START 必回 0x05）
  {
    const state = { connects: 0, closes: [] }
    installOtaBle(state)
    const otaBle = freshRequire('../utils/ota-ble')

    let failure = null
    try {
      await otaBle.upgradeFirmware('DEV-OTA', {
        buffer: buildPackage(4096)
      }, { pace: 0, headerDelayMs: 0 })
    } catch (error) {
      failure = error
    }

    assert.ok(failure, '头信息被回 0x0C 必须失败')
    assert.ok(!failure.deviceUntouched, '这一轮确实碰过设备')
    assert.ok(/面板/.test(failure.message), '设备语义要透传给用户')
    assert.strictEqual(state.connects, 1)
    assert.ok(state.closes.indexOf('DEV-OTA') > -1, '碰过设备的失败必须断链复位')
    assert.strictEqual(otaBle.isConnected('DEV-OTA'), false, '会话必须一并作废')
  }

  console.log('ota-connection-safety.test.js 全部通过')
})().catch(error => {
  console.error(error)
  process.exit(1)
})
