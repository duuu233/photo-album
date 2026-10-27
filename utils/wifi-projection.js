// WiFi 版投屏（2026-10-27，对接进度 STEP 3；契约见 docs/前端对接文档_草稿.md 第一节与 docs/wifi/前端评审回复.md v0.32）。
//
// 一张图的完整过程（projectOne）：
//   ① 上传 POST /api/device/play（multipart：deviceNo、type、file），进度 = 真实上传进度 0~100；
//   ② 上传到 100% 但接口未返回：「图片处理中」（服务端转 bin + 上传 OSS + 下发，最长约 8 秒）；
//   ③ 接口返回 status=SENT（旧版 DOWNLOADING）→ 指令已下发；status=FAILED → MQTT 下发失败，直接失败；
//   ④ 等终态：WebSocket play.result 为主，GET /api/device/play/status 每 3 秒轮询兜底（WS 断线 / 没订上也能走完）；
//      状态只进不退：SENT → DOWNLOADING → FLASHING → SUCCESS / FAILED / TIMEOUT，迟到的低档位忽略；
//   ⑤ TIMEOUT 不立即定论：再等 3 秒给迟到的成功 ack（corrected=true 的 SUCCESS），再查一次状态；
//   ⑥ 客户端兜底 90 秒（服务端 ack 超时 60 秒）仍无终态，查一次状态，仍不是终态按「结果未知」。
// WS 事件可能早于 HTTP 响应到达（那时还不知道 msgid）：上传前就开始按 msgid 缓存本设备的 play.result，拿到 msgid 后补认。
const iotApi = require('./iot-api')
const iotWs = require('./iot-ws')

const POLL_INTERVAL_MS = 3000
const TIMEOUT_GRACE_MS = 3000
const OVERALL_TIMEOUT_MS = 90000

// 状态档位：只进不退
const RANK = { UPLOADING: 0, PROCESSING: 1, SENT: 2, DOWNLOADING: 3, FLASHING: 4, SUCCESS: 9, FAILED: 9, TIMEOUT: 9 }
const TERMINAL = ['SUCCESS', 'FAILED', 'TIMEOUT']

// 文案（服务端只给状态码，文案由 App 维护，文档 1.4 文案对照表 + 评审回复 SENT 口径）
const STAGE_TEXT = {
  UPLOADING: '图片上传中',
  PROCESSING: '图片处理中',
  SENT: '指令已下发，等待设备',
  DOWNLOADING: '屏幕即将刷新',
  FLASHING: '设备刷屏中',
  SUCCESS: '投屏成功',
  FAILED: '投屏失败',
  TIMEOUT: '投屏超时',
  UNKNOWN: '结果未知，请稍后查看设备',
  CANCELLED: '已取消'
}

// 失败原因（play.result / 状态查询的 reason，评审回复 14.1）
const REASON_TEXT = {
  PLAY_DOWNLOAD_FAILED: '设备下载图片失败',
  PLAY_STORAGE_ERROR: '设备存储异常',
  PLAY_FAILED: '设备处理失败'
}

function plainDeviceNo(deviceNo) {
  return String(deviceNo == null ? '' : deviceNo).replace(/[:\-\s]/g, '').toUpperCase()
}

function normalizeStatus(status) {
  const value = String(status || '').toUpperCase()
  return RANK[value] === undefined ? '' : value
}

function isTerminal(status) {
  return TERMINAL.indexOf(status) > -1
}

// 接口错误 → 给用户看的文案：去掉「接口(IoT)-」前缀（文案本身已按错误码翻译，见 utils/iot-errors.js）
function errorText(error) {
  return String((error && error.message) || '投屏失败，请稍后重试').replace(/^接口\(IoT\)-/, '')
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// 投一张图。options：
//   { deviceNo, filePath, type, onStage({ stage, text, progress }), isCancelled() }
// resolve { status: SUCCESS / FAILED / TIMEOUT / UNKNOWN / CANCELLED, msgid, message, reason, corrected, error }，不 reject。
async function projectOne(options) {
  const deviceNo = plainDeviceNo(options.deviceNo)
  const onStage = typeof options.onStage === 'function' ? options.onStage : () => {}
  const isCancelled = typeof options.isCancelled === 'function' ? options.isCancelled : () => false

  let stage = 'UPLOADING'
  let progress = 0
  const report = next => {
    if (next && RANK[next] !== undefined && RANK[next] >= RANK[stage]) {
      stage = next
    }
    onStage({ stage, text: STAGE_TEXT[stage], progress })
  }

  // WS：先订阅、先缓存，事件可能比 HTTP 响应早到
  const cached = {}
  let msgid = ''
  let wake = null
  const offs = [
    iotWs.on('play.result', event => {
      if (!event || plainDeviceNo(event.deviceNo) !== deviceNo || !event.msgid) {
        return
      }
      const key = String(event.msgid)
      const list = cached[key] || (cached[key] = [])
      list.push(event)
      if (key === msgid && wake) {
        wake()
      }
    }),
    // 断线重连后立即补查一次（断线期间的事件会丢）
    iotWs.on('state', event => {
      if (event && event.state === 'open' && event.reconnect && wake) {
        wake()
      }
    })
  ]
  const alreadySubscribed = iotWs.getSubscriptions().indexOf(deviceNo) > -1
  iotWs.subscribe(deviceNo)

  const finish = result => {
    offs.forEach(off => off())
    if (!alreadySubscribed) {
      iotWs.unsubscribe(deviceNo)
    }
    return Object.assign({ msgid, text: STAGE_TEXT[result.status] }, result)
  }

  try {
    report('UPLOADING')
    let response = null
    try {
      response = await iotApi.play(deviceNo, options.filePath, options.type, {
        showError: false,
        onProgress: percent => {
          progress = Math.max(progress, Math.min(100, Math.round(percent)))
          // 传完还没返回：图片处理中
          report(progress >= 100 ? 'PROCESSING' : 'UPLOADING')
        }
      })
    } catch (error) {
      return finish({ status: 'FAILED', message: errorText(error), error })
    }
    progress = 100
    msgid = String((response && response.msgid) || '')
    const first = normalizeStatus(response && response.status)
    if (first === 'FAILED') {
      return finish({ status: 'FAILED', message: STAGE_TEXT.FAILED })
    }
    // 兼容旧版初始状态 DOWNLOADING；SENT 为当前口径
    report(first && !isTerminal(first) ? first : 'SENT')
    if (!msgid) {
      // 没有任务号无法跟踪：指令已下发，结果只能看设备
      return finish({ status: 'UNKNOWN', message: STAGE_TEXT.UNKNOWN })
    }

    let latest = null // 最新一条终态事件 / 查询结果
    const apply = record => {
      const status = normalizeStatus(record && record.status)
      if (!status) {
        return
      }
      if (isTerminal(status)) {
        // 终态可被修正：TIMEOUT 之后迟到的 SUCCESS（corrected=true）以成功为准
        if (!latest || (latest.status === 'TIMEOUT' && status === 'SUCCESS')) {
          latest = { status, reason: record.reason || '', corrected: !!record.corrected }
        }
      }
      report(status)
    }
    const drain = () => {
      const list = cached[msgid] || []
      cached[msgid] = []
      list.forEach(apply)
    }
    const query = async () => {
      try {
        apply(await iotApi.getPlayStatus(msgid, { showError: false }))
        return null
      } catch (error) {
        return error
      }
    }
    // 等一小段：WS 事件到了提前醒
    const waitAWhile = ms =>
      new Promise(resolve => {
        const timer = setTimeout(done, ms)
        function done() {
          clearTimeout(timer)
          wake = null
          resolve()
        }
        wake = done
      })

    drain()
    const deadline = Date.now() + OVERALL_TIMEOUT_MS
    let lastQueryError = null
    while (!(latest && latest.status !== 'TIMEOUT') && Date.now() < deadline) {
      if (isCancelled()) {
        return finish({ status: 'CANCELLED', message: STAGE_TEXT.CANCELLED })
      }
      if (latest && latest.status === 'TIMEOUT') {
        // 给迟到的成功 ack 留修正窗口，再查一次确认
        await sleep(TIMEOUT_GRACE_MS)
        drain()
        if (latest.status === 'TIMEOUT') {
          await query()
        }
        break
      }
      await waitAWhile(POLL_INTERVAL_MS)
      drain()
      if (!latest) {
        lastQueryError = await query()
      }
    }
    if (!latest) {
      // 客户端兜底到点：最后查一次；任务过期（4044）或仍无终态都按结果未知
      lastQueryError = await query()
      drain()
    }
    if (!latest) {
      const expired = lastQueryError && Number(lastQueryError.code) === 4044
      return finish({ status: 'UNKNOWN', message: expired ? '任务已过期，结果未知' : STAGE_TEXT.UNKNOWN })
    }
    if (latest.status === 'FAILED') {
      return finish({
        status: 'FAILED',
        reason: latest.reason,
        message: REASON_TEXT[latest.reason] || STAGE_TEXT.FAILED
      })
    }
    return finish({ status: latest.status, corrected: latest.corrected, message: STAGE_TEXT[latest.status] })
  } catch (error) {
    return finish({ status: 'FAILED', message: errorText(error), error })
  }
}

module.exports = {
  STAGE_TEXT,
  REASON_TEXT,
  POLL_INTERVAL_MS,
  TIMEOUT_GRACE_MS,
  OVERALL_TIMEOUT_MS,
  projectOne
}
