// 把「跳变的目标进度」渲染成连续增长的平滑进度。
//
// 为什么需要（2026-08-14）：BLE 图传的真实进度天生是**跳变**的——固件每 10 包才回一次 0x23
// 累计应答，窗口 50 包时一次应答就推进几十包，进度条于是一段一段往前蹦。
//
// 直觉做法是提高刷新频率，但那正是**不能做**的事：`setData` 跨线程推给视图层会占住 JS 线程、
// 推迟 0x23 应答的处理，越刷越慢——图传性能档案里为此专门加过节流。
// 所以方向是**减小每次更新的幅度**而不是提高频率：整场传输真正 setData 的次数 ≤101 次
//（0~100 每个整数最多画一次），比原来「最多 8 次/秒」还少，观感却是连续的。
//
// ── 关键：为什么不能「尽快追平目标」（第一版的教训）────────────────────────────
// 第一版每拍朝目标走一格、追平即停表。结果是「0%→7% 丝滑、停 0.2s、7%→14% 丝滑、再停 0.2s」：
// 每次应答带来的增量被几拍就冲完了，剩下的时间在干等下一次应答。**快不是问题，停顿才是。**
//
// 现在改为**按节奏铺开 + 缓冲吸抖**：显示值不赶着追平，而是把当前这段增量摊到
// 「预计下一次目标更新的 PLAN_AHEAD 倍时刻」——用实测更新间隔（指数滑动平均）估算。
// 截止时间故意放在预计到达之后，每段永远走不完、剩下的部分就是缓冲（视频播放器 jitter buffer
// 的思路）：ACK 晚到 50% 以内都有存量可走，指针不断流；ACK 提前到只是缓冲变厚、速度平滑上调。
// 只有更新**真的**迟迟不来（设备卡顿/中断）时，才把已确认的存量走完、如实停下。
//
// ── 受控前瞻（第四版，产品拍板「可以酌情浮动百分之几，但失败必须立即停」）────────────
// 纯"绝不超过已确认进度"仍留一个死角：小步幅节奏(每 10 包 +1.5%)下缓冲只有 2~3%，ACK 连续
// 晚到时缓冲耗尽、指针只能停（仿真实测中段最长停顿 240ms——那是诚实模型的物理下限）。
// 现允许显示值**领先**真实目标最多 LEAD_MAX(3%)：领先量按锥减速率推进（领先越多走得越慢，
// 渐近逼近上限，不会冲到顶再急停），ACK 恢复后自然回到落后段的铺开逻辑。
//
// 不变量（第四版口径）：
//   · 显示值 ≤ 真实目标 + LEAD_MAX，且**永不画到 100%**——100 只能来自真实完成(jumpTo)；
//   · 显示值单调不减（freeze 是唯一例外，见下）；
//   · 失败即 freeze：**连领先的部分一起收回**（钳回真实目标），绝不停在造出来的数字上——
//     这是「可以造一点假」的对价条款，失败画面上多出来的每一分都是事故；
//   · 无处可走（前瞻打满且无新目标）时停表，不空转占 JS 线程。

const DEFAULT_TICK_MS = 33 // 渲染节拍（约 30 次/秒）。真正 setData 只在取整值变化时发生
const DEFAULT_INTERVAL_MS = 300 // 还没有观测值时，假设的目标更新间隔（宁可估长：估短会先冲完再等）
const MIN_REMAINING_MS = 40 // 目标更新已逾期时，把剩余增量收拢完的最短时间
const INTERVAL_EMA_WEIGHT = 0.3 // 新观测在间隔均值里的权重
// 计划超前系数（jitter buffer，2026-08-14 第三版）：把「走完当前段」的截止时间**故意**定在
// 预计下一次更新的 PLAN_AHEAD 倍处。定在 1.0 倍（第二版）意味着估准了刚好走完——但 ACK 稍晚
// 就先走完、停一小下；稍早则速度突增。定在 1.5 倍后每段只走掉 1/1.5≈2/3，剩下 1/3 是缓冲：
// ACK 晚到 50% 以内都有存量可走，运动不断流。数学上稳态滞后 = PLAN_AHEAD × 单次推进量
//（g' = g×(1-1/P) + S 的不动点 g = P×S）：常见的每 10 包一次 ACK ≈1.5%，稳态滞后 ≈2.3%；
// 整窗一次 7.5% 时 ≈11.3%，恰在 MAX_LAG=12 之内——两个参数是配套算过的，改一个要重推另一个。
const PLAN_AHEAD = 1.5
// 允许领先真实目标的最大格数（受控前瞻的上限）。3 是「用户看不出来」和「失败时要收回多少」
// 之间的折衷：再大，失败瞬间的回撤就会明显。
const LEAD_MAX = 3
// 允许落后真实进度的最大格数。落后是**故意**的（铺开增量才能连续增长），但不能落后太多：
// 传输突然提速（设备缓冲吃满、窗口涨回）时，若仍按旧节奏慢慢铺，进度条会明显拖后腿，
// 甚至传完了还在半路。超出这个差距就直接把超出部分补齐，只保留一个节拍的落后量。
const MAX_LAG = 12

// options:
//   onRender(value)  必填，把当前显示值（整数）写进页面（调用方自己 setData）
//   stepMs           渲染节拍，缺省 33ms
//   max              进度上限，缺省 100
function createSmoothProgress(options) {
  const onRender = options && options.onRender
  if (typeof onRender !== 'function') {
    throw new Error('createSmoothProgress 需要 onRender 回调')
  }
  const tickMs = (options && options.stepMs) || DEFAULT_TICK_MS
  const max = (options && options.max) || 100

  let target = 0
  let shown = 0 // 内部保留小数，避免每拍不足 1% 时永远走不动
  let painted = -1 // 上一次真正 setData 出去的整数值
  let timer = null
  let lastTargetAt = 0 // 上一次收到真实目标的时刻
  let intervalEma = 0 // 实测「两次目标更新的间隔」指数滑动平均
  let rateEma = 0 // 实测真实推进速率（%/ms）指数滑动平均——前瞻段的速度基准
  let lastTickAt = 0

  const clamp = value =>
    Math.max(0, Math.min(max, Math.round(Number(value) || 0)))

  // 只在取整值变化时才 setData：这是整场 setData 次数被钉在 ≤101 次的原因
  const paint = () => {
    const value = Math.min(max, Math.floor(shown))
    if (value !== painted) {
      painted = value
      onRender(value)
    }
  }

  const stop = () => {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  // 可画上限：真实目标 + LEAD_MAX，且未真实完成前 99 封顶；目标本身到了 max（真实完成信号）
  // 则放行到 max——100% 只能由真实完成给出。
  const upperBound = () =>
    target >= max ? max : Math.min(target + LEAD_MAX, max - 1)

  const tick = () => {
    const now = Date.now()
    const dt = Math.max(1, now - lastTickAt)
    lastTickAt = now

    let gap = target - shown
    // 落后过多先补齐超出部分：真实传输提速（窗口涨回、设备吃满）时旧节奏铺不过来，
    // 不补的话进度条会明显拖在后面。补到只剩 MAX_LAG，剩下的仍按节奏铺开。
    if (gap > MAX_LAG) {
      shown = target - MAX_LAG
      gap = MAX_LAG
    }
    const upper = upperBound()
    const room = upper - shown
    if (room <= 0.05) {
      stop() // 前瞻打满：没有可画的了，停表（新目标到达会重新开表）
      return
    }

    // 每拍步长取两条腿的较大者——这是「全程不断流」的关键（第四版重构）：
    //   · 计划步长：把落后增量摊到「预计下次更新的 PLAN_AHEAD 倍时刻」（缓冲吸抖，稳态推导
    //     见 PLAN_AHEAD 注释）。它只在落后时有值，段末自然衰减为 0；
    //   · 速率步长：按实测真实速率前进，随「距上限的余量」锥减——计划步长衰减后它自然接管，
    //     无缝滚入前瞻区（≤LEAD_MAX），到顶前渐近减速，绝不急停。
    // 此前把两段写成互斥分支，前瞻只在「恰好追平」才切入——中段几乎不会发生，等于没生效
    //（仿真实测最大领先 0.0%）；取 max 合并后两条腿互为兜底，哪条走得动走哪条。
    let planStep = 0
    if (gap > 0) {
      const expected = (intervalEma || DEFAULT_INTERVAL_MS) * PLAN_AHEAD
      const remaining = Math.max(MIN_REMAINING_MS, lastTargetAt + expected - now)
      planStep = gap * Math.min(1, dt / remaining)
    }
    const velStep = rateEma * dt * Math.max(0, Math.min(1, room / LEAD_MAX))
    const step = Math.max(planStep, velStep)
    if (step <= 0) {
      stop() // 无速率依据也无落后增量：无处可画
      return
    }
    shown = Math.min(shown + step, upper)
    paint()
  }

  const start = () => {
    if (!timer && shown < upperBound()) {
      lastTickAt = Date.now()
      timer = setInterval(tick, tickMs)
    }
  }

  return {
    // 设定真实目标（由 BLE 进度回调驱动）。只增不减，避免回退造成的抖动。
    setTarget(value) {
      const next = clamp(value)
      if (next <= target) {
        return
      }
      const now = Date.now()
      if (lastTargetAt) {
        // 观测两次真实更新的间隔与速率：前者是落后段铺开增量的依据，后者是前瞻段的速度基准
        const delta = Math.max(1, now - lastTargetAt)
        intervalEma = intervalEma
          ? intervalEma * (1 - INTERVAL_EMA_WEIGHT) + delta * INTERVAL_EMA_WEIGHT
          : delta
        const sampleRate = (next - target) / delta
        rateEma = rateEma
          ? rateEma * (1 - INTERVAL_EMA_WEIGHT) + sampleRate * INTERVAL_EMA_WEIGHT
          : sampleRate
      } else {
        // 首个目标还没有观测值：按缺省间隔假设一个保守速率，让前瞻段起步时有依据
        rateEma = next / DEFAULT_INTERVAL_MS
      }
      lastTargetAt = now
      target = next
      start()
    },
    // 就地冻结（用于**图传失败**）：立刻停止动画，并把显示值**钳回真实目标**——
    // 前瞻段领先出去的那几格是借来的观感，失败瞬间必须还回去（这是「允许造一点假」的
    // 对价条款：失败画面上停着一个比真实进度高的数字，就是在骗用户）。
    // 落后段冻结则停在当前显示值：那部分本来就 ≤ 真实确认进度，不多画一分即可。
    freeze() {
      stop()
      target = Math.floor(Math.min(shown, target))
      shown = target
      paint()
    },
    // 立刻跳到某个值并停表（用于本张收尾 100% / 失败复位），不再做递进动画
    jumpTo(value) {
      const next = clamp(value)
      stop()
      target = next
      shown = next
      paint()
    },
    // 新的一张开始：清零重来（间隔/速率观测一并重置，避免把上一张的节奏带过来）
    reset() {
      stop()
      target = 0
      shown = 0
      painted = -1
      lastTargetAt = 0
      intervalEma = 0
      rateEma = 0
      paint()
    },
    // 页面卸载/传输结束务必调用，防止定时器泄漏
    dispose() {
      stop()
    },
    // 供测试与排查
    current() {
      return Math.floor(shown)
    },
    targetValue() {
      return target
    }
  }
}

module.exports = { createSmoothProgress }
