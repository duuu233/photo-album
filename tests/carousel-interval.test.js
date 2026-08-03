// 轮播间隔单位换算：后端 carouselInterval 的单位 2026-08-03 起由「小时」改为「分钟」。
// 端上统一按秒存 intervalSeconds（固件 0x12 收的就是秒），intervalHours 只作展示派生值。
// 这里守住的是回归红线：分钟级间隔（5 分钟）不能在任何一层被取整成整数小时。
const assert = require('assert')
const api = require('../utils/api')

;(async () => {
  const originalDetail = api.getUserProductDetail
  try {
    api.getUserProductDetail = () =>
      Promise.resolve({
        userProductId: 'dev-1',
        productName: '相框',
        deviceId: 'e948c21ed428',
        carouselInterval: 5 // 分钟
      })
    const device = await api.getDeviceDetail('dev-1')
    // 5 分钟 = 300 秒；旧口径（按小时）会算成 5*3600=18000
    assert.strictEqual(device.intervalSeconds, 300)
    // 派生小时保留小数，不得被 Math.round 吃成 0 或 1
    assert.ok(Math.abs(device.intervalHours - 5 / 60) < 1e-9)

    // 小数分钟（0.5 分钟 = 30 秒）同样要能过；四舍五入到秒，最小 1 秒
    api.getUserProductDetail = () =>
      Promise.resolve({ userProductId: 'dev-2', carouselInterval: 0.5 })
    assert.strictEqual((await api.getDeviceDetail('dev-2')).intervalSeconds, 30)

    // 字符串形态（后端偶有下发字符串数字）
    api.getUserProductDetail = () =>
      Promise.resolve({ userProductId: 'dev-3', carouselInterval: '90' })
    assert.strictEqual((await api.getDeviceDetail('dev-3')).intervalSeconds, 5400)

    // 未下发 carouselInterval（列表接口）：回落 BLE 读回的 intervalSeconds，不被默认值覆盖
    api.getUserProductDetail = () =>
      Promise.resolve({ userProductId: 'dev-4', intervalSeconds: 300 })
    const fromBle = await api.getDeviceDetail('dev-4')
    assert.strictEqual(fromBle.intervalSeconds, 300)

    // 两者都没有：intervalSeconds 为 0（未知），展示小时回落 2
    api.getUserProductDetail = () => Promise.resolve({ userProductId: 'dev-5' })
    const unknown = await api.getDeviceDetail('dev-5')
    assert.strictEqual(unknown.intervalSeconds, 0)
    assert.strictEqual(unknown.intervalHours, 2)

    // 本地缓存里的旧记录只有归一化过的 intervalHours：按小时兜底还原成秒
    api.getUserProductDetail = () =>
      Promise.resolve({ userProductId: 'dev-6', intervalHours: 4 })
    assert.strictEqual((await api.getDeviceDetail('dev-6')).intervalSeconds, 14400)
  } finally {
    api.getUserProductDetail = originalDetail
  }

  console.log('carousel-interval tests passed')
})().catch(error => {
  console.error(error)
  process.exitCode = 1
})
