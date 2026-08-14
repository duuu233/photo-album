// 把「跳变的目标进度」渲染成逐格递增的平滑进度。
//
// 为什么需要（2026-08-14）：BLE 图传的真实进度天生是**跳变**的——固件每 10 包才回一次 0x23
// 累计应答，窗口 50 包时一次应答就推进几十包，进度条于是一段一段往前蹦。页面侧此前还叠了一层
// 「最多约 8 次/秒」的节流，跳感更明显。
//
// 直觉做法是提高刷新频率，但那正是**不能做**的事：`setData` 跨线程推给视图层会占住 JS 线程、
// 推迟 0x23 应答的处理，越刷越慢——图传性能档案里为此专门加过节流。
//
// 这里换个方向：**降低每次更新的幅度，而不是提高频率**。目标值仍由 BLE 事件驱动（真实、不作假），
// 显示值按固定节拍朝目标逐格逼近，每格 1%。整场传输的 setData 次数 ≈ 100 次，均摊到十几秒里
// 比原来的 8 次/秒**更少**，观感却是连续增长的。
//
// 三条不变量：
//   · 显示值**永不超过**真实目标值——只把已经发生的进度画得更细腻，绝不凭空预测；
//   · 落后太多时按比例追赶（否则每格 1% 追不上真实速度，进度条会显得"拖后腿"）；
//   · 到达目标即停表，不空转。

const DEFAULT_STEP_MS = 45 // 递进节拍：约 22 次/秒，但只在「显示值 < 目标值」时才真的 setData
const CATCH_UP_DIVISOR = 6 // 落后越多、每格走得越大：步长 = 差值/6（至少 1）

// options:
//   onRender(value)  必填，把当前显示值写进页面（调用方自己 setData）
//   stepMs           递进节拍，缺省 45ms
//   max              进度上限，缺省 100
function createSmoothProgress(options) {
  const onRender = options && options.onRender
  if (typeof onRender !== 'function') {
    throw new Error('createSmoothProgress 需要 onRender 回调')
  }
  const stepMs = (options && options.stepMs) || DEFAULT_STEP_MS
  const max = (options && options.max) || 100

  let target = 0
  let shown = 0
  let timer = null

  const stop = () => {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  const tick = () => {
    if (shown >= target) {
      stop() // 追平了就停表，不空转占 JS 线程
      return
    }
    // 落后多就多走几格：只按 1 格走的话，真实速度快时进度条会明显滞后于实际传输
    const gap = target - shown
    const step = Math.max(1, Math.floor(gap / CATCH_UP_DIVISOR))
    shown = Math.min(target, shown + step)
    onRender(shown)
    if (shown >= target) {
      stop()
    }
  }

  const start = () => {
    if (!timer && shown < target) {
      timer = setInterval(tick, stepMs)
    }
  }

  return {
    // 设定真实目标（由 BLE 进度回调驱动）。只增不减，避免回退造成的抖动。
    setTarget(value) {
      const next = Math.max(0, Math.min(max, Math.round(Number(value) || 0)))
      if (next <= target) {
        return
      }
      target = next
      start()
    },
    // 立刻跳到某个值并停表（用于本张收尾 100% / 失败复位），不再做递进动画
    jumpTo(value) {
      const next = Math.max(0, Math.min(max, Math.round(Number(value) || 0)))
      stop()
      target = next
      shown = next
      onRender(shown)
    },
    // 新的一张开始：清零重来
    reset() {
      this.jumpTo(0)
    },
    // 页面卸载/传输结束务必调用，防止定时器泄漏
    dispose() {
      stop()
    },
    // 供测试与排查
    current() {
      return shown
    },
    targetValue() {
      return target
    }
  }
}

module.exports = { createSmoothProgress }
