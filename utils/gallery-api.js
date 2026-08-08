// 官方图库 + 我的收藏 客户端接口层。
//
// ⚠️ 后端接口尚未提供：`docs/reference/client-api-matrix.md` 里没有官方图库分类、图片列表、
//    图片详情或收藏相关的 `/Client/...` 端点。本模块先按需求文档
//    （`assets/ai/支付&ai&官方图库.docx`「三、官方图库模块」）固定客户端契约，
//    数据由本地 mock 提供，接口就位后只替换各方法体内的取数分支。
//
// 收藏态目前落在本机 Storage，**只是 mock**：换手机/重装即丢，也不会跨端同步。
// 真实实现必须是服务端账号维度的收藏关系。

const MOCK_DELAY = 220

// 收藏关系本地缓存 key。接真实接口后应删除。
const MOCK_FAVORITE_KEY = 'mockGalleryFavorites'

// 分类：`id` 供接口筛选，`name` 供 UI 展示。`hot`/`new` 是后端排序口径而非真实标签，
// 与「风景/人物/动漫」这类内容标签分开，避免前端把两者混成同一个参数。
const CATEGORIES = [
  { id: 'hot', name: '热门' },
  { id: 'new', name: '最新' },
  { id: 'landscape', name: '风景' },
  { id: 'portrait', name: '人物' },
  { id: 'anime', name: '动漫' }
]

// 设备尺寸标签：详情页「适用设备尺寸」。取值与投屏链路的设备物理分辨率同口径
// （见 docs/architecture/image-projection-pipeline.md），不要在这里另造一套写法。
const MOCK_PHOTOS = [
  {
    id: 'g1',
    title: '蓝天绿树',
    desc: '抬头是一整片被阳光滤过的绿，风穿过枝叶，把夏天的声音一并带了下来。',
    url: 'https://oss.boltfox.cn/prodFile/gallery/blue-sky-green-tree.jpg',
    ratio: 0.75, // 宽/高，列表瀑布流预占位用，避免图片加载后跳版
    sizes: ['680×960', '470×760'],
    category: ['hot', 'landscape']
  },
  {
    id: 'g2',
    title: '把夏天抛向天空',
    desc: '草地、躺椅和一顶被抛起来的帽子，夏天最好的样子大概就是这样。',
    url: 'https://oss.boltfox.cn/prodFile/gallery/summer-sky.jpg',
    ratio: 1,
    sizes: ['680×960', '800×1200'],
    category: ['hot', 'new', 'portrait']
  },
  {
    id: 'g3',
    title: '我们是好朋友',
    desc: '一黑一黄两只边牧趴在草里，舌头吐着，眼睛亮得像刚下过雨。',
    url: 'https://oss.boltfox.cn/prodFile/gallery/good-friends.jpg',
    ratio: 1.1,
    sizes: ['680×960', '470×760', '800×1200'],
    category: ['hot', 'new']
  },
  {
    id: 'g4',
    title: '午后的风吹过发梢',
    desc: '逆光里的一点绒毛，和被晒得发暖的空气，午后就这么慢慢过去了。',
    url: 'https://oss.boltfox.cn/prodFile/gallery/afternoon-breeze.jpg',
    ratio: 0.78,
    sizes: ['680×960', '800×1200'],
    category: ['hot', 'portrait']
  },
  {
    id: 'g5',
    title: '走进风吹过的草海',
    desc: '沿着草浪间的小路慢慢前行，风把绿色吹成层层波纹，也把忙碌的日子，轻轻放慢。',
    url: 'https://oss.boltfox.cn/prodFile/gallery/grass-sea.jpg',
    ratio: 0.62,
    sizes: ['680×960', '470×760', '800×1200'],
    category: ['hot', 'landscape']
  },
  {
    id: 'g6',
    title: '雪山之上',
    desc: '云停在半山腰，雪线之上只剩下光。',
    url: 'https://oss.boltfox.cn/prodFile/gallery/snow-mountain.jpg',
    ratio: 1.05,
    sizes: ['680×960', '470×760'],
    category: ['hot', 'landscape', 'new']
  },
  {
    id: 'g7',
    title: '橘猫的下午',
    desc: '它从树叶缝里看过来，那一眼把整个下午都定住了。',
    url: 'https://oss.boltfox.cn/prodFile/gallery/orange-cat.jpg',
    ratio: 0.8,
    sizes: ['680×960', '470×760'],
    category: ['hot', 'new']
  },
  {
    id: 'g8',
    title: '云在天上走',
    desc: '蓝得很干净的一天，云走得比人还慢。',
    url: 'https://oss.boltfox.cn/prodFile/gallery/clouds.jpg',
    ratio: 0.95,
    sizes: ['680×960', '800×1200'],
    category: ['hot', 'landscape']
  }
]

function delay(value) {
  return new Promise((resolve) => {
    setTimeout(() => resolve(value), MOCK_DELAY)
  })
}

function readFavoriteIds() {
  try {
    const cached = wx.getStorageSync(MOCK_FAVORITE_KEY)
    if (Array.isArray(cached)) {
      return cached
    }
  } catch (error) {
    // 读缓存失败按「没有收藏」走
  }
  return []
}

function writeFavoriteIds(ids) {
  try {
    wx.setStorageSync(MOCK_FAVORITE_KEY, ids)
  } catch (error) {
    // 写失败只影响 mock 的连续性
  }
}

/** 给列表项补上 `favorited` 字段：收藏页与图库页共用同一份图片数据，只是收藏态不同 */
function decorate(photo, favoriteIds) {
  return Object.assign({}, photo, {
    favorited: favoriteIds.indexOf(photo.id) !== -1
  })
}

/**
 * 把一维列表分成左右两列的瀑布流。
 *
 * 用**累计高度**而不是奇偶下标分列：图片高宽比不一，按奇偶分会让一列明显长出一截
 * （设计稿里两列的卡片底部是错开但整体齐平的）。高度按 `ratio` 估算即可，
 * 真实图片加载后不再重排——重排会让用户正在看的卡片跳走。
 */
function splitColumns(list) {
  const columns = [[], []]
  const heights = [0, 0]
  list.forEach((item) => {
    const target = heights[0] <= heights[1] ? 0 : 1
    columns[target].push(item)
    // 1 / ratio = 高/宽；再加上标题行的固定高度（估值，单位与列宽同为「份」）
    heights[target] += 1 / (Number(item.ratio) || 1) + 0.22
  })
  return columns
}

module.exports = {
  CATEGORIES,
  splitColumns,

  /** 分类导航 */
  getCategories() {
    // TODO(后端): 替换为 request.get('/Client/Gallery/getCategoryList')
    return delay(CATEGORIES.map((item) => Object.assign({}, item)))
  },

  /**
   * 分类下的图片列表。
   * @param {string} categoryId
   */
  getPhotos(categoryId) {
    // TODO(后端): 替换为 request.get('/Client/Gallery/getPhotoList', { categoryId, page, pageSize })
    const favoriteIds = readFavoriteIds()
    const list = MOCK_PHOTOS
      .filter((photo) => !categoryId || photo.category.indexOf(categoryId) !== -1)
      .map((photo) => decorate(photo, favoriteIds))
    return delay(list)
  },

  /** 图片详情 */
  getPhotoDetail(id) {
    // TODO(后端): 替换为 request.get('/Client/Gallery/getPhotoDetail', { id })
    const favoriteIds = readFavoriteIds()
    const found = MOCK_PHOTOS.filter((photo) => photo.id === id)[0]
    if (!found) {
      return Promise.reject({ code: 'NOT_FOUND', message: '图片不存在或已下架' })
    }
    return delay(decorate(found, favoriteIds))
  },

  /** 我的收藏列表 */
  getFavorites() {
    // TODO(后端): 替换为 request.get('/Client/Gallery/getFavoriteList')
    const favoriteIds = readFavoriteIds()
    const list = MOCK_PHOTOS
      .filter((photo) => favoriteIds.indexOf(photo.id) !== -1)
      .map((photo) => decorate(photo, favoriteIds))
    return delay(list)
  },

  /** 收藏总数（「我的」页那一行的数字） */
  getFavoriteCount() {
    // TODO(后端): 与 getFavoriteList 合并为带 total 的分页接口
    return delay(readFavoriteIds().length)
  },

  /**
   * 切换收藏态。
   * @returns {Promise<boolean>} 切换后的收藏态
   */
  toggleFavorite(id) {
    // TODO(后端): 替换为 request.post('/Client/Gallery/setFavorite', { id, favorited })
    const ids = readFavoriteIds()
    const index = ids.indexOf(id)
    if (index === -1) {
      ids.push(id)
    } else {
      ids.splice(index, 1)
    }
    writeFavoriteIds(ids)
    return delay(index === -1)
  }
}
