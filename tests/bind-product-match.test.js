// 绑定时按蓝牙广播名匹配产品（2026-10-22）：产品列表 /Client/Product/getProductList 的 broadcastId
// 命中广播名就是那个产品，权重压过名称/型号的零散命中。
//
// 锁三件事：
//   ① 不靠列表顺序：EC-370 的屏型若按 3.7 寸上报，型号会同时命中 EF6-370，旧打分平分、谁排前面绑谁；
//   ② 广播名带后缀、名字在 localName 里、后台 broadcastId 带首尾空格（实测 "EB-169 "）都认得出；
//   ③ 新绑定记录带上匹配产品的 broadcastId（去空格），设备图随之按机型区分。
const assert = require('node:assert/strict')
const api = require('../utils/api')

// 后台实际返回（2026-10-22），顺序打乱：EF6-370 排在 EC-370 前面，EB-169 的 broadcastId 带尾随空格
const catalog = [
  { productId: 9, broadcastId: 'EF6-370', productName: 'EF6-370', productImg: 'https://oss/9.png' },
  { productId: 15, broadcastId: 'EF6-589', productName: 'EF6-589', productImg: 'https://oss/15.png' },
  { productId: 17, broadcastId: 'EC-370', productName: 'EC-370', productImg: 'https://oss/17.png' },
  { productId: 18, broadcastId: 'EB-169 ', productName: 'EB-169 ', productImg: 'https://oss/18.png' }
]

;(async () => {
  const originalList = api.getProductList
  const originalAdd = api.addUserProduct
  let submitted = null
  try {
    api.getProductList = () => Promise.resolve({ pageData: catalog })
    api.addUserProduct = payload => {
      submitted = payload
      return Promise.resolve({})
    }
    const bind = async scan => {
      submitted = null
      const device = await api.bindDevice(Object.assign({ deviceId: 'ble-handle', deviceNo: 'e948c21ed428' }, scan))
      return { productId: submitted.productId, device }
    }

    // ① 型号命中 EF6-370、广播名命中 EC-370：认广播名
    assert.equal((await bind({ name: 'EC-370', model: 'EF6-370', screen: '3.7寸' })).productId, 17)
    // ② 带后缀 / 名字只在 localName / 后台带空格
    assert.equal((await bind({ name: 'EC-370-0B37' })).productId, 17)
    assert.equal((await bind({ name: '设备 0B37', localName: 'ec-370' })).productId, 17)
    const round = await bind({ name: 'EB-169' })
    assert.equal(round.productId, 18)
    // 老机型照旧
    assert.equal((await bind({ name: 'EF6-589', model: 'EF6-589' })).productId, 15)
    assert.equal((await bind({ name: 'EF6-370', model: 'EF6-370' })).productId, 9)

    // ③ 记录带去空格的 broadcastId，设备图是圆屏图
    assert.equal(round.device.broadcastId, 'EB-169')
    assert.equal(round.device.thumb, '/assets/images/home-device-circle-thumb.png')
  } finally {
    api.getProductList = originalList
    api.addUserProduct = originalAdd
  }
  console.log('bind-product-match ok')
})().catch(error => {
  console.error(error)
  process.exit(1)
})
