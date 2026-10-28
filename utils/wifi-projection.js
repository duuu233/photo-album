// WiFi 版投屏（2026-10-27，对接进度 STEP 3；契约见 docs/前端对接文档_草稿.md 第一节，
// 2026-10-27 起按 docs/wifi/XT相框通讯协议_V1.4_更新说明.md 第二节改为「不等 ack」）。
//
// 一张图的完整过程（projectOne）：
//   ① 上传 POST /api/device/play（multipart：deviceNo、type、file、refresh、renderMode），进度 = 真实上传进度 0~100；
//   ② 上传到 100% 但接口未返回：「图片处理中」（服务端转 bin + 上传 OSS + 下发，最长约 8 秒）；
//   ③ 接口返回即结束，不再轮询 /api/device/play/status、也不等 WS play.result：
//      · status=SENT（旧版 DOWNLOADING）→ 指令已下发，提示「已发送，屏幕即将刷新」；
//      · status=UPLOADED（refresh=false）→ 只上传了 bin、不刷屏，msgid 为 null，不能拿来查状态；
//      · status=FAILED → MQTT 下发失败；
//      · 设备真正刷屏成功 / 失败由服务端写消息通知（PLAY_SUCCESS / PLAY_DOWNLOAD_FAILED / PLAY_STORAGE_ERROR / PLAY_FAILED）。
//   ④ 批量：接口仍是一次一张，前 N-1 张 refresh=false、最后一张 refresh=true，只刷一次屏（更新说明 2.4，由结果页决定）。
//   ⑤ addToCarousel=true（2026-10-27 追加内容第二节，预览页「同时加入轮播」）：每张都带，返回的 carouselUpdated 原样交回，
//      false = 没加进轮播（投屏本身照常成功），由结果页提示。
//   ⑥ renderMode（2026-10-28）：后台产品配置的渲染模式，调用方用 api.resolveRenderMode 取好传进来，有值才带、原样传。
// 返回里带 binUrl：结果页拿它写老服务相册记录（imgBle），「我的上传」、轮播选图、删除都靠这条记录。
//
// ── 投屏日志（options.onLog，同时打控制台 [WiFi投屏]；结果页开发版 / 体验版显示、可复制）──
// 每个接口按「接口【名称】方法 路径」+「参数」+「返回 / 失败」三行记；阶段只在变化时记一行，上传进度只记 25% 档位。
// 不记 userToken；图片只记本地路径（尺寸 / 大小由结果页在上传前补一行）。
const iotApi = require('./iot-api')

// 文案（服务端只给状态码，文案由 App 维护；SENT / UPLOADED 按 V1.4 更新说明 2.1 / 2.4）
const STAGE_TEXT = {
  UPLOADING: '图片上传中',
  PROCESSING: '图片处理中',
  SENT: '已发送，屏幕即将刷新',
  UPLOADED: '已上传',
  FAILED: '投屏失败',
  CANCELLED: '已取消'
}

// 上传阶段只进不退（迟到的进度回调不把「处理中」拉回「上传中」）
const RANK = { UPLOADING: 0, PROCESSING: 1 }

function plainDeviceNo(deviceNo) {
  return String(deviceNo == null ? '' : deviceNo).replace(/[:\-\s]/g, '').toUpperCase()
}

// 接口错误 → 给用户看的文案：去掉「接口(IoT)-」前缀（文案本身已按错误码翻译，见 utils/iot-errors.js）
function errorText(error) {
  return String((error && error.message) || '投屏失败，请稍后重试').replace(/^接口\(IoT\)-/, '')
}

// 4041（设备已离线）时补查一次在线状态：休眠中 / 已关机的设备也回 4041，此时改成对应提示（休眠状态对接说明 4.2、V1.4 第三节）
async function offlineText(deviceNo, error, log) {
  if (!error || Number(error.code) !== 4041 || typeof iotApi.getDeviceOnline !== 'function') {
    return errorText(error)
  }
  try {
    const res = await iotApi.getDeviceOnline(deviceNo, undefined, { showError: false })
    log(`4041 补查【在线状态】${json(res)}`)
    const status = String((res && res.status) || '').toUpperCase()
    if (status === 'SLEEPING') {
      return '设备休眠中，唤醒后可操作'
    }
    if (status === 'SHUTDOWN') {
      return '设备已关机，开机后可操作'
    }
  } catch (queryError) {
    log(`4041 补查【在线状态】失败 ${(queryError && queryError.message) || queryError}`)
  }
  return errorText(error)
}

function json(value) {
  try {
    return JSON.stringify(value)
  } catch (error) {
    return String(value)
  }
}

// 接口失败的日志文案：HTTP 状态、业务码、服务端原文、给用户看的文案
function errorLine(error) {
  if (!error) {
    return '失败（无错误信息）'
  }
  const parts = []
  if (error.statusCode !== undefined) parts.push(`HTTP ${error.statusCode}`)
  if (error.code !== undefined) parts.push(`code ${error.code}`)
  if (error.serverMessage) parts.push(`服务端：${error.serverMessage}`)
  return `失败 ${parts.join(' ')}${parts.length ? '，' : ''}${(error && error.message) || error}`
}

// 接口返回的 status → 本次结果：SENT / UPLOADED / FAILED。旧版初始状态 DOWNLOADING 等同 SENT；
// 没给 status 时按本次是否刷屏推断（刷屏 = SENT，只上传 = UPLOADED）
function resultStatus(response, refresh) {
  const status = String((response && response.status) || '').toUpperCase()
  if (status === 'FAILED') {
    return 'FAILED'
  }
  if (status === 'UPLOADED') {
    return 'UPLOADED'
  }
  if (status === 'SENT' || status === 'DOWNLOADING') {
    return 'SENT'
  }
  return refresh ? 'SENT' : 'UPLOADED'
}

// 投一张图。options：
//   { deviceNo, filePath, type, renderMode（空 = 不传）, refresh（默认 true）, addToCarousel（默认 false）, onStage({ stage, text, progress }), isCancelled(), onLog(text) }
// resolve { status: SENT / UPLOADED / FAILED / CANCELLED, text, message, msgid, binUrl, carouselUpdated（true / false / null）, error }，不 reject。
async function projectOne(options) {
  const deviceNo = plainDeviceNo(options.deviceNo)
  const refresh = options.refresh !== false
  const addToCarousel = options.addToCarousel === true
  const renderMode = String(options.renderMode || '').trim()
  const onStage = typeof options.onStage === 'function' ? options.onStage : () => {}
  const isCancelled = typeof options.isCancelled === 'function' ? options.isCancelled : () => false
  const onLog = typeof options.onLog === 'function' ? options.onLog : () => {}
  const log = text => {
    console.log('[WiFi投屏]', text)
    try {
      onLog(text)
    } catch (error) {
      // 页面日志回调出错不影响投屏
    }
  }

  let stage = 'UPLOADING'
  let progress = 0
  let loggedStage = ''
  const report = next => {
    if (RANK[next] === undefined || RANK[stage] === undefined || RANK[next] >= RANK[stage]) {
      stage = next
    }
    if (stage !== loggedStage) {
      loggedStage = stage
      log(`阶段 → ${stage}（${STAGE_TEXT[stage]}）`)
    }
    onStage({ stage, text: STAGE_TEXT[stage], progress })
  }

  const finish = result => {
    const done = Object.assign({ msgid: '', binUrl: '', carouselUpdated: null, text: STAGE_TEXT[result.status] }, result)
    log(
      `结束：${done.status}${done.message ? `（${done.message}）` : ''}，msgid=${done.msgid || '-'}，binUrl=${done.binUrl || '-'}` +
        (addToCarousel ? `，carouselUpdated=${done.carouselUpdated}` : '')
    )
    return done
  }

  log(`开始投屏：设备 ${deviceNo || '-'}，type=${options.type}${renderMode ? `，renderMode=${renderMode}` : ''}，refresh=${refresh}${addToCarousel ? '，addToCarousel=true' : ''}，文件 ${options.filePath || '-'}`)
  if (isCancelled()) {
    return finish({ status: 'CANCELLED', message: STAGE_TEXT.CANCELLED })
  }
  report('UPLOADING')
  let response = null
  let loggedPercent = -1
  log('接口【投屏】POST /api/device/play（IoT，multipart 上传）')
  log(`参数 ${json(Object.assign({ deviceNo, type: String(options.type) }, renderMode ? { renderMode } : {}, { refresh }, addToCarousel ? { addToCarousel } : {}, { file: options.filePath }))}`)
  const startedAt = Date.now()
  try {
    response = await iotApi.play(deviceNo, options.filePath, options.type, {
      showError: false,
      refresh,
      addToCarousel,
      renderMode,
      onProgress: percent => {
        progress = Math.max(progress, Math.min(100, Math.round(percent)))
        const bucket = Math.floor(progress / 25) * 25
        if (bucket > loggedPercent) {
          loggedPercent = bucket
          log(`上传进度 ${bucket}%`)
        }
        // 传完还没返回：图片处理中
        report(progress >= 100 ? 'PROCESSING' : 'UPLOADING')
      }
    })
  } catch (error) {
    log(`${errorLine(error)}（耗时 ${Date.now() - startedAt}ms）`)
    return finish({ status: 'FAILED', message: await offlineText(deviceNo, error, log), error })
  }
  log(`返回 ${json(response)}（耗时 ${Date.now() - startedAt}ms）`)
  progress = 100
  const status = resultStatus(response, refresh)
  report(status)
  return finish({
    status,
    message: STAGE_TEXT[status],
    msgid: String((response && response.msgid) || ''),
    binUrl: String((response && response.binUrl) || ''),
    carouselUpdated: response && typeof response.carouselUpdated === 'boolean' ? response.carouselUpdated : null
  })
}

module.exports = {
  STAGE_TEXT,
  resultStatus,
  projectOne
}
