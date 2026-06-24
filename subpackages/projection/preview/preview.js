const system = require('../../../utils/system')
const toast = require('../../../utils/toast')

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

    // 裁剪交互状态
    cropping: false, // 是否处于裁剪交互（显示裁剪层/手柄）
    cropImageRect: null, // 进入裁剪时算出的图片在舞台内显示矩形 {left,top,width,height}(px)
    cropBox: null, // 当前裁剪框 {left,top,width,height}(px，相对舞台)
    stageW: 0,
    stageH: 0,
    cropNaturalW: 0, // 原图真实像素宽
    cropNaturalH: 0 // 原图真实像素高
  },

  onLoad() {
    this.setData(system.getLayoutMetrics())
    // 待投屏的设备与图片由上个页面通过 Storage 传入（见首页/相册的 openPreview）
    const pending = wx.getStorageSync('pendingProjection') || {}
    const images = pending.images || []
    const device = pending.device || null
    this.updateImageState(images, device, 0)
  },

  // 统一刷新图片相关状态：当前预览图与张数（设备空间是否够由结果页按真实容量/掩码判断）
  updateImageState(images, device, activeIndex) {
    const safeIndex = Math.max(0, Math.min(activeIndex, images.length - 1)) // 防止下标越界

    this.setData({
      device,
      images,
      activeIndex: safeIndex,
      activeImage: images[safeIndex] || null,
      imageCount: images.length
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

  // 进入裁剪：量出舞台尺寸 + 图片真实尺寸，算出图片「适应」显示矩形作为裁剪坐标基准，默认裁剪框=整张图。
  enterCrop() {
    const image = this.data.images[this.data.activeIndex]
    const src = image && (image.tempFilePath || image.url)
    if (!src) {
      toast.show({ title: '暂无可裁剪的图片', icon: 'none' })
      return
    }
    // 裁剪基于未旋转的原图，进入裁剪先把预览旋转归零，避免“看到的”和“裁到的”不一致
    this.setData({ activeTool: 'crop', editing: true, rotation: 0 })

    const query = wx.createSelectorQuery()
    query.select('.preview-swiper').boundingClientRect()
    query.exec((res) => {
      const rect = res && res[0]
      if (!rect || !rect.width) {
        toast.show({ title: '初始化裁剪失败', icon: 'none' })
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
          this.setData({
            cropping: true,
            stageW,
            stageH,
            cropNaturalW: info.width,
            cropNaturalH: info.height,
            cropImageRect: imageRect,
            cropBox: { left, top, width: dispW, height: dispH }
          })
        },
        fail: () => toast.show({ title: '读取图片失败', icon: 'none' })
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

  // 裁剪框拖拽中：按手柄类型调整裁剪框，并约束在图片显示矩形内、不小于最小尺寸
  onCropTouchMove(e) {
    if (!this._cropDrag) {
      return
    }
    const MIN = 60 // 裁剪框最小边长(px)
    const t = e.touches[0]
    const dx = t.clientX - this._cropDrag.x
    const dy = t.clientY - this._cropDrag.y
    const img = this.data.cropImageRect
    const start = this._cropDrag.box
    const imgRight = img.left + img.width
    const imgBottom = img.top + img.height
    const startRight = start.left + start.width
    const startBottom = start.top + start.height
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi))

    let left = start.left
    let top = start.top
    let width = start.width
    let height = start.height

    switch (this._cropDrag.handle) {
      case 'move':
        left = clamp(start.left + dx, img.left, imgRight - start.width)
        top = clamp(start.top + dy, img.top, imgBottom - start.height)
        break
      case 'tl':
        left = clamp(start.left + dx, img.left, startRight - MIN)
        top = clamp(start.top + dy, img.top, startBottom - MIN)
        width = startRight - left
        height = startBottom - top
        break
      case 'tr': {
        top = clamp(start.top + dy, img.top, startBottom - MIN)
        const right = clamp(startRight + dx, start.left + MIN, imgRight)
        width = right - start.left
        height = startBottom - top
        break
      }
      case 'bl': {
        left = clamp(start.left + dx, img.left, startRight - MIN)
        const bottom = clamp(startBottom + dy, start.top + MIN, imgBottom)
        width = startRight - left
        height = bottom - start.top
        break
      }
      case 'br': {
        const right = clamp(startRight + dx, start.left + MIN, imgRight)
        const bottom = clamp(startBottom + dy, start.top + MIN, imgBottom)
        width = right - start.left
        height = bottom - start.top
        break
      }
      default:
        return
    }

    this.setData({ cropBox: { left, top, width, height } })
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

  // 保存编辑：裁剪态把选区真正裁出来写回当前图片；其它编辑（旋转）仅退出编辑态
  savePhoto() {
    if (this.data.cropping) {
      this.applyCrop()
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
        toast.show({ title: '裁剪失败：画布不可用', icon: 'none' })
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
            toast.show({ title: '裁剪导出失败', icon: 'none' })
          }
        })
      }
      img.onerror = () => {
        wx.hideLoading()
        toast.show({ title: '图片加载失败', icon: 'none' })
      }
      img.src = src
    })
  },

  // 把当前 images 写回 Storage(pendingProjection)，保证结果页拿到的是裁剪后的图
  persistPending(images) {
    const pending = wx.getStorageSync('pendingProjection') || {}
    pending.images = images
    pending.device = this.data.device || pending.device
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
      toast.show({ title: '请选择设备', icon: 'none' })
      return
    }

    if (!this.data.images.length) {
      toast.show({ title: '请至少保留一张照片', icon: 'none' })
      return
    }

    // 必须有真实蓝牙 deviceId 才能连接图传（绑定时由蓝牙读取写入）
    if (!this.data.device.deviceId) {
      toast.show({ title: '设备未连接，请重新绑定后再投屏', icon: 'none' })
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
