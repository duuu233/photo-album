// 「选择投屏设备」弹层（2026-08-13 需求 2/3）：AI 对话页与图片详情页共用
// components/device-picker-sheet，且交互由「点中即投」改成「先选、再按按钮才连」。
//
// 锁三件事：
//  ① **不默认选中**——投屏是往设备写图，端上替用户选好、他顺手一点就投到别的设备上了；
//  ② 没选中时按钮不做事（观感上也置灰）；选中后 confirm 事件把那台设备原样带出去；
//  ③ 两个页面都真的用上了组件，且没留下「点一行就投屏」的老路径。
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const readCode = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8')

// 最小 Component 运行时：只要能拿到 properties/data/methods/observers 就够验行为了
function loadComponent(rel) {
  let def = null
  global.Component = options => {
    def = options
  }
  const file = path.join(__dirname, '..', rel)
  delete require.cache[require.resolve(file)]
  require(file)
  assert.ok(def, '组件应调用 Component()')

  const ctx = {
    data: Object.assign(
      {},
      Object.keys(def.properties || {}).reduce((acc, key) => {
        acc[key] = def.properties[key].value
        return acc
      }, {}),
      def.data || {}
    ),
    events: []
  }
  ctx.setData = patch => Object.assign(ctx.data, patch)
  ctx.triggerEvent = (name, detail) => ctx.events.push({ name, detail })
  Object.keys(def.methods || {}).forEach(name => {
    ctx[name] = def.methods[name].bind(ctx)
  })
  // observers 手工触发（真实运行时由 setData 驱动，这里只验 show 那一条的语义）
  ctx.fireObserver = (name, value) => def.observers[name].call(ctx, value)
  return ctx
}

const sheet = loadComponent('components/device-picker-sheet/device-picker-sheet.js')
sheet.setData({
  devices: [
    { pickerId: '1', name: '客厅相框', productDeviceId: 'E9:48:C2:1E:D4:28' },
    { pickerId: '2', name: '卧室相框', productDeviceId: 'E9:48:C2:1E:D4:29' }
  ]
})

// ── ① 不默认选中 ────────────────────────────────────────────────────────
assert.strictEqual(sheet.data.selectedId, '', '弹层打开时必须是「一台都没选」')

// ── ② 没选中 → 按钮不做事；选中 → confirm 带出那一台 ────────────────────
sheet.onConfirm()
assert.strictEqual(
  sheet.events.length,
  0,
  '没选设备就按按钮不许触发 confirm（观感上按钮也是置灰的，行为要与观感一致）'
)

sheet.onSelect({ currentTarget: { dataset: { id: '2' } } })
assert.strictEqual(sheet.data.selectedId, '2', '点一行只是选中')
assert.strictEqual(sheet.events.length, 0, '⚠️ 点一行绝不能直接开投——那正是本轮要改掉的老交互')

sheet.onConfirm()
assert.strictEqual(sheet.events.length, 1)
assert.strictEqual(sheet.events[0].name, 'confirm')
assert.strictEqual(
  sheet.events[0].detail.device.name,
  '卧室相框',
  'confirm 要把选中的那台原样带给页面'
)

// 关掉再打开：不许残留上一次的选中态
sheet.fireObserver('show', false)
assert.strictEqual(sheet.data.selectedId, '', '重开弹层要回到「未选中」')

// 取消按钮/点遮罩：只发 cancel，不发 confirm
sheet.events.length = 0
sheet.onCancel()
assert.deepStrictEqual(
  sheet.events.map(item => item.name),
  ['cancel'],
  '取消只发 cancel'
)

// ── ③ 两个页面都接上了组件，且老的「点行即投」路径已删干净 ────────────────
;[
  ['subpackages/ai/chat/chat', 'AI 对话页'],
  ['subpackages/gallery/detail/detail', '图片详情页']
].forEach(([base, label]) => {
  const wxml = readCode(`${base}.wxml`)
  const js = readCode(`${base}.js`)
  const json = JSON.parse(readCode(`${base}.json`))

  assert.ok(
    /<device-picker-sheet[\s\S]*?bind:confirm="onDevicePickerConfirm"/.test(wxml),
    `${label} 应改用 device-picker-sheet 组件并接 confirm 事件`
  )
  assert.strictEqual(
    (json.usingComponents || {})['device-picker-sheet'],
    '/components/device-picker-sheet/device-picker-sheet',
    `${label} 的 json 要注册组件，否则弹层根本不渲染`
  )
  assert.ok(
    !/onDevicePickerSelect/.test(js) && !/onDevicePickerSelect/.test(wxml),
    `${label} 不该再留「点一行就投屏」的 onDevicePickerSelect`
  )
  assert.ok(
    !/selectedId/.test(js),
    `${label} 不该再自己预置 selectedId（默认选中正是本轮要去掉的）`
  )
})

console.log('device-picker-sheet.test.js 全部通过')
