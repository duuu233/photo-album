const assert = require('assert')
const battery = require('../utils/battery')
const deviceBle = require('../utils/device-ble')

assert.strictEqual(battery.normalizeBattery(0), 0)
assert.strictEqual(battery.normalizeBattery(57.6), 58)
assert.strictEqual(battery.normalizeBattery(100), 100)
assert.strictEqual(battery.normalizeBattery(-1), null)
assert.strictEqual(battery.normalizeBattery(101), null)
assert.strictEqual(battery.normalizeBattery(255), null)
assert.strictEqual(battery.normalizeBattery(undefined), null)

const live = Object.assign(
  { connected: true },
  battery.stampBattery(76)
)
assert.strictEqual(battery.resolveBattery(live), 76)
assert.strictEqual(battery.batteryText(live), '76%')
assert.strictEqual(
  battery.batteryText(Object.assign({}, live, { connected: false })),
  '--'
)

;(async () => {
  const originalReadBattery = deviceBle.readBattery
  let calls = 0
  try {
    deviceBle.readBattery = () => Promise.resolve(++calls === 1 ? 61 : 62)
    const first = await battery.readLatestBattery('device-a')
    const second = await battery.readLatestBattery('device-a')
    assert.strictEqual(first.battery, 61)
    assert.strictEqual(second.battery, 62)
    assert.strictEqual(calls, 2, '顺序展示必须各发一次真实读取，不能复用上次结果')

    calls = 0
    deviceBle.readBattery = () => {
      calls += 1
      return new Promise(resolve => setTimeout(() => resolve(63), 0))
    }
    const concurrent = await Promise.all([
      battery.readLatestBattery('device-b'),
      battery.readLatestBattery('device-b')
    ])
    assert.strictEqual(calls, 1, '同一设备的并发请求应只共享在途读取')
    assert.strictEqual(concurrent[0].battery, 63)
    assert.strictEqual(concurrent[1].battery, 63)
  } finally {
    deviceBle.readBattery = originalReadBattery
  }

  console.log('battery tests passed')
})().catch(error => {
  console.error(error)
  process.exitCode = 1
})
