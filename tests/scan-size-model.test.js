// 搜索列表的屏幕尺寸（2026-10-23）：按蓝牙广播名匹配产品列表的 broadcastId，显示该产品的 sizeModel；
// 不再用广播屏型字节推算。匹配口径与扫描白名单、bindDevice 一致：去首尾空白、大小写不敏感的包含匹配。
const assert = require('node:assert/strict')
const api = require('../utils/api')

const catalog = [
  { productId: 9, broadcastId: 'EF6-370', sizeModel: '3.7寸' },
  { productId: 15, broadcastId: 'EF6-589', sizeModel: ' 5.89寸 ' },
  { productId: 17, broadcastId: 'EC-370', sizeModel: '3.6寸' },
  { productId: 18, broadcastId: 'EB-169 ', sizeModel: '' },
  { productId: 19, broadcastId: '', sizeModel: '9.9寸' }
]

assert.equal(api.scanSizeModel({ name: 'EC-370' }, catalog), '3.6寸')
assert.equal(api.scanSizeModel({ name: 'ec-370-0B37' }, catalog), '3.6寸', '带后缀、大小写不同')
assert.equal(api.scanSizeModel({ name: '设备', localName: 'EF6-589' }, catalog), '5.89寸', 'localName 命中且去空白')
assert.equal(api.scanSizeModel({ name: 'EB-169' }, catalog), '', '后台没配不展示')
assert.equal(api.scanSizeModel({ name: 'XX-001' }, catalog), '', '匹配不到不展示，不再按屏型猜')
assert.equal(api.scanSizeModel({ name: 'EC-370', screen: '3.7寸' }, []), '', '产品列表没拉到也不展示')
assert.equal(api.scanSizeModel({ name: 'EF6-370' }, catalog), '3.7寸')
// 多个命中取更具体（更长）的 broadcastId
assert.equal(
  api.scanSizeModel({ name: 'EF6-370-PRO' }, catalog.concat({ broadcastId: 'EF6-370-PRO', sizeModel: '4.0寸' })),
  '4.0寸'
)

console.log('scan-size-model: ok')
