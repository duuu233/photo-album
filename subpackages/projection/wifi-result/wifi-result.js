const system = require('../../../utils/system')
const fold = require('../../../utils/fold-adapt')
const dithering = require('../../../utils/dithering')
const wifiProjection = require('../../../utils/wifi-projection')

// WiFi 版投屏结果页（2026-10-27，对接进度 STEP 3）：预览页构图导出后 redirectTo 到这里（蓝牙版去 result 页）。
// 逐张调 utils/wifi-projection.projectOne：上传进度条 0~100（真实上传进度），之后按阶段文案推进
//（图片处理中 → 指令已下发 → 屏幕即将刷新 → 设备刷屏中 → 终态）。多张按顺序一张一张投，每张走完再投下一张。
// 结束后：全部成功只给「完成」；有失败 / 超时 / 结果未知给「重试未成功的」+「完成」。
// 投屏记录（setUserProductUpload / 相册归属）WiFi 版尚未确定口径（评审回复：需产品 / 老服务确认），本页不写记录。
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
    items: [], // [{ key, src, status: pending/running/SUCCESS/FAILED/TIMEOUT/UNKNOWN, text }]
    successCount: 0,
    retryable: false
  },

  onLoad() {
    this.setData(system.getLayoutMetrics())
    const pending = wx.getStorageSync('pendingProjection') || {}
    this.device = pending.device || null
    this.images = (pending.images || []).filter(image => imageSrc(image))
    this.setData({
      deviceName: (this.device && (this.device.name || this.device.productName)) || '',
      total: this.images.length,
      items: this.images.map((image, index) => ({ key: index, src: imageSrc(image), status: 'pending', text: '等待投屏' }))
    })
    if (!this.device || !this.images.length) {
      this.setData({ phase: 'done', stageText: '投屏信息已失效，请返回重新选择' })
      return
    }
    this.run(this.images.map((image, index) => index))
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

  // 按顺序投 indexes 里的这些张
  async run(indexes) {
    this.setData({ phase: 'running', retryable: false })
    if (wx.setKeepScreenOn) {
      wx.setKeepScreenOn({ keepScreenOn: true })
    }
    const device = this.device
    const deviceNo = device.productDeviceId || device.deviceNo
    // type 与蓝牙版抖动出帧同口径：480×720 传 1，其余 0（评审回复 8.1）
    const type = dithering.typeForDevice(device)
    for (let n = 0; n < indexes.length; n += 1) {
      if (this.unloaded) {
        return
      }
      const index = indexes[n]
      this.setData({ current: index, progress: 0, stageText: '图片上传中' })
      this.setItem(index, { status: 'running', text: '投屏中' })
      let result
      try {
        const filePath = await resolveLocalFile(this.images[index])
        result = await wifiProjection.projectOne({
          deviceNo,
          filePath,
          type,
          isCancelled: () => this.unloaded,
          onStage: ({ text, progress }) => {
            if (!this.unloaded) {
              this.setData({ stageText: text, progress })
            }
          }
        })
      } catch (error) {
        result = { status: 'FAILED', message: (error && error.message) || '投屏失败' }
      }
      if (this.unloaded || result.status === 'CANCELLED') {
        return
      }
      this.setItem(index, { status: result.status, text: result.message || result.text || '' })
      this.setData({ stageText: result.message || result.text || '' })
    }
    const successCount = this.data.items.filter(item => item.status === 'SUCCESS').length
    const total = this.data.items.length
    this.setData({
      phase: 'done',
      successCount,
      retryable: successCount < total,
      stageText: successCount === total ? '投屏成功' : successCount ? `成功 ${successCount} 张，${total - successCount} 张未成功` : this.data.stageText
    })
    if (wx.setKeepScreenOn) {
      wx.setKeepScreenOn({ keepScreenOn: false })
    }
  },

  // 重试未成功的（失败 / 超时 / 结果未知）。超时已在 projectOne 里等过 3 秒并查过一次最终状态，这里可直接重投
  retryFailed() {
    if (this.data.phase !== 'done') {
      return
    }
    const indexes = this.data.items.filter(item => item.status !== 'SUCCESS').map(item => item.key)
    if (indexes.length) {
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
