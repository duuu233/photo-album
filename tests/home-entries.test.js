// 首页六大入口 + 底栏收回两格（2026-08-21 改版）。
//
// 锁三件事：
//   ① 六项的顺序、文案与素材：按设计稿 assets/首页调整/首页-内容调整UI.jpg 排 3×2，
//      素材命名规律是「home-icon0N = 第 N 项线稿图标，home-icon1N = 同一项的箭头徽标」，
//      12 个文件必须真实存在——引用一张不存在的图，小程序不会报错，只会渲染成空白；
//   ② 六项各自跳去哪：前两项走投屏三道闸（登录/绑定/连接），后四项各进各的页面；
//   ③ 底栏只剩「首页 / 我的」两格，AI 与官方图库不再有 tab 入口。
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')

const navigations = []
global.wx = new Proxy(
  {
    navigateTo: options => {
      navigations.push(options.url)
      if (options.complete) options.complete()
    },
    switchTab: () => {},
    getStorageSync: () => '',
    setStorageSync: () => {},
    removeStorageSync: () => {}
  },
  {
    get(target, prop) {
      return prop in target ? target[prop] : () => {}
    }
  }
)
global.getApp = () => ({
  globalData: { selectedDevice: null },
  requireLogin: () => true,
  setSelectedDevice: () => {}
})

let home = null
global.Page = config => {
  home = config
}
require('../pages/home/home.js')

// ── ① 六项的顺序 / 文案 / 素材 ────────────────────────────────
const entries = home.data.homeEntries
assert.equal(entries.length, 6, '首页宫格是 3×2 六项')
assert.deepEqual(
  entries.map(item => item.key),
  ['camera', 'album', 'uploads', 'ai', 'gallery', 'devices'],
  '顺序按设计稿：拍照投屏 / 相册投屏 / 我的上传 / AI创作 / 官方图库 / 我的设备'
)
assert.deepEqual(
  entries.map(item => item.name),
  ['拍照投屏', '相册投屏', '我的上传', 'AI创作', '官方图库', '我的设备']
)

entries.forEach((item, index) => {
  const n = index + 1
  assert.equal(
    item.icon,
    `/assets/images/home-icon0${n}.png`,
    '第 N 项的线稿图标固定叫 home-icon0N'
  )
  assert.equal(
    item.arrow,
    `/assets/images/home-icon1${n}.png`,
    '第 N 项的箭头徽标固定叫 home-icon1N（与图标同色成对）'
  )
  ;[item.icon, item.arrow].forEach(src => {
    assert.ok(fs.existsSync(path.join(root, src.slice(1))), `素材缺失：${src}`)
  })
  assert.ok(/^#[0-9A-F]{6}$/i.test(item.color), '每项都要有标题主色')
})

// ── ② 点哪一项去哪里 ──────────────────────────────────────────
const tap = key =>
  home.tapHomeEntry.call(home, { currentTarget: { dataset: { key } } })

navigations.length = 0
tap('uploads')
assert.equal(navigations.pop(), '/subpackages/album/list/list', '「我的上传」＝我的相册页')
tap('gallery')
assert.equal(navigations.pop(), '/subpackages/gallery/list/list', '「官方图库」进图库列表')
tap('devices')
assert.equal(navigations.pop(), '/subpackages/device/list/list', '「我的设备」进设备列表')
tap('ai')
assert.ok(
  String(navigations.pop()).startsWith('/subpackages/ai/chat/chat'),
  '「AI创作」进聊天页（是否带 sessionId 由 ai-last-session 决定，见 ai-last-session.test.js）'
)

// 前两项统一走 ensureCanProject（登录 → 已绑定 → 已连接），这里只验分发接对了函数：
// 真按下去会调相机/相册，不适合在 node 里跑。
let called = ''
const stub = Object.create(home)
stub.tapCameraEntry = () => {
  called = 'camera'
}
stub.tapAlbumEntry = () => {
  called = 'album'
}
home.tapHomeEntry.call(stub, { currentTarget: { dataset: { key: 'camera' } } })
assert.equal(called, 'camera', '「拍照投屏」仍走 tapCameraEntry（含投屏三道闸）')
home.tapHomeEntry.call(stub, { currentTarget: { dataset: { key: 'album' } } })
assert.equal(called, 'album', '「相册投屏」仍走 tapAlbumEntry')

// 首页背景改成 2026-08-21 的新图；本地占位图必须同源，否则会看见一次「换底色」
const homeWxml = fs.readFileSync(path.join(root, 'pages/home/home.wxml'), 'utf8')
assert.ok(
  home.data.homeBgImage.indexOf('202608211340094498724.jpg') > -1,
  '首页背景图＝2026-08-21 换的那张 OSS 图'
)
assert.ok(
  fs.existsSync(path.join(root, 'assets/images/home-bg-placeholder.jpg')),
  '本地占位背景图必须在'
)
// 只认节点、不认文字：注释里还留着这句话（说明为什么删的），不该被当成漏删
assert.ok(
  homeWxml.indexOf('class="projection-title"') === -1,
  '小标题「选择投屏方式」按产品要求已去掉'
)

// ── ③ 底栏只剩两格 ────────────────────────────────────────────
const tabbarWxml = fs.readFileSync(
  path.join(root, 'components/custom-tabbar/custom-tabbar.wxml'),
  'utf8'
)
assert.equal(
  (tabbarWxml.match(/class="tab-item/g) || []).length,
  2,
  '底栏只保留「首页 / 我的」两格'
)
// 同样只认绑定、不认注释文字（注释里写着这两格为什么没了）
assert.ok(
  tabbarWxml.indexOf('bindtap="goAi"') === -1 &&
    tabbarWxml.indexOf('bindtap="goGallery"') === -1,
  'AI 与官方图库不再有 tab 入口（已搬到首页六宫格）'
)

const tabbarWxss = fs.readFileSync(
  path.join(root, 'components/custom-tabbar/custom-tabbar.wxss'),
  'utf8'
)
assert.ok(
  /grid-template-columns:\s*repeat\(2,\s*1fr\)/.test(tabbarWxss),
  '两格就得按两列分，否则两个 tab 会挤在胶囊左半边'
)

console.log('home-entries.test.js 全部通过')
