// 投屏结果页：进入时（status=progress）真实连接设备并走 BLE 图传，进度条与张数为真实进度；
// 传完按真实结果切到「成功 / 失败」。已改为「后端转换 + BLE 图传」链路（图片处理放到服务器，画质更稳）：
//   连接 → 读真实设备信息(0x01) → 逐张：
//     原图传后端转换(setUserProductUpload，得 .bin 下载地址 + taskId + upirId)
//     → 下载 .bin 帧数据 → 图传到设备(0x20/0x21/0x22)
//     → 设备成功才编辑投屏记录(editUserProductImgRecord 置 deviceUploadState=1) → 刷新显示(0x24)。
// 再次/重新投屏（投屏记录页进入，images 带 imgBle）：一律直接下载记录里的 imgBle 帧数据图传，
//     不调后端上传/转码接口(setUserProductUpload)、也不调 editUserProductImgRecord；
//     设备图传成功(1)/失败(0)都调 addUserProductImgRecord 新增一条投屏记录（见 addRetryRecord）。
const system = require('../../../utils/system')
const api = require('../../../utils/api')
const deviceBle = require('../../../utils/device-ble')
const protocol = require('../../../utils/frame-protocol')
const toast = require('../../../utils/toast')
const media = require('../../../utils/media')
const activeDevice = require('../../../utils/active-device')

const STATUS_TEXT = {
  progress: {
    title: '图片转码中',
    desc: '投屏过程中请不要关闭手机'
  },
  success: {
    title: '投屏完成',
    desc: '照片已成功投屏到设备，可前往相册查看'
  },
  fail: {
    title: '投屏失败',
    desc: '设备连接中断，请检查设备状态后重试'
  }
}

// 不同投屏状态对应的插画图片
const STATUS_ART = {
  progress: '/assets/images/upload-icon01.png',
  fail: '/assets/images/upload-icon02.png',
  success: '/assets/images/upload-icon03.png'
}

// 把投屏过程中的底层错误归一成用户能看懂的结果页提示：
//   · 设备内存已满 → 引导清理；
//   · 设备连接 / 蓝牙链路问题（会话已断、或错误带「设备-」前缀、或命中断连关键词）→ 统一
//     「设备未连接，请检查手机或设备连接后继续」，不把「应答超时 / 连接已断开」等底层码抛给用户
//     （常见于投屏完成后设备正在刷新屏幕、蓝牙暂短断开时立刻再投）；
//   · 其余（如后端转换 / 网络下载失败）保留原始文案，配合失败页固定提示排查。
function classifyFailureMessage(rawMessage, deviceId) {
  const msg = (rawMessage && String(rawMessage)) || '投屏失败'
  if (/内存已满|已存满|空间不足/.test(msg)) {
    return '设备内存已满，请清理后继续。'
  }
  // 设备忙(0x0B)：设备答得上话、只是暂时在忙，别被下方「设备-」前缀误归成「设备未连接」，
  // 原样提示「当前设备繁忙，请稍后重试」，引导用户稍后再投。
  if (msg.indexOf(protocol.BUSY_MESSAGE) !== -1) {
    return protocol.BUSY_MESSAGE
  }
  const connLost =
    (deviceId && !deviceBle.isConnected(deviceId)) ||
    /^设备-/.test(msg) ||
    /连接已断开|连接中断|连接失败|已断开|连接超时|链路|该型号暂不支持图传/.test(msg)
  if (connLost) {
    return '设备未连接，请检查手机或设备连接后继续'
  }
  return msg
}

function readPerformanceEnvironment() {
  let device = {}
  let app = {}
  try {
    device = wx.getDeviceInfo ? wx.getDeviceInfo() : wx.getSystemInfoSync()
  } catch (error) {
    device = {}
  }
  try {
    app = wx.getAppBaseInfo ? wx.getAppBaseInfo() : wx.getSystemInfoSync()
  } catch (error) {
    app = {}
  }
  const base = {
    platform: device.platform || '',
    system: device.system || '',
    model: device.model || '',
    brand: device.brand || '',
    wechatVersion: app.version || '',
    sdkVersion: app.SDKVersion || ''
  }
  if (!wx.getNetworkType) {
    return Promise.resolve(base)
  }
  return new Promise(resolve => {
    wx.getNetworkType({
      success: res => resolve(Object.assign(base, { networkType: res.networkType || '' })),
      fail: () => resolve(base)
    })
  })
}

Page({
  data: {
    statusBarHeight: 20,
    safeBottom: 0,
    status: 'progress',
    title: '图片转码中',
    desc: STATUS_TEXT.progress.desc,
    artImage: STATUS_ART.progress,
    deviceName: '相框',
    recordCount: 0,
    // 投屏明细：n/n = 实际参与投屏/本次所选数量。successCount 绿色(成功)、failCount 红色(失败)
    successCount: 0,
    failCount: 0,
    selectedTotal: 0,
    progressCurrent: 0,
    progressTotal: 0,
    progressPercent: 0,
    // 「继续投屏」在当前页弹出的「拍照/相册」选择弹层显隐 + 退场动画标记
    showMediaSheet: false,
    mediaSheetClosing: false
  },

  onLoad(options) {
    this.setData(system.getLayoutMetrics())
    this._aborted = false
    this._activeDeviceId = ''
    this._retryImageInFlight = null // 正在图传的再次投屏图：失败时外层 catch 据此补记失败记录

    const status = options.status || 'progress'
    if (status === 'progress') {
      // 真实投屏：读取预览页写入的待投屏设备与图片，连接设备后逐张图传
      this.runRealProjection()
    } else {
      // 直接以某个结果态进入（如从别处跳转）：只展示，不发起图传
      const result = wx.getStorageSync('lastProjectionResult') || {}
      this.applyStatus(status, result)
    }
  },

  // 进入后台（息屏 / 切到微信外）：图传在后台无法继续（蓝牙挂起、设备 1s 超时会中止），打中止标记尽快干净停下
  onHide() {
    if (this.data.status === 'progress') {
      this._aborted = true
    }
  },

  onUnload() {
    this._aborted = true
    this._unloaded = true // 卸载后 finishProjection 只落存储，不再 setData/弹 toast
    wx.setKeepScreenOn && wx.setKeepScreenOn({ keepScreenOn: false })
    // 离开投屏结果页不再主动断开：按用户要求保持连接（非手动/物理断开就一直连着）。
    this._activeDeviceId = ''
  },

  applyStatus(status, result) {
    const text = STATUS_TEXT[status] || STATUS_TEXT.progress
    this.setData({
      status,
      title: text.title,
      // 结果页正文：有归类后的结果提示（失败原因 / 部分成功的失败说明，如「设备内存已满」「设备未连接」）就优先显示，
      // 否则回落状态默认文案（全部成功时展示成功文案）。
      desc: result.message || text.desc,
      artImage: STATUS_ART[status] || STATUS_ART.progress,
      deviceName: result.deviceName || '相框',
      recordCount: result.imageCount || 0,
      successCount: result.successCount || 0,
      failCount: result.failCount || 0,
      selectedTotal: result.selectedTotal || 0
    })
  },

  // 统一收尾：按「成功张数」决定跳成功/失败页——只要有一张传成功(uploaded>=1)就算投屏完成(成功页，
  // 可能部分成功)，一张都没成功才是失败页。成功/失败页都带上投屏明细计数与归类后的结果文案。
  finishProjection(device, options) {
    const opts = options || {}
    const uploaded = opts.uploaded || 0
    const failCount = opts.failCount || 0
    const total = opts.total || 0
    const message = opts.message || ''
    const status = uploaded >= 1 ? 'success' : 'fail'

    this._sessionDevice = device // 供成功页「继续投屏」复用这台设备
    if (status === 'success') {
      wx.removeStorageSync('pendingProjection') // 成功(含部分成功)后清掉，避免重复整单投；失败图片在投屏记录里可重传
    }
    // 失败图片留在投屏记录（deviceUploadState=0）可重传；失败页保留 pendingProjection 便于「重新投屏」

    const result = {
      status,
      deviceName: (device && device.name) || '相框',
      imageCount: uploaded,
      successCount: uploaded,
      failCount,
      selectedTotal: total,
      // 成功页仅在「部分成功」时带失败说明；失败页始终带归类后的失败原因
      message: status === 'fail' ? message : failCount ? message : ''
    }
    wx.setStorageSync('lastProjectionResult', result)
    if (this._unloaded) {
      return // 用户已退出本页：结果已落存储，别再对已销毁实例 setData / 弹 toast
    }
    this.applyStatus(status, result)
    if (status === 'fail' && message) {
      toast.warn({ title: message, icon: 'none' })
    }
  },

  queueRecordTask(label, taskFactory, imagePerformance) {
    const startedAt = Date.now()
    const task = Promise.resolve()
      .then(taskFactory)
      .then(
        () => {
          if (imagePerformance) {
            imagePerformance.recordSuccess = true
          }
        },
        error => {
          if (imagePerformance) {
            imagePerformance.recordSuccess = false
            imagePerformance.recordError =
              (error && error.message) || '投屏记录写入失败'
          }
          console.error(`[投屏] ${label}（设备状态不受影响）：`, error)
        }
      )
      .then(() => {
        if (imagePerformance) {
          imagePerformance.recordMs = Date.now() - startedAt
        }
      })
    this._recordTasks.push(task)
    return task
  },

  async drainRecordTasks() {
    const tasks = this._recordTasks || []
    if (!tasks.length) {
      return 0
    }
    const startedAt = Date.now()
    await Promise.all(tasks)
    return Date.now() - startedAt
  },

  reportProjectionPerformance(performance) {
    const perf = performance || {}
    ;(perf.images || []).forEach(item => {
      console.log('[投屏性能] 单张汇总', item)
    })
    console.log('[投屏性能] 整单汇总', perf)
  },

  // 真实投屏主流程：连接 → 读设备信息 → 逐张解码并图传 → 按真实结果置成功/失败
  async runRealProjection() {
    const pending = wx.getStorageSync('pendingProjection') || {}
    const device = pending.device || {}
    // 记住本次投屏的设备，供成功后「继续投屏」复用（成功会清掉 pendingProjection）
    this._sessionDevice = device
    // 只投有真实图片文件的照片（相册占位图 url 为空，无法图传）
    const images = (pending.images || []).filter(
      item => item && (item.tempFilePath || item.url)
    )
    // 是否压缩图片（预览页开关写入）：仅明确关闭才传原图，缺省（老数据/记录页再次投屏）默认压缩
    this._compressImage = pending.compressImage !== false
    const deviceId = device.deviceId

    if (!deviceId) {
      this.finishProjection(device, {
        uploaded: 0,
        failCount: images.length ? 1 : 0,
        total: images.length,
        message: '设备未连接，请重新绑定后再投屏'
      })
      return
    }
    if (!images.length) {
      this.finishProjection(device, {
        uploaded: 0,
        failCount: 0,
        total: 0,
        message: '没有可投屏的照片'
      })
      return
    }

    this._aborted = false
    this._activeDeviceId = deviceId
    // 投屏期间保持屏幕常亮：避免息屏导致蓝牙被挂起、传输中断
    wx.setKeepScreenOn && wx.setKeepScreenOn({ keepScreenOn: true })

    const total = images.length
    const pendingPerformance = pending.performance || {}
    const performance = {
      traceId:
        pendingPerformance.traceId ||
        `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      startedAt: Date.now(),
      previewPrepareMs: pendingPerformance.previewPrepareMs || 0,
      selectedTotal: total,
      phases: {},
      images: []
    }
    const environmentPromise = readPerformanceEnvironment()
    this._recordTasks = []
    this.setData({
      progressTotal: total,
      progressCurrent: 0,
      progressPercent: 0
    })
    console.log(`[投屏] 开始：deviceId=${deviceId}，待投 ${total} 张`)

    let uploaded = 0
    try {
      // 1) 连接并读取真实设备信息（屏幕尺寸/类型/容量/已存掩码）。
      // 这几步在第一包数据发出前要花点时间（连接尤其慢），逐步更新文案，避免页面看起来卡在 0% 不动。
      this.setData({ desc: '正在连接设备…' })
      performance.connectionReused = deviceBle.isConnected(deviceId)
      let phaseStartedAt = Date.now()
      await deviceBle.ensureConnection(deviceId)
      performance.phases.connectMs = Date.now() - phaseStartedAt
      this.setData({ desc: '正在读取设备信息…' })
      phaseStartedAt = Date.now()
      const info = await deviceBle.readTransferInfo(deviceId)
      performance.phases.readTransferInfoMs = Date.now() - phaseStartedAt
      performance.device = {
        screenType: info.screenType,
        width: info.width,
        height: info.height,
        capacity: info.capacity,
        firmwareVersion: device.firmwareVersion || ''
      }
      console.log('[投屏] 设备信息：', {
        screenType: info.screenType,
        width: info.width,
        height: info.height,
        capacity: info.capacity,
        imgCount: info.imgCount
      })

      if (info.screenType === 0x03) {
        // 固件明确上报 screenType=0x03：该机型确实不支持图传
        throw new Error('该型号暂不支持图传')
      }
      if (!info.width || !info.height) {
        // 读到空的设备信息(宽/高为 0)：多为「投屏完成后设备正在刷新屏幕、蓝牙暂短断开」时立刻再投所致，
        // 并非机型不支持——按连接问题提示，引导用户等刷新完成 / 检查连接后再试。
        throw new Error('设备未连接，请检查手机或设备连接后继续')
      }

      // 设备空间：剩余可存张数 = 容量 - 已存张数（掩码置位数）。不再整单预检「够不够放下全部」，
      // 改为逐张尝试、放满为止：设备放满时下方 firstFreeIndex 返回 -1 抛「设备内存已满」，
      // 此前已成功的张数照常算「部分成功」跳成功页（对齐产品：内存差 N 张时能把 N 张投进去）。
      let usedIndexes = protocol.maskToIndexes(info.imgMask)
      const free = (info.capacity || 0) - usedIndexes.length
      console.log(
        `[投屏] 设备空间：容量 ${info.capacity}，已存 ${usedIndexes.length}，剩余 ${free}，待投 ${total}`
      )

      // 2) 逐张：原图传后端转换得 .bin → 下载帧数据 → 选空闲槽位 → 图传 → 设备成功才写投屏记录 → 刷新显示。
      // A3 预取流水线：设备帧的「后端转码 + 下载」是纯网络，与「BLE 图传」互不占用资源。所以在投第 i 张
      // (走蓝牙)的同时，提前并行拉取第 i+1 张的设备帧；轮到它时通常已就绪，省去「传完一张才开始下一张
      // 转码下载」的串行等待（批量投屏体感提速最明显的一块）。只预取下一张(最多 1 张在后台)，中断时浪费最小。
      // 预取失败不在此处抛，包成 {error} 留到主循环 await 时再抛，走原有失败处理 / 失败记账。
      const framePrefetch = []
      const startPrefetch = idx => {
        if (idx >= total || framePrefetch[idx]) {
          return
        }
        framePrefetch[idx] = this.acquireFrame(images[idx], device, info, idx, total)
          .then(result => ({ result }))
          .catch(error => ({ error }))
      }
      startPrefetch(0) // 先启动第一张的取帧

      // 第一张网络准备已启动；连接间隔优化与它并行，避免这些 BLE 控制指令继续挡住原图上传/转码。
      phaseStartedAt = Date.now()
      try {
        performance.connectionInterval =
          await deviceBle.optimizeConnectionIntervalForTransfer(deviceId)
      } catch (error) {
        performance.connectionIntervalError =
          (error && error.message) || '连接间隔优化失败'
      }
      performance.phases.optimizeConnectionIntervalMs =
        Date.now() - phaseStartedAt

      for (let i = 0; i < total; i++) {
        if (this._aborted) {
          throw new Error('UPLOAD_ABORTED')
        }
        const image = images[i]
        // 再次/重新投屏的图（记录页带入 imgBle 且未在预览页重新编辑过）：
        // 本张不论最终成功失败都要 addUserProductImgRecord 记账，失败记账由外层 catch 统一补
        const isRetry = !!(image.imgBle && !image.tempFilePath)
        this._retryImageInFlight = isRetry ? image : null
        const imagePerformance = {
          imageNumber: i + 1,
          retryProjection: isRetry,
          acquireWaitMs: 0,
          recordMs: 0
        }
        performance.images.push(imagePerformance)
        // 每张传输前把进度条清零：本张从 0% 独立开始（批量传输时每张 0→100）。
        // 取帧可能仍在进行(首张 / 弱网)，先给「准备」文案；已预取就绪则 await 立即返回。
        this.setData({
          progressCurrent: i + 1,
          progressPercent: 0,
          title: '图片处理中',
          desc: `正在准备第 ${i + 1}/${total} 张…`
        })
        // 取本张要发给设备的六色 4bpp 帧 + 后端记录 id（见 acquireFrame）：预取已就绪则秒拿，
        // 未就绪则在此等待。失败原样抛出，走外层失败处理。
        const acquireWaitStartedAt = Date.now()
        const acquired = await framePrefetch[i]
        imagePerformance.acquireWaitMs = Date.now() - acquireWaitStartedAt
        if (acquired.error) {
          imagePerformance.acquireError =
            (acquired.error && acquired.error.message) || '设备帧准备失败'
          throw acquired.error
        }
        const { frameData, taskId, upirId, timings } = acquired.result
        imagePerformance.prepare = timings || {}
        // 本张帧一到手，立刻启动下一张的预取，让它与本张 BLE 图传并行
        startPrefetch(i + 1)
        const head = protocol.bytesToHex(frameData.subarray(0, 16))
        const expected4bpp = Math.ceil((info.width * info.height) / 2)
        console.log(
          `[投屏] 第 ${i + 1}/${total} 张 .bin=${frameData.length} 字节 头16=${head} 设备需六色4bpp=${expected4bpp} 字节`
        )
        // 字节数必须 = 六色4bpp(宽×高÷2)；对不上直接报清晰错误（设备会回含糊的「参数错误」），便于核对后端返回格式
        if (frameData.length !== expected4bpp) {
          throw new Error(
            `后端返回的不是设备要的六色4bpp帧：收到 ${frameData.length} 字节(头16=${head})，设备 ${info.width}×${info.height} 需要 ${expected4bpp} 字节`
          )
        }
        this.setData({ title: '图片传输中', desc: `正在投第 ${i + 1}/${total} 张…` })

        const index = protocol.firstFreeIndex(
          protocol.indexesToMask(usedIndexes),
          info.capacity
        )
        if (index < 0) {
          throw new Error('设备内存已满，请清理后继续。')
        }
        console.log(
          `[投屏] 第 ${i + 1}/${total} 张 图传(0x20)：index=${index} screenType=${info.screenType} ` +
            `${info.width}x${info.height} dataSize=${frameData.length}`
        )

        // 本张设备事务：只有 BLE 图传失败才回滚删掉刚传到设备的图、再向外抛出让整单判失败。
        // 图传成功后照片已物理写入相框，本张即算成功——后续写记录是后端记账，已与设备状态解耦。
        let summary
        let lastProgressUpdateAt = 0
        let lastProgressPercent = -1
        try {
          summary = await deviceBle.uploadImage(deviceId, {
            screenType: info.screenType,
            index,
            width: info.width,
            height: info.height,
            data: frameData,
            traceId: performance.traceId,
            imageIndex: i,
            shouldAbort: () => this._aborted,
            // ACK 仍实时驱动底层滑动窗口；页面最多约 8 次/秒更新，避免高频 setData 反过来拖慢 BLE。
            onProgress: (done, totalPackets, phase) => {
              const frac = totalPackets ? done / totalPackets : 0
              const percent = Math.min(100, Math.floor(frac * 100))
              const now = Date.now()
              const immediate =
                phase === 'start' ||
                phase === 'done' ||
                phase === 'retry' ||
                percent === 100
              if (
                !immediate &&
                (percent === lastProgressPercent || now - lastProgressUpdateAt < 120)
              ) {
                return
              }
              lastProgressUpdateAt = now
              lastProgressPercent = percent
              this.setData({
                progressPercent: percent
              })
            }
          })
          imagePerformance.ble = summary.transferStats || {}
          console.log(`[投屏] 第 ${i + 1}/${total} 张 设备图传成功`, summary)
        } catch (error) {
          imagePerformance.ble = (error && error.transferStats) || {}
          console.error(
            `[投屏] 第 ${i + 1}/${total} 张 设备图传失败，回滚 index=${index}：`,
            error
          )
          await this.rollbackDeviceImage(deviceId, index)
          throw error
        }

        // 设备图传成功 → 写后端投屏记录。尽力而为：记账失败只记日志，不回滚设备、
        // 不把整单判失败，避免设备已传成功却被误删/误判失败。两条链路：
        //   · 再次/重新投屏(imgBle 直传)：addUserProductImgRecord 新增一条成功记录；
        //   · 正常投屏(后端转码时已按失败态建记录)：editUserProductImgRecord 按 taskId 置成功。
        if (isRetry) {
          // 设备已成功，本张不再可能补记失败；记账放入并行队列，不挡住下一张 BLE。
          this._retryImageInFlight = null
          this.queueRecordTask(
            `第 ${i + 1}/${total} 张再次投屏记录写入失败`,
            () => this.addRetryRecord(image, 1),
            imagePerformance
          )
        } else {
          this.queueRecordTask(
            `第 ${i + 1}/${total} 张投屏记录写入失败`,
            async () => {
              await api.editUserProductImgRecord({
                upirId,
                taskId,
                deviceUploadState: 1,
                showError: false
              })
              console.log(
                `[投屏] 第 ${i + 1}/${total} 张 投屏记录已置成功：taskId=${taskId}`
              )
            },
            imagePerformance
          )
        }

        // 该槽位记为已用，供下一张选空闲槽位
        usedIndexes = usedIndexes.concat(index)
        uploaded++
        // 本张传输完成：进度条置 100%，张数 +1（下一张会重新从 0 开始）
        this.setData({ progressCurrent: uploaded, progressPercent: 100 })

        // 只有最后一张传完后才刷新屏幕(0x24)：部分固件收到 0x24 会断开蓝牙，
        // 批量传输时中途刷屏会导致后续图片传输失败。故中间张一律不刷屏，
        // 等全部传完后只对最后一张执行一次 0x24，切到最后这张显示。
        if (i === total - 1) {
          const refreshStartedAt = Date.now()
          try {
            await deviceBle.refreshScreen(deviceId, index)
          } catch (error) {
            // 刷新失败不阻断整体成功
          }
          performance.phases.refreshScreenMs = Date.now() - refreshStartedAt
        }
      }

      performance.phases.recordDrainMs = await this.drainRecordTasks()
      console.log(`[投屏] 全部完成：成功 ${uploaded}/${total} 张`)
      performance.outcome = 'success'
      this.finishProjection(device, { uploaded, failCount: 0, total, message: '' })
    } catch (error) {
      // 再次/重新投屏：传固件失败也要新增一条失败记录(deviceUploadState=0)；成功记账已在循环内完成
      if (this._retryImageInFlight) {
        const failedImagePerformance = performance.images[performance.images.length - 1]
        const failedImage = this._retryImageInFlight
        this._retryImageInFlight = null
        this.queueRecordTask(
          '再次投屏失败记录写入失败',
          () => this.addRetryRecord(failedImage, 0),
          failedImagePerformance
        )
      }
      performance.phases.recordDrainMs = await this.drainRecordTasks()
      const aborted =
        this._aborted || (error && error.message === 'UPLOAD_ABORTED')
      const rawMessage = aborted
        ? '投屏已中断：上传时手机息屏/切到后台，蓝牙会被挂起。请保持亮屏后重新投屏。'
        : (error && error.message) || '投屏失败'
      // 归类：设备断联/蓝牙链路问题统一成「设备未连接…」、内存满统一成「设备内存已满…」；主动中断文案原样保留。
      const message = aborted
        ? rawMessage
        : classifyFailureMessage(rawMessage, deviceId)
      console.error(
        `[投屏] 失败（已成功 ${uploaded}/${total} 张，原始错误：${rawMessage}）：${message}`,
        error
      )
      performance.outcome = aborted ? 'aborted' : 'failed'
      performance.error = rawMessage
      // 「任意一张失败即中断」下本次至多 1 张真正失败 → failCount=1。已成功 uploaded>=1 走成功页(部分成功)，
      // 一张都没成功才走失败页。两页都带明细计数(成功/失败/本次所选)与归类后的结果文案。
      this.finishProjection(device, { uploaded, failCount: 1, total, message })
    } finally {
      performance.uploaded = uploaded
      performance.totalMs = Date.now() - performance.startedAt
      performance.environment = await environmentPromise
      this.reportProjectionPerformance(performance)
      wx.setKeepScreenOn && wx.setKeepScreenOn({ keepScreenOn: false })
      // 不再传完即断：保持连接（设备单连接，下次投屏可直接复用、省去重新扫描+连接）。
      // 仅在物理断开(onBLEConnectionStateChange 清理)或用户手动断开时才真正断开。
      this._activeDeviceId = ''
    }
  },

  // 取本张要发给设备的六色 4bpp 帧 + 后端记录 id（原图传后端转换 → 下载 .bin）。
  // 纯网络、无 UI 副作用：可被主循环「预取下一张」提前并行调用（见 runRealProjection 的预取流水线），
  // 页面文案/进度统一由主循环控制，避免预取抢占当前正在投屏那张的界面。i/total 仅用于日志。
  async acquireFrame(image, device, info, i, total) {
    const acquireStartedAt = Date.now()
    // 再次投屏（投屏记录页带入 imgBle）：记录里已有后端转换好的设备帧文件，直接下载 imgBle
    // 走 BLE 图传，不再调后端上传/转码接口(setUserProductUpload)。
    // 若用户在预览页重新裁剪/旋转过（产生 tempFilePath），旧帧已对不上编辑结果，仍走后端转换链路。
    if (image.imgBle && !image.tempFilePath) {
      console.log(`[投屏] 第 ${i + 1}/${total} 张 再次投屏：直接下载 imgBle=${image.imgBle}`)
      // 产品要求：再次/重新投屏一律直接用记录里的设备帧 .bin(imgBle)，
      // 不回退后端上传/转码；下载失败即本张失败（runRealProjection 外层 catch 会补记失败记录）
      const downloaded = await this.downloadFrameBin(image.imgBle)
      return {
        frameData: downloaded.frameData,
        upirId: image.upirId,
        timings: Object.assign({}, downloaded.timings, {
          acquireMs: Date.now() - acquireStartedAt
        })
      }
    }

    // 正常投屏：先「转换照片」(传后端按设备尺寸转换) 得到可下载的 .bin 地址 + taskId(更新设备上传状态用)
    // + upirId(投屏记录id)，再下载 .bin 得到六色 4bpp 帧（客户端不做任何图像转换）。
    const converted = await this.convertOnServer(
      image,
      device,
      info
    )
    const downloaded = await this.downloadFrameBin(converted.url)
    return {
      frameData: downloaded.frameData,
      taskId: converted.taskId,
      upirId: converted.upirId,
      timings: Object.assign({}, converted.timings, downloaded.timings, {
        acquireMs: Date.now() - acquireStartedAt
      })
    }
  },

  // 本张照片传后端转换：上传原图 → 后端按设备宽高(targetWidth×targetHeight)转换成设备帧并存 OSS，
  // 返回 { url(.bin 下载地址)、taskId、upirId }。初始按「未成功(0)」建记录，设备图传成功后再 editUserProductImgRecord 置 1。
  // 失败会抛出，让本张投屏判为失败并跳到失败场景。
  async convertOnServer(image, device, info) {
    const userProductId = device && (device.userProductId || device.id)
    const sourceResolveStartedAt = Date.now()
    const filePath = await this.resolveLocalFilePath(image)
    const sourceResolveMs = Date.now() - sourceResolveStartedAt
    if (!filePath) {
      throw new Error('图片文件不可用，无法转换')
    }

    // 压缩开关：开(默认)=1 后端压到约300-400KB；关=0 传原图
    const isCompress = this._compressImage === false ? 0 : 1
    console.log(
      `[投屏] 上传原图转换：userProductId=${userProductId} target=${info.width}x${info.height} isCompress=${isCompress} file=${filePath}`
    )
    const uploadConvertStartedAt = Date.now()
    const res = await api.setUserProductUpload({
      filePath,
      userProductId,
      targetWidth: info.width,
      targetHeight: info.height,
      isCompress,
      deviceUploadState: 0,
      loading: false, // 结果页用 setData desc 自管进度，关掉全局 loading 遮罩
      showError: false // 失败统一走本页失败场景，不额外弹 toast
    })
    const uploadConvertMs = Date.now() - uploadConvertStartedAt

    // 单文件上传返回的就是该对象；保险起见也兼容数组返回
    const item = Array.isArray(res) ? res[0] : res
    console.log('[投屏] 转换接口返回：', item)
    const url = item && (item.url || item.fileUrl || item.path)
    if (!url) {
      throw new Error('服务器未返回转换结果')
    }
    return {
      url,
      taskId: item.taskId,
      upirId: item.upirId,
      timings: { sourceResolveMs, uploadConvertMs }
    }
  },

  // 再次/重新投屏的记账：设备图传成功(1)/失败(0)后都调 addUserProductImgRecord 新增一条投屏记录。
  // 必填字段按后端约定：userProductId / img / imgBle / deviceUploadState；upirId 等其他字段有就带上。
  // 尽力而为：记账失败只记日志，不影响投屏结果展示（设备侧状态已成事实）。
  async addRetryRecord(image, deviceUploadState) {
    await api.addUserProductImgRecord({
      upirId: image.upirId,
      userProductId: image.userProductId,
      img: image.url,
      imgBle: image.imgBle,
      deviceUploadState,
      showError: false
    })
    console.log(`[投屏] 再次投屏已记账：deviceUploadState=${deviceUploadState}`)
  },

  // downloadFile 通用封装：单次尝试带超时，弱网下「downloadFile:fail timeout」/网络抖动自动退避重试。
  // 一次 timeout 就把整单判失败太脆（投屏常在户外弱网下进行）；这里对超时/连接类失败重试几次，
  // 仍失败才抛出，错误信息沿用最后一次。HTTP 状态码错误（如 404/403）属确定性失败，不重试直接抛出。
  downloadFileWithRetry(url, label, attempts = 3, timeout = 20000) {
    const once = () =>
      new Promise((resolve, reject) => {
        wx.downloadFile({
          url,
          timeout,
          success: res => {
            if (res.statusCode === 200 && res.tempFilePath) {
              resolve(res.tempFilePath)
            } else {
              reject(new Error(`${label}(${res.statusCode})`))
            }
          },
          fail: error => reject(new Error((error && error.errMsg) || label))
        })
      })
    const run = left =>
      once().catch(error => {
        // 仅超时/连接/网络类失败才重试；白名单、HTTP 状态码等确定性失败不重试
        const retriable = /timeout|connect|网络|ERR_/i.test(error.message || '')
        if (left > 1 && retriable) {
          console.warn(
            `[投屏] ${label}，将重试（剩余 ${left - 1} 次）：`,
            error.message
          )
          return new Promise(r => setTimeout(r, 800)).then(() => run(left - 1))
        }
        throw error
      })
    return run(attempts)
  },

  // 解析出可上传的本地文件路径：本地图（相机/相册/裁剪导出）直接用 tempFilePath；
  // 仅有 https 远程地址的（重复投屏云端图）先 downloadFile 落到本地临时文件再上传。
  resolveLocalFilePath(image) {
    const localPath = image && image.tempFilePath
    if (localPath) {
      return Promise.resolve(localPath)
    }
    const remoteUrl = image && image.url
    if (remoteUrl && /^https?:\/\//i.test(remoteUrl)) {
      return this.downloadFileWithRetry(remoteUrl, '原图下载失败')
    }
    return Promise.resolve(remoteUrl || '')
  },

  // 下载后端按设备分辨率转换好的六色 4bpp 帧(.bin)，读成 Uint8Array 直接喂给 BLE 图传。
  // 注意：生产环境需把 OSS 域名加入小程序「downloadFile 合法域名」白名单（开发期 urlCheck=false 不校验）。
  async downloadFrameBin(url) {
    const downloadStartedAt = Date.now()
    const tempFilePath = await this.downloadFileWithRetry(url, '转换结果下载失败')
    const frameDownloadMs = Date.now() - downloadStartedAt
    const readStartedAt = Date.now()
    const frameData = await new Promise((resolve, reject) => {
      wx.getFileSystemManager().readFile({
        filePath: tempFilePath,
        success: r => resolve(new Uint8Array(r.data)),
        fail: () => reject(new Error('转换结果读取失败'))
      })
    })
    return {
      frameData,
      timings: {
        frameDownloadMs,
        frameReadMs: Date.now() - readStartedAt
      }
    }
  },

  // 单张投屏失败时的设备侧回滚：删掉本次刚传到设备的这张图（CMD 0x12），让设备与后端回到一致状态。
  // index 取自 firstFreeIndex，必为本张新占的空闲槽位，删它只影响这次上传、不会误删旧图。
  // 回滚删除本身失败（息屏/断连下本就发不出指令，设备多半也未真正落盘）不再抛出，避免掩盖真正的失败原因。
  async rollbackDeviceImage(deviceId, index) {
    if (!deviceId || !Number.isInteger(index) || index < 0) {
      return
    }
    try {
      await deviceBle.deleteImage(deviceId, [index])
    } catch (error) {
      // 回滚删除失败不覆盖原始失败原因
    }
  },

  goBack() {
    const pages = getCurrentPages()

    if (pages.length > 1) {
      wx.navigateBack()
      return
    }

    wx.switchTab({
      url: '/pages/home/home'
    })
  },

  backHome() {
    wx.switchTab({
      url: '/pages/home/home'
    })
  },

  goRecords() {
    wx.redirectTo({
      url: '/subpackages/projection/records/records'
    })
  },

  retry() {
    wx.redirectTo({
      url: '/subpackages/projection/preview/preview'
    })
  },

  // 「继续投屏」：不跳首页，在当前结果页弹出「拍照/相册」二选一弹层，选图后走投屏预览页。
  continueProjection() {
    this.setData({ showMediaSheet: true, mediaSheetClosing: false })
  },

  // 关闭「拍照/相册」弹层（带退场动画，与首页/设备详情页一致）
  hideMediaSheet() {
    if (this.data.mediaSheetClosing) {
      return
    }
    this.setData({ mediaSheetClosing: true })
    setTimeout(() => {
      this.setData({ showMediaSheet: false, mediaSheetClosing: false })
    }, 220)
  },

  // 选「拍照」：调起相机拍一张后继续投屏
  chooseCamera() {
    this.pickAndContinue(() => media.chooseFromCamera())
  },

  // 选「相册」：从相册选图后继续投屏
  chooseAlbum() {
    this.pickAndContinue(() => media.chooseFromAlbum())
  },

  // 选图(拍照/相册)后继续投屏：复用本次投屏的设备，确保已连接后写 pendingProjection 跳投屏预览页。
  // 用户取消选择不报错；连不上设备时提示已由 ensureConnectedForAction 弹出。
  async pickAndContinue(pickImages) {
    let images
    try {
      images = await pickImages()
    } catch (error) {
      if (error && error.errMsg && error.errMsg.indexOf('cancel') > -1) {
        return // 用户取消选择，保留弹层
      }
      toast.warn({ title: '选择照片失败', icon: 'none' })
      return
    }
    if (!images || !images.length) {
      return
    }

    // 复用本次投屏的设备；缺失时退回全局选中设备
    const device = this._sessionDevice || activeDevice.getActiveDevice()
    if (
      !device ||
      !(
        device.deviceId ||
        device.bleDeviceId ||
        device.deviceNo ||
        device.productDeviceId ||
        device.name
      )
    ) {
      toast.warn({ title: '未找到可投屏的设备', icon: 'none' })
      return
    }

    this.hideMediaSheet()
    // 自动寻找并连接该设备（未连接会自动扫描重连；连不上/无权限有提示）
    const deviceId = await activeDevice.ensureConnectedForAction(device)
    if (!deviceId) {
      return // 提示已由 ensureConnectedForAction 弹出
    }

    wx.setStorageSync('pendingProjection', {
      device: Object.assign({}, device, {
        deviceId,
        bleDeviceId: deviceId,
        connected: true
      }),
      images
    })
    wx.redirectTo({
      url: '/subpackages/projection/preview/preview'
    })
  },

  noop() {}
})
