// 一键清空：等 0x12「删除全部」应答的同时回读 0x01，设备上一张都不剩了就算清完（2026-09-21）。
//
// 报障原话：「清除后，设备都刷出默认图片了，小程序还在转圈圈」。
// 0x12 是设备**全删完才回一次**应答，所以代码侧等应答的预算按张数给（每张 2s、下限 6s、封顶
// 180s，见 device-ble.deleteImage）。这份预算只在「设备真的还没删完」时有意义；设备早就删完、
// 屏幕都刷成默认图了，而那一次应答迟到或丢了，转圈就要一直转到预算用完——几十张就是一两分钟，
// 之后还要再走一轮失败回读。
//
// 做法：发出 0x12 后等一小段（pollStartMs），之后每隔 pollGapMs 读一次 0x01 看还剩几张：
//   · 剩 0 张 → 设备已清空，立刻按成功收尾，不再等 0x12 应答（cancelDelete 收回那条 pending，
//     否则它会一直占着 0x12 直到超时，期间再删图会被拒成「正在等待应答」）；
//   · 读不到（设备正忙回 0x0B / 应答超时）或还有剩余 → 设备还在擦，下一拍再看；
//   · 0x12 自己先回来了（成功或失败）→ 以它为准，停止回读，失败照旧交给调用方原来的核对逻辑。
// 这是协议允许的：设备处理指令期间收到新指令会回 0x0B「设备繁忙」（规格书 v1.5 §6.6.1），
// 各指令的应答按命令字分别配对，0x01 与在途的 0x12 互不干扰。
//
// 依赖全部由调用方传入，便于在 node 里单测（tests/clear-watch.test.js）。

const POLL_START_MS = 5000
const POLL_GAP_MS = 3000

// options:
//   deleteAll()    → Promise：发 0x12 删除全部，resolve 设备应答解析结果
//   readState()    → Promise<{ remaining, imgMask }>：读一次 0x01，remaining = 设备上还剩几张
//   cancelDelete() → 不再等 0x12 应答（没有在等时应为空操作）
//   log(label, data)      可选，排查日志
//   pollStartMs / pollGapMs  可选，回读起点与间隔
//   setTimer / clearTimer    可选，默认 setTimeout / clearTimeout
// 返回 Promise：0x12 的应答结果；或回读确认清空时 { result: 0, imgMask, confirmedByPoll: true }。
function deleteAllWatching(options) {
  const deleteAll = options.deleteAll
  const readState = options.readState
  const cancelDelete = options.cancelDelete || function () {}
  const log = options.log || function () {}
  const pollStartMs = options.pollStartMs != null ? options.pollStartMs : POLL_START_MS
  const pollGapMs = options.pollGapMs != null ? options.pollGapMs : POLL_GAP_MS
  const setTimer = options.setTimer || setTimeout
  const clearTimer = options.clearTimer || clearTimeout

  return new Promise((resolve, reject) => {
    let settled = false
    let timer = null

    const finish = (settle, value) => {
      if (settled) {
        return
      }
      settled = true
      if (timer) {
        clearTimer(timer)
        timer = null
      }
      // 0x12 已经回来时这里是空操作；回读先确认清空时，收回那条还在等的 0x12
      // （它随后以 CANCELLED 失败，已经 settled，被上面那句挡掉）。
      cancelDelete()
      settle(value)
    }

    const poll = async () => {
      timer = null
      if (settled) {
        return
      }
      try {
        const state = await readState()
        if (settled) {
          return
        }
        log('等 0x12 应答期间回读 0x01', { remaining: state && state.remaining })
        if (state && state.remaining === 0) {
          log('回读确认设备已清空，不再等 0x12 应答')
          finish(resolve, {
            result: 0x00,
            imgMask: state.imgMask,
            confirmedByPoll: true
          })
          return
        }
      } catch (error) {
        if (settled) {
          return
        }
        log('等 0x12 应答期间回读 0x01 未成功（设备多半还在擦除），稍后再读', {
          error: (error && error.message) || String(error)
        })
      }
      if (!settled) {
        timer = setTimer(poll, pollGapMs)
      }
    }

    Promise.resolve()
      .then(deleteAll)
      .then(value => finish(resolve, value), error => finish(reject, error))
    timer = setTimer(poll, pollStartMs)
  })
}

module.exports = {
  deleteAllWatching,
  POLL_START_MS,
  POLL_GAP_MS
}
