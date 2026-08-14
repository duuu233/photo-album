// 进度条逐格平滑（utils/smooth-progress.js）。
//
// 背景（2026-08-14）：BLE 图传的真实进度天生跳变——固件每 10 包才回一次 0x23 累计应答，
// 窗口 50 包时一次应答推进几十包，进度条一段一段往前蹦。
// 关键约束：**不能靠提高刷新频率来解决**。setData 跨线程推给视图层会占住 JS 线程、推迟 0x23
// 应答处理，越刷越慢（图传性能档案里为此专门加过节流）。所以改为「减小每次更新的幅度」：
// 目标值仍由真实进度驱动，显示值把增量**铺开到下一次更新预计到达的时刻**，
// 整场 setData 次数 ≤101（每个整数最多画一次），反而比原来更少。
//
// 第一版的教训：追平即停表 → 「0%→7% 丝滑、停 0.2s、7%→14% 丝滑、再停 0.2s」。
// 那 7% 是「窗口 50 包 / 共 668 包」跑满一个窗口的推进量，0.2s 是设备消化 50 包并回 0x23 的
// 真实耗时——传输节奏本身不该改，要改的是「几拍冲完就干等」的渲染方式。
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
  await sleep(500) // 单次目标：按缺省间隔 250ms 铺开，留足余量
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

  // ── 用例 2：增量必须**铺开**，不能几拍冲完就干等（第一版的核心缺陷）───────────
  // 模拟真机节奏：每 200ms 来一次目标更新、每次 +7%（窗口 50 包 / 共 668 包的真实推进量）。
  // 断言：两次更新之间的每个采样点都在动，不出现「早早追平后长时间不动」。
  const samples = []
  const p2 = createSmoothProgress({ stepMs: 20, onRender: () => {} })
  p2.setTarget(7)
  await sleep(200)
  p2.setTarget(14) // 第二次更新到达，此时才建立起间隔观测
  // 观察第二段：每 40ms 采样一次，看它是否持续爬升
  for (let i = 0; i < 5; i++) {
    await sleep(40)
    samples.push(p2.current())
  }
  p2.dispose()
  const movedSteps = samples.filter((v, i) => i > 0 && v > samples[i - 1]).length
  assert.ok(
    movedSteps >= 3,
    `增量应铺开到整个间隔里持续增长，而不是冲完就停（采样 ${samples.join('→')}）`
  )

  // ── 用例 3：追平后必须停表，不空转占用 JS 线程 ────────────────────────────
  const idle = []
  const p3 = createSmoothProgress({ stepMs: 10, onRender: v => idle.push(v) })
  p3.setTarget(5)
  await sleep(500)
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
  await sleep(500) // 留足节拍余量：铺开需要约一个更新间隔（缺省 250ms）+ 抖动
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
  await sleep(500)
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

  // ── 用例 7：落后不得过大（真实传输突然提速时不能拖后腿）─────────────────────
  // 先用慢节奏把间隔均值养大，再突然把目标推到 100：若只按旧节奏铺，会落后一大截。
  const p7 = createSmoothProgress({ stepMs: 10, onRender: () => {} })
  p7.setTarget(5)
  await sleep(300)
  p7.setTarget(10) // 建立「间隔约 300ms」的观测
  await sleep(30)
  p7.setTarget(100) // 传输突然提速
  await sleep(40) // 只给几拍
  assert.ok(
    100 - p7.current() <= 12,
    `落后不得超过 MAX_LAG=12 格（实际落后 ${100 - p7.current()} 格）`
  )
  p7.dispose()

  // ── 用例 8：失败即冻结——绝不能在报错后继续往前爬（「失败当成功」是最坏观感）──
  const frozen = []
  const p8 = createSmoothProgress({ stepMs: 10, onRender: v => frozen.push(v) })
  p8.setTarget(60)
  await sleep(50) // 铺到一半
  const mid = p8.current()
  assert.ok(mid < 60, '前提：此时还没铺完（仍落后于真实目标）')
  p8.freeze()
  const atFreeze = p8.current()
  const countAtFreeze = frozen.length
  await sleep(200)
  assert.strictEqual(
    p8.current(),
    atFreeze,
    'freeze 后显示值必须钉住，绝不继续爬向未完成的目标'
  )
  assert.strictEqual(frozen.length, countAtFreeze, 'freeze 后不应再有任何渲染')
  p8.dispose()

  console.log('smooth-progress tests passed')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
