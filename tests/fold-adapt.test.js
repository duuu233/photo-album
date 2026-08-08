// 折叠屏适配公共件（utils/fold-adapt.adapt）的注入契约。
//
// 锁成回归用例是因为它包着**每一个**接入页的生命周期：注入写错就是整页白屏/不初始化，
// 而这类问题在真机上才暴露。三条红线：
// ① 页面原有的 onLoad/onResize/onNavMeasure 必须照常被调用（参数、this 都不能丢）；
// ② 页面自己声明的 data 不能被默认值覆盖（默认值只补页面没写的键）；
// ③ onResize 要重测状态栏与底部安全区 —— 折叠前后内外屏的刘海/Home Indicator 不一样。
const assert = require('assert')

// utils/system 走 wx.getWindowInfo 读窗口信息，这里按「折叠前后两套值」打桩。
let windowInfo = {
  statusBarHeight: 20,
  screenHeight: 800,
  windowHeight: 800,
  safeArea: { bottom: 766 }
}
global.wx = {
  getWindowInfo: () => windowInfo
}

const fold = require('../utils/fold-adapt')

const makePage = options => {
  const config = fold.adapt(options)
  const page = Object.create(config)
  page.data = JSON.parse(JSON.stringify(config.data))
  page.setData = patch => Object.assign(page.data, patch)
  return page
}

// ② 页面自己写的 data 保留，没写的键补默认值
const page = makePage({
  data: { statusBarHeight: 44, custom: 'keep' },
  onLoad(query) {
    this.loadedWith = query
  },
  onResize(size) {
    this.resizedWith = size
  },
  onNavMeasure(event) {
    this.navEvent = event
  }
})
assert.strictEqual(page.data.custom, 'keep')
assert.strictEqual(page.data.safeBottom, 0) // 默认值补齐
assert.strictEqual(page.data.navHeight, 64)

// ① onLoad 照常收到 query，同时已经测过一次真实值（44 是页面写的占位，实测是 20）
page.onLoad({ id: '7' })
assert.deepStrictEqual(page.loadedWith, { id: '7' })
assert.strictEqual(page.data.statusBarHeight, 20)
assert.strictEqual(page.data.safeBottom, 34)

// ③ 折叠形态切换：onResize 必须重测（内屏没有 Home Indicator、状态栏更矮）
windowInfo = {
  statusBarHeight: 32,
  screenHeight: 1000,
  windowHeight: 1000,
  safeArea: { bottom: 1000 }
}
page.onResize({ size: { windowWidth: 1000, windowHeight: 1000 } })
assert.strictEqual(page.data.statusBarHeight, 32)
assert.strictEqual(page.data.safeBottom, 0)
// ① 页面原有的 onResize 也要被调到，且拿到原参数
assert.deepStrictEqual(page.resizedWith, {
  size: { windowWidth: 1000, windowHeight: 1000 }
})

// ④ page-nav 的实测导航高度写进 navHeight，页面原有回调照常触发
page.onNavMeasure({ detail: { navHeight: 88, statusBarHeight: 32 } })
assert.strictEqual(page.data.navHeight, 88)
assert.deepStrictEqual(page.navEvent.detail.navHeight, 88)
// 非法/缺省事件不能把 navHeight 冲成 0（拿它算 calc 高度的页面会整块塌掉）
page.onNavMeasure({})
assert.strictEqual(page.data.navHeight, 88)

// 页面完全不写这三个钩子时也不能报错（大多数接入页就是这种）
const bare = makePage({ data: {} })
bare.onLoad()
bare.onResize()
bare.onNavMeasure({ detail: { navHeight: 70 } })
assert.strictEqual(bare.data.navHeight, 70)
assert.strictEqual(bare.data.statusBarHeight, 32)

console.log('fold-adapt tests passed')
