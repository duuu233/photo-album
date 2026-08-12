// 2026-08-12 两条改动的回归：
//   ① **解除绑定后再次添加，命名弹窗要带出后端回带的上次昵称**（后端本轮改的出参）。
//      端上此前把本地按型号/广播名拼的 productName 盖在 `saved` 后面，后端给什么都白搭；
//      而且就算改了 productName 也不够 —— `normalizeDevice` 的 name 取「第一个非空」，
//      蓝牙广播名（scan.name）排在前面，弹窗里带出来的仍是广播名。两处一起改才生效。
//   ② 星币消耗规则表 `GET /Client/Order/getAiConfigList` 的字段映射：
//      `aiProject/num/remark` → `name/cost/remark`，`retData` 是**裸数组**（不是分页壳），
//      `num` 是 number（后端 30.0 这种写法出现过，页面要显示成 30）。
const assert = require('node:assert/strict')

const storage = { token: 'user-token', jwtToken: 'jwt-token' }
const routes = {}

global.getCurrentPages = () => []
global.getApp = () => ({ globalData: {} })
global.wx = {
  getStorageSync: key => storage[key],
  setStorageSync: () => {},
  getDeviceInfo: () => ({ model: 'test-device' }),
  getAppBaseInfo: () => ({ language: 'zh-CN' }),
  showToast() {},
  hideToast() {},
  showLoading() {},
  hideLoading() {},
  request(options) {
    const path = String(options.url).replace(/^https?:\/\/[^/]+/, '').split('?')[0]
    const handler = routes[path]
    if (!handler) {
      throw new Error(`用例没有为 ${path} 准备桩数据`)
    }
    options.success({
      statusCode: 200,
      data: { retCode: 200, retData: handler(options) }
    })
  }
}

const api = require('../utils/api')
const tokenApi = require('../utils/token-api')

// 绑定链路：先拉产品列表匹配 productId，再 addUserProduct
routes['/Client/Product/getProductList'] = () => ({
  pageData: [{ productId: 7, productName: '智能相框', width: 680, height: 960 }]
})

// 扫描侧：广播名是「BoltStar-D428」这种机器味的名字，不是用户起的
const scanned = {
  deviceId: 'ble-handle-uuid',
  name: 'BoltStar-D428',
  deviceNo: 'e948c21ed428'
}

;(async () => {
  // ── ① 后端回带昵称 → 设备名以它为准 ─────────────────────────────────────
  {
    routes['/Client/UserProduct/addUserProduct'] = () => ({
      userProductId: 91,
      // 后端记着这台设备上次解绑前的名字，原样回带
      productName: '客厅那台'
    })
    const device = await api.bindDevice(scanned)
    assert.equal(
      device.name,
      '客厅那台',
      '后端回带了上次昵称就该带出它 —— 蓝牙广播名不能再盖在前面（命名弹窗取的就是 name）'
    )
    assert.equal(device.productName, '客厅那台')
  }

  // ── ①' 后端没回昵称（首次绑定/老后端）→ 维持原行为，别把名字弄丢 ─────────
  {
    routes['/Client/UserProduct/addUserProduct'] = () => ({ userProductId: 92 })
    const device = await api.bindDevice(scanned)
    assert.equal(
      device.name,
      'BoltStar-D428',
      '后端没给昵称时回落到原来的取值链（广播名/型号），不能变成空'
    )
  }

  // ── ② 星币消耗规则表的字段映射 ──────────────────────────────────────────
  {
    routes['/Client/Order/getAiConfigList'] = () => [
      { aiConfigId: 1, aiProject: '最低账户余额', num: 30.0, remark: '发起会话条件' },
      { aiConfigId: 2, aiProject: '纯文本对话', num: 5, remark: '仅文字问答' },
      { aiConfigId: 3, aiProject: '图生图 / 融合图-1', num: 32, remark: '1张参考图' }
    ]
    const rules = await tokenApi.getAiConfigs()

    assert.equal(rules.length, 3)
    assert.deepEqual(
      rules.map(item => item.name),
      ['最低账户余额', '纯文本对话', '图生图 / 融合图-1'],
      '顺序原样保留：后端按权重排好再下发，端上重排会和后台配置对不上'
    )
    assert.equal(rules[0].cost, '30', '30.0 要显示成 30 —— 星币是整数计价，小数点只会让人误会')
    assert.equal(rules[1].cost, '5')
    assert.equal(rules[0].remark, '发起会话条件')

    // 没有服务类型的脏数据不进表（整行都没意义，画出来就是一行空白）
    routes['/Client/Order/getAiConfigList'] = () => [
      { aiConfigId: 4, aiProject: '', num: 9, remark: '脏数据' },
      { aiConfigId: 5, aiProject: '纯文本对话', num: 5, remark: '' }
    ]
    const filtered = await tokenApi.getAiConfigs()
    assert.equal(filtered.length, 1)
    assert.equal(filtered[0].name, '纯文本对话')
  }

  console.log('rebind-name & ai-config: 全部用例通过')
})()
