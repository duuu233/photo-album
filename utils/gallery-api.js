// 官方图库 + 我的收藏 客户端接口层。
//
// 2026-08-12：**由本地 mock 切到真实后端**（接口清单 `assets/图库接口地址清单.png`，
// 字段以 https://api.boltfox.cn/v2/api-docs 当日快照为准）：
//   GET  /Client/Product/getImgCategory             公共图库分类列表  → ClientImgCategoryApiOut[]
//   GET  /Client/Product/getProductImgList          公共图库列表(分页) → BasePageOutput<ClientProductImgApiOut>
//   GET  /Client/Product/getProductImgDetail        公共图库详情(id=productImgId)
//   GET  /Client/Product/getProductImgCollectionList 用户图库收藏列表(分页)
//   POST /Client/Product/setImgCollected            图片收藏/取消收藏(入参只有 productImgId)
// 全部经 utils/request.js（自动带 userToken / terminal=3 / language 与两枚鉴权头）。
//
// 与页面的约定（沿用切接口前的字段名，wxml 不用动）：
//   列表项 { id, productImgId, title, url, thumbUrl, ratio, favorited }
//   详情   { id, productImgId, title, desc, url, favorited, sizes }
//
// ⚠️⚠️ **后端两处缺口，端上只能兜着**（都已在 docs/changes/2026-08-12-图库接口对接.md 记为待办）：
//
//   ① 列表项**没有图片宽高/比例**（`ClientProductImgApiOut` 只有 img/imgThumb/productImgId/title）。
//      瀑布流要在渲染前就把高度占住（否则图陆续到达时把下方卡片一路顶走，用户正看的那张会跳掉），
//      所以这里给 `ratio: 0`＝未知，页面按 DEFAULT_RATIO 先占位、图片 bindload 拿到真实宽高后
//      再校正**那一张**。请后端在列表项里补 width/height 或 ratio，这段兜底即可删。
//
//   ② 列表项**没有收藏态**（详情才有 `isAlreadyCollected`）。图库列表右上角的红心要按收藏态
//      显示实心/描边，所以另用 `getFavoriteIds()` 拉一页收藏列表在端上标记 —— 拉不到就一律按
//      未收藏渲染（不影响点击，点了以详情/收藏列表为准）。请后端给 `ClientProductImgApiOut`
//      补 `isAlreadyCollected`，这次额外请求即可省掉。
const http = require('./request')

// 列表分页大小。瀑布流两列，20 条≈10 行，一屏多一点，滚到底再续
const PAGE_SIZE = 20

// 列表项拿不到真实比例时的占位比例（宽/高）。取 0.75（3:4 竖图）——
// 图库以竖图为主，用它兜底时首屏的错落感最接近真实数据
const DEFAULT_RATIO = 0.75

// 「收藏态兜底扫描」一次拉多少条（见文件头缺口②）。收藏一般不会太多，一页够用；
// 真超了也只是第 200 条之后的图在列表里显示成未收藏，点进详情仍是对的。
const FAVORITE_SCAN_SIZE = 200

// 客户端补的「全部」分类：后端 `getImgCategory` 只给真实分类，而 `getProductImgList` 的
// `categoryId` 是可选参数（不传即全部）。没有它，进页面就只能看见第一个分类。
const ALL_CATEGORY = { id: '', categoryId: 0, name: '全部' }

function toNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback || 0
}

// BasePageOutput 取列表：与 utils/token-api.js 的 pageRows 同口径
function pageRows(data) {
  if (Array.isArray(data)) {
    return data
  }
  if (data && Array.isArray(data.pageData)) {
    return data.pageData
  }
  return []
}

/**
 * 分页判停：优先用后端的 `pageCount`，缺失时退回「不满一页即最后一页」。
 * 不能只看条数——后端可能无视 pageSize 按自己的默认值分页（同 token-api.getRecords 的老坑）。
 */
function hasMorePage(data, pageIndex, pageSize, rowCount) {
  const pageCount = toNumber(data && data.pageCount, 0)
  return pageCount > 0 ? pageIndex < pageCount : rowCount >= pageSize
}

/**
 * 列表项归一。`id` 保持字符串：页面用它做比对、还要经 URL 传给详情页，
 * 数字进出 URL 容易变类型；真正提交给接口的是数字 `productImgId`。
 */
function normalizePhoto(item) {
  const source = item || {}
  const productImgId = toNumber(source.productImgId, 0)
  return {
    id: String(productImgId),
    productImgId,
    title: source.title || '',
    // 详情/投屏用原图，列表用缩略图（后端没给缩略图时回落原图）
    url: source.img || '',
    thumbUrl: source.imgThumb || source.img || '',
    // 0 = 未知，页面按 DEFAULT_RATIO 占位后由 bindload 校正（见文件头缺口①）。
    // 后端哪天补了字段，这里认 ratio 或 width/height 两种写法，页面不用改。
    ratio:
      toNumber(source.ratio, 0) > 0
        ? toNumber(source.ratio, 0)
        : toNumber(source.width, 0) > 0 && toNumber(source.height, 0) > 0
          ? toNumber(source.width, 0) / toNumber(source.height, 0)
          : 0,
    favorited: false
  }
}

/** 详情归一。`content` 是简介、`isAlreadyCollected` 是 0/1 而不是布尔 */
function normalizeDetail(data) {
  const source = data || {}
  const productImgId = toNumber(source.productImgId, 0)
  return {
    id: String(productImgId),
    productImgId,
    title: source.title || '',
    desc: source.content || '',
    url: source.img || '',
    favorited: toNumber(source.isAlreadyCollected, 0) === 1,
    // 「适用设备尺寸」区块 2026-08-12 已按产品要求从详情页去掉，字段仍解出来备用
    sizes: Array.isArray(source.productSizeList)
      ? source.productSizeList.filter(Boolean)
      : String(source.productSizes || '')
          .split(/[,，\s]+/)
          .filter(Boolean)
  }
}

/**
 * 把一维列表分成左右两列的瀑布流。
 *
 * 用**累计高度**而不是奇偶下标分列：图片高宽比不一，按奇偶分会让一列明显长出一截
 * （设计稿里两列的卡片底部是错开但整体齐平的）。
 * ⚠️ 当前后端列表项没有比例（见文件头缺口①），传进来的多半是同一个默认值，
 * 这时它退化成奇偶交替，两列高度可能不齐 —— 图加载完各自校正高度后会自然错落。
 * **不要**在校正后重新分列：那会让用户正在看的卡片整块跳走。
 */
function splitColumns(list) {
  const columns = [[], []]
  const heights = [0, 0]
  list.forEach((item) => {
    const target = heights[0] <= heights[1] ? 0 : 1
    columns[target].push(item)
    // 1 / ratio = 高/宽；再加上标题行的固定高度（估值，单位与列宽同为「份」）
    heights[target] += 1 / (Number(item.ratio) || DEFAULT_RATIO) + 0.22
  })
  return columns
}

/** 按列宽算这一张的渲染高度（rpx）。ratio 未知时用 DEFAULT_RATIO 兜底 */
function photoHeight(ratio, columnWidth) {
  return Math.round(columnWidth / (Number(ratio) || DEFAULT_RATIO))
}

/**
 * 分类导航。返回 [{ id, categoryId, name }]，首项是端上补的「全部」（id 为空串）。
 */
function getCategories() {
  return http
    .get('/Client/Product/getImgCategory', {}, { mock: false })
    .then((data) => {
      const list = (Array.isArray(data) ? data : []).map((item) => {
        const categoryId = toNumber(item && item.categoryId, 0)
        return {
          id: String(categoryId),
          categoryId,
          name: (item && item.categoryName) || ''
        }
      })
      return [Object.assign({}, ALL_CATEGORY)].concat(list)
    })
}

/**
 * 公共图库列表（分页）。
 * @param {{categoryId?: string|number, pageIndex?: number, pageSize?: number}} [options]
 *        categoryId 空＝全部（后端该参数可选）
 * @returns {Promise<{list: Array, hasMore: boolean, pageIndex: number, total: number}>}
 */
function getPhotos(options) {
  const opts = options || {}
  const pageIndex = Math.max(1, toNumber(opts.pageIndex, 1))
  const pageSize = Math.max(1, toNumber(opts.pageSize, PAGE_SIZE))
  const query = { pageIndex, pageSize }
  // 空串/0 一律不传：request.js 会把空值滤掉，但显式些，免得以后有人以为 0 是「全部」的编码
  const categoryId = toNumber(opts.categoryId, 0)
  if (categoryId > 0) {
    query.categoryId = categoryId
  }

  return http
    .get('/Client/Product/getProductImgList', query, { mock: false })
    .then((data) => {
      const rows = pageRows(data)
      return {
        list: rows.map(normalizePhoto),
        hasMore: hasMorePage(data, pageIndex, pageSize, rows.length),
        pageIndex,
        total: toNumber(data && data.recordCount, rows.length)
      }
    })
}

/**
 * 用户图库收藏列表（分页）。列表项与公共图库同结构，只是这里的每一张按定义都是已收藏。
 */
function getFavorites(options) {
  const opts = options || {}
  const pageIndex = Math.max(1, toNumber(opts.pageIndex, 1))
  const pageSize = Math.max(1, toNumber(opts.pageSize, PAGE_SIZE))

  return http
    .get(
      '/Client/Product/getProductImgCollectionList',
      { pageIndex, pageSize },
      { mock: false }
    )
    .then((data) => {
      const rows = pageRows(data)
      return {
        list: rows.map((item) =>
          Object.assign(normalizePhoto(item), { favorited: true })
        ),
        hasMore: hasMorePage(data, pageIndex, pageSize, rows.length),
        pageIndex,
        total: toNumber(data && data.recordCount, rows.length)
      }
    })
}

/**
 * 收藏态兜底：拉一页收藏列表，返回其中的图片 id 数组（见文件头缺口②）。
 * **静默失败**返回空数组：未登录、接口异常都只是让列表里的心都显示成描边，
 * 不该因此打断图库浏览，更不该弹一条红字。
 */
function getFavoriteIds() {
  return http
    .get(
      '/Client/Product/getProductImgCollectionList',
      { pageIndex: 1, pageSize: FAVORITE_SCAN_SIZE },
      { mock: false, showError: false }
    )
    .then((data) => pageRows(data).map((item) => String(toNumber(item && item.productImgId, 0))))
    .catch(() => [])
}

/** 图片详情（id 传 productImgId） */
function getPhotoDetail(id) {
  const productImgId = toNumber(id, 0)
  if (!productImgId) {
    return Promise.reject({ code: 'NOT_FOUND', message: '图片不存在或已下架' })
  }
  return http
    .get('/Client/Product/getProductImgDetail', { id: productImgId }, { mock: false })
    .then((data) => {
      if (!data || !toNumber(data.productImgId, 0)) {
        return Promise.reject({ code: 'NOT_FOUND', message: '图片不存在或已下架' })
      }
      return normalizeDetail(data)
    })
}

/**
 * 收藏 / 取消收藏（同一个接口来回切）。
 *
 * @param {string|number} id       productImgId
 * @param {boolean} favorited      **当前**收藏态
 * @returns {Promise<boolean>} 切换后的收藏态
 *
 * ⚠️ 新状态由端上**取反当前态**推出，不看接口返回值：`setImgCollected` 的出参是
 * `BaseOutput<boolean>`，而这个布尔到底是「操作是否成功」还是「切换后的收藏态」文档没写。
 * 两种语义下「取反」都是对的（真失败会走 reject，到不了这里）。原值打进日志供对账，
 * 后端明确后再决定要不要改用它。
 */
function toggleFavorite(id, favorited) {
  const productImgId = toNumber(id, 0)
  if (!productImgId) {
    return Promise.reject({ code: 'NOT_FOUND', message: '图片不存在或已下架' })
  }
  return http
    .post('/Client/Product/setImgCollected', { productImgId }, { mock: false })
    .then((data) => {
      console.log('[图库] setImgCollected 返回', data, '（端上按取反推定新状态）')
      return !favorited
    })
}

module.exports = {
  PAGE_SIZE,
  DEFAULT_RATIO,
  ALL_CATEGORY,
  splitColumns,
  photoHeight,
  getCategories,
  getPhotos,
  getFavorites,
  getFavoriteIds,
  getPhotoDetail,
  toggleFavorite,
  // 归一函数导出供单测直接验字段映射（String→Number、0/1→布尔这类最容易接错的地方）
  normalizePhoto,
  normalizeDetail
}
