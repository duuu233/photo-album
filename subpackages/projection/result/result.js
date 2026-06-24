// 投屏结果页：进入时（status=progress）真实连接设备并走 BLE 图传，进度条与张数为真实进度；
// 传完按真实结果切到「成功 / 失败」。链路与调试台一致：
//   连接 → 读真实设备信息(0x01) → 逐张：解码→量化六色帧→图传(0x20/0x21/0x22)→刷新显示(0x24)。
const system = require('../../../utils/system')
const api = require('../../../utils/api')
const deviceBle = require('../../../utils/device-ble')
const imageCodec = require('../../../utils/image-codec')
const protocol = require('../../../utils/frame-protocol')
const toast = require('../../../utils/toast')

// 真实投屏默认使用当前实机验证效果最好的参数：
// 1) 跳过 wx.compressImage，直接用原图进 canvas；
// 2) imageToImageData 内保持单步 drawImage 缩放；
// 3) 量化使用调试页「实拍 2026-06-22」校准档。
const PROJECTION_QUANTIZE_OPTIONS = {
  dither: true,
  contrast: 1.12,
  saturation: 1.28,
  palette: [
    { nibble: 0x0, rgb: [0, 0, 0], name: '黑' },
    { nibble: 0x1, rgb: [255, 255, 255], name: '白' },
    { nibble: 0x2, rgb: [255, 250, 0], name: '黄' },
    { nibble: 0x3, rgb: [97, 0, 0], name: '红' },
    { nibble: 0x5, rgb: [20, 56, 180], name: '蓝' },
    { nibble: 0x6, rgb: [57, 104, 57], name: '绿' }
  ]
}

const STATUS_TEXT = {
  progress: {
    title: '投屏中',
    desc: '投屏过程中请不要关闭手机'
  },
  success: {
    title: '投屏成功',
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

Page({
  data: {
    statusBarHeight: 20,
    safeBottom: 0,
    status: 'progress',
    title: '投屏中',
    desc: STATUS_TEXT.progress.desc,
    artImage: STATUS_ART.progress,
    deviceName: '相框',
    recordCount: 0,
    progressCurrent: 0,
    progressTotal: 0,
    progressPercent: 0
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
    wx.setKeepScreenOn && wx.setKeepScreenOn({ keepScreenOn: false })
    if (this._activeDeviceId) {
      deviceBle.disconnect(this._activeDeviceId) // 释放连接，让设备能重新被连接
    }
  },

  applyStatus(status, result) {
    const text = STATUS_TEXT[status] || STATUS_TEXT.progress
    this.setData({
      status,
      title: text.title,
      // 失败时优先显示真实失败原因
      desc: status === 'fail' && result.message ? result.message : text.desc,
      artImage: STATUS_ART[status] || STATUS_ART.progress,
      deviceName: result.deviceName || '相框',
      recordCount: result.imageCount || 0
    })
  },

  // 真实投屏主流程：连接 → 读设备信息 → 逐张解码并图传 → 按真实结果置成功/失败
  async runRealProjection() {
    const pending = wx.getStorageSync('pendingProjection') || {}
    const device = pending.device || {}
    // 只投有真实图片文件的照片（相册占位图 url 为空，无法图传）
    const images = (pending.images || []).filter(item => item && (item.tempFilePath || item.url))
    const deviceId = device.deviceId

    if (!deviceId) {
      this.failResult(device, 0, '设备未连接，请重新绑定后再投屏')
      return
    }
    if (!images.length) {
      this.failResult(device, 0, '没有可投屏的照片')
      return
    }

    this._aborted = false
    this._activeDeviceId = deviceId
    // 投屏期间保持屏幕常亮：避免息屏导致蓝牙被挂起、传输中断
    wx.setKeepScreenOn && wx.setKeepScreenOn({ keepScreenOn: true })

    const total = images.length
    this.setData({ progressTotal: total, progressCurrent: 0, progressPercent: 0 })

    let uploaded = 0
    try {
      // 1) 连接并读取真实设备信息（屏幕尺寸/类型/容量/已存掩码）
      await deviceBle.ensureConnection(deviceId)
      const info = await deviceBle.readDeviceInfo(deviceId)

      // v1.4 固件支持主动设置 BLE 连接间隔。图传前切到 30ms，可减少默认慢连接间隔造成的写入排队/卡顿。
      // 旧固件或链路暂不支持时继续走原有图传逻辑，避免把优化能力变成硬依赖。
      try {
        await deviceBle.optimizeConnectionIntervalForTransfer(deviceId)
      } catch (error) {
        // 不阻断投屏
      }

      if (info.screenType === 0x03 || !info.width || !info.height) {
        throw new Error('该型号暂不支持图传')
      }

      // 设备空间校验：剩余可存张数 = 容量 - 已存张数（掩码置位数）
      let usedIndexes = protocol.maskToIndexes(info.imgMask)
      const free = (info.capacity || 0) - usedIndexes.length
      if (free < total) {
        throw new Error(`设备空间不足：剩余 ${Math.max(0, free)} 张，待投 ${total} 张`)
      }

      // 2) 逐张：解码到目标尺寸 → 量化成六色帧 → 选空闲槽位 → 图传 → 刷新显示
      for (let i = 0; i < total; i++) {
        if (this._aborted) {
          throw new Error('UPLOAD_ABORTED')
        }
        const image = images[i]
        this.setData({ desc: `正在投第 ${i + 1}/${total} 张…` })

        const srcPath = image.tempFilePath || image.url
        const imageData = await this.imageToImageData(srcPath, info.width, info.height)
        const frame = imageCodec.fromImageData(imageData, info.width, info.height, PROJECTION_QUANTIZE_OPTIONS)

        const index = protocol.firstFreeIndex(protocol.indexesToMask(usedIndexes), info.capacity)
        if (index < 0) {
          throw new Error('设备已存满')
        }

        // 本张事务：设备图传(BLE) + 后端上传(api) 二者都成功才保留；任一步失败 →
        // 回滚删掉本张刚传到设备的图，再向外抛出让整体判失败（满足「二边都成功才算成功」）。
        try {
          await deviceBle.uploadImage(deviceId, {
            screenType: info.screenType,
            index,
            width: info.width,
            height: info.height,
            data: frame.data,
            shouldAbort: () => this._aborted,
            // 单张内的分包进度叠加已完成张数 → 整体百分比，进度条平滑推进
            onProgress: (done, totalPackets) => {
              const frac = totalPackets ? done / totalPackets : 0
              const percent = Math.min(100, Math.floor(((i + frac) / total) * 100))
              this.setData({ progressPercent: percent })
            }
          })

          // 后端上传失败现在会抛出（不再吞掉），从而触发本张回滚
          await this.syncUploadedImage(device, image)
        } catch (error) {
          await this.rollbackDeviceImage(deviceId, index)
          throw error
        }

        // 传完顺手刷新到这张（失败不影响整体）；并把该槽位记为已用，供下一张选槽位
        try {
          await deviceBle.refreshScreen(deviceId, index)
        } catch (error) {
          // 刷新失败不阻断
        }
        usedIndexes = usedIndexes.concat(index)
        uploaded++
        this.setData({
          progressCurrent: uploaded,
          progressPercent: Math.floor((uploaded / total) * 100)
        })
      }

      this.successResult(device, uploaded)
    } catch (error) {
      const aborted = this._aborted || (error && error.message === 'UPLOAD_ABORTED')
      const message = aborted
        ? '投屏已中断：上传时手机息屏/切到后台，蓝牙会被挂起。请保持亮屏后重新投屏。'
        : (error && error.message) || '投屏失败'
      this.failResult(device, uploaded, message)
    } finally {
      wx.setKeepScreenOn && wx.setKeepScreenOn({ keepScreenOn: false })
      deviceBle.disconnect(deviceId) // 传完/失败都断开，释放连接
      this._activeDeviceId = ''
    }
  },

  // 后端上传本张照片记录。失败会抛出，让本张投屏判为失败并触发设备侧回滚
  //（与「设备 + 后端二边都成功才算成功」一致；旧逻辑曾吞掉错误，已去除）。
  async syncUploadedImage(device, image) {
    const filePath = image && (image.tempFilePath || image.url)
    const userProductId = device && (device.userProductId || device.id)

    // 远程 url（已是服务端图片）或缺 userProductId：本次无需/无法再传后端，按跳过处理，不阻断本张。
    if (!filePath || /^https?:\/\//i.test(filePath) || !userProductId) {
      return
    }

    await api.setUserProductUpload({
      filePath,
      userProductId,
      deviceUploadState: 1
    })
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

  successResult(device, count) {
    wx.removeStorageSync('pendingProjection') // 成功后清掉，避免重复投
    const result = { status: 'success', deviceName: device.name || '相框', imageCount: count }
    wx.setStorageSync('lastProjectionResult', result)
    this.applyStatus('success', result)
  },

  failResult(device, count, message) {
    // 失败保留 pendingProjection，便于「重新投屏」直接重试
    const result = { status: 'fail', deviceName: device.name || '相框', imageCount: count, message }
    wx.setStorageSync('lastProjectionResult', result)
    this.applyStatus('fail', result)
    if (message) {
      toast.show({ title: message, icon: 'none' })
    }
  },

  // 大图预压缩：原图长边明显大于目标显示尺寸时，按比例压一遍再解码，给离屏 canvas 解码减负。
  // 任何环节失败都退回原图，绝不阻断投屏。
  shrinkIfHuge(path, targetW, targetH) {
    return new Promise(resolve => {
      if (!wx.compressImage) {
        resolve(path)
        return
      }
      wx.getImageInfo({
        src: path,
        success: ({ width, height }) => {
          // 长边上限取「目标长边 ×2.5」并兜底 1600：给目标分辨率留 2 倍以上过采样(下采样越多越锐)，
          // 同时把超大图(12MP+)的解码内存压住。只有真超过上限才预缩，普通手机照片原样通过。
          const maxEdge = Math.max(1600, Math.round(Math.max(targetW, targetH) * 2.5))
          const srcMax = Math.max(width, height)
          if (!srcMax || srcMax <= maxEdge) {
            resolve(path)
            return
          }
          const scale = maxEdge / srcMax
          wx.compressImage({
            src: path,
            compressedWidth: Math.round(width * scale),
            compressedHeight: Math.round(height * scale),
            quality: 92, // 仅超大图才会走到，质量拉高减少二次 JPEG 损失
            success: res => resolve(res.tempFilePath),
            fail: () => resolve(path)
          })
        },
        fail: () => resolve(path)
      })
    })
  },

  // 用离屏 canvas 把图片解码并缩放到目标尺寸，取出 RGBA 像素（ImageData）
  imageToImageData(path, width, height) {
    return new Promise((resolve, reject) => {
      if (!wx.createOffscreenCanvas) {
        reject(new Error('当前微信版本不支持离屏 canvas'))
        return
      }
      const canvas = wx.createOffscreenCanvas({ type: '2d', width, height })
      const ctx = canvas.getContext('2d')
      const img = canvas.createImage()
      img.onload = () => {
        ctx.clearRect(0, 0, width, height)
        // 开高质量缩放：大图一步缩到屏幕尺寸时默认平滑会发糊/锯齿，high 明显更锐(APP 用原生双线性)。
        ctx.imageSmoothingEnabled = true
        ctx.imageSmoothingQuality = 'high'
        // 中心裁剪「覆盖」(与 APP 的 centerCropCover 一致)：等比缩放铺满目标后从原图正中取，
        // 保持宽高比、不拉伸变形。用户在预览页手动裁过的图已是目标比例，这里几乎无裁切。
        const iw = img.width || width
        const ih = img.height || height
        const scale = Math.max(width / iw, height / ih)
        const sw = width / scale
        const sh = height / scale
        const sx = (iw - sw) / 2
        const sy = (ih - sh) / 2
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, width, height)
        try {
          resolve(ctx.getImageData(0, 0, width, height))
        } catch (error) {
          reject(error)
        }
      }
      img.onerror = () => reject(new Error('图片解码失败'))
      img.src = path
    })
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

  continueProjection() {
    wx.switchTab({
      url: '/pages/home/home'
    })
  }
})
