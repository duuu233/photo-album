const assert = require('assert')
const fs = require('fs')
const path = require('path')

let environment = 'develop'
let registrations = []
let effects = []
const pending = { device: { id: 'real-device', deviceNo: 'AABBCCDDEE01', width: 480, height: 720 }, images: [{ url: 'real.jpg' }], editStates: { 0: { saved: true } } }
global.wx = {
  getStorageSync: key => { effects.push(['read', key]); return pending },
  setStorageSync: (key, data) => effects.push(['write', key, data]),
  showLoading: () => effects.push(['loading']),
  hideLoading: () => effects.push(['hide-loading']),
  previewImage: data => effects.push(['preview', data]),
  switchTab: data => effects.push(['switch', data]),
  showModal: data => effects.push(['modal', data])
}
global.Page = options => registrations.push(options)

function stub(request, exports) {
  const filename = require.resolve(request)
  require.cache[filename] = { id: filename, filename, loaded: true, exports }
}

stub('../utils/system', {
  getLayoutMetrics: () => ({ statusBarHeight: 24, safeBottom: 12 }),
  isDevEnv: () => environment === 'develop'
})
stub('../utils/active-device', {
  ensureDeviceConnected: async () => { effects.push(['connect']); return 'verified-BLE' }
})
stub('../utils/dithering', { prefetchAuthToken: () => effects.push(['dithering']) })
stub('../utils/toast', { warn: data => effects.push(['warn', data]) })

const createPreviewPage = require('../subpackages/projection/preview/preview-page')
assert.strictEqual(registrations.length, 0, '导入共享内核不得注册页面')
require('../subpackages/projection/preview/preview')
assert.strictEqual(registrations.length, 1)
const production = registrations[0]
require('../subpackages/projection/preview-demo/preview-demo')
assert.strictEqual(registrations.length, 2, '每个入口只注册一次')
const demo = registrations[1]

function page(options) {
  const instance = Object.create(options)
  instance.data = JSON.parse(JSON.stringify(options.data))
  instance.setData = (patch, callback) => {
    Object.assign(instance.data, patch)
    if (callback) callback()
  }
  return instance
}

async function main() {
  const normal = page(production)
  normal.onLoad()
  await normal._warmup
  assert.ok(effects.some(item => item[0] === 'read' && item[1] === 'pendingProjection'))
  assert.ok(effects.some(item => item[0] === 'connect'))
  assert.ok(effects.some(item => item[0] === 'dithering'))
  assert.strictEqual(normal.data.device.deviceId, 'verified-BLE')
  assert.strictEqual(normal.data.device.id, pending.device.id)
  normal.persistPending(normal.data.images)
  assert.ok(effects.some(item => item[0] === 'write' && item[1] === 'pendingProjection'))
  const originalPending = JSON.stringify(pending)

  for (const shapeType of [1, 0, undefined, null, '1']) {
    for (const editing of [false, true]) {
      const instance = page(production)
      instance.data.device = { shapeType }
      instance._edit = editing ? { orientation: 'portrait', stageW: 320, stageH: 400, natW: 600, natH: 400, baseScale: 1, zoom: 1, tx: 0, ty: 0, angle: 0 } : null
      instance._frameFor = () => ({ left: 1, top: 2, width: 300, height: 200 })
      instance._clearLongPress = () => {}
      instance._applyEdit = () => {}
      instance._schedulePrebake = () => {}
      const before = JSON.stringify(instance._edit)
      instance.setOrientation({ currentTarget: { dataset: { orient: 'landscape' } } })
      assert.strictEqual(instance.data.orientation, shapeType === 1 ? 'portrait' : 'landscape')
      if (shapeType === 1) assert.strictEqual(JSON.stringify(instance._edit), before, '圆屏不得修改编辑快照或几何')
    }
  }
  const unselected = page(production)
  unselected.setOrientation({ currentTarget: { dataset: { orient: 'landscape' } } })
  assert.strictEqual(unselected.data.orientation, 'landscape')

  effects = []
  const round = page(demo)
  round.onLoad({ shape: 'round' })
  assert.strictEqual(round.data.device.shapeType, 1)
  assert.strictEqual(round.data.device.width, round.data.device.height)
  assert.strictEqual(round.data.imageCount, 2)
  assert.ok(round.data.images.every(image => /^https:\/\//.test(image.url)))
  round.persistPending(round.data.images)
  assert.deepStrictEqual(effects, [], 'demo 初始化、保存编辑不能读写业务存储、连接设备或预热抖动')
  assert.strictEqual(JSON.stringify(pending), originalPending)

  let editCount = 0
  round.enterEdit = () => { editCount++ }
  round.onReady()
  assert.strictEqual(editCount, 1)
  round.setOrientation({ currentTarget: { dataset: { orient: 'landscape' } } })
  assert.strictEqual(round.data.orientation, 'portrait')
  round.restoreOrigin()
  assert.strictEqual(effects[0][0], 'modal', '原图动作仍可用')
  effects = []
  round._edit = { zoom: 1, tx: 0, ty: 0, angle: 10 }
  let rotatedAngle
  round._applyEdit = (zoom, tx, ty, angle) => { rotatedAngle = angle }
  round._schedulePrebake = () => {}
  round.rotate90()
  assert.strictEqual(rotatedAngle, 100, '仅禁用横竖向切换，不禁用图片旋转')

  const rectangle = page(demo)
  rectangle.onLoad({ shape: 'rectangle' })
  assert.strictEqual(rectangle.data.device.shapeType, 0)
  assert.notStrictEqual(rectangle.data.device.width, rectangle.data.device.height)
  rectangle.setOrientation({ currentTarget: { dataset: { orient: 'landscape' } } })
  assert.strictEqual(rectangle.data.orientation, 'landscape')
  round.data.images[0].url = 'changed-demo-only'
  assert.notStrictEqual(rectangle.data.images[0].url, round.data.images[0].url, '不同演示实例不得共享可变数据')

  for (const name of ['setOrientation', 'onEditTouchStart', 'onEditTouchMove', 'onEditTouchEnd', 'rotate90', 'restoreOrigin', '_frameFor', '_clampTransform', 'switchImage', 'prepareProjectionImages', '_bakeToFile', '_exportCanvas']) {
    assert.strictEqual(demo[name].toString(), production[name].toString(), `${name} 必须复用正式实现`)
  }
  const isolated = createPreviewPage()
  isolated.data.images.push({ url: 'isolated' })
  assert.strictEqual(createPreviewPage().data.images.length, 0)

  effects = []
  round.data.activeIndex = 1
  round.prepareProjectionImages = async () => [
    { tempFilePath: 'wxfile://local-1.jpg', cropW: 500, cropH: 500 },
    { tempFilePath: 'wxfile://local-2.jpg', cropW: 500, cropH: 500 }
  ]
  await round.confirmProjection()
  assert.strictEqual(effects.find(item => item[0] === 'preview')[1].current, 'wxfile://local-2.jpg')
  assert.ok(!effects.some(item => ['read', 'write', 'connect', 'dithering', 'switch'].includes(item[0])))
  assert.strictEqual(round.data.projecting, false)
  effects = []
  round.prepareProjectionImages = async () => [{ tempFilePath: 'bad', cropW: 0, cropH: 0 }]
  await round.confirmProjection()
  assert.ok(effects.some(item => item[0] === 'warn'))
  assert.ok(!effects.some(item => item[0] === 'preview'))
  assert.strictEqual(round.data.projecting, false)
  effects = []
  round.data.projecting = true
  await round.confirmProjection()
  assert.deepStrictEqual(effects, [])

  for (const version of ['trial', 'release', 'unknown']) {
    environment = version
    effects = []
    const blocked = page(demo)
    blocked.onLoad({ shape: 'round' })
    blocked.enterEdit = () => { throw new Error('不允许初始化演示') }
    blocked.onReady()
    await blocked.confirmProjection()
    assert.deepStrictEqual(effects, [['switch', { url: '/pages/home/home' }]])
    assert.strictEqual(blocked.data.imageCount, 0)
  }

  const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
  assert.match(read('subpackages/projection/preview-demo/preview-demo.wxml'), /<include src="\.\.\/preview\/preview\.wxml"/)
  assert.match(read('subpackages/projection/preview-demo/preview-demo.wxss'), /@import "\.\.\/preview\/preview\.wxss"/)
  assert.deepStrictEqual(JSON.parse(read('subpackages/projection/preview-demo/preview-demo.json')), JSON.parse(read('subpackages/projection/preview/preview.json')))
  const template = read('subpackages/projection/preview/preview.wxml')
  assert.strictEqual((template.match(/aria-disabled="\{\{device.shapeType === 1\}\}"/g) || []).length, 2)
  assert.strictEqual((template.match(/hover-class="\{\{device.shapeType === 1 \? 'none'/g) || []).length, 2)
  assert.match(template, /wx:if="\{\{device.shapeType !== 1\}\}" class="segmented-thumb"/)
  const styles = read('subpackages/projection/preview/preview.wxss')
  assert.match(styles, /\.segmented-item\.is-disabled\s*\{[^}]*color:\s*#a8adb5;[^}]*opacity:\s*0\.5;[^}]*pointer-events:\s*none;/)
  assert.match(styles, /\.segmented-item\.is-disabled \.segmented-icon\s*\{[^}]*filter:\s*grayscale\(1\)/)
  const registry = JSON.parse(read('app.json')).subpackages.find(item => item.root === 'subpackages/projection')
  assert.ok(registry.pages.includes('preview-demo/preview-demo'))
  const conditions = JSON.parse(read('project.config.json')).condition.miniprogram.list
  assert.ok(conditions.some(item => item.pathName === 'subpackages/projection/preview-demo/preview-demo' && item.query === 'shape=round'))
  assert.ok(conditions.some(item => item.query === 'shape=rectangle'))
  console.log('projection preview demo and orientation guard tests passed')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
