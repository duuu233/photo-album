// 投屏结果页：进入时（status=progress）真实连接设备并走 BLE 图传，进度条与张数为真实进度；
// 传完按真实结果切到「成功 / 失败」。正常投屏链路（2026-07-22 起设备帧改由 seekink 抖动接口生成，
// 不再下载后端转码的 .bin，见 utils/dithering.js 与 docs/architecture/image-projection-pipeline.md）：
//   连接 → 读真实设备信息(0x01) → 逐张（两路网络并行，见 acquireFrame）：
//     ① 设备帧：预览处理后的设备分辨率图 → 统一压缩(compressForUpload) → 抖动接口 → 六色4bpp帧
//     ② 投屏记录：原图（进预览页前未操作过的图，_origSrc）→ 同一套统一压缩 →
//        setUserProductUpload 建记录拿 taskId/upirId（接口返回的 .bin url 不再下载使用）
//   → ① 的帧图传到设备(0x20/0x21/0x22)
//   → 设备成功才编辑投屏记录(editUserProductImgRecord 置 deviceUploadState=1，逻辑不变)
//   → 整单收尾（传完/中途失败/中断）刷新显示(0x24)一次，切到本批第一张成功写入的槽位。
// 再次/重新投屏（投屏记录页进入）：2026-07-23 起与正常投屏完全同链路——记录页只把后端图片地址
//     写进 pendingProjection（与首页手选图片同形态），出帧/图传/建记录/记账全走上面的正常链路。
//     旧「imgBle(.bin) 直传 + addUserProductImgRecord 补记」机制已删除（后端不再生成 .bin）。
const system = require('../../../utils/system')
const api = require('../../../utils/api')
const deviceBle = require('../../../utils/device-ble')
const dithering = require('../../../utils/dithering')
const protocol = require('../../../utils/frame-protocol')
const toast = require('../../../utils/toast')
const media = require('../../../utils/media')
const activeDevice = require('../../../utils/active-device')
const fold = require('../../../utils/fold-adapt')
const smoothProgress = require('../../../utils/smooth-progress')

// 统一的上传前压缩质量（性能优化 2026-07-13；2026-07-16 改为直接缩到设备物理分辨率；
// 2026-07-22 起抖动接口上传与原图建记录上传两路共用同一套 compressForUpload）。
// 只影响「上传」耗时（真机曾达 5.7s），**不影响图传耗时**——发给设备的六色帧恒为 宽×高÷2
//（3.7寸=172800字节），与源图大小无关。
// 长边缩到「设备长边」（480×720 → 720）、只缩分辨率不改比例；已不大于设备尺寸的图原样上传、不再降质。质量 90。
// 任一步失败（老基础库没有 compressImage / 取不到尺寸 / 压缩报错）都回退原图上传，绝不阻断投屏。
// ⚠️ 少了过采样余量，抖动(dither)细节可能略糙——先真机对比画质再决定是否保留。
const UPLOAD_COMPRESS_QUALITY = 90

// ⚠️ 投屏收尾刷屏(0x24)总开关（2026-08-20 **临时屏蔽**，供真机测试用）。
// 关闭后 scheduleFinalRefresh 直接空转：整批图传完成后不再下发 0x24，设备当前显示保持不变
//（图片照常写进设备槽位，投屏成功/失败判定、记账、进度、连接间隔回落一律不受影响）。
// 只是屏蔽、不是删除：收尾函数与三处调用点原样保留，把这里改回 true 即完全恢复原逻辑。
const FINAL_REFRESH_ENABLED = false
// 存储覆盖键：调试时 wx.setStorageSync('finalRefreshEnabled', true) 即可临时打开，不必改代码重编译
//（与 device-ble 的 idleConnIntervalEnabled 同一套「存储值优先于默认值」机制）。
const FINAL_REFRESH_STORAGE_KEY = 'finalRefreshEnabled'

// 收尾刷屏是否生效：存储里显式写过 true/false 就听它的，否则用上面的默认值。
function isFinalRefreshEnabled() {
  try {
    const stored = wx.getStorageSync(FINAL_REFRESH_STORAGE_KEY)
    if (stored === true || stored === false) {
      return stored
    }
  } catch (error) {
    // 读存储失败按默认值走，不影响投屏
  }
  return FINAL_REFRESH_ENABLED
}

const STATUS_TEXT = {
  progress: {
    title: '图片转码中',
    desc: '投屏过程中请不要关闭手机'
  },
  success: {
    title: '投屏完成',
    desc: '照片已成功投屏到电子纸设备，可前往相册查看'
  },
  fail: {
    title: '投屏失败',
    desc: '电子纸设备连接中断，请检查电子纸设备状态后重试'
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
    return '电子纸设备内存已满，请清理后继续。'
  }
  // 设备忙(0x0B)：设备答得上话、只是暂时在忙，别被下方「设备-」前缀误归成「设备未连接」，
  // 原样提示「当前设备繁忙，请稍后重试」，引导用户稍后再投。
  if (msg.indexOf(protocol.BUSY_MESSAGE) !== -1) {
    return protocol.BUSY_MESSAGE
  }
  const connLost =
    (deviceId && !deviceBle.isConnected(deviceId)) ||
    /^(?:设备|电子纸设备)-/.test(msg) ||
    /连接已断开|连接中断|连接失败|已断开|连接超时|链路|该型号暂不支持图传/.test(msg)
  if (connLost) {
    return '电子纸设备未连接，请检查手机或电子纸设备连接后继续'
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

// 折叠屏/分屏适配：Page 配置外面包一层 fold.adapt（方案见 utils/fold-adapt.js 与
// styles/fold-adapt.wxss）。只叠加「形态变化后重测状态栏/安全区」等钩子，页面原有配置一字不改。
Page(fold.adapt({
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
    // 进度平滑器内部有 setInterval，卸载必须停表，否则定时器泄漏、还会对已卸载页面 setData
    if (this._progress) {
      this._progress.dispose()
      this._progress = null
    }
    wx.setKeepScreenOn && wx.setKeepScreenOn({ keepScreenOn: false })
    // 离开投屏结果页不再主动断开：按用户要求保持连接（非手动/物理断开就一直连着）。
    this._activeDeviceId = ''
  },

  // 进度条平滑器（懒建，单例）：把 BLE 那边跳变的真实进度渲染成逐格递增。
  // 页面已卸载就不再 setData（onUnload 会 dispose，这里再兜一层，防止在途回调）。
  ensureProgressAnimator() {
    if (!this._progress) {
      this._progress = smoothProgress.createSmoothProgress({
        onRender: value => {
          if (this._unloaded) {
            return
          }
          this.setData({ progressPercent: value })
        }
      })
    }
    return this._progress
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
    let device = pending.device || {}
    // 记住本次投屏的设备，供成功后「继续投屏」复用（成功会清掉 pendingProjection）
    this._sessionDevice = device
    // 只投有真实图片文件的照片（相册占位图 url 为空，无法图传）
    const images = (pending.images || []).filter(
      item => item && (item.tempFilePath || item.url)
    )
    let deviceId = ''

    if (
      !(
        device.deviceId ||
        device.bleDeviceId ||
        device.deviceNo ||
        device.productDeviceId
      )
    ) {
      this.finishProjection(device, {
        uploaded: 0,
        failCount: images.length ? 1 : 0,
        total: images.length,
        message: '电子纸设备未连接，请重新绑定后再投屏'
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
    // 投屏期间保持屏幕常亮：避免息屏导致蓝牙被挂起、传输中断
    wx.setKeepScreenOn && wx.setKeepScreenOn({ keepScreenOn: true })
    // 批量传输可达数十秒且左上角返回随时可点：传输期间拦截返回（左上角/安卓物理键/侧滑），
    // 弹系统确认后才允许离开，防误触一下就静默中断、传了一半还没有任何提示。
    if (wx.enableAlertBeforeUnload) {
      wx.enableAlertBeforeUnload({
        message: '正在投屏，退出将中断本次投屏，确定退出吗？'
      })
    }

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
    this.ensureProgressAnimator().reset() // 整单开始：进度条归零并停表
    this.setData({
      progressTotal: total,
      progressCurrent: 0
    })
    console.log(`[投屏] 开始：目标设备=${device.id || device.deviceNo || '--'}，待投 ${total} 张`)

    let uploaded = 0
    // 本批第一张成功写入设备的真实槽位：整单收尾只刷一次屏，刷的就是它（最终展示首张）。
    // 用 null 作为未设置标记，避免合法槽位 0 被误判成空值。
    let firstSuccessfulIndex = null
    // 收尾那一次异步刷屏(0x24)的 Promise：把连接间隔回落到空闲档(100ms)时要等它跑完再发——
    // 刷屏期间设备对新指令回忙(0x0B)，两者挤在一起会让回落白白失败。一张都没成功则保持 null。
    let lastRefreshPromise = null
    // 整单只刷一次屏，刷的是本批**第一张**成功写入设备的槽位，触发点是「整个投屏流程结束」：
    // 全部传完、中途某张失败、用户中断都算收尾，只要已经有图物理写进设备就补这一次 0x24。
    // ⚠️ 2026-08-20 口径修正：此前只在「最后一张传完」那一格触发，选 5 张第 3 张失败时前 2 张
    // 已经在设备里、屏上却还停在投屏前那张（页面还按部分成功进成功页），与产品口径不符。
    // 中途张一律不刷：部分固件收到 0x24 会断蓝牙，批量传输中途刷屏会让后续图片传输失败。
    // ⚠️ 索引来源只有一个：本张图传时由设备 0x01 回的 IMG_MASK 现算出的空闲槽位(firstFreeIndex)，
    // 也就是真正写进相框的那个物理位置。**不要改成后端回的 imgIndex** —— 后端那份是我们
    // 事后写上去的账(editUserProductImgRecord 是 fire-and-forget 的记账，还可能失败)，
    // 拿账本去刷屏就等于用可能过期/写失败的值定位物理槽位，会刷出别的图。
    // 感知优化(2026-07-10)：0x24 的应答要等墨水屏物理刷完才回（真机实测 ~4s），而刷屏结果本来
    // 就不影响投屏成败（此前失败也被吞掉）。故不 await——图片已写入设备，立即进入收尾/成功页，
    // 刷屏在后台继续；耗时/失败异步补记 trace 并单独打一条日志（整单汇总先打出，不含此项）。
    // 代价：成功页出现时设备可能还在刷屏，立刻「继续投屏」可能撞上设备忙(0x0B)/暂时断连，
    // 已有归类提示兜底（「当前设备繁忙…」/「设备未连接…」）。
    const scheduleFinalRefresh = () => {
      // 一张都没成功 → 设备上没有本批的图，不刷；已排过 → 不重复排（收尾路径只会走其一）。
      if (firstSuccessfulIndex === null || lastRefreshPromise) {
        return
      }
      // 总开关关闭（2026-08-20 临时屏蔽，测试用）：整条收尾刷屏空转，只留一条日志。
      // lastRefreshPromise 保持 null → finally 里的连接间隔回落立即执行，不必等刷屏。
      if (!isFinalRefreshEnabled()) {
        performance.refreshScreenSkipped = true
        console.warn(
          `[投屏] 收尾刷屏(0x24)已屏蔽(FINAL_REFRESH_ENABLED=false)，设备当前显示保持不变；` +
            `本应刷到的槽位=${firstSuccessfulIndex}`
        )
        return
      }
      const refreshStartedAt = Date.now()
      lastRefreshPromise = deviceBle
        .refreshScreen(deviceId, firstSuccessfulIndex)
        .then(() => {
          performance.phases.refreshScreenMs = Date.now() - refreshStartedAt
          console.log(
            `[投屏性能] 刷屏完成(异步)：${performance.phases.refreshScreenMs}ms`
          )
        })
        .catch(error => {
          performance.phases.refreshScreenMs = Date.now() - refreshStartedAt
          performance.refreshScreenError = (error && error.message) || '刷新失败'
          console.warn(
            `[投屏性能] 刷屏失败(异步，不影响投屏结果)：${performance.refreshScreenError}`
          )
        })
    }
    try {
      // A3 预取流水线：设备帧的「抖动接口出帧」与「记录上传」是纯网络，与「BLE 图传」互不占用资源。
      // 投第 i 张(走蓝牙)的同时提前并行拉取第 i+1 张的设备帧；只预取下一张(最多 1 张在后台)，中断时浪费最小。
      // 预取失败不在此处抛，包成 {error} 留到主循环 await 时再抛，走原有失败处理 / 失败记账。
      // sizeInfo 显式传入：首张早启动时用设备记录尺寸，其余用 0x01 读到的真实尺寸。
      const framePrefetch = []
      const startPrefetch = (idx, sizeInfo) => {
        if (idx >= total || framePrefetch[idx]) {
          return
        }
        framePrefetch[idx] = this.acquireFrame(images[idx], device, sizeInfo, idx, total)
          .then(result => ({ result }))
          .catch(error => ({ error }))
      }

      // F1 首张网络准备与「连接 → 0x01」并行（性能优化）：出帧目标尺寸/抖动 type 只依赖设备记录里
      // 后端按物理型号下发的 width/height，不必等 0x01。
      // 记录尺寸可用时立刻启动第一张的「抖动出帧+记录上传」，把冷连接 1~3s 的等待与网络准备重叠；
      // 0x01 返回后校验尺寸，不一致（记录过期/异常）则作废预取按真实尺寸重取，
      // 主循环的「帧字节数 = 宽×高÷2」校验仍是最后闸门，错帧绝不会发往设备。
      const guessedSize =
        Number(device.width) > 0 && Number(device.height) > 0
          ? { width: Number(device.width), height: Number(device.height) }
          : null
      if (guessedSize) {
        performance.firstPrefetchEarly = true
        startPrefetch(0, guessedSize)
      }

      // 1) 连接并读取真实设备信息（屏幕尺寸/类型/容量/已存掩码）。
      // 这几步在第一包数据发出前要花点时间（连接尤其慢），逐步更新文案，避免页面看起来卡在 0% 不动。
      this.setData({ desc: '正在连接电子纸设备…' })
      performance.connectionReused = !!activeDevice.findConnectedDeviceId(device)
      let phaseStartedAt = Date.now()
      // pendingProjection 可能来自旧页面/旧缓存，里面的 BLE deviceId 不能直接信任。
      // 统一按后端记录 ID + 完整硬件 ID 找到同一台设备；扫描候选也会在 0x01 校验通过后才返回。
      deviceId = await activeDevice.ensureDeviceConnected(device, {
        showLoading: false
      })
      device = Object.assign({}, device, {
        deviceId,
        bleDeviceId: deviceId,
        connected: true
      })
      this._sessionDevice = device
      this._activeDeviceId = deviceId
      performance.phases.connectMs = Date.now() - phaseStartedAt
      this.setData({ desc: '正在读取电子纸设备信息…' })
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
        throw new Error('电子纸设备未连接，请检查手机或电子纸设备连接后继续')
      }

      // 设备空间：剩余可存张数 = 容量 - 已存张数（掩码置位数）。不再整单预检「够不够放下全部」，
      // 改为逐张尝试、放满为止：设备放满时下方 firstFreeIndex 返回 -1 抛「设备内存已满」，
      // 此前已成功的张数照常算「部分成功」跳成功页（对齐产品：内存差 N 张时能把 N 张投进去）。
      let usedIndexes = protocol.maskToIndexes(info.imgMask)
      const free = (info.capacity || 0) - usedIndexes.length
      console.log(
        `[投屏] 设备空间：容量 ${info.capacity}，已存 ${usedIndexes.length}，剩余 ${free}，待投 ${total}`
      )

      // 2) 逐张：抖动接口出帧 + 原图上传建记录（并行）→ 选空闲槽位 → 图传 → 设备成功才写投屏记录 → 刷新显示。
      // F1 校验：首张若已用设备记录尺寸早启动预取，此处对照 0x01 真实尺寸——不一致则作废重取
      //（后台在跑的旧转码结果直接丢弃）。
      if (
        framePrefetch[0] &&
        guessedSize &&
        (guessedSize.width !== info.width || guessedSize.height !== info.height)
      ) {
        console.warn(
          `[投屏] 设备记录尺寸(${guessedSize.width}x${guessedSize.height})与设备实际(${info.width}x${info.height})不一致，首张预取作废重取`
        )
        performance.firstPrefetchDiscarded = true
        framePrefetch[0] = null
      }
      startPrefetch(0, info) // 未早启动/已作废时从这里启动首张取帧；早启动过则为空操作

      // 第一张网络准备已启动；连接间隔优化与它并行，避免这些 BLE 控制指令继续挡住原图上传/转码。
      // 内含 0x05 回读探针（约 +300ms，被并行的网络准备吸收）：识别「设置成功≠真实生效」。
      phaseStartedAt = Date.now()
      try {
        performance.connectionInterval =
          await deviceBle.optimizeConnectionIntervalForTransfer(deviceId)
        const ci = performance.connectionInterval
        // 无条件下发 0x13 后，changed=false（传前读到的就是目标值）也可能没真生效——
        // 只看回读结果 verified/applied，别再拿 changed 当前置条件，否则这条告警会被吞掉。
        if (ci && ci.verified && !ci.applied) {
          // 手机系统拒绝了参数更新（iOS 常拒 <15ms）：链路仍跑在回读到的实际值上。
          // 提速方向：调试页把连接间隔同步成 ≥15ms 再试，而不是继续怀疑发送侧。
          console.warn(
            `[投屏] 连接间隔未真实生效：请求 ${ci.requested.ms}ms，链路实际 ${ci.current.ms}ms（iOS 常拒绝 <15ms 的请求）`
          )
        }
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
        const imagePerformance = {
          imageNumber: i + 1,
          acquireWaitMs: 0,
          recordMs: 0
        }
        performance.images.push(imagePerformance)
        // 每张传输前把进度条清零：本张从 0% 独立开始（批量传输时每张 0→100）。
        // 取帧可能仍在进行(首张 / 弱网)，先给「准备」文案；已预取就绪则 await 立即返回。
        this.ensureProgressAnimator().reset()
        this.setData({
          progressCurrent: i + 1,
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
            (acquired.error && acquired.error.message) || '电子纸设备帧准备失败'
          throw acquired.error
        }
        const { frameData, taskId, upirId, timings, prepared } = acquired.result
        imagePerformance.prepare = timings || {}
        // 本张帧一到手，立刻启动下一张的预取，让它与本张 BLE 图传并行
        startPrefetch(i + 1, info)
        const head = protocol.bytesToHex(frameData.subarray(0, 16))
        const expected4bpp = Math.ceil((info.width * info.height) / 2)
        console.log(
          `[投屏] 第 ${i + 1}/${total} 张 .bin=${frameData.length} 字节 头16=${head} 设备需六色4bpp=${expected4bpp} 字节`
        )
        // 字节数必须 = 六色4bpp(宽×高÷2)；对不上直接报清晰错误（设备会回含糊的「参数错误」），便于核对后端返回格式
        if (frameData.length !== expected4bpp) {
          throw new Error(
            `后端返回的不是电子纸设备要的六色4bpp帧：收到 ${frameData.length} 字节(头16=${head})，电子纸设备 ${info.width}×${info.height} 需要 ${expected4bpp} 字节`
          )
        }
        this.setData({ title: '图片传输中', desc: `正在投第 ${i + 1}/${total} 张…` })

        const index = protocol.firstFreeIndex(
          protocol.indexesToMask(usedIndexes),
          info.capacity
        )
        if (index < 0) {
          throw new Error('电子纸设备内存已满，请清理后继续。')
        }
        console.log(
          `[投屏] 第 ${i + 1}/${total} 张 图传(0x20)：index=${index} screenType=${info.screenType} ` +
            `${info.width}x${info.height} dataSize=${frameData.length}`
        )

        // 本张设备事务：只有 BLE 图传失败才回滚删掉刚传到设备的图、再向外抛出让整单判失败。
        // 图传成功后照片已物理写入相框，本张即算成功——后续写记录是后端记账，已与设备状态解耦。
        let summary
        try {
          summary = await deviceBle.uploadImage(deviceId, {
            screenType: info.screenType,
            index,
            width: info.width,
            height: info.height,
            data: frameData,
            // D1/D2：预取阶段算好的整图 CRC32 + 预组好的 0x21 帧（对不上会自动回退现算现组）
            prepared,
            traceId: performance.traceId,
            imageIndex: i,
            shouldAbort: () => this._aborted,
            // 进度更新（2026-08-14 改为逐格平滑）：
            // BLE 的真实进度天生跳变——固件每 10 包才回一次 0x23，窗口 50 包时一次应答推进几十包。
            // 这里只把**真实目标**喂给平滑器，由它按固定节拍逐格逼近（每格 1%，落后多时按比例追赶）。
            // 注意方向：不是提高刷新频率（那会让 setData 占住 JS 线程、推迟 0x23 处理，越刷越慢，
            // 正是图传性能档案里加节流的原因），而是**减小每次更新的幅度**——整场 setData 次数
            // ≈100 次，比原来「最多 8 次/秒」还少，观感却是连续增长的。
            onProgress: (done, totalPackets) => {
              const frac = totalPackets ? done / totalPackets : 0
              this.ensureProgressAnimator().setTarget(
                Math.min(100, Math.floor(frac * 100))
              )
            }
          })
          imagePerformance.ble = summary.transferStats || {}
          console.log(`[投屏] 第 ${i + 1}/${total} 张 设备图传成功`, summary)
        } catch (error) {
          imagePerformance.ble = (error && error.transferStats) || {}
          // 进度条就地冻结：失败时最后一段增量往往还没铺完，不冻结会在报错后继续往前爬，
          // 看起来像「还在传/已传成功」。停在真实确认到的那一格，不多画一分。
          this.ensureProgressAnimator().freeze()
          console.error(
            `[投屏] 第 ${i + 1}/${total} 张 设备图传失败，回滚 index=${index}：`,
            error
          )
          await this.rollbackDeviceImage(deviceId, index)
          throw error
        }

        // 设备图传成功 → 写后端投屏记录（editUserProductImgRecord 按 taskId 置成功）。
        // 尽力而为：记账失败只记日志，不回滚设备、不把整单判失败，避免设备已传成功却被误删/误判失败。
        // 记账放入并行队列，不挡住下一张 BLE。必须带上本张实际写入设备的槽位索引 index(imgIndex)：
        // 图库删除/刷新屏幕靠它定位相框上的物理位置，不上报的话这张图在图库里就成了「不知道在哪」的记录。
        // ⚠️ index 可能为 0（相框第一个位置），是合法值，勿按假值过滤。见 docs/decisions/image-slot-index.md。
        this.queueRecordTask(
          `第 ${i + 1}/${total} 张投屏记录写入失败`,
          async () => {
            await api.editUserProductImgRecord({
              upirId,
              taskId,
              deviceUploadState: 1,
              imgIndex: index,
              showError: false
            })
            console.log(
              `[投屏] 第 ${i + 1}/${total} 张 投屏记录已置成功：taskId=${taskId} imgIndex=${index}`
            )
          },
          imagePerformance
        )

        // 记下本批第一张成功写入的真实槽位（收尾那一次 0x24 用它），只记不刷。
        if (firstSuccessfulIndex === null) {
          firstSuccessfulIndex = index
        }
        // 该槽位记为已用，供下一张选空闲槽位
        usedIndexes = usedIndexes.concat(index)
        uploaded++
        // 本张传输完成：进度条直接置 100%（不再走递进动画，收尾要干脆），张数 +1（下一张从 0 开始）
        this.ensureProgressAnimator().jumpTo(100)
        this.setData({ progressCurrent: uploaded })
        // 本张帧数据(frameData+预组帧 prepared，5.89 寸两份合计 ≈660KB)传完即不再需要：
        // 立刻解除 framePrefetch[i] 的引用让其可被回收——此前整批传完前一直驻留，
        // 批量投屏峰值内存随张数线性涨。只清本张，第 i+1 张的在途预取不动。
        framePrefetch[i] = null

        // 刷屏(0x24)不在循环里发：中途刷屏会让部分固件断蓝牙、拖垮后续图片传输。
        // 统一由收尾的 scheduleFinalRefresh() 只发一次（见上方声明处的口径注释）。
      }

      // 整批传完 → 流程结束，按本批第一张成功的槽位刷一次屏。放在记账收敛(drain)之前排，
      // 免得设备刷屏白等一轮纯后端的网络请求。
      scheduleFinalRefresh()
      performance.phases.recordDrainMs = await this.drainRecordTasks()
      console.log(`[投屏] 全部完成：成功 ${uploaded}/${total} 张`)
      performance.outcome = 'success'
      this.finishProjection(device, { uploaded, failCount: 0, total, message: '' })
    } catch (error) {
      // 中途失败/中断同样是「投屏流程结束」：失败的那张已在上面回滚(0x12)，之前成功的几张仍
      // 物理留在设备上，照口径按第一张成功的槽位补这一次 0x24（一张都没成功则内部直接跳过）。
      // 链路已断/设备忙时这次刷屏会失败，失败被吞掉，不影响本单的成功/失败判定。
      scheduleFinalRefresh()
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
      // 投屏已收尾（成功/失败/中断都会走到这），解除返回拦截
      wx.disableAlertBeforeUnload && wx.disableAlertBeforeUnload({ fail: () => {} })
      // 不再传完即断：保持连接（设备单连接，下次投屏可直接复用、省去重新扫描+连接）。
      // 仅在物理断开(onBLEConnectionStateChange 清理)或用户手动断开时才真正断开。
      this._activeDeviceId = ''
      // 图传结束：把连接间隔从图传极速档(7.5/15ms)回落到省电的空闲档(100ms)。best-effort、不 await 收尾。
      // 若收尾刚触发了异步刷屏(0x24)，等它跑完再回落——刷屏期间设备对新指令回忙(0x0B)，挤在一起会白白失败；
      // 没有在途刷屏(一张都没成功)则立即回落。applyIdleConnectionInterval 内部已吞错、未连接会自行跳过。
      // ⚠️ 空闲省电档总开关(device-ble.IDLE_CONN_INTERVAL_ENABLED)当前为 false → 这里实际空转，
      // 传完后链路会一直停在图传极速档上。等刷屏的时序保留着，开关打开即恢复原行为。
      const resetIdleInterval = () =>
        deviceBle.applyIdleConnectionInterval(deviceId).catch(() => {})
      if (lastRefreshPromise) {
        lastRefreshPromise.then(resetIdleInterval, resetIdleInterval)
      } else {
        resetIdleInterval()
      }
    }
  },

  // 取本张要发给设备的六色 4bpp 帧 + 后端记录 id（2026-07-22 起帧由抖动接口生成，记录另路上传原图）。
  // 纯网络、无 UI 副作用：可被主循环「预取下一张」提前并行调用（见 runRealProjection 的预取流水线），
  // 页面文案/进度统一由主循环控制，避免预取抢占当前正在投屏那张的界面。i/total 仅用于日志。
  async acquireFrame(image, device, info, i, total) {
    const acquireStartedAt = Date.now()
    // （2026-07-23 起再次/重新投屏也走本链路：记录页带后端图片地址进预览，与手选图片无差别；
    //   旧「imgBle .bin 直传」分支已删除——后端不再生成 .bin。）
    // 两路网络并行，任一失败本张失败——
    //   · 设备帧：预览处理后的设备分辨率图 → 统一压缩 → 抖动接口出六色 4bpp 帧
    //     （不再下载后端转码的 .bin，客户端仍不做任何图像转换）；
    //   · 投屏记录：原图（进预览页前未操作过的图）→ 同一套统一压缩 → setUserProductUpload
    //     建记录拿 taskId(更新设备上传状态用) + upirId(投屏记录id)。
    // 注意：帧失败时记录可能已按「未成功(0)」建好，与旧链路「转码成功后图传失败」同态，无需回滚。
    const [record, dithered] = await Promise.all([
      this.uploadOriginalForRecord(image, device, info),
      this.fetchDitheringFrame(image, info)
    ])
    const prepared = await this.prepareTransfer(device, dithered.frameData)
    return {
      frameData: dithered.frameData,
      taskId: record.taskId,
      upirId: record.upirId,
      prepared: prepared.value,
      timings: Object.assign({}, record.timings, dithered.timings, prepared.timings, {
        acquireMs: Date.now() - acquireStartedAt
      })
    }
  },

  // 图传预处理（性能优化 D1/D2）：整图 CRC32 + 按会话分包大小预组全部 0x21 帧，放在预取阶段执行，
  // 与上一张的 BLE 传输/本张的网络下载重叠，把这两块纯计算从图传串行热路径上挪走。
  // 失败不阻断本张投屏（uploadImage 拿不到 prepared 会回退现算现组）；首张与连接并行预取时
  // 会话未就绪，只有 CRC32（frames=null），同样由 uploadImage 兜底。
  async prepareTransfer(device, frameData) {
    const startedAt = Date.now()
    try {
      const value = await deviceBle.prepareImageTransfer(device.deviceId, frameData)
      return { value, timings: { prepareMs: Date.now() - startedAt } }
    } catch (error) {
      console.warn('[投屏] 图传预处理失败，回退为传输时现算：', error)
      return { value: null, timings: { prepareMs: Date.now() - startedAt } }
    }
  },

  // 解析「原图」的本地路径（进预览页前未操作过的图）：预览页烘焙/裁切前把源备份在 _origSrc
  //（远程地址先落地再上传）；从未处理过的图（处理失败回退等）没有 _origSrc，就是图片本身。
  resolveOriginalLocalPath(image) {
    const orig = (image && image._origSrc) || ''
    if (orig && !/^https?:\/\//i.test(orig)) {
      return Promise.resolve(orig)
    }
    if (orig) {
      return this.downloadFileWithRetry(orig, '原图下载失败')
    }
    return this.resolveLocalFilePath(image)
  },

  // 本张的投屏记录上传（2026-07-22 起改传原图）：把「原图」统一压缩后传 setUserProductUpload，
  // 按「未成功(0)」建投屏记录，返回 { taskId、upirId }；设备图传成功后再 editUserProductImgRecord
  // 置 1（逻辑不变）。接口仍会转码并返回 .bin url，但已不再下载使用——设备帧改由抖动接口生成
  //（见 fetchDitheringFrame），这里只负责建记录与后端存图（图库/记录页展示的就是这张原图）。
  // 失败会抛出，让本张投屏判为失败（记录建不起来，设备成功了也没法记账）。
  async uploadOriginalForRecord(image, device, info) {
    const userProductId = device && (device.userProductId || device.id)
    const sourceResolveStartedAt = Date.now()
    const filePath = await this.resolveOriginalLocalPath(image)
    const sourceResolveMs = Date.now() - sourceResolveStartedAt
    if (!filePath) {
      throw new Error('图片文件不可用，无法上传')
    }

    // 压缩恒开（api.setUserProductUpload 固定传 isCompress=1 + compressSize=1024KB，后端把它存的图压到 1MB 上下）。
    // 注意 isCompress/compressSize 只约束后端存的图，管不到上传字节数——上传字节数由下面
    // compressForUpload 统一压缩（长边缩到设备长边）兜住；原图可能是高清大图，正靠它挡住 5s+ 的上传。
    // sourceBytes 就是用来盯这个的：uploadRecordMs 一旦变长，先看它是不是又变大了。
    const sourceBytes = await this.readFileSize(filePath)
    const shrunk = await this.compressForUpload(filePath, info, sourceBytes)
    console.log(
      `[投屏] 上传原图建记录：userProductId=${userProductId} target=${info.width}x${info.height} ` +
        `源图=${(sourceBytes / 1024).toFixed(0)}KB ` +
        `上传=${(shrunk.bytes / 1024).toFixed(0)}KB${shrunk.compressed ? `(已压缩 ${shrunk.compressMs}ms)` : '(未压缩)'} ` +
        `file=${shrunk.filePath}`
    )
    const uploadRecordStartedAt = Date.now()
    const res = await api.setUserProductUpload({
      filePath: shrunk.filePath,
      userProductId,
      targetWidth: info.width,
      targetHeight: info.height,
      deviceUploadState: 0,
      loading: false, // 结果页用 setData desc 自管进度，关掉全局 loading 遮罩
      showError: false // 失败统一走本页失败场景，不额外弹 toast
    })
    const uploadRecordMs = Date.now() - uploadRecordStartedAt

    // 单文件上传返回的就是该对象；保险起见也兼容数组返回
    const item = Array.isArray(res) ? res[0] : res
    console.log('[投屏] 上传接口返回：', item)
    if (!item || (item.taskId === undefined && item.upirId === undefined)) {
      throw new Error('服务器未返回投屏记录')
    }
    return {
      taskId: item.taskId,
      upirId: item.upirId,
      timings: {
        sourceResolveMs,
        sourceBytes,
        uploadBytes: shrunk.bytes,
        compressMs: shrunk.compressMs,
        uploadRecordMs
      }
    }
  },

  // 本张的设备帧（2026-07-22 起）：预览处理后的图（已是设备分辨率）→ 与记录上传同一套统一压缩
  //（compressForUpload 对「已不大于设备尺寸」的图原样通过，不会二次降质/改尺寸）→ 抖动接口出
  // 六色 4bpp 帧。字节数是否 = 宽×高÷2 由主循环铁闸校验，错帧绝不会发往设备。
  async fetchDitheringFrame(image, info) {
    const filePath = await this.resolveLocalFilePath(image)
    if (!filePath) {
      throw new Error('图片文件不可用，无法转换')
    }
    const sourceBytes = await this.readFileSize(filePath)
    const shrunk = await this.compressForUpload(filePath, info, sourceBytes)
    const ditherStartedAt = Date.now()
    const frameData = await dithering.requestFrameBin({
      filePath: shrunk.filePath,
      type: dithering.typeForDevice(info)
    })
    return {
      frameData,
      timings: {
        ditherUploadBytes: shrunk.bytes,
        ditherCompressMs: shrunk.compressMs,
        ditherMs: Date.now() - ditherStartedAt
      }
    }
  },

  // 统一的上传前压缩（2026-07-22 起两路上传共用）：把要上传的图长边缩到「设备长边」、只缩分辨率
  // 不改比例。两处调用：① fetchDitheringFrame 的处理图（已是设备分辨率 → 原样通过，不二次降质）；
  // ② uploadOriginalForRecord 的原图（高清大图靠它挡住 5s+ 的上传耗时）。
  // 返回 { filePath, bytes, compressMs, compressed }；任何失败都原样返回原文件，投屏不受影响。
  // 注意这只省「上传」的字节数，设备帧字节数(宽×高÷2)与源图无关，图传耗时一秒都不会变。
  async compressForUpload(filePath, info, sourceBytes) {
    const original = { filePath, bytes: sourceBytes, compressMs: 0, compressed: false }
    if (!wx.compressImage || !(Number(info.width) > 0) || !(Number(info.height) > 0)) {
      return original
    }

    const startedAt = Date.now()
    try {
      const size = await new Promise((resolve, reject) => {
        wx.getImageInfo({ src: filePath, success: resolve, fail: reject })
      })
      const longEdge = Math.max(size.width, size.height)
      const deviceLongEdge = Math.max(info.width, info.height)
      // 已不大于设备尺寸就别再缩/重压，免得白丢一道质（原样返回）
      if (!(longEdge > deviceLongEdge)) {
        return Object.assign({}, original, { compressMs: Date.now() - startedAt })
      }
      const ratio = deviceLongEdge / longEdge
      const compressed = await new Promise((resolve, reject) => {
        wx.compressImage({
          src: filePath,
          quality: UPLOAD_COMPRESS_QUALITY,
          compressedWidth: Math.max(1, Math.round(size.width * ratio)),
          compressedHeight: Math.max(1, Math.round(size.height * ratio)),
          success: resolve,
          fail: reject
        })
      })
      const bytes = await this.readFileSize(compressed.tempFilePath)
      const compressMs = Date.now() - startedAt
      // 压完反而更大/读不到大小：用原图，别赌
      if (!bytes || bytes >= sourceBytes) {
        return Object.assign({}, original, { compressMs })
      }
      return {
        filePath: compressed.tempFilePath,
        bytes,
        compressMs,
        compressed: true
      }
    } catch (error) {
      console.warn('[投屏] 上传前缩放失败，改用原图上传：', error)
      return Object.assign({}, original, { compressMs: Date.now() - startedAt })
    }
  },

  // 读上传源文件的字节数，纯性能观测用（uploadRecordMs/ditherMs 是否被大文件拖慢，一眼可见）。
  // 取不到就当 0，绝不阻断投屏。
  readFileSize(filePath) {
    return new Promise(resolve => {
      try {
        wx.getFileSystemManager().getFileInfo({
          filePath,
          success: res => resolve(Number(res.size) || 0),
          fail: () => resolve(0)
        })
      } catch (error) {
        resolve(0)
      }
    })
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

  // 「投屏明细」那一行的去处（2026-08-12 产品改口径）：由**投屏记录页**改成**我的相册**。
  // 刚投完屏的人想看的是「刚才那几张现在长什么样」，我的相册渲染的正是投屏成功的记录；
  // 投屏记录页（含失败记录 + 重新投屏）本身没下线，仍从「我的 → 我的相册」那条路进。
  // ⚠️ 行文案与右侧 n/n 计数没动：它说的是本次明细，与去哪一页是两回事。
  // 仍用 redirectTo（与改动前一致）：结果页是流程终点，不该留在返回栈里让人退回来。
  goAlbum() {
    wx.redirectTo({
      url: '/subpackages/album/list/list'
    })
  },

  // 「重新投屏」：回投屏预览页重新构图后再投（链路与首次投屏完全一致：抖动接口出帧 +
  // setUserProductUpload 建记录 + BLE 图传，旧「imgBle(.bin) 直传」分支已删除）。
  // ⚠️ 跳之前必须把 pendingProjection 里的图**还原成原图**：投屏时预览页已把「取景框内所见」
  // 烘焙成设备物理分辨率文件写回 tempFilePath（preview.js _applyBakedFile），直接跳回去会把这张
  // **成品图**当成新的编辑底图：
  //   · 竖向 → 成品已按设备 verticalRotation 转过（2026-08-04 起，缺省 0°），拿它二次裁剪/旋转
  //     会方向错误且越编越糊；
  //   · 横向 → 成品是转过 rotationDegree(默认 270°) 进竖向画布的文件，而编辑层按竖向重新起
  //     （_states 随页面重建已清空），用户看到的是躺倒的画面，再导出还会再转一次 → 设备上必然错位。
  retry() {
    this.restorePendingOriginals()
    wx.redirectTo({
      url: '/subpackages/projection/preview/preview'
    })
  },

  // 把 pendingProjection.images 逐张还原成「进预览页前的原图」，口径与预览页「原图」按钮
  //（preview.js restoreOrigin）保持一致：图源回 _origSrc、清掉裁剪尺寸与展示样式、作废预览缓存。
  // 上一轮的构图（缩放/平移/旋转/横竖向）不丢——预览页会按 pendingProjection.editStates 原样恢复，
  // 用户不用重新构图，但底图已经是原图，随手一改就是从原图重新出图。
  // 失败静默：还原不了也要让「重新投屏」跳得过去（大不了是回到旧行为）。
  restorePendingOriginals() {
    try {
      const pending = wx.getStorageSync('pendingProjection') || {}
      const images = pending.images || []
      if (!images.length) {
        return
      }
      pending.images = images.map(image => {
        const updated = Object.assign({}, image)
        // 原图是远程地址（再次投屏的云端图）时清空 tempFilePath 回落到 url：
        // 把 https 地址塞进 tempFilePath，本页会当本地文件上传（必失败）
        if (updated._origSrc) {
          updated.tempFilePath = /^https?:\/\//i.test(updated._origSrc) ? '' : updated._origSrc
        }
        updated.cropW = 0
        updated.cropH = 0
        updated.wrapStyle = ''
        updated.imgStyle = ''
        updated.previewSrc = ''
        updated._bakedKey = ''
        return updated
      })
      wx.setStorageSync('pendingProjection', pending)
    } catch (error) {
      console.warn('[投屏] 重新投屏还原原图失败，按原样跳预览页：', error)
    }
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
      toast.warn({ title: '未找到可投屏的电子纸设备', icon: 'none' })
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
}))
