// 进度条逐格平滑（utils/smooth-progress.js）。
//
// 背景（2026-08-14）：BLE 图传的真实进度天生跳变——固件每 10 包才回一次 0x23 累计应答，
// 窗口 50 包时一次应答推进几十包，进度条一段一段往前蹦。
// 关键约束：**不能靠提高刷新频率来解决**。setData 跨线程推给视图层会占住 JS 线程、推迟 0x23
// 应答处理，越刷越慢（图传性能档案里为此专门加过节流）。所以改为「减小每次更新的幅度」：
// 目标值仍由真实进度驱动，显示值按固定节拍逐格逼近，整场 setData 次数 ≈100 次，反而更少。
const assert = require('assert')
const { createSmoothProgress } = require('../utils/smooth-progress')

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function main() {
  // ── 用例 1：一次大跳（0 → 40）必须被拆成多次递进，而不是一步到位 ──────────────
  const rendered = []
  const p1 = createSmoothProgress({
    stepMs: 10,
    onRender: v => rendered.push(v)
  })
  p1.setTarget(40)
  await sleep(300)
  p1.dispose()

  assert.strictEqual(rendered[rendered.length - 1], 40, '最终必须追平目标值')
  assert.ok(
    rendered.length >= 5,
    `一次大跳应被拆成多次递进（实际 ${rendered.length} 次：${rendered.join(',')}）`
  )
  // 每一步都不许超过目标：只把已发生的进度画细，绝不预测
  assert.ok(
    rendered.every(v => v <= 40),
    '显示值永不超过真实目标值'
  )
  // 单调不减
  assert.ok(
    rendered.every((v, i) => i === 0 || v >= rendered[i - 1]),
    '显示值必须单调不减'
  )

  // ── 用例 2：落后越多走得越快（否则真实速度快时进度条会明显滞后）─────────────
  const bigJump = []
  const p2 = createSmoothProgress({
    stepMs: 10,
    onRender: v => bigJump.push(v)
  })
  p2.setTarget(90) // 一次落后 90 格
  await sleep(60) // 只给 6 拍：按每格 1% 只能走到 6，按比例追赶必须远超它
  const reachedIn6Ticks = p2.current()
  p2.dispose()
  assert.ok(
    reachedIn6Ticks > 6,
    `落后多时应按比例追赶而不是每格 1%（6 拍只走到 ${reachedIn6Ticks}）`
  )

  // ── 用例 3：追平后必须停表，不空转占用 JS 线程 ────────────────────────────
  const idle = []
  const p3 = createSmoothProgress({ stepMs: 10, onRender: v => idle.push(v) })
  p3.setTarget(5)
  await sleep(300)
  const countAfterSettled = idle.length
  await sleep(200) // 再等一段，期间没有新目标
  assert.strictEqual(
    idle.length,
    countAfterSettled,
    '追平目标后不应再有任何 setData（定时器必须停掉）'
  )
  assert.strictEqual(p3.current(), 5)
  p3.dispose()

  // ── 用例 4：目标只增不减，避免回退抖动 ──────────────────────────────────
  const p4 = createSmoothProgress({ stepMs: 10, onRender: () => {} })
  p4.setTarget(50)
  await sleep(400) // 留足节拍余量：setInterval 有抖动，差一格就误判
  assert.strictEqual(p4.current(), 50)
  p4.setTarget(20) // 倒退的目标应被忽略
  await sleep(50)
  assert.strictEqual(p4.current(), 50, '目标只增不减，不因回退目标而倒退')
  p4.dispose()

  // ── 用例 5：jumpTo 立即到位并停表（本张收尾 100%）；reset 归零（下一张重来）──
  const jumped = []
  const p5 = createSmoothProgress({ stepMs: 10, onRender: v => jumped.push(v) })
  p5.setTarget(30)
  p5.jumpTo(100)
  assert.strictEqual(p5.current(), 100, 'jumpTo 立即到位，不走递进动画')
  assert.strictEqual(jumped[jumped.length - 1], 100)
  const countAfterJump = jumped.length
  await sleep(100)
  assert.strictEqual(jumped.length, countAfterJump, 'jumpTo 之后必须已停表')

  p5.reset()
  assert.strictEqual(p5.current(), 0, 'reset 归零，供下一张重新开始')
  p5.setTarget(10)
  await sleep(300)
  assert.strictEqual(p5.current(), 10, 'reset 后仍能正常递进')
  p5.dispose()

  // ── 用例 6：dispose 后不再产生任何渲染（页面卸载后不许 setData）──────────
  const afterDispose = []
  const p6 = createSmoothProgress({ stepMs: 10, onRender: v => afterDispose.push(v) })
  p6.setTarget(80)
  p6.dispose()
  const countAtDispose = afterDispose.length
  await sleep(150)
  assert.strictEqual(
    afterDispose.length,
    countAtDispose,
    'dispose 后定时器必须停掉，不再对已卸载页面 setData'
  )

  console.log('smooth-progress tests passed')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
