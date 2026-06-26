// 投屏结果页：进入时（status=progress）真实连接设备并走 BLE 图传，进度条与张数为真实进度；
// 传完按真实结果切到「成功 / 失败」。已改为「后端转换 + BLE 图传」链路（图片处理放到服务器，画质更稳）：
//   连接 → 读真实设备信息(0x01) → 逐张：
//     原图传后端转换(setUserProductUpload，得 .bin 下载地址 + taskId + upirId)
//     → 下载 .bin 帧数据 → 图传到设备(0x20/0x21/0x22)
//     → 设备成功才编辑投屏记录(editUserProductImgRecord 置 deviceUploadState=1) → 刷新显示(0x24)。
const system = require('../../../utils/system')
const api = require('../../../utils/api')
const deviceBle = require('../../../utils/device-ble')
const protocol = require('../../../utils/frame-protocol')
const toast = require('../../../utils/toast')

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

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ 【本地 .raw 直发测试】临时调试用，正式上线前请整块删除（见 docs/local-raw-test.md）║
// ╚══════════════════════════════════════════════════════════════════════════╝
// true：投屏不走「后端转换 + 下载 .bin」，改为把 assets/demo.raw 的字节原样发给设备，
//       用于真机直接验证某份「六色 4bpp 帧」的真实显示效果（朝向/颜色/裁剪）。测完改回 false 即走真实流程。
// 为什么内嵌 base64：小程序读不了代码包内任意文件，故 demo.raw 编译期编进 demo-raw-base64.js；
//       换别的 .raw 后执行 `node scripts/gen-demo-raw-base64.js` 重新生成。
// 注意：字节数必须 = 所连设备 宽×高÷2（EF6-370 480×720 = 172800），否则被长度校验拦下。
const USE_LOCAL_DEMO_RAW = true
const DEMO_RAW_BASE64 = require('./demo-raw-base64')
const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
let B64_LOOKUP = null
function base64ToUint8Array(b64) {
  if (!B64_LOOKUP) {
    B64_LOOKUP = new Uint8Array(256)
    for (let i = 0; i < B64_CHARS.length; i++) {
      B64_LOOKUP[B64_CHARS.charCodeAt(i)] = i
    }
  }
  const len = b64.length
  let pad = 0
  if (len && b64[len - 1] === '=') pad++
  if (len > 1 && b64[len - 2] === '=') pad++
  const byteLen = (len >> 2) * 3 - pad
  const out = new Uint8Array(byteLen)
  let p = 0
  for (let i = 0; i < len; i += 4) {
    const a = B64_LOOKUP[b64.charCodeAt(i)]
    const b = B64_LOOKUP[b64.charCodeAt(i + 1)]
    const c = B64_LOOKUP[b64.charCodeAt(i + 2)]
    const d = B64_LOOKUP[b64.charCodeAt(i + 3)]
    out[p++] = (a << 2) | (b >> 4)
    if (p < byteLen) out[p++] = ((b & 15) << 4) | (c >> 2)
    if (p < byteLen) out[p++] = ((c & 3) << 6) | d
  }
  return out
}
// ╚════════════════════════════ 测试块结束 ════════════════════════════╝

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
    // 离开投屏结果页不再主动断开：按用户要求保持连接（非手动/物理断开就一直连着）。
    this._activeDeviceId = ''
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
    const images = (pending.images || []).filter(
      item => item && (item.tempFilePath || item.url)
    )
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
      await deviceBle.ensureConnection(deviceId)
      this.setData({ desc: '正在读取设备信息…' })
      const info = await deviceBle.readDeviceInfo(deviceId)
      console.log('[投屏] 设备信息：', {
        screenType: info.screenType,
        width: info.width,
        height: info.height,
        capacity: info.capacity,
        imgCount: info.imgCount,
        firmware: info.firmwareVersion
      })

      // v1.4 固件支持主动设置 BLE 连接间隔。图传前切到 7.5ms（最小值/最快），可减少默认慢连接间隔造成的写入排队/卡顿。
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
      console.log(
        `[投屏] 设备空间：容量 ${info.capacity}，已存 ${usedIndexes.length}，剩余 ${free}`
      )
      if (free < total) {
        throw new Error(
          `设备空间不足：剩余 ${Math.max(0, free)} 张，待投 ${total} 张`
        )
      }

      // 2) 逐张：原图传后端转换得 .bin → 下载帧数据 → 选空闲槽位 → 图传 → 设备成功才写投屏记录 → 刷新显示
      for (let i = 0; i < total; i++) {
        if (this._aborted) {
          throw new Error('UPLOAD_ABORTED')
        }
        const image = images[i]
        // 取本张要发给设备的六色 4bpp 帧 + 后端记录 id（见 acquireFrame）：
        //   · 正常：传后端转换 → 下载 .bin（taskId/upirId 有值）
        //   · 本地直发测试：直接读内嵌 demo.raw 原样发（taskId/upirId 为空，不写后端记录）
        const { frameData, taskId, upirId } = await this.acquireFrame(image, device, info, i, total)
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
        this.setData({ desc: `正在投第 ${i + 1}/${total} 张…` })

        const index = protocol.firstFreeIndex(
          protocol.indexesToMask(usedIndexes),
          info.capacity
        )
        if (index < 0) {
          throw new Error('设备已存满')
        }
        console.log(
          `[投屏] 第 ${i + 1}/${total} 张 图传(0x20)：index=${index} screenType=${info.screenType} ` +
            `${info.width}x${info.height} dataSize=${frameData.length}`
        )

        // 本张事务：BLE 图传成功 → 才编辑投屏记录置成功(deviceUploadState=1)；任一步失败 →
        // 回滚删掉本张刚传到设备的图，再向外抛出让整体判失败、跳到失败场景（设备失败时不写成功记录）。
        try {
          const summary = await deviceBle.uploadImage(deviceId, {
            screenType: info.screenType,
            index,
            width: info.width,
            height: info.height,
            data: frameData,
            shouldAbort: () => this._aborted,
            // 单张内的分包进度叠加已完成张数 → 整体百分比，进度条平滑推进
            onProgress: (done, totalPackets) => {
              const frac = totalPackets ? done / totalPackets : 0
              const percent = Math.min(
                100,
                Math.floor(((i + frac) / total) * 100)
              )
              this.setData({ progressPercent: percent })
            }
          })
          console.log(`[投屏] 第 ${i + 1}/${total} 张 设备图传成功`, summary)

          // 设备图传成功后才编辑投屏记录（设备失败则不调用，记录保持失败态）；失败会抛出触发本张回滚。
          // 【本地 .raw 直发测试】测试模式没有后端记录(upirId/taskId)，跳过这步（删测试块时把 if 还原成无条件调用）。
          if (!USE_LOCAL_DEMO_RAW && upirId) {
            await api.editUserProductImgRecord({
              upirId,
              taskId,
              deviceUploadState: 1,
              showError: false
            })
            console.log(
              `[投屏] 第 ${i + 1}/${total} 张 投屏记录已置成功：upirId=${upirId} taskId=${taskId}`
            )
          } else if (USE_LOCAL_DEMO_RAW) {
            console.log(`[投屏][测试] 第 ${i + 1}/${total} 张 本地直发模式：跳过后端投屏记录更新`)
          }
        } catch (error) {
          console.error(
            `[投屏] 第 ${i + 1}/${total} 张 图传/记录更新失败，回滚 index=${index}：`,
            error
          )
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

      console.log(`[投屏] 全部完成：成功 ${uploaded}/${total} 张`)
      this.successResult(device, uploaded)
    } catch (error) {
      const aborted =
        this._aborted || (error && error.message === 'UPLOAD_ABORTED')
      const message = aborted
        ? '投屏已中断：上传时手机息屏/切到后台，蓝牙会被挂起。请保持亮屏后重新投屏。'
        : (error && error.message) || '投屏失败'
      console.error(
        `[投屏] 失败（已成功 ${uploaded}/${total} 张）：${message}`,
        error
      )
      this.failResult(device, uploaded, message)
    } finally {
      wx.setKeepScreenOn && wx.setKeepScreenOn({ keepScreenOn: false })
      // 不再传完即断：保持连接（设备单连接，下次投屏可直接复用、省去重新扫描+连接）。
      // 仅在物理断开(onBLEConnectionStateChange 清理)或用户手动断开时才真正断开。
      this._activeDeviceId = ''
    }
  },

  // 取本张要发给设备的六色 4bpp 帧 + 后端记录 id。
  // 【本地 .raw 直发测试】USE_LOCAL_DEMO_RAW=true 时直接用内嵌 demo.raw，不走后端（删测试块时此分支一并删）。
  async acquireFrame(image, device, info, i, total) {
    if (USE_LOCAL_DEMO_RAW) {
      this.setData({ desc: `测试：使用本地帧 demo.raw（第 ${i + 1}/${total} 张）…` })
      const frameData = base64ToUint8Array(DEMO_RAW_BASE64)
      console.log(`[投屏][测试] 使用内嵌 demo.raw，${frameData.length} 字节，原样发送（不经后端、不旋转/转换）`)
      return { frameData, taskId: undefined, upirId: undefined }
    }
    // 先「转换照片」(传后端按设备尺寸转换 + 下载 .bin)，再「投屏」(BLE 图传)，文案区分两个阶段，
    // 让用户知道开头这段不是卡死，而是在处理第一张图。
    this.setData({ desc: `正在转换第 ${i + 1}/${total} 张照片…` })
    // 后端转换：返回可下载的 .bin 地址 + taskId(更新设备上传状态用) + upirId(投屏记录id)
    const { url, taskId, upirId } = await this.convertOnServer(image, device, info)
    // 后端按设备分辨率直接返回六色 4bpp 帧；下载后原样走 BLE 图传（客户端不做任何图像转换）
    const frameData = await this.downloadFrameBin(url)
    return { frameData, taskId, upirId }
  },

  // 本张照片传后端转换：上传原图 → 后端按设备宽高(targetWidth×targetHeight)转换成设备帧并存 OSS，
  // 返回 { url(.bin 下载地址)、taskId、upirId }。初始按「未成功(0)」建记录，设备图传成功后再 editUserProductImgRecord 置 1。
  // 失败会抛出，让本张投屏判为失败并跳到失败场景。
  async convertOnServer(image, device, info) {
    const userProductId = device && (device.userProductId || device.id)
    const filePath = await this.resolveLocalFilePath(image)
    if (!filePath) {
      throw new Error('图片文件不可用，无法转换')
    }

    console.log(
      `[投屏] 上传原图转换：userProductId=${userProductId} target=${info.width}x${info.height} file=${filePath}`
    )
    const res = await api.setUserProductUpload({
      filePath,
      userProductId,
      targetWidth: info.width,
      targetHeight: info.height,
      deviceUploadState: 0,
      loading: false, // 结果页用 setData desc 自管进度，关掉全局 loading 遮罩
      showError: false // 失败统一走本页失败场景，不额外弹 toast
    })

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
      upirId: item.upirId
    }
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
      return new Promise((resolve, reject) => {
        wx.downloadFile({
          url: remoteUrl,
          success: res => {
            if (res.statusCode === 200 && res.tempFilePath) {
              resolve(res.tempFilePath)
            } else {
              reject(new Error('原图下载失败'))
            }
          },
          fail: error =>
            reject(new Error((error && error.errMsg) || '原图下载失败'))
        })
      })
    }
    return Promise.resolve(remoteUrl || '')
  },

  // 下载后端按设备分辨率转换好的六色 4bpp 帧(.bin)，读成 Uint8Array 直接喂给 BLE 图传。
  // 注意：生产环境需把 OSS 域名加入小程序「downloadFile 合法域名」白名单（开发期 urlCheck=false 不校验）。
  downloadFrameBin(url) {
    return new Promise((resolve, reject) => {
      wx.downloadFile({
        url,
        success: res => {
          if (res.statusCode !== 200 || !res.tempFilePath) {
            reject(new Error('转换结果下载失败'))
            return
          }
          wx.getFileSystemManager().readFile({
            filePath: res.tempFilePath,
            success: r => resolve(new Uint8Array(r.data)),
            fail: () => reject(new Error('转换结果读取失败'))
          })
        },
        fail: error =>
          reject(new Error((error && error.errMsg) || '转换结果下载失败'))
      })
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
    const result = {
      status: 'success',
      deviceName: device.name || '相框',
      imageCount: count
    }
    wx.setStorageSync('lastProjectionResult', result)
    this.applyStatus('success', result)
  },

  failResult(device, count, message) {
    // 失败保留 pendingProjection，便于「重新投屏」直接重试
    const result = {
      status: 'fail',
      deviceName: device.name || '相框',
      imageCount: count,
      message
    }
    wx.setStorageSync('lastProjectionResult', result)
    this.applyStatus('fail', result)
    if (message) {
      toast.show({ title: message, icon: 'none' })
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

  continueProjection() {
    wx.switchTab({
      url: '/pages/home/home'
    })
  }
})
