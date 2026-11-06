const api = require('../../../utils/api')
const tapGuard = require('../../../utils/tap-guard')
const system = require('../../../utils/system')
const fold = require('../../../utils/fold-adapt')
const dithering = require('../../../utils/dithering')
const wifiProjection = require('../../../utils/wifi-projection')
const config = require('../../../utils/config')
const media = require('../../../utils/media')
const toast = require('../../../utils/toast')

// WiFi 版投屏结果页（2026-10-27，对接进度 STEP 3）：预览页构图导出后 redirectTo 到这里（蓝牙版去 result 页）。
// 逐张调 utils/wifi-projection.projectOne：图片上传中 → 图片处理中（两段合占进度条 0~99%）→ 接口返回成功才到 100%。
// V1.4（docs/wifi/XT相框通讯协议_V1.4_更新说明.md 第二节）起不再等设备 ack：返回 SENT 就提示「已发送，屏幕即将刷新」，
// 设备真正的成功 / 失败由服务端写消息通知。
// 多张按顺序一张一张传：本轮最后一张 refresh=true（刷屏），前面的 refresh=false（只上传、返回 UPLOADED、不刷屏），
// 整批只刷一次屏（更新说明 2.4）。重试时同样按「本轮最后一张刷屏」。
// 每张拿到 binUrl 后写老服务相册记录（api.addWifiAlbumRecord，img + imgBle），「我的上传」、轮播选图、删除都靠它；
// 写记录失败不算投屏失败，只在这一张的文案后注明「未存入我的上传」并记日志。
// 记录的 img 存原图（2026-11-06）：投屏用的那张是预览页按设备 verticalRotation / rotationDegree 转过的成品，
// 竖向 180° 的机型（如 IJ_101）存进去，「我的上传」和轮播选图就是倒的；与蓝牙版结果页（uploadOriginalForRecord）同口径，
// 改存进预览页前的原图（_origSrc），长边缩到设备长边。见 saveAlbumRecord / recordImageFile。
// 结束后两个按钮，与蓝牙版结果页一致（2026-11-05，docs/wifi/前端对接文档20261105.md 第一节第 10 项）：
//   全部成功 →「再投一张」（当前页弹拍照 / 相册，选图后同一台设备进预览页）+「返回首页」；
//   有失败 →「重试未成功的」+「返回首页」。
// 同时加入轮播（2026-10-27 追加内容第二节）：预览页勾了「同时加入轮播」时 pendingProjection.addToCarousel=true，
// 每张（含只上传的）都带 addToCarousel=true；有任何一张成功投出但 carouselUpdated=false，结束后在结果下方追加
// 「未成功加入轮播，请前往轮播设置添加」；true / null 不额外提示。相册记录照常写（全部相册轮播靠它才拉得到这张）。
// 投屏日志（2026-10-27，与当初配网日志同款）：开发版 / 体验版在页面下方显示、可一键复制；正式版不显示，只打控制台 [WiFi投屏]。
// 渲染模式 renderMode（2026-10-28）：首轮投屏前按设备取一次后台产品配置（api.resolveRenderMode），每张原样带上，重试复用。
// type 同日改取产品屏幕方向 screenType（api.resolveScreenType），同样只查一次。
// 本页记设备信息（尺寸 / 旋转字段，排查横竖向用）与每张图上传前的像素尺寸、文件大小；接口与 WS 过程由 projectOne 的 onLog 给出。
// 重试不清空，一次进页面的全部过程都在一份日志里。
const LOG_LIMIT = 500
const CAROUSEL_FAILED_TIP = '未成功加入轮播，请前往轮播设置添加'

function showLogPanel() {
  try {
    return wx.getAccountInfoSync().miniProgram.envVersion !== 'release'
  } catch (error) {
    return false
  }
}

// 上传前那张图的真实像素与大小（日志用，取不到写 ?，不影响投屏）
function describeFile(filePath) {
  const imageInfo = new Promise(resolve => {
    wx.getImageInfo({
      src: filePath,
      success: res => resolve(`${res.width}×${res.height}`),
      fail: () => resolve('?×?')
    })
  })
  const fileSize = new Promise(resolve => {
    try {
      wx.getFileSystemManager().getFileInfo({
        filePath,
        success: res => resolve(`${Math.round((res.size || 0) / 1024)}KB`),
        fail: () => resolve('?KB')
      })
    } catch (error) {
      resolve('?KB')
    }
  })
  return Promise.all([imageInfo, fileSize]).then(([size, bytes]) => `${size}，${bytes}`)
}
// SENT（已下发刷屏）与 UPLOADED（只上传）都算这一张成功
function isSent(status) {
  return status === 'SENT' || status === 'UPLOADED'
}

// 结束文案：全部成功按张数给「已发送，屏幕即将刷新」；部分成功报张数；全失败沿用最后一张的失败原因
function doneText(successCount, total, lastText) {
  if (successCount === total) {
    return total > 1 ? `已发送 ${total} 张，屏幕即将刷新` : '已发送，屏幕即将刷新'
  }
  return successCount ? `成功 ${successCount} 张，${total - successCount} 张未成功` : lastText
}

function imageSrc(image) {
  return (image && (image.tempFilePath || image.url)) || ''
}

// 逐张列表缩略图（2026-11-06）：用原图 _origSrc，与「我的上传」记录图同方位。
// tempFilePath 是预览页按设备 verticalRotation / rotationDegree 转过的投屏图，竖向 180° 的机型（如 IJ_101）显示是倒的
function thumbSrc(image) {
  return (image && image._origSrc) || imageSrc(image)
}

// 逐张列表文案跟着进度条阶段走（2026-11-06）：「图片上传中」→「上传中」、「图片处理中」→「处理中」，不再统一叫「投屏中」
function itemStageText(stageText) {
  return String(stageText || '').replace(/^图片/, '') || '处理中'
}

function downloadToLocal(url) {
  return new Promise((resolve, reject) => {
    wx.downloadFile({
      url,
      success: res => (res.statusCode === 200 && res.tempFilePath ? resolve(res.tempFilePath) : reject(new Error('原图下载失败'))),
      fail: () => reject(new Error('原图下载失败'))
    })
  })
}

// 相册记录用图（2026-11-06）：与蓝牙版结果页 resolveOriginalLocalPath + compressForUpload 同口径——
// 取预览页烘焙 / 导出前备份的原图 _origSrc（云端地址先下载），长边缩到设备长边、不改比例（质量 90，已不大于就原样）。
// 没有 _origSrc（预览页没处理过，发出去的就是原图本身）或原图下载失败，退回投屏用的那张；缩放失败用未缩的原图。
// 返回 { filePath, source }，source 只进日志。
const RECORD_COMPRESS_QUALITY = 90

function resolveRecordSource(image, projectedPath) {
  const orig = (image && image._origSrc) || ''
  if (!orig) {
    return Promise.resolve({ filePath: projectedPath, source: '投屏图（预览页未处理，即原图）' })
  }
  if (!/^https?:\/\//i.test(orig)) {
    return Promise.resolve({ filePath: orig, source: '原图' })
  }
  return downloadToLocal(orig).then(
    filePath => ({ filePath, source: '原图（云端图已下载）' }),
    () => ({ filePath: projectedPath, source: '投屏图（原图下载失败）' })
  )
}

function shrinkToDevice(filePath, device) {
  const deviceLongEdge = Math.max(Number(device && device.width) || 0, Number(device && device.height) || 0)
  if (!filePath || !(deviceLongEdge > 0) || typeof wx.getImageInfo !== 'function' || typeof wx.compressImage !== 'function') {
    return Promise.resolve(filePath)
  }
  return new Promise(resolve => {
    try {
      wx.getImageInfo({
        src: filePath,
        success: size => {
          const longEdge = Math.max(Number(size.width) || 0, Number(size.height) || 0)
          if (!(longEdge > deviceLongEdge)) {
            resolve(filePath)
            return
          }
          const ratio = deviceLongEdge / longEdge
          try {
            wx.compressImage({
              src: filePath,
              quality: RECORD_COMPRESS_QUALITY,
              compressedWidth: Math.max(1, Math.round(size.width * ratio)),
              compressedHeight: Math.max(1, Math.round(size.height * ratio)),
              success: res => resolve((res && res.tempFilePath) || filePath),
              fail: () => resolve(filePath)
            })
          } catch (error) {
            resolve(filePath)
          }
        },
        fail: () => resolve(filePath)
      })
    } catch (error) {
      resolve(filePath)
    }
  })
}

async function recordImageFile(image, projectedPath, device) {
  const picked = await resolveRecordSource(image, projectedPath)
  const filePath = await shrinkToDevice(picked.filePath, device)
  return { filePath, source: picked.source }
}

// 本地图直接用；只有 https 地址的（再次投屏的云端图）先下载到本地再上传
function resolveLocalFile(image) {
  const local = image && image.tempFilePath
  if (local) {
    return Promise.resolve(local)
  }
  const remote = image && image.url
  if (remote && /^https?:\/\//i.test(remote)) {
    return downloadToLocal(remote)
  }
  return Promise.resolve(remote || '')
}

Page(fold.adapt(tapGuard.wrap({
  data: {
    statusBarHeight: 20,
    safeBottom: 0,
    deviceName: '',
    phase: 'running', // running / done
    current: 0, // 正在投第几张（从 0 起）
    total: 0,
    stageText: '准备投屏',
    progress: 0,
    items: [], // [{ key, src, status: pending / running / SENT / UPLOADED / FAILED, text }]
    successCount: 0,
    retryable: false,
    carouselTip: '',
    canContinue: false,
    showMediaSheet: false,
    mediaSheetClosing: false,
    showLog: false,
    logs: [],
    logAnchor: ''
  },

  onLoad() {
    this.setData(system.getLayoutMetrics())
    const pending = wx.getStorageSync('pendingProjection') || {}
    this.device = pending.device || null
    this.images = (pending.images || []).filter(image => imageSrc(image))
    this.addToCarousel = pending.addToCarousel === true
    this.setData({
      deviceName: (this.device && (this.device.name || this.device.productName)) || '',
      total: this.images.length,
      items: this.images.map((image, index) => ({ key: index, src: thumbSrc(image), status: 'pending', text: '等待投屏' })),
      canContinue: !!this.device,
      showLog: showLogPanel()
    })
    if (!this.device || !this.images.length) {
      this.appendLog(`投屏信息已失效：${this.device ? '' : '没有设备'}${this.images.length ? '' : ' 没有图片'}`)
      this.setData({ phase: 'done', stageText: '投屏信息已失效，请返回重新选择' })
      return
    }
    const d = this.device
    this.appendLog(`IoT 服务 ${config.iotBaseURL}，共 ${this.images.length} 张${this.addToCarousel ? '，同时加入轮播' : ''}`)
    this.appendLog(
      `设备：${d.name || '-'}，deviceNo ${d.productDeviceId || d.deviceNo || '-'}，broadcastId ${d.broadcastId || '-'}，` +
        `尺寸 ${d.sizeModel || '-'}，接口宽高 ${d.width || '-'}×${d.height || '-'}，` +
        `rotationDegree ${d.rotationDegree === undefined ? '-' : d.rotationDegree}，verticalRotation ${d.verticalRotation === undefined ? '-' : d.verticalRotation}`
    )
    this.run(this.images.map((image, index) => index))
  },

  // 追加一行投屏日志（带时分秒毫秒）；只在显示日志面板时写页面数据
  appendLog(text) {
    if (this.unloaded || !this.data.showLog) {
      return
    }
    const now = new Date()
    const pad = (n, len) => String(n).padStart(len || 2, '0')
    this._logId = (this._logId || 0) + 1
    const line = { id: `log${this._logId}`, text: `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)} ${text}` }
    this.setData({ logs: this.data.logs.concat(line).slice(-LOG_LIMIT), logAnchor: line.id })
  },

  // 复制全部日志，方便发给开发对照
  copyLogs() {
    const text = this.data.logs.map(line => line.text).join('\n')
    if (!text) {
      return
    }
    wx.setClipboardData({ data: text })
  },

  onUnload() {
    this.unloaded = true
    if (wx.setKeepScreenOn) {
      wx.setKeepScreenOn({ keepScreenOn: false })
    }
  },

  setItem(index, patch) {
    if (this.unloaded) {
      return
    }
    const item = Object.assign({}, this.data.items[index], patch)
    this.setData({ [`items[${index}]`]: item })
  },

  // 写老服务相册记录（img + imgBle）。失败只记日志、返回 false，不影响投屏结果。
  // img 传原图（2026-11-06，见 recordImageFile），不传 projectedPath（已按设备旋转角转过）；imgBle 仍是这次投屏的 binUrl
  async saveAlbumRecord(image, projectedPath, binUrl) {
    const device = this.device || {}
    const userProductId = device.userProductId || device.id
    if (!binUrl || !userProductId) {
      this.appendLog(`相册记录：跳过（${binUrl ? '' : '接口没返回 binUrl'}${userProductId ? '' : ' 设备没有 userProductId'}）`)
      return false
    }
    this.appendLog(`接口【写相册记录】setFileUpload + addUserProductImgRecord 参数 ${JSON.stringify({ userProductId, imgBle: binUrl })}`)
    try {
      const record = await recordImageFile(image, projectedPath, device)
      this.appendLog(`相册记录用图：${record.source} ${record.filePath}`)
      const saved = await api.addWifiAlbumRecord({ userProductId, filePath: record.filePath, imgBle: binUrl })
      this.appendLog(`返回 img=${saved.img}`)
      return true
    } catch (error) {
      this.appendLog(`失败 ${(error && (error.message || error.errMsg)) || error}`)
      return false
    }
  },

  // 按顺序投 indexes 里的这些张：本轮最后一张刷屏，前面的只上传
  async run(indexes) {
    this.setData({ phase: 'running', retryable: false, carouselTip: '' })
    if (wx.setKeepScreenOn) {
      wx.setKeepScreenOn({ keepScreenOn: true })
    }
    const device = this.device
    const deviceNo = device.productDeviceId || device.deviceNo
    // type 取后台产品配置的屏幕方向 screenType（0=竖屏、1=横屏）原样传（2026-10-28），与 renderMode 一样只查一次、重试复用；
    // 产品没配 / 查不到才按分辨率回退旧口径（480×720 传 1，其余 0）
    if (this.screenTypeValue === undefined) {
      const screenType = await api.resolveScreenType(device)
      this.screenTypeValue = screenType || dithering.typeForDevice(device)
      this.appendLog(
        `type=${this.screenTypeValue}（${screenType ? '产品屏幕方向 screenType' : '产品未配置 screenType，按分辨率回退'}）`
      )
    }
    const type = this.screenTypeValue
    if (this.renderMode === undefined) {
      this.renderMode = await api.resolveRenderMode(device)
      this.appendLog(`渲染模式 renderMode=${this.renderMode || '（产品未配置，不传）'}`)
    }
    for (let n = 0; n < indexes.length; n += 1) {
      if (this.unloaded) {
        return
      }
      const index = indexes[n]
      const refresh = n === indexes.length - 1
      this.setData({ current: index, progress: 0, stageText: '图片上传中' })
      this.setItem(index, { status: 'running', text: itemStageText('图片上传中') })
      let result
      let filePath = ''
      try {
        const image = this.images[index]
        this.appendLog(`—— 第 ${index + 1} / ${this.images.length} 张${refresh ? '（本轮最后一张，刷屏）' : '（只上传，不刷屏）'} ——`)
        filePath = await resolveLocalFile(image)
        if (this.data.showLog) {
          this.appendLog(
            `图片：${filePath}，取景 ${image.exportOrientation || '-'}，导出角 ${image.exportRotation === undefined ? '-' : image.exportRotation}°，` +
              `导出记录 ${image.cropW || '-'}×${image.cropH || '-'}，实际 ${await describeFile(filePath)}` +
              `${image.tempFilePath ? '' : '（云端图已下载到本地）'}`
          )
        }
        result = await wifiProjection.projectOne({
          deviceNo,
          filePath,
          type,
          renderMode: this.renderMode,
          refresh,
          addToCarousel: this.addToCarousel,
          isCancelled: () => this.unloaded,
          onLog: text => this.appendLog(text),
          onStage: ({ text, progress }) => {
            if (!this.unloaded) {
              this.setData({ stageText: text, progress })
              // 这一张还在进行中时，列表文案跟着阶段变（上传中 / 处理中）
              if (this.data.items[index] && this.data.items[index].status === 'running' && this.data.items[index].text !== itemStageText(text)) {
                this.setItem(index, { text: itemStageText(text) })
              }
            }
          }
        })
      } catch (error) {
        result = { status: 'FAILED', message: (error && error.message) || '投屏失败' }
        this.appendLog(`投屏前出错：${result.message}`)
      }
      if (this.unloaded || result.status === 'CANCELLED') {
        return
      }
      let text = result.message || result.text || ''
      // 写相册记录时不改阶段文案：100% 只显示「已发送，屏幕即将刷新」（2026-10-29），过程只进日志
      if (isSent(result.status)) {
        const saved = await this.saveAlbumRecord(this.images[index], filePath, result.binUrl)
        if (this.unloaded) {
          return
        }
        if (!saved) {
          text = `${text}（未存入我的上传）`
        }
      }
      // carouselFailed：这张投出去了但没加进轮播（只认 carouselUpdated=false）
      this.setItem(index, { status: result.status, text, carouselFailed: isSent(result.status) && result.carouselUpdated === false })
      this.setData({ stageText: text })
    }
    const successCount = this.data.items.filter(item => isSent(item.status)).length
    const total = this.data.items.length
    this.setData({
      phase: 'done',
      successCount,
      retryable: successCount < total,
      stageText: doneText(successCount, total, this.data.stageText),
      carouselTip: this.addToCarousel && this.data.items.some(item => isSent(item.status) && item.carouselFailed) ? CAROUSEL_FAILED_TIP : ''
    })
    if (wx.setKeepScreenOn) {
      wx.setKeepScreenOn({ keepScreenOn: false })
    }
  },

  // 重试未成功的（接口失败）：同样按「本轮最后一张刷屏」
  retryFailed() {
    if (this.data.phase !== 'done') {
      return
    }
    const indexes = this.data.items.filter(item => !isSent(item.status)).map(item => item.key)
    if (indexes.length) {
      this.appendLog(`重试未成功的：第 ${indexes.map(i => i + 1).join('、')} 张`)
      this.run(indexes)
    }
  },

  backHome() {
    wx.switchTab({ url: '/pages/home/home' })
  },

  // 「再投一张」：不跳首页，在当前页弹出「拍照 / 相册」二选一弹层（与蓝牙版结果页「继续投屏」同一做法）
  continueProjection() {
    if (!this.device) {
      return
    }
    this.setData({ showMediaSheet: true, mediaSheetClosing: false })
  },

  hideMediaSheet() {
    if (this.data.mediaSheetClosing) {
      return
    }
    this.setData({ mediaSheetClosing: true })
    setTimeout(() => {
      if (!this.unloaded) {
        this.setData({ showMediaSheet: false, mediaSheetClosing: false })
      }
    }, 220)
  },

  chooseCamera() {
    return this.pickAndContinue(() => media.chooseFromCamera())
  },

  chooseAlbum() {
    return this.pickAndContinue(() => media.chooseFromAlbum())
  },

  // 选图后用本次投屏的同一台设备进预览页构图；预览页认出 WiFi 版，导出后再回到本页。
  // 结果页是流程终点，用 redirectTo（与蓝牙版一致），不留在返回栈里。用户取消选择不报错、保留弹层
  async pickAndContinue(pickImages) {
    let images
    try {
      images = await pickImages()
    } catch (error) {
      if (error && error.errMsg && error.errMsg.indexOf('cancel') > -1) {
        return
      }
      toast.warn({ title: '选择照片失败', icon: 'none' })
      return
    }
    if (!images || !images.length || !this.device) {
      return
    }
    this.setData({ showMediaSheet: false, mediaSheetClosing: false })
    wx.setStorageSync('pendingProjection', { device: Object.assign({}, this.device, { isWifi: true }), images })
    wx.redirectTo({ url: '/subpackages/projection/preview/preview' })
  },

  noop() {}
}, { retryFailed: 'projection', continueProjection: 'projection', chooseCamera: 'pick', chooseAlbum: 'pick' })))
