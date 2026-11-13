// 「我的」页「我的相册」卡片的张数 = **全部设备**的投屏成功记录条数
// （api.getProjectionSuccessCount，2026-08-05 起替代原来的相册口径 imgCount）。
//
// 锁成回归用例的三条红线：
// ① 后端认 deviceUploadState 时用分页元数据 recordCount —— 超过单页条数不能被截断；
// 2026-11-14 有意改口径：单页由 100 改为 21（与「我的上传」同口径，一次少传更快），保险丝由 20 页改为 100 页，
// 下面各用例的条数随之调整，三条红线判据不变。
// ② 后端忽略该参数时 recordCount 是「成功+失败」合计，不能直接用，必须逐页翻并按状态过滤；
// ③ 分页元数据缺失/异常时要能停下来（不满一页即最后一页；再不行有页数保险丝），不能死循环。
const assert = require('assert')
const api = require('../utils/api')

const PAGE_SIZE = 21
// deviceUploadState：1=投屏成功，0=失败
const rows = (count, state) =>
  Array.from({ length: count }, (_, i) => ({
    upirId: `r${state}-${i}`,
    deviceUploadState: state
  }))

;(async () => {
  const originalList = api.getUserProductImgRecordList
  try {
    // ① 后端确实过滤了：整页都是成功记录 → 直接取 recordCount，一次请求拿到真实总数
    let calls = []
    api.getUserProductImgRecordList = params => {
      calls.push(params)
      return Promise.resolve({
        pageData: rows(PAGE_SIZE, 1),
        recordCount: 238,
        pageCount: 3
      })
    }
    assert.strictEqual(await api.getProjectionSuccessCount(), 238)
    assert.strictEqual(calls.length, 1)
    assert.strictEqual(calls[0].deviceUploadState, 1)
    // 卡片统计的是全部设备的合计：绝不能带 userProductId 把范围缩到某一台设备
    assert.strictEqual(calls[0].userProductId, undefined)

    // ② 后端忽略 deviceUploadState（页里混着失败记录）：recordCount(150) 不能当成功数用，
    //    逐页翻 + 按状态过滤，只数成功的那些
    calls = []
    api.getUserProductImgRecordList = params => {
      calls.push(params)
      const page = params.pageIndex === 1
        ? rows(60, 1).concat(rows(40, 0))
        : rows(30, 1).concat(rows(20, 0))
      return Promise.resolve({ pageData: page, recordCount: 150, pageCount: 2 })
    }
    assert.strictEqual(await api.getProjectionSuccessCount(), 90)
    assert.strictEqual(calls.length, 2)

    // ③ 没有任何分页元数据：整页(21 条)说明可能还有下一页，必须继续翻；
    //    不满一页即最后一页 —— 21 + 10 = 31
    calls = []
    api.getUserProductImgRecordList = params => {
      calls.push(params)
      return Promise.resolve({
        pageData: params.pageIndex === 1 ? rows(PAGE_SIZE, 1) : rows(10, 1)
      })
    }
    assert.strictEqual(await api.getProjectionSuccessCount(), 31)
    assert.strictEqual(calls.length, 2)
    assert.strictEqual(calls[0].pageSize, 21, '单页 21 条')

    // ③ 之二：后端一直回满页且不给元数据时，靠页数保险丝停住（100 页 × 21 条）
    calls = []
    api.getUserProductImgRecordList = params => {
      calls.push(params)
      return Promise.resolve({ pageData: rows(PAGE_SIZE, 1) })
    }
    assert.strictEqual(await api.getProjectionSuccessCount(), 2100)
    assert.strictEqual(calls.length, 100)

    // 一条成功记录都没有 → 0（不能因为空页去翻第二页）
    calls = []
    api.getUserProductImgRecordList = () => {
      calls.push(1)
      return Promise.resolve({ pageData: [], recordCount: 0, pageCount: 0 })
    }
    assert.strictEqual(await api.getProjectionSuccessCount(), 0)
    assert.strictEqual(calls.length, 1)

    // 后端只回裸数组（无分页壳）时同样能数：不满一页即结束
    api.getUserProductImgRecordList = () => Promise.resolve(rows(7, 1))
    assert.strictEqual(await api.getProjectionSuccessCount(), 7)

    console.log('projection-success-count tests passed')
  } finally {
    api.getUserProductImgRecordList = originalList
  }
})().catch(error => {
  console.error(error)
  process.exit(1)
})
