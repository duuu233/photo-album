// 一键清空：等 0x12「删除全部」应答的同时回读 0x01，设备一张不剩就算清完（2026-09-21 报障：
// 「清除后，设备都刷出默认图片了，小程序还在转圈圈」）。见 utils/clear-watch.js。
//
// 守的几条：
//   ① 0x12 先回来 → 以它为准，一次都不回读、也不收回应答；
//   ② 0x12 迟迟不回、回读看到清空 → 立刻按成功收尾，并收回那条还在等的 0x12；
//   ③ 回读失败（设备忙 0x0B / 应答超时）或还有剩余 → 接着读，不误判；
//   ④ 0x12 自己失败 → 原样交给调用方（它还有「回读核对」那一套），不吞；
//   ⑤ 收尾之后不再回读（计时器清干净），迟到的 0x12 失败不会再改结果。
const assert = require('assert')
const clearWatch = require('../utils/clear-watch')

const FAST = { pollStartMs: 5, pollGapMs: 5 }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// 一条可以从外面决定何时、以何种结果回来的「0x12 应答」
function pendingDelete() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function main() {
  // ① 0x12 在第一次回读之前就回来了
  {
    let reads = 0
    let cancels = 0
    const result = await clearWatch.deleteAllWatching(
      Object.assign({}, FAST, {
        pollStartMs: 50,
        deleteAll: async () => ({ result: 0, imgMask: [0, 0] }),
        readState: async () => {
          reads++
          return { remaining: 0, imgMask: [] }
        },
        cancelDelete: () => {
          cancels++
        }
      })
    )
    assert.deepStrictEqual(result, { result: 0, imgMask: [0, 0] })
    await sleep(80)
    assert.strictEqual(reads, 0, '0x12 已回来就不该再回读')
    assert.ok(!result.confirmedByPoll)
    // 收尾时照例调一次 cancelDelete——真实实现里 0x12 已回来时它是空操作
    assert.strictEqual(cancels, 1)
  }

  // ② 0x12 一直不回：回读先看到还剩 3 张，再看到 0 张 → 按成功收尾并收回 0x12
  {
    const del = pendingDelete()
    const remainingSeq = [3, 0]
    let reads = 0
    let cancelled = false
    const result = await clearWatch.deleteAllWatching(
      Object.assign({}, FAST, {
        deleteAll: () => del.promise,
        readState: async () => {
          const remaining = remainingSeq[Math.min(reads, remainingSeq.length - 1)]
          reads++
          return { remaining, imgMask: remaining ? [7] : [0] }
        },
        cancelDelete: () => {
          cancelled = true
          // 真实实现：收回 pending 后，等待方以 CANCELLED 失败
          const error = new Error('指令 0x12 已不再等待应答')
          error.code = 'CANCELLED'
          del.reject(error)
        }
      })
    )
    assert.strictEqual(result.confirmedByPoll, true)
    assert.strictEqual(result.result, 0)
    assert.deepStrictEqual(result.imgMask, [0])
    assert.strictEqual(reads, 2)
    assert.strictEqual(cancelled, true, '回读确认清空后必须收回还在等的 0x12')
    // ⑤ 收尾后不再回读
    await sleep(40)
    assert.strictEqual(reads, 2, '收尾之后不该再回读')
  }

  // ③ 回读先失败（设备正忙擦除回 0x0B），之后读到清空 → 仍按成功收尾
  {
    const del = pendingDelete()
    let reads = 0
    const logs = []
    const result = await clearWatch.deleteAllWatching(
      Object.assign({}, FAST, {
        deleteAll: () => del.promise,
        readState: async () => {
          reads++
          if (reads < 3) {
            throw new Error('设备-当前电子纸设备繁忙，请稍后重试')
          }
          return { remaining: 0, imgMask: [] }
        },
        cancelDelete: () => del.reject(new Error('cancelled')),
        log: label => logs.push(label)
      })
    )
    assert.strictEqual(result.confirmedByPoll, true)
    assert.strictEqual(reads, 3)
    assert.ok(
      logs.some(label => label.indexOf('未成功') > -1),
      '回读失败要记一条日志，便于排查'
    )
  }

  // ④ 0x12 自己失败（应答超时）且回读一直没看到清空 → 把 0x12 的错误原样抛给调用方
  {
    const del = pendingDelete()
    let reads = 0
    const failure = new Error('设备-指令 0x12 应答超时')
    setTimeout(() => del.reject(failure), 30)
    await assert.rejects(
      clearWatch.deleteAllWatching(
        Object.assign({}, FAST, {
          deleteAll: () => del.promise,
          readState: async () => {
            reads++
            return { remaining: 5, imgMask: [31] }
          },
          cancelDelete: () => {}
        })
      ),
      error => error === failure
    )
    const readsAtFailure = reads
    assert.ok(readsAtFailure >= 1, '等应答期间应该在回读')
    await sleep(40)
    assert.strictEqual(reads, readsAtFailure, '0x12 失败收尾后不该再回读')
  }

  // 默认节奏：5 秒后开始、每 3 秒一次（真机用的就是这两个数）
  assert.strictEqual(clearWatch.POLL_START_MS, 5000)
  assert.strictEqual(clearWatch.POLL_GAP_MS, 3000)

  console.log('clear-watch.test.js: all passed')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
