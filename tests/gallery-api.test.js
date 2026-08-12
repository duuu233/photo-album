// 官方图库接口对接的字段映射回归（2026-08-12，由 mock 切到 `/Client/Product/*`）。
//
// 锁的是「接错了页面照样渲染、只是数据不对」的那几处 —— 这类错误没有任何地方会报错：
//   ① `productImgId` 是 **integer**，页面拿它当 id 比对、还要经 URL 传给详情页，必须转字符串；
//      提交给接口的又必须是数字（`setImgCollected` 的入参是 integer）；
//   ② 详情的收藏态是 **`isAlreadyCollected` 0/1**，不是布尔；简介字段叫 `content` 不叫 desc；
//   ③ 列表是 **BasePageOutput**（pageData/pageCount/recordCount），判停优先 pageCount ——
//      只看条数会在「后端无视 pageSize 按自己的默认值分页」时提前停（同购买记录页的老坑）；
//   ④ 「全部」分类是**端上补的**（后端只给真实分类，列表接口的 categoryId 可选），
//      id 是空串 —— 判空写成 `if (id)` 就会把「全部」当成没选中；
//   ⑤ `setImgCollected` 的返回布尔语义未定（成功？还是切换后的态？），端上一律按取反推新状态。
const assert = require('node:assert/strict')

const storage = { token: 'user-token', jwtToken: 'jwt-token' }
const routes = {}
let requests = []

global.getCurrentPages = () => []
global.getApp = () => ({ globalData: {} })
global.wx = {
  getStorageSync: key => storage[key],
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
    requests.push({ path, method: options.method, data: options.data })
    const result = handler(options)
    options.success(
      result && result.body
        ? { statusCode: 200, data: result.body }
        : { statusCode: 200, data: { retCode: 200, retData: result } }
    )
  }
}

const galleryApi = require('../utils/gallery-api')

;(async () => {
  // ── ① 分类：categoryId(int) → id(string)，首项是端上补的「全部」 ─────────────
  {
    routes['/Client/Product/getImgCategory'] = () => [
      { categoryId: 12, categoryName: '风景' },
      { categoryId: 13, categoryName: '人物' }
    ]
    const categories = await galleryApi.getCategories()
    assert.equal(categories.length, 3, '后端两个分类 + 端上补的「全部」')
    assert.deepEqual(categories[0], { id: '', categoryId: 0, name: '全部' })
    assert.equal(categories[1].id, '12', 'id 必须是字符串（页面比对 + 进 URL）')
    assert.equal(categories[1].categoryId, 12, '提交给接口的仍是数字')
    assert.equal(categories[1].name, '风景')
  }

  // ── ② 列表：分页壳 + 字段映射 + 「全部」不传 categoryId ──────────────────────
  {
    routes['/Client/Product/getProductImgList'] = () => ({
      pageIndex: 1,
      pageCount: 3,
      recordCount: 47,
      pageData: [
        { productImgId: 101, title: '蓝天绿树', img: 'https://oss/a.jpg', imgThumb: 'https://oss/a-thumb.jpg' },
        { productImgId: 102, title: '雪山', img: 'https://oss/b.jpg' }
      ]
    })
    requests = []
    const page = await galleryApi.getPhotos({ categoryId: '', pageIndex: 1 })

    assert.equal(requests[0].data.categoryId, undefined, '「全部」不能带 categoryId，后端该参数可选')
    assert.equal(requests[0].data.pageIndex, 1)
    assert.equal(requests[0].data.pageSize, galleryApi.PAGE_SIZE)

    assert.equal(page.total, 47, 'total 取 recordCount，不是本页条数')
    assert.equal(page.hasMore, true, 'pageIndex(1) < pageCount(3) → 还有下一页')
    assert.equal(page.list[0].id, '101')
    assert.equal(page.list[0].productImgId, 101)
    assert.equal(page.list[0].url, 'https://oss/a.jpg')
    assert.equal(page.list[0].thumbUrl, 'https://oss/a-thumb.jpg')
    assert.equal(page.list[1].thumbUrl, 'https://oss/b.jpg', '没给缩略图就回落原图，别让列表空着')
    assert.equal(page.list[0].ratio, 0, '后端不给比例：0=未知，由页面按 DEFAULT_RATIO 占位再校正')
    assert.equal(page.list[0].favorited, false, '列表项没有收藏态，默认未收藏（由收藏列表另行标记）')

    // 选了具体分类才带 categoryId
    requests = []
    await galleryApi.getPhotos({ categoryId: '12', pageIndex: 2 })
    assert.equal(requests[0].data.categoryId, 12, 'categoryId 提交给接口时是数字')
    assert.equal(requests[0].data.pageIndex, 2)

    // 判停兜底：后端没给 pageCount 时看「够不够一页」
    routes['/Client/Product/getProductImgList'] = () => ({
      pageData: [{ productImgId: 1, img: 'https://oss/x.jpg' }]
    })
    const tail = await galleryApi.getPhotos({ pageIndex: 1 })
    assert.equal(tail.hasMore, false, '不满一页即最后一页')
  }

  // ── ③ 详情：content→desc、img→url、isAlreadyCollected 0/1 → 布尔 ────────────
  {
    routes['/Client/Product/getProductImgDetail'] = () => ({
      productImgId: 101,
      title: '蓝天绿树',
      content: '抬头是一整片被阳光滤过的绿',
      img: 'https://oss/a.jpg',
      isAlreadyCollected: 1,
      productSizeList: ['680×960', '470×760']
    })
    requests = []
    const detail = await galleryApi.getPhotoDetail('101')
    assert.equal(requests[0].data.id, 101, 'id 传的是 productImgId，且必须是数字')
    assert.equal(detail.id, '101')
    assert.equal(detail.desc, '抬头是一整片被阳光滤过的绿', '简介字段后端叫 content')
    assert.equal(detail.url, 'https://oss/a.jpg')
    assert.equal(detail.favorited, true, 'isAlreadyCollected=1 → 已收藏')
    assert.deepEqual(detail.sizes, ['680×960', '470×760'])

    routes['/Client/Product/getProductImgDetail'] = () => ({
      productImgId: 101,
      isAlreadyCollected: 0,
      productSizes: '680×960,470×760'
    })
    const plain = await galleryApi.getPhotoDetail(101)
    assert.equal(plain.favorited, false, 'isAlreadyCollected=0 → 未收藏（不能当成「有值即已收藏」）')
    assert.deepEqual(plain.sizes, ['680×960', '470×760'], '只给字符串时也要拆得出来')

    // 详情取不到图片（下架/脏 id）要 reject，不能让页面拿一个空壳去渲染
    routes['/Client/Product/getProductImgDetail'] = () => null
    await assert.rejects(() => galleryApi.getPhotoDetail(999))
    await assert.rejects(() => galleryApi.getPhotoDetail(''), '空 id 直接拒，别白打一次接口')
  }

  // ── ④ 收藏列表：每一项按定义都是已收藏 ──────────────────────────────────────
  {
    routes['/Client/Product/getProductImgCollectionList'] = () => ({
      pageCount: 1,
      recordCount: 2,
      pageData: [
        { productImgId: 101, img: 'https://oss/a.jpg' },
        { productImgId: 205, img: 'https://oss/c.jpg' }
      ]
    })
    const page = await galleryApi.getFavorites({ pageIndex: 1 })
    assert.equal(page.list.length, 2)
    assert.equal(page.list[0].favorited, true, '收藏列表里的每一张都是已收藏')
    assert.equal(page.hasMore, false)

    // 图库列表的收藏态兜底：只要 id
    const ids = await galleryApi.getFavoriteIds()
    assert.deepEqual(ids, ['101', '205'])

    // 静默失败：未登录 / 接口异常都只让红心显示成描边，不该打断图库浏览
    routes['/Client/Product/getProductImgCollectionList'] = () => {
      throw new Error('boom')
    }
    assert.deepEqual(await galleryApi.getFavoriteIds(), [], '拿不到收藏态要静默返回空')
  }

  // ── ⑤ 收藏切换：入参是数字 productImgId，新状态按取反推 ──────────────────────
  {
    routes['/Client/Product/setImgCollected'] = () => true
    requests = []
    assert.equal(await galleryApi.toggleFavorite('101', false), true, '未收藏 → 收藏')
    assert.equal(requests[0].method, 'POST')
    assert.deepEqual(requests[0].data, { productImgId: 101 }, '入参只有 productImgId，且是数字')

    // ⚠️ 返回值语义未定（「操作成功」还是「切换后的态」都可能），端上一律取反：
    //    两种语义下这都是对的，真失败会走 reject
    routes['/Client/Product/setImgCollected'] = () => true
    assert.equal(await galleryApi.toggleFavorite('101', true), false, '已收藏 → 取消（不看 retData）')
  }

  console.log('gallery-api: 全部用例通过')
})()
