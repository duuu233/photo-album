// 进度条平滑渲染（utils/smooth-progress.js）。
//
// 背景（2026-08-14）：BLE 图传的真实进度天生跳变——固件每 10 包才回一次 0x23 累计应答，
// 窗口 50 包时一次应答推进几十包，进度条一段一段往前蹦。
// 关键约束：**不能靠提高刷新频率解决**（setData 会占住 JS 线程、推迟 0x23 处理，越刷越慢），
// 只能减小每次更新的幅度：内部小数递进、只在取整值变化时 setData，整场 ≤101 次。
//
// 演进（每一步都是真机/仿真实测出来的教训）：
//   v1 追平即停表 → 「0→7% 丝滑、停 0.2s、再 7→14%」——冲完就干等；
//   v2 按预计间隔铺开 → 段间不停了，但 ACK 稍晚仍会先走完停一下；
//   v3 计划超前 PLAN_AHEAD=1.5 + 仅逾期才吸附 → 缓冲吸抖动；小步幅节奏下缓冲只有 2~3%，
//      ACK 连续晚到时仍有 ~240ms 的诚实停顿（不造假的物理下限）；
//   v4 受控前瞻（产品拍板「可酌情浮动百分之几，失败必须立即停」）→ 允许领先真实目标
//      ≤LEAD_MAX(3%)，锥减速率渐近逼近、永不画到 100、失败瞬间连领先部分一起收回。
const assert = require('assert')
const { createSmoothProgress } = require('../utils/smooth-progress')

const LEAD_MAX = 3 // 与实现里的 LEAD_MAX 同步；改实现须同步改这里

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function main() {
  // ── 用例 1：一次大跳（0 → 40）被拆成多次递进；上界 = 目标 + LEAD_MAX ───────────
  const rendered = []
  const p1 = createSmoothProgress({
    stepMs: 10,
    onRender: v => rendered.push(v)
  })
  p1.setTarget(40)
  await sleep(700) // 计划截止 450ms（缺省间隔 300 × PLAN_AHEAD 1.5）+ 前瞻段，留足余量
  p1.dispose()

  const last1 = rendered[rendered.length - 1]
  assert.ok(last1 >= 40, `最终至少追平目标（实际 ${last1}）`)
  assert.ok(
    rendered.length >= 5,
    `一次大跳应被拆成多次递进（实际 ${rendered.length} 次：${rendered.join(',')}）`
  )
  assert.ok(
    rendered.every(v => v <= 40 + LEAD_MAX),
    `显示值不得超过 目标+LEAD_MAX=${40 + LEAD_MAX}（实际 ${rendered.join(',')}）`
  )
  assert.ok(
    rendered.every((v, i) => i === 0 || v >= rendered[i - 1]),
    '显示值必须单调不减'
  )

  // ── 用例 2：增量必须**铺开**，不能几拍冲完就干等（v1 的核心缺陷）───────────────
  // 模拟真机节奏：每 200ms 来一次目标更新、每次 +7%（窗口 50 包 / 共 668 包的真实推进量）。
  const samples = []
  const p2 = createSmoothProgress({ stepMs: 20, onRender: () => {} })
  p2.setTarget(7)
  await sleep(200)
  p2.setTarget(14) // 第二次更新到达，此时才建立起间隔观测
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

  // ── 用例 3：更新彻底停止后，前瞻打满即停表，不空转 ─────────────────────────────
  const idle = []
  const p3 = createSmoothProgress({ stepMs: 10, onRender: v => idle.push(v) })
  p3.setTarget(5)
  await sleep(1400) // 追平(≈450ms) + 前瞻锥减打满(τ=LEAD_MAX/速率≈180ms，打满需 ~4τ)
  const countAfterSettled = idle.length
  await sleep(300) // 再等一段，期间没有新目标
  assert.strictEqual(
    idle.length,
    countAfterSettled,
    '前瞻打满后不应再有任何 setData（定时器必须停掉）'
  )
  assert.ok(
    p3.current() >= 5 && p3.current() <= 5 + LEAD_MAX,
    `停在 [目标, 目标+LEAD_MAX] 区间内（实际 ${p3.current()}）`
  )
  p3.dispose()

  // ── 用例 4：目标只增不减；显示值上界始终受 目标+LEAD_MAX 约束 ──────────────────
  const p4 = createSmoothProgress({ stepMs: 10, onRender: () => {} })
  p4.setTarget(50)
  await sleep(900)
  const settled4 = p4.current()
  assert.ok(
    settled4 >= 50 && settled4 <= 50 + LEAD_MAX,
    `追平后落在 [50, ${50 + LEAD_MAX}]（实际 ${settled4}）`
  )
  p4.setTarget(20) // 倒退的目标应被忽略
  await sleep(50)
  assert.ok(p4.current() >= settled4, '目标只增不减，不因回退目标而倒退')
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
  await sleep(600)
  assert.ok(p5.current() >= 10, `reset 后仍能正常递进（实际 ${p5.current()}）`)
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

  // ── 用例 8：失败即冻结（落后段）——报错后绝不能继续往前爬 ──────────────────
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

  // ── 用例 9：失败即冻结（前瞻段）——领先出去的部分必须**收回**到真实目标 ─────────
  // 「允许造一点假」的对价条款：失败画面上停着一个比真实进度高的数字就是在骗用户。
  const p9 = createSmoothProgress({ stepMs: 10, onRender: () => {} })
  p9.setTarget(30)
  await sleep(700) // 追平后进入前瞻段
  const leading = p9.current()
  assert.ok(leading > 30, `前提：此刻确实在领先真实目标（实际 ${leading}）`)
  p9.freeze()
  assert.ok(
    p9.current() <= 30,
    `freeze 必须把领先部分钳回真实目标 30 以内（实际 ${p9.current()}）`
  )
  p9.dispose()

  // ── 用例 10：前瞻永不画到 100——100% 只能来自真实完成(jumpTo) ─────────────────
  const highs = []
  const p10 = createSmoothProgress({ stepMs: 10, onRender: v => highs.push(v) })
  p10.setTarget(98)
  await sleep(1200) // 追平 98 后前瞻：上限被 99 封顶
  assert.ok(
    highs.every(v => v <= 99),
    `未真实完成前绝不显示 100%（实际渲染过 ${highs[highs.length - 1]}）`
  )
  assert.ok(p10.current() <= 99)
  p10.dispose()

  console.log('smooth-progress tests passed')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
