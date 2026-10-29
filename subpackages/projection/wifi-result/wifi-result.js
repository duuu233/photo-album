const api = require('../../../utils/api')
const system = require('../../../utils/system')
const fold = require('../../../utils/fold-adapt')
const dithering = require('../../../utils/dithering')
const wifiProjection = require('../../../utils/wifi-projection')
const config = require('../../../utils/config')

// WiFi 版投屏结果页（2026-10-27，对接进度 STEP 3）：预览页构图导出后 redirectTo 到这里（蓝牙版去 result 页）。
// 逐张调 utils/wifi-projection.projectOne：图片上传中 → 图片处理中（两段合占进度条 0~99%）→ 接口返回成功才到 100%。
// V1.4（docs/wifi/XT相框通讯协议_V1.4_更新说明.md 第二节）起不再等设备 ack：返回 SENT 就提示「已发送，屏幕即将刷新」，
// 设备真正的成功 / 失败由服务端写消息通知。
// 多张按顺序一张一张传：本轮最后一张 refresh=true（刷屏），前面的 refresh=false（只上传、返回 UPLOADED、不刷屏），
// 整批只刷一次屏（更新说明 2.4）。重试时同样按「本轮最后一张刷屏」。
// 每张拿到 binUrl 后写老服务相册记录（api.addWifiAlbumRecord，img + imgBle），「我的上传」、轮播选图、删除都靠它；
// 写记录失败不算投屏失败，只在这一张的文案后注明「未存入我的上传」并记日志。
// 结束后：全部成功只给「完成」；有失败给「重试未成功的」+「完成」。
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

function downloadToLocal(url) {
  return new Promise((resolve, reject) => {
    wx.downloadFile({
      url,
      success: res => (res.statusCode === 200 && res.tempFilePath ? resolve(res.tempFilePath) : reject(new Error('原图下载失败'))),
      fail: () => reject(new Error('原图下载失败'))
    })
  })
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

Page(fold.adapt({
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
      items: this.images.map((image, index) => ({ key: index, src: imageSrc(image), status: 'pending', text: '等待投屏' })),
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

  // 写老服务相册记录（img + imgBle）。失败只记日志、返回 false，不影响投屏结果
  async saveAlbumRecord(filePath, binUrl) {
    const device = this.device || {}
    const userProductId = device.userProductId || device.id
    if (!binUrl || !userProductId) {
      this.appendLog(`相册记录：跳过（${binUrl ? '' : '接口没返回 binUrl'}${userProductId ? '' : ' 设备没有 userProductId'}）`)
      return false
    }
    this.appendLog(`接口【写相册记录】setFileUpload + addUserProductImgRecord 参数 ${JSON.stringify({ userProductId, imgBle: binUrl })}`)
    try {
      const saved = await api.addWifiAlbumRecord({ userProductId, filePath, imgBle: binUrl })
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
      this.setItem(index, { status: 'running', text: '投屏中' })
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
        const saved = await this.saveAlbumRecord(filePath, result.binUrl)
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

  finish() {
    wx.navigateBack({
      fail() {
        wx.switchTab({ url: '/pages/home/home' })
      }
    })
  }
}))
