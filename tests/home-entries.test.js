// 首页六大入口 + 底栏收回两格（2026-08-21 改版）。
//
// 锁三件事：
//   ① 六项的顺序、文案与素材：按设计稿 assets/首页调整/首页-内容调整UI.jpg 排 3×2，
//      素材命名规律是「home-icon0N = 第 N 项线稿图标，home-icon1N = 同一项的箭头徽标」，
//      12 个文件必须真实存在——引用一张不存在的图，小程序不会报错，只会渲染成空白；
//   ② 六项各自跳去哪：前两项走投屏三道闸（登录/绑定/连接），后四项各进各的页面；
//   ③ 设备图（原 home-icon02，现 home-device-thumb）在六处引用点上不许被新素材顶掉；
//   ④ 底栏只剩「首页 / 我的」两格，AI 与官方图库不再有 tab 入口。
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

// 「我的」页仍用原来那张 OSS 背景，占位图必须跟着是**原背景**的压缩版：
// 两页共用一张占位图的话，首页换背景就会把「我的」页的打底也换掉，进页面先闪一下新底色。
const mineWxml = fs.readFileSync(path.join(root, 'pages/mine/mine.wxml'), 'utf8')
assert.ok(
  mineWxml.indexOf('/assets/images/mine-bg-placeholder.jpg') > -1,
  '「我的」页要用自己的占位图 mine-bg-placeholder.jpg'
)
assert.ok(
  mineWxml.indexOf('src="/assets/images/home-bg-placeholder.jpg"') === -1,
  '「我的」页不能再引用首页那张占位图（首页背景已换新）'
)
assert.ok(
  mineWxml.indexOf('202607310920402821453.png') > -1,
  '「我的」页的 OSS 背景保持原样，本次只换首页'
)
assert.ok(
  fs.existsSync(path.join(root, 'assets/images/mine-bg-placeholder.jpg')),
  '「我的」页的占位图必须在'
)
// 只认节点、不认文字：注释里还留着这句话（说明为什么删的），不该被当成漏删
assert.ok(
  homeWxml.indexOf('class="projection-title"') === -1,
  '小标题「选择投屏方式」按产品要求已去掉'
)

// ── ③ home-icon0N/1N 是首页宫格专属，别的页面不许再引用 ──────────
//
// 2026-08-21 改版把 home-icon01~06 这批名字给了新素材，而**旧的** home-icon02.png 是
// 首页/设备列表/设备详情/搜索设备/命名弹窗/投屏选设备六处共用的那张橙色设备图 ——
// 改名时漏改任何一处，那一处不会报错，只会安静地换成新的蓝色相册图标（当天就这么翻过车）。
// 旧图已更名为 home-device-thumb.png，这里把「谁该用哪张」钉死。
{
  const deviceThumbUsers = [
    'pages/home/home.wxml',
    'subpackages/device/list/list.wxml',
    'subpackages/device/detail/detail.wxml',
    'subpackages/device/bind/bind.wxml',
    'components/device-name-dialog/device-name-dialog.wxml',
    'components/device-picker-sheet/device-picker-sheet.wxml'
  ]
  deviceThumbUsers.forEach(file => {
    const text = fs.readFileSync(path.join(root, file), 'utf8')
    assert.ok(
      text.indexOf('src="/assets/images/home-device-thumb.png"') > -1,
      `${file} 的设备图必须是 home-device-thumb.png`
    )
  })
  assert.ok(
    fs.existsSync(path.join(root, 'assets/images/home-device-thumb.png')),
    '设备图文件必须在'
  )

  // 全项目扫一遍：除首页的 HOME_ENTRIES 之外，任何地方都不该再出现 home-icon0N/1N
  const walk = dir => {
    const out = []
    fs.readdirSync(dir, { withFileTypes: true }).forEach(item => {
      if (item.name === 'node_modules' || item.name === '.git') return
      const full = path.join(dir, item.name)
      if (item.isDirectory()) out.push(...walk(full))
      else if (/\.(wxml|wxss)$/.test(item.name)) out.push(full)
    })
    return out
  }
  const offenders = walk(root)
    .filter(file => !file.includes(`${path.sep}docs${path.sep}`))
    .filter(file =>
      /src="\/assets\/images\/home-icon\d\d\.png"/.test(fs.readFileSync(file, 'utf8'))
    )
  assert.deepEqual(
    offenders,
    [],
    'home-icon0N/1N 只属于首页宫格，且只在 home.js 的 HOME_ENTRIES 里拼路径；模板里直接写死＝多半是改名漏改'
  )
}

// ── ④ 底栏只剩两格 ────────────────────────────────────────────
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
