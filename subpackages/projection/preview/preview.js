const system = require('../../../utils/system')
const toast = require('../../../utils/toast')
const deviceBle = require('../../../utils/device-ble')

// 设备屏幕分辨率（width×height）：列表/详情接口都会返回，裁剪框据此锁定宽高比（如 500x500 → 1:1）。
// 接口暂未返回该字段，这里先给默认值便于联调测试（如需 1:1 改成 { width: 500, height: 500 }）。
const DEFAULT_DEVICE_SIZE = { width: 480, height: 720 }

// 预览舞台（.preview-stage）的可用区域，单位 rpx：宽 = 屏宽 750 - 左右各 46 边距；高 = swiper 高度。
// 裁剪后按此区域把图片「等比缩放」铺满 photo-wrap，保证整张裁剪图完整显示且不留白。
const STAGE_W_RPX = 658
const STAGE_H_RPX = 760

Page({
  data: {
    statusBarHeight: 20,
    safeBottom: 0,
    device: null,
    images: [],
    activeImage: null,
    activeIndex: 0,
    imageCount: 0,
    activeTool: 'origin',
    editing: false,
    rotation: 0,
    projecting: false,
    // 是否压缩图片后再传后端转码（后端压到约300-400KB）：默认开启，用户选择持久化到 Storage
    compressImage: true,

    // 裁剪交互状态
    cropping: false, // 是否处于裁剪交互（显示裁剪层/手柄）
    cropImageRect: null, // 进入裁剪时算出的图片在舞台内显示矩形 {left,top,width,height}(px)
    cropBox: null, // 当前裁剪框 {left,top,width,height}(px，相对舞台)
    stageW: 0,
    stageH: 0,
    cropNaturalW: 0, // 原图真实像素宽
    cropNaturalH: 0, // 原图真实像素高
    cropRatio: 1, // 裁剪框锁定的宽高比 = 设备 width / height
    deviceWrapStyle: '' // 未裁剪图片的 photo-wrap 初始尺寸：按设备比例铺，作为预览
  },

  onLoad() {
    this.setData(system.getLayoutMetrics())
    // 待投屏的设备与图片由上个页面通过 Storage 传入（见首页/相册的 openPreview）
    const pending = wx.getStorageSync('pendingProjection') || {}
    const images = pending.images || []
    const device = pending.device || null
    this.updateImageState(images, device, 0)

    // 压缩开关：默认开启；用户改过则沿用上次选择（Storage 未设置时为 ''，不等于 false）
    this.setData({
      compressImage: wx.getStorageSync('projectionCompressImage') !== false
    })

    // 预热连接：用户在预览页裁剪/确认的这几秒里，后台先把设备连上。
    // 这样点「确认投屏」后，结果页的 ensureConnection 能直接复用已就绪的会话，
    // 省掉「投屏中」开头那段最耗时的连接等待。失败静默忽略，结果页仍会正常重连。
    if (device && device.deviceId) {
      deviceBle.ensureConnection(device.deviceId).catch(() => {})
    }
  },

  // 统一刷新图片相关状态：当前预览图与张数（设备空间是否够由结果页按真实容量/掩码判断）
  updateImageState(images, device, activeIndex) {
    const safeIndex = Math.max(0, Math.min(activeIndex, images.length - 1)) // 防止下标越界
    // 未裁剪图片的初始展示比例 = 当前绑定设备的比例（与裁剪锁定的比例一致），作为投屏预览
    const size = this.getDeviceCropSize(device)

    this.setData({
      device,
      images,
      activeIndex: safeIndex,
      activeImage: images[safeIndex] || null,
      imageCount: images.length,
      deviceWrapStyle: this.computeWrapStyle(size.width, size.height)
    })
  },

  onSwiperChange(e) {
    const index = e.detail.current
    // 切换图片即视为换了一张，退出裁剪/编辑态并重置旋转
    this._cropDrag = null
    this.setData({
      activeIndex: index,
      activeImage: this.data.images[index] || null,
      activeTool: 'origin',
      editing: false,
      cropping: false,
      rotation: 0
    })
  },

  // 底部工具切换：裁剪进入裁剪交互；旋转每次 +90° 循环；原图弹二次确认后还原
  selectTool(e) {
    const tool = e.currentTarget.dataset.tool

    if (tool === 'crop') {
      this.enterCrop()
      return
    }

    if (tool === 'rotate') {
      // 旋转仍是预览态可视效果（暂不写入图片）；进入旋转先退出裁剪交互
      this.setData({
        cropping: false,
        activeTool: 'rotate',
        editing: true,
        rotation: (this.data.rotation + 90) % 360
      })
      return
    }

    if (tool === 'origin') {
      this.restoreOrigin()
    }
  },

  // 当前连接设备的屏幕分辨率(width×height)：列表/详情接口都会返回，这里直接取投屏页拿到的设备对象。
  // 接口未就绪/字段缺省时退回默认值，保证裁剪比例始终可用（便于联调测试）。
  getDeviceCropSize(device) {
    const d = device || this.data.device || {}
    const w = Number(d.width)
    const h = Number(d.height)
    return {
      width: w > 0 ? w : DEFAULT_DEVICE_SIZE.width,
      height: h > 0 ? h : DEFAULT_DEVICE_SIZE.height
    }
  },

  // 由裁剪后图片的真实像素宽高，算出 photo-wrap 的展示尺寸（rpx）：在舞台内等比缩放。
  // 返回内联 style 字符串；未裁剪(传入非法宽高)时返回空串，让 photo-wrap 回到 CSS 默认尺寸。
  computeWrapStyle(w, h) {
    if (!(w > 0) || !(h > 0)) {
      return ''
    }
    const aspect = w / h
    let dispW = STAGE_W_RPX
    let dispH = dispW / aspect
    if (dispH > STAGE_H_RPX) {
      dispH = STAGE_H_RPX
      dispW = dispH * aspect
    }
    return `width:${dispW.toFixed(2)}rpx;height:${dispH.toFixed(2)}rpx;`
  },

  // 进入裁剪：量出舞台尺寸 + 图片真实尺寸，算出图片「适应」显示矩形作为裁剪坐标基准，裁剪框锁定设备比例。
  enterCrop() {
    const image = this.data.images[this.data.activeIndex]
    const src = image && (image.tempFilePath || image.url)
    if (!src) {
      toast.warn({ title: '暂无可裁剪的图片', icon: 'none' })
      return
    }
    // 进入裁剪前先把已选旋转烘焙进图片，再基于旋转后的图测量裁剪框，避免「旋转后再裁剪」丢失旋转
    this.bakeRotation().then(() => {
      this.setData({ activeTool: 'crop', editing: true, rotation: 0 })
      this.measureCropLayout()
    })
  },

  // 量出舞台尺寸 + 当前图片真实尺寸，算出图片「适应」显示矩形作为裁剪坐标基准，裁剪框锁定设备比例。
  // 读取的是当前最新的图片源（可能已被 bakeRotation 旋转导出过）。
  measureCropLayout() {
    const image = this.data.images[this.data.activeIndex]
    const src = image && (image.tempFilePath || image.url)
    if (!src) {
      return
    }
    const query = wx.createSelectorQuery()
    query.select('.preview-swiper').boundingClientRect()
    query.exec((res) => {
      const rect = res && res[0]
      if (!rect || !rect.width) {
        toast.warn({ title: '初始化裁剪失败', icon: 'none' })
        return
      }
      wx.getImageInfo({
        src,
        success: (info) => {
          const stageW = rect.width
          const stageH = rect.height
          // 「适应」缩放：整张图都显示出来（带留白），裁剪框只能在图片范围内移动
          const scale = Math.min(stageW / info.width, stageH / info.height)
          const dispW = info.width * scale
          const dispH = info.height * scale
          const left = (stageW - dispW) / 2
          const top = (stageH - dispH) / 2
          const imageRect = { left, top, width: dispW, height: dispH }
          // 设备屏幕比例：裁剪框锁定为该比例（如 500x500 → 1:1）
          const size = this.getDeviceCropSize()
          const ratio = size.width / size.height
          // 初始裁剪框：在图片显示矩形内取「该比例的最大居中框」
          let boxW = dispW
          let boxH = boxW / ratio
          if (boxH > dispH) {
            boxH = dispH
            boxW = boxH * ratio
          }
          const boxLeft = left + (dispW - boxW) / 2
          const boxTop = top + (dispH - boxH) / 2
          this.setData({
            cropping: true,
            stageW,
            stageH,
            cropNaturalW: info.width,
            cropNaturalH: info.height,
            cropRatio: ratio,
            cropImageRect: imageRect,
            cropBox: { left: boxLeft, top: boxTop, width: boxW, height: boxH }
          })
        },
        fail: () => toast.warn({ title: '读取图片失败', icon: 'none' })
      })
    })
  },

  // 裁剪框拖拽开始：记录按下的手柄与起始裁剪框
  onCropHandleStart(e) {
    const t = e.touches[0]
    this._cropDrag = {
      handle: e.currentTarget.dataset.handle,
      x: t.clientX,
      y: t.clientY,
      box: Object.assign({}, this.data.cropBox)
    }
  },

  // 裁剪框拖拽中：move 在图片范围内平移；四角缩放锁定设备比例（改宽则高按比例自适应）
  onCropTouchMove(e) {
    if (!this._cropDrag) {
      return
    }
    const t = e.touches[0]
    const dx = t.clientX - this._cropDrag.x
    const dy = t.clientY - this._cropDrag.y
    const start = this._cropDrag.box
    const handle = this._cropDrag.handle

    if (handle === 'move') {
      const img = this.data.cropImageRect
      const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi))
      const left = clamp(start.left + dx, img.left, img.left + img.width - start.width)
      const top = clamp(start.top + dy, img.top, img.top + img.height - start.height)
      this.setData({
        cropBox: { left, top, width: start.width, height: start.height }
      })
      return
    }

    this.setData({ cropBox: this.resizeCropBox(handle, dx, dy, start) })
  },

  // 四角缩放：锁定设备宽高比(cropRatio = width / height)，对角顶点固定。
  // 按手指拖动量取主导边、另一边按比例推导，再约束在图片范围内与最小尺寸内。
  resizeCropBox(handle, dx, dy, start) {
    const MIN = 60 // 较短边最小边长(px)
    const img = this.data.cropImageRect
    const ratio = this.data.cropRatio || start.width / start.height
    const imgRight = img.left + img.width
    const imgBottom = img.top + img.height
    const startRight = start.left + start.width
    const startBottom = start.top + start.height

    // 锚点（对角顶点固定）确定的最大可用空间，与随手指变化的候选宽高
    let maxW
    let maxH
    let cw
    let ch
    switch (handle) {
      case 'br': // 锚点：左上
        maxW = imgRight - start.left
        maxH = imgBottom - start.top
        cw = start.width + dx
        ch = start.height + dy
        break
      case 'tr': // 锚点：左下
        maxW = imgRight - start.left
        maxH = startBottom - img.top
        cw = start.width + dx
        ch = start.height - dy
        break
      case 'bl': // 锚点：右上
        maxW = startRight - img.left
        maxH = imgBottom - start.top
        cw = start.width - dx
        ch = start.height + dy
        break
      case 'tl': // 锚点：右下
        maxW = startRight - img.left
        maxH = startBottom - img.top
        cw = start.width - dx
        ch = start.height - dy
        break
      default:
        return start
    }

    // 1) 取主导边，另一边按比例推导（对角拖动更跟手）
    let width
    let height
    if (cw >= ch * ratio) {
      width = cw
      height = cw / ratio
    } else {
      height = ch
      width = ch * ratio
    }
    // 2) 限制在图片显示范围内（保持比例）
    if (width > maxW) {
      width = maxW
      height = width / ratio
    }
    if (height > maxH) {
      height = maxH
      width = height * ratio
    }
    // 3) 最小尺寸（作用于较短边，保持比例）
    const minW = ratio >= 1 ? MIN * ratio : MIN
    const minH = ratio >= 1 ? MIN : MIN / ratio
    if (width < minW || height < minH) {
      width = minW
      height = minH
    }
    // 4) 按锚点（对角固定）定位
    let left = start.left
    let top = start.top
    if (handle === 'tr') {
      top = startBottom - height
    } else if (handle === 'bl') {
      left = startRight - width
    } else if (handle === 'tl') {
      left = startRight - width
      top = startBottom - height
    }
    return { left, top, width, height }
  },

  onCropTouchEnd() {
    this._cropDrag = null
  },

  // 原图：二次确认后还原到最原始的图片（把裁剪过的图片源换回原图，重置旋转并退出编辑态）
  restoreOrigin() {
    wx.showModal({
      title: '还原原图',
      content: '确定要还原到最原始的图片吗？当前的编辑将不会保存。',
      confirmText: '还原',
      confirmColor: '#ff5f1f',
      success: (res) => {
        if (!res.confirm) {
          return
        }
        const { images, activeIndex } = this.data
        const next = images.slice()
        const updated = Object.assign({}, next[activeIndex])
        // 之前裁剪过：把图片源还原回最初的原图
        if (updated._origSrc) {
          updated.tempFilePath = updated._origSrc
        }
        // 还原即非裁剪态：清掉裁剪宽高与展示尺寸，photo-wrap 回到默认满铺
        updated.cropW = 0
        updated.cropH = 0
        updated.wrapStyle = ''
        next[activeIndex] = updated
        this.setData({
          images: next,
          activeImage: updated,
          activeTool: 'origin',
          editing: false,
          cropping: false,
          rotation: 0
        })
        this.persistPending(next)
      }
    })
  },

  // 保存编辑：裁剪态把选区真正裁出来写回当前图片；旋转态把旋转角度真正烘焙进图片
  //（保证投屏的「设备图传」与「后端上传」用的都是处理后的图——含裁剪、含旋转）。
  savePhoto() {
    if (this.data.cropping) {
      this.applyCrop()
      return
    }
    const angle = ((this.data.rotation % 360) + 360) % 360
    if (angle !== 0) {
      this.bakeRotation().then(() => {
        this.setData({ activeTool: '', editing: false })
        toast.show({ title: '已保存', icon: 'none' })
      })
      return
    }
    this.setData({
      activeTool: '',
      editing: false
    })
    toast.show({
      title: '已保存',
      icon: 'none'
    })
  },

  // 把当前已选旋转角度(0/90/180/270)真正绘制进图片并导出为新临时文件，写回当前图片并持久化。
  // 返回 Promise（rotation=0 或无图时直接 resolve）。投屏用的是这里导出的处理图，故旋转会随之生效。
  bakeRotation() {
    return new Promise((resolve) => {
      const angle = ((this.data.rotation % 360) + 360) % 360
      const { activeIndex, images } = this.data
      const image = images[activeIndex]
      const src = image && (image.tempFilePath || image.url)
      if (angle === 0 || !src) {
        this.setData({ rotation: 0 })
        resolve()
        return
      }

      wx.showLoading({ title: '处理中', mask: true })
      wx.getImageInfo({
        src,
        success: (info) => {
          const swap = angle === 90 || angle === 270
          const outW = swap ? info.height : info.width
          const outH = swap ? info.width : info.height
          const query = wx.createSelectorQuery()
          query.select('#cropCanvas').fields({ node: true }).exec((res) => {
            const node = res && res[0] && res[0].node
            if (!node) {
              wx.hideLoading()
              toast.warn({ title: '旋转失败：画布不可用', icon: 'none' })
              resolve()
              return
            }
            node.width = outW
            node.height = outH
            const ctx = node.getContext('2d')
            const img = node.createImage()
            img.onload = () => {
              ctx.clearRect(0, 0, outW, outH)
              // 以输出画布中心为原点旋转，再按原图尺寸居中绘制（90/270 时画布已宽高互换）
              ctx.save()
              ctx.translate(outW / 2, outH / 2)
              ctx.rotate((angle * Math.PI) / 180)
              ctx.drawImage(img, -info.width / 2, -info.height / 2, info.width, info.height)
              ctx.restore()
              wx.canvasToTempFilePath({
                canvas: node,
                success: (r) => {
                  const next = images.slice()
                  const updated = Object.assign({}, next[activeIndex])
                  // 首次编辑时备份原图源，供「原图」还原
                  if (!updated._origSrc) {
                    updated._origSrc = updated.tempFilePath || updated.url || ''
                  }
                  updated.tempFilePath = r.tempFilePath
                  // 旋转后真实宽高变化，重算 photo-wrap 展示尺寸
                  updated.cropW = outW
                  updated.cropH = outH
                  updated.wrapStyle = this.computeWrapStyle(outW, outH)
                  next[activeIndex] = updated
                  this.setData({ images: next, activeImage: updated, rotation: 0 })
                  this.persistPending(next)
                  wx.hideLoading()
                  resolve()
                },
                fail: () => {
                  wx.hideLoading()
                  toast.warn({ title: '旋转导出失败', icon: 'none' })
                  resolve()
                }
              })
            }
            img.onerror = () => {
              wx.hideLoading()
              toast.warn({ title: '图片加载失败', icon: 'none' })
              resolve()
            }
            img.src = src
          })
        },
        fail: () => {
          wx.hideLoading()
          toast.warn({ title: '读取图片失败', icon: 'none' })
          resolve()
        }
      })
    })
  },

  // 应用裁剪：把裁剪框映射回原图像素 → 画到离屏画布 → 导出临时文件 → 写回当前图片并持久化。
  applyCrop() {
    const { cropBox, cropImageRect, cropNaturalW, cropNaturalH, activeIndex, images } = this.data
    const image = images[activeIndex]
    const src = image && (image.tempFilePath || image.url)
    if (!cropBox || !cropImageRect || !cropNaturalW || !src) {
      this.setData({ cropping: false, activeTool: '', editing: false })
      return
    }

    const scale = cropImageRect.width / cropNaturalW // 显示 px / 原图 px
    // 裁剪框（显示坐标）映射回原图像素坐标
    let sx = Math.round((cropBox.left - cropImageRect.left) / scale)
    let sy = Math.round((cropBox.top - cropImageRect.top) / scale)
    let sw = Math.round(cropBox.width / scale)
    let sh = Math.round(cropBox.height / scale)
    // 钳进原图范围，避免浮点误差越界
    sx = Math.max(0, Math.min(sx, cropNaturalW - 1))
    sy = Math.max(0, Math.min(sy, cropNaturalH - 1))
    sw = Math.max(1, Math.min(sw, cropNaturalW - sx))
    sh = Math.max(1, Math.min(sh, cropNaturalH - sy))

    // 输出限幅：长边最多 2000px，足够覆盖任何相框分辨率，又不至于画布过大
    const MAX_EDGE = 2000
    let outW = sw
    let outH = sh
    const longEdge = Math.max(outW, outH)
    if (longEdge > MAX_EDGE) {
      const k = MAX_EDGE / longEdge
      outW = Math.max(1, Math.round(outW * k))
      outH = Math.max(1, Math.round(outH * k))
    }

    wx.showLoading({ title: '裁剪中', mask: true })
    const query = wx.createSelectorQuery()
    query.select('#cropCanvas').fields({ node: true }).exec((res) => {
      const node = res && res[0] && res[0].node
      if (!node) {
        wx.hideLoading()
        toast.warn({ title: '裁剪失败：画布不可用', icon: 'none' })
        return
      }
      node.width = outW
      node.height = outH
      const ctx = node.getContext('2d')
      const img = node.createImage()
      img.onload = () => {
        ctx.clearRect(0, 0, outW, outH)
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, outW, outH)
        wx.canvasToTempFilePath({
          canvas: node,
          success: (r) => {
            const next = images.slice()
            const updated = Object.assign({}, next[activeIndex])
            // 首次编辑时备份原图源，供「原图」还原
            if (!updated._origSrc) {
              updated._origSrc = updated.tempFilePath || updated.url || ''
            }
            updated.tempFilePath = r.tempFilePath
            // 记录裁剪后真实宽高，并预算 photo-wrap 展示尺寸：展示当前图时按裁剪比例铺满
            updated.cropW = outW
            updated.cropH = outH
            updated.wrapStyle = this.computeWrapStyle(outW, outH)
            next[activeIndex] = updated
            this.setData({
              images: next,
              activeImage: updated,
              cropping: false,
              activeTool: '',
              editing: false
            })
            this.persistPending(next)
            wx.hideLoading()
            toast.show({ title: '已保存', icon: 'none' })
          },
          fail: () => {
            wx.hideLoading()
            toast.warn({ title: '裁剪导出失败', icon: 'none' })
          }
        })
      }
      img.onerror = () => {
        wx.hideLoading()
        toast.warn({ title: '图片加载失败', icon: 'none' })
      }
      img.src = src
    })
  },

  // 压缩开关：更新页面状态并持久化，结果页经 pendingProjection 拿到最终值
  onCompressChange(e) {
    const compressImage = !!(e.detail && e.detail.value)
    this.setData({ compressImage })
    wx.setStorageSync('projectionCompressImage', compressImage)
  },

  // 把当前 images 写回 Storage(pendingProjection)，保证结果页拿到的是裁剪后的图
  persistPending(images) {
    const pending = wx.getStorageSync('pendingProjection') || {}
    pending.images = images
    pending.device = this.data.device || pending.device
    pending.compressImage = this.data.compressImage
    wx.setStorageSync('pendingProjection', pending)
  },

  // 确认投屏：基础校验后跳到结果页，由结果页真实连接设备并走 BLE 图传（带真实进度）。
  // 设备空间是否够、能否连接，都在结果页用真实读到的容量/掩码与连接结果判断，这里不再用假数据预判。
  confirmProjection() {
    // 编辑态下按钮置灰不可投屏，需先保存或还原退出编辑
    if (this.data.editing) {
      return
    }

    if (!this.data.device) {
      toast.warn({ title: '请选择设备', icon: 'none' })
      return
    }

    if (!this.data.images.length) {
      toast.warn({ title: '请至少保留一张照片', icon: 'none' })
      return
    }

    // 必须有真实蓝牙 deviceId 才能连接图传（绑定时由蓝牙读取写入）
    if (!this.data.device.deviceId) {
      toast.warn({ title: '设备未连接，请重新绑定后再投屏', icon: 'none' })
      return
    }

    // 把（可能裁剪过的）图片写回 Storage，再跳结果页真实图传
    this.persistPending(this.data.images)
    wx.redirectTo({
      url: '/subpackages/projection/result/result?status=progress'
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
  }
})
