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
// 现在改为**按节奏铺开**：显示值不再赶着追平，而是把当前这段增量摊到「下一次目标更新预计到达」
// 的时刻——用实测的目标更新间隔（指数滑动平均）估算，令显示值恰好在下一次应答到来时走完上一段。
// 于是指针一直在动，衔接处没有停顿。更新迟到时会提前走完并短暂停住（此时是真的没有新进度了，
// 不能凭空往前画）；更新提前到达则自然加速——这两种情况都由「剩余时间」自适应吸收。
//
// 三条不变量：
//   · 显示值**永不超过**真实目标——只把已发生的进度画得更细腻，绝不预测未发生的进度；
//   · 显示值单调不减；
//   · 追平且无新目标时停表，不空转占 JS 线程。

const DEFAULT_TICK_MS = 33 // 渲染节拍（约 30 次/秒）。真正 setData 只在取整值变化时发生
const DEFAULT_INTERVAL_MS = 300 // 还没有观测值时，假设的目标更新间隔（宁可估长：估短会先冲完再等）
const MIN_REMAINING_MS = 40 // 目标更新已逾期时，把剩余增量收拢完的最短时间
const INTERVAL_EMA_WEIGHT = 0.3 // 新观测在间隔均值里的权重
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

  const tick = () => {
    const now = Date.now()
    const dt = Math.max(1, now - lastTickAt)
    lastTickAt = now

    let gap = target - shown
    if (gap <= 0) {
      stop() // 已追平且没有新目标：真的没有新进度可画了，停表
      return
    }

    // 落后过多先补齐超出部分：真实传输提速（窗口涨回、设备吃满）时旧节奏铺不过来，
    // 不补的话进度条会明显拖在后面。补到只剩 MAX_LAG，剩下的仍按节奏铺开。
    if (gap > MAX_LAG) {
      shown = target - MAX_LAG
      gap = MAX_LAG
    }

    // 把剩余增量摊到「下一次目标更新预计到达」之前：这一步是消除停顿的关键。
    // 逾期（更新迟到）时 remaining 收敛到下限，剩余增量快速走完，而不是卡在半路。
    const expected = intervalEma || DEFAULT_INTERVAL_MS
    const remaining = Math.max(MIN_REMAINING_MS, lastTargetAt + expected - now)
    const step = gap * Math.min(1, dt / remaining)
    // 收尾吸附：上面是按比例逼近，数学上会无限接近而永不抵达（39.9 取整仍是 39，
    // 差最后一格永远画不出来）。剩不到一格时直接吸附到目标，把这一格交代干净。
    shown = gap - step < 1 ? target : shown + step
    paint()

    if (shown >= target) {
      stop()
    }
  }

  const start = () => {
    if (!timer && shown < target) {
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
        // 观测两次真实更新的间隔，用来估算下一次何时到——铺开增量的依据
        const delta = now - lastTargetAt
        intervalEma = intervalEma
          ? intervalEma * (1 - INTERVAL_EMA_WEIGHT) + delta * INTERVAL_EMA_WEIGHT
          : delta
      }
      lastTargetAt = now
      target = next
      start()
    },
    // 就地冻结：立刻停止动画并把目标钉在当前显示值（用于**图传失败**）。
    // 失败时最后一段增量往往还没铺完，不冻结的话进度条会在报错后继续往前爬，
    // 看起来像"还在传/传成功了"——这正是绝不能出现的观感。
    freeze() {
      stop()
      target = Math.floor(shown)
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
    // 新的一张开始：清零重来（间隔观测一并重置，避免把上一张的节奏带过来）
    reset() {
      stop()
      target = 0
      shown = 0
      painted = -1
      lastTargetAt = 0
      intervalEma = 0
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
