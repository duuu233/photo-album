// 折叠屏 / 分屏 / 平板适配 —— JS 侧公共件（2026-08-05）。
// 样式那一半在 styles/fold-adapt.wxss（已在 app.wxss 里 @import，全站可用）。
//
// 这里只管一件事：**窗口形态变了要重测什么**。
//   · 页面高度 → 交给 wxss 的 100vh，webview 自己解析，这里一个字都不掺和；
//     ⚠️ 绝不要把 wx.getWindowInfo().windowHeight 当页面高度用（2026-08-04 首页踩过：
//        tabBar 页的 windowHeight 扣掉了已 hideTabBar 的原生 tabBar → 底部露缝；
//        展开态冷启动的快照偏大 → 滚不动。当天即回滚，见 home.wxss 顶部注释）。
//   · 状态栏高度 / 底部安全区 → 只能靠接口读，且**折叠前后确实会变**（内外屏的刘海、
//     挖孔、Home Indicator 都不一样），所以必须在 onResize 时重测。
//   · 导航栏实测高度 → 由 page-nav 的 measure 事件回抛，页面要用 `calc(100vh - 导航高)`
//     时直接用这份值，不再各自复算一遍状态栏+胶囊（两处算法会漂移）。
//
// 用法（页面 JS 改一行，原有配置原样不动）：
//   const fold = require('../../utils/fold-adapt')
//   Page(fold.adapt({ data: {...}, onLoad() {...}, ... }))
//
// adapt() 的注入全部是**叠加**，不改写页面任何既有字段：
//   ① data 补 statusBarHeight / safeBottom / navHeight 默认值（页面自己写了就用页面的）；
//   ② onLoad 前先测一次（页面原本自己测的照旧保留，值一样，多测一次无副作用）；
//   ③ onResize 先重测再调页面原本的 onResize（折叠/展开/旋转/分屏/三折叠切形态都会触发）；
//   ④ onNavMeasure 接住 page-nav 的 measure 事件写入 navHeight，页面 wxml 里
//      `--nav-h: {{navHeight}}px` 即可使用；页面不绑这个事件时完全没有副作用。
const system = require('./system')

// 页面没自己声明时补的默认值。navHeight 的 64 与 page-nav 组件的兜底一致。
const DEFAULT_DATA = {
  statusBarHeight: 20,
  safeBottom: 0,
  navHeight: 64
}

// 重测状态栏高度与底部安全区，只在值变了才 setData（onResize 会连续触发，避免无谓渲染）。
function measure(page) {
  if (!page || typeof page.setData !== 'function') {
    return null
  }

  const metrics = system.getLayoutMetrics()
  const data = page.data || {}
  const patch = {}

  if (data.statusBarHeight !== metrics.statusBarHeight) {
    patch.statusBarHeight = metrics.statusBarHeight
  }
  if (data.safeBottom !== metrics.safeBottom) {
    patch.safeBottom = metrics.safeBottom
  }
  if (patch.statusBarHeight !== undefined || patch.safeBottom !== undefined) {
    page.setData(patch)
  }

  return metrics
}

// 接住 page-nav 的 measure 事件（导航栏实测高度）。
function applyNavHeight(page, event) {
  const navHeight = (event && event.detail && event.detail.navHeight) || 0
  if (page && navHeight && navHeight !== (page.data || {}).navHeight) {
    page.setData({ navHeight })
  }
}

function adapt(options) {
  const config = Object.assign({}, options)
  config.data = Object.assign({}, DEFAULT_DATA, (options && options.data) || {})

  const pageOnLoad = config.onLoad
  const pageOnResize = config.onResize
  const pageOnNavMeasure = config.onNavMeasure

  config.onLoad = function (query) {
    measure(this)
    if (typeof pageOnLoad === 'function') {
      return pageOnLoad.call(this, query)
    }
  }

  // 折叠屏展开/折叠、旋转、分屏、三折叠切形态都会触发。页面高度由 100vh 自动跟随，
  // 这里只补状态栏与安全区；页面自己还有别的重排逻辑就接在后面跑。
  config.onResize = function (size) {
    measure(this)
    if (typeof pageOnResize === 'function') {
      return pageOnResize.call(this, size)
    }
  }

  config.onNavMeasure = function (event) {
    applyNavHeight(this, event)
    if (typeof pageOnNavMeasure === 'function') {
      return pageOnNavMeasure.call(this, event)
    }
  }

  return config
}

module.exports = {
  DEFAULT_DATA,
  adapt,
  measure,
  applyNavHeight
}
