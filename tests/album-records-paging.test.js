// 「我的上传」投屏记录分页（2026-11-03）：每页 21 条，触底加载下一页。
//   ① api.getProjectionRecordsPage：带 pageIndex / pageSize；hasMore 先信 pageCount、再信 recordCount，都没回才看条数；
//      getProjectionRecords（投屏记录页、WiFi 轮播选图在用）仍是第一页 100 条，不跟着改；
//   ② 「我的上传」页：首屏取第 1 页 21 条，onReachBottom 追加下一页、沿用同一组查询条件、按 id 去重、保留已选；
//      没有下一页 / 加载中 / 首屏失败时不再请求；下一页失败只标 moreError，已加载的照片不清；
//      切设备（重新 loadRecords）后，旧设备的翻页回包丢弃；
//   ③ 「共 N 张」：第一页全是成功记录时用后端 recordCount，否则按已加载的成功张数。
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8')

;(async () => {
  // ① api 层
  {
    const api = require('../utils/api')
    const original = api.getUserProductImgRecordList
    const calls = []
    let reply = null
    api.getUserProductImgRecordList = params => {
      calls.push(params)
      return Promise.resolve(reply)
    }
    const rows = n => Array.from({ length: n }, (_, i) => ({ upirId: String(i + 1), deviceUploadState: 1 }))
    try {
      reply = { pageData: rows(21), pageCount: 3, recordCount: 50 }
      let page = await api.getProjectionRecordsPage({ deviceUploadState: 1, pageIndex: 2, pageSize: 21 })
      assert.strictEqual(calls[0].pageIndex, 2)
      assert.strictEqual(calls[0].pageSize, 21)
      assert.strictEqual(page.hasMore, true, 'pageCount=3、第 2 页 → 还有')
      assert.strictEqual(page.records.length, 21)
      assert.strictEqual(page.recordCount, 50)

      reply = { pageData: rows(8), pageCount: 3, recordCount: 50 }
      page = await api.getProjectionRecordsPage({ pageIndex: 3, pageSize: 21 })
      assert.strictEqual(page.hasMore, false, '最后一页')

      // 只回 10 条（后端按自己的默认值分页），但 pageCount 说还有 → 信 pageCount
      reply = { pageData: rows(10), pageCount: 2 }
      page = await api.getProjectionRecordsPage({ pageIndex: 1, pageSize: 21 })
      assert.strictEqual(page.hasMore, true, '不按条数判停')

      reply = { pageData: rows(21), recordCount: 21 }
      page = await api.getProjectionRecordsPage({ pageIndex: 1, pageSize: 21 })
      assert.strictEqual(page.hasMore, false, '只有 recordCount 时按累计条数判')

      reply = { pageData: rows(21) }
      page = await api.getProjectionRecordsPage({ pageIndex: 1, pageSize: 21 })
      assert.strictEqual(page.hasMore, true, '元数据都没回：满页认为还有')

      reply = { pageData: [], pageCount: 5 }
      page = await api.getProjectionRecordsPage({ pageIndex: 2, pageSize: 21 })
      assert.strictEqual(page.hasMore, false, '空页一律停')

      reply = { pageData: rows(3) }
      const list = await api.getProjectionRecords({ deviceUploadState: 1 })
      const last = calls[calls.length - 1]
      assert.ok(Array.isArray(list) && list.length === 3, 'getProjectionRecords 仍返回数组')
      assert.strictEqual(last.pageIndex, 1, 'getProjectionRecords 仍取第 1 页')
      assert.strictEqual(last.pageSize, 100, 'getProjectionRecords 仍是 100 条（轮播选图不变）')
    } finally {
      api.getUserProductImgRecordList = original
    }
  }

  // 轮播设置选图仍走 getProjectionRecords、不传 pageSize
  {
    const source = read('subpackages/device/wifi-slideshow/wifi-slideshow.js')
    const calls = source.match(/getProjectionRecords\(\{[\s\S]*?\}\)/g) || []
    assert.ok(calls.length > 0, '轮播选图仍调 getProjectionRecords')
    calls.forEach(call => assert.ok(!/pageSize/.test(call), '轮播选图不改分页'))
  }

  // ② ③ 「我的上传」页
  {
    const stubModule = (request, exports) => {
      const filename = require.resolve(request)
      require.cache[filename] = { id: filename, filename, loaded: true, children: [], paths: [], exports }
    }
    global.wx = new Proxy({ getStorageSync: () => undefined, setStorageSync: () => {} }, {
      get: (target, key) => key in target ? target[key] : () => {}
    })
    global.getApp = () => ({ globalData: {} })
    const requests = []
    const pending = []
    stubModule('../utils/api', {
      getProjectionRecordsPage: params => {
        requests.push(params)
        return new Promise((resolve, reject) => pending.push({ resolve, reject }))
      }
    })
    ;['../utils/iot-api', '../utils/wifi-status', '../utils/device-ble', '../utils/device-info', '../utils/media'].forEach(name => stubModule(name, {}))
    stubModule('../utils/toast', { warn: () => {}, show: () => {}, error: () => {} })
    stubModule('../utils/active-device', { friendlyConnectMessage: m => m, findConnectedDeviceId: () => '' })
    stubModule('../utils/system', { getLayoutMetrics: () => ({}) })
    stubModule('../utils/upload-limit', { albumPickLimit: () => 10 })
    stubModule('../utils/fold-adapt', { adapt: options => options })
    let pageOptions = null
    global.Page = options => { pageOptions = options }
    delete require.cache[require.resolve('../subpackages/album/list/list.js')]
    require('../subpackages/album/list/list.js')

    const page = Object.create(pageOptions)
    page.data = JSON.parse(JSON.stringify(pageOptions.data))
    // 支持小程序 setData 的路径写法 filteredPhotos[n]
    page.setData = patch => Object.keys(patch).forEach(key => {
      const m = key.match(/^(\w+)\[(\d+)\]$/)
      if (m) {
        page.data[m[1]] = page.data[m[1]].slice()
        page.data[m[1]][Number(m[2])] = patch[key]
      } else {
        page.data[key] = patch[key]
      }
    })
    page.devices = [
      { id: 'W1', userProductId: 'W1', name: 'WiFi相框', productDeviceId: 'D0:CF:13:F0:2F:F8' },
      { id: 'B1', userProductId: 'B1', name: '旧相框', productDeviceId: '' }
    ]
    const recs = (from, n, status = 'success') => Array.from({ length: n }, (_, i) => ({ id: String(from + i), status, img: 'x', imgThumb: 'x' }))
    const settle = () => new Promise(resolve => setImmediate(resolve))
    const originalLog = console.log
    const originalWarn = console.warn
    console.log = () => {}
    console.warn = () => {}
    try {
      assert.strictEqual(pageOptions.data.pageSize, 21, '每页 21 条')

      // 首屏
      let loading = page.loadRecords('W1')
      assert.strictEqual(requests[0].pageIndex, 1)
      assert.strictEqual(requests[0].pageSize, 21)
      assert.strictEqual(requests[0].deviceId, 'D0:CF:13:F0:2F:F8')
      pending.shift().resolve({ records: recs(1, 21), rowCount: 21, recordCount: 45, hasMore: true })
      await loading
      assert.strictEqual(page.data.filteredPhotos.length, 21)
      assert.strictEqual(page.data.hasMore, true)
      assert.strictEqual(page.data.totalCount, 45, '整页成功 → 共 N 张用 recordCount')

      // 选一张，触底翻页：已选保留，条件沿用
      page.setData({ selectedMap: { 3: true }, selectedCount: 1 })
      loading = page.onReachBottom()
      page.onReachBottom() // 加载中再触底不重复请求
      assert.strictEqual(requests.length, 2, '加载中不重复请求')
      assert.strictEqual(requests[1].pageIndex, 2)
      assert.strictEqual(requests[1].pageSize, 21)
      assert.strictEqual(requests[1].deviceId, 'D0:CF:13:F0:2F:F8', '翻页沿用 deviceId')
      assert.strictEqual(requests[1].userProductId, 'W1')
      assert.strictEqual(page.data.loadingMore, true)
      // 第 2 页与第 1 页重叠一条（id 21）
      pending.shift().resolve({ records: recs(21, 21), rowCount: 21, recordCount: 45, hasMore: true })
      await loading
      assert.strictEqual(page.data.filteredPhotos.length, 41, '按 id 去重后追加')
      assert.strictEqual(page.records.length, 41)
      assert.deepStrictEqual(page.data.selectedMap, { 3: true }, '翻页不清已选')
      assert.strictEqual(page.data.loadingMore, false)

      // 第 3 页失败：照片保留，标 moreError，可点重试
      loading = page.onReachBottom()
      pending.shift().reject(new Error('net'))
      await loading
      assert.strictEqual(page.data.moreError, true)
      assert.strictEqual(page.data.filteredPhotos.length, 41, '失败不清已加载')
      loading = page.retryLoadMore()
      assert.strictEqual(requests[requests.length - 1].pageIndex, 3, '重试仍是第 3 页')
      pending.shift().resolve({ records: recs(42, 4), rowCount: 4, recordCount: 45, hasMore: false })
      await loading
      assert.strictEqual(page.data.filteredPhotos.length, 45)
      assert.strictEqual(page.data.hasMore, false)
      assert.strictEqual(page.data.moreError, false)
      const count = requests.length
      await page.onReachBottom()
      assert.strictEqual(requests.length, count, '没有下一页不再请求')

      // 首屏混有失败记录：共 N 张按已加载成功张数
      loading = page.loadRecords('B1')
      pending.shift().resolve({ records: recs(1, 20).concat(recs(100, 1, 'failed')), rowCount: 21, recordCount: 60, hasMore: true })
      await loading
      assert.strictEqual(page.data.filteredPhotos.length, 20)
      assert.strictEqual(page.data.totalCount, 20, 'recordCount 混着失败记录，不用')
      assert.deepStrictEqual(page.data.selectedMap, {}, '切设备清已选')

      // 翻页途中切设备：旧回包丢弃
      const stale = page.onReachBottom()
      const fresh = page.loadRecords('W1')
      pending.shift().resolve({ records: recs(500, 21), rowCount: 21, recordCount: 60, hasMore: true }) // B1 第 2 页
      pending.shift().resolve({ records: recs(1, 5), rowCount: 5, recordCount: 5, hasMore: false })
      await Promise.all([stale, fresh])
      await settle()
      assert.strictEqual(page.data.filteredPhotos.length, 5, '旧设备的翻页不倒灌')
      assert.ok(!page.records.some(item => item.id === '500'))

      // 首屏失败时触底不翻页
      loading = page.loadRecords('W1')
      pending.shift().reject(new Error('net'))
      await loading
      const before = requests.length
      await page.onReachBottom()
      assert.strictEqual(requests.length, before, '首屏失败不翻页')
    } finally {
      console.log = originalLog
      console.warn = originalWarn
    }
  }

  // 模板：分页尾在网格里（选中时 has-bottom-bar 留白落在它下面）
  {
    const wxml = read('subpackages/album/list/list.wxml')
    const grid = wxml.slice(wxml.indexOf('<view class="photo-grid'), wxml.indexOf('<!-- 底部操作栏'))
    assert.ok(/class="photo-more"[^>]*bindtap="retryLoadMore"/.test(grid), '分页尾在网格内、可点重试')
    assert.ok(/\.photo-more \{[^}]*grid-column: 1 \/ -1;/.test(read('subpackages/album/list/list.wxss')), '分页尾横跨三列')
  }

  console.log('album-records-paging: ok')
})().catch(error => {
  console.error(error)
  process.exit(1)
})
