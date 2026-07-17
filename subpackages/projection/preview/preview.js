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

// 画布导出格式（性能优化，2026-07-13）。canvasToTempFilePath 的 fileType 默认是 png——
// 照片存 png 是同画质 jpg 的 5~10 倍（长边 2000 的照片常到 5MB+）。而本页导出的这个临时文件
// 正是投屏要上传给后端转码的源图：真机 trace 里 uploadConvertMs 高达 5.7s，几乎全耗在传这个大 png 上。
// 统一导出 jpg：后端拿到后还要缩到设备分辨率（如 480×720）并量化成六色，q=0.92 对最终成像完全无损，
// 体积却只有 1/10。jpg 不支持透明，导出前先铺白底，避免透明区域变黑（照片无 alpha，纯属兜底）。
const EXPORT_FILE_TYPE = 'jpg'
const EXPORT_QUALITY = 0.92

// 统一编辑态里图片相对「铺满裁剪框(cover)」还能再放大的上限倍数（防止无限放大成马赛克）
const MAX_ZOOM_FACTOR = 8

// 在画布上铺一层白底（jpg 无 alpha 通道，不铺底的话透明像素会被压成黑色）
function fillWhite(ctx, width, height) {
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)
}

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
    editing: false, // 是否处于统一编辑态（裁剪+缩放+旋转）
    projecting: false,

    // 统一编辑态渲染字段（数值真值存在 this._edit，这里只放模板需要的显示量）
    editSrc: '', // 正在编辑的图片源
    editBaseW: 0, // 图片「铺满裁剪框(cover)」时的显示宽(px)，作为 zoom=1 基准
    editBaseH: 0, // 同上，高
    editImgLeft: 0, // 图片元素左上角 X(px，相对编辑层)：使其中心落在裁剪框中心
    editImgTop: 0, // 同上，Y
    editTransform: '', // translate/rotate/scale 组合串——仅此字段随手势高频 setData
    frame: null, // 固定裁剪框 {left,top,width,height}(px)，锁定设备比例、居中不动
    editHint: true, // 首次进入编辑显示手势提示，触摸后隐藏

    deviceWrapStyle: '' // 未裁剪图片的 photo-wrap 初始尺寸：按设备比例铺，作为预览
  },

  onLoad() {
    this.setData(system.getLayoutMetrics())
    // 待投屏的设备与图片由上个页面通过 Storage 传入（见首页/相册的 openPreview）
    const pending = wx.getStorageSync('pendingProjection') || {}
    const images = pending.images || []
    const device = pending.device || null
    this.updateImageState(images, device, 0)

    // 压缩图片：产品要求恒为开启，页面已隐藏开关入口，故不再读取 Storage 覆盖（保持 data 默认 true）

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
    // 切换图片即视为换了一张，退出编辑态（丢弃未保存的手势变换）
    this._edit = null
    this._gesture = null
    this.setData({
      activeIndex: index,
      activeImage: this.data.images[index] || null,
      activeTool: 'origin',
      editing: false
    })
  },

  // 底部工具切换：裁剪/旋转都进入同一个「统一编辑态」；旋转额外把图片转 90°；原图弹二次确认后还原。
  selectTool(e) {
    const tool = e.currentTarget.dataset.tool

    if (tool === 'crop') {
      this.enterEdit()
      return
    }

    if (tool === 'rotate') {
      // 旋转按钮：不在编辑态时先进入编辑态再转 90°；已在编辑态直接每次 +90°
      if (this.data.editing) {
        this.rotate90()
      } else {
        this.enterEdit().then((ok) => {
          if (ok) {
            this.rotate90()
          }
        })
      }
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

  // 由处理后图片的真实像素宽高，算出 photo-wrap 的展示尺寸（rpx）：在舞台内等比缩放。
  // 返回内联 style 字符串；未处理(传入非法宽高)时返回空串，让 photo-wrap 回到 CSS 默认尺寸。
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

  // 进入统一编辑态：量出舞台尺寸 + 图片真实尺寸，摆好「固定裁剪框(设备比例) + 铺满该框的图片」。
  // 之后用户单指平移 / 双指缩放旋转 / 点旋转按钮 90°，图片在框下自由变换，框不动，框内即最终成像。
  // 返回 Promise<boolean>（true=已进入编辑态），供「旋转」按钮进入后再转 90°。
  enterEdit() {
    return new Promise((resolve) => {
      const image = this.data.images[this.data.activeIndex]
      const src = image && (image.tempFilePath || image.url)
      if (!src) {
        toast.warn({ title: '暂无可编辑的图片', icon: 'none' })
        resolve(false)
        return
      }
      // 已在编辑同一张图：直接复用当前变换，不重置（例如连续点旋转）
      if (this.data.editing && this._edit && this._edit.src === src) {
        resolve(true)
        return
      }
      const query = wx.createSelectorQuery()
      query.select('.preview-swiper').boundingClientRect()
      query.exec((res) => {
        const rect = res && res[0]
        if (!rect || !rect.width) {
          toast.warn({ title: '初始化编辑失败', icon: 'none' })
          resolve(false)
          return
        }
        wx.getImageInfo({
          src,
          success: (info) => {
            const stageW = rect.width
            const stageH = rect.height
            const dev = this.getDeviceCropSize()
            const ratio = dev.width / dev.height
            // 固定裁剪框：舞台内「设备比例」的最大居中矩形
            let fw = stageW
            let fh = fw / ratio
            if (fh > stageH) {
              fh = stageH
              fw = fh * ratio
            }
            const frame = {
              left: (stageW - fw) / 2,
              top: (stageH - fh) / 2,
              width: fw,
              height: fh
            }
            // cover：图片刚好铺满裁剪框的基准显示尺寸（zoom=1 时的显示 px/原图 px）
            const baseScale = Math.max(fw / info.width, fh / info.height)
            const baseW = info.width * baseScale
            const baseH = info.height * baseScale
            // 数值真值都放 this._edit，避免手势里频繁读 setData 后的 data（异步、易错）
            this._edit = {
              src,
              natW: info.width,
              natH: info.height,
              baseScale,
              baseW,
              baseH,
              frameW: fw,
              frameH: fh,
              zoom: 1,
              tx: 0,
              ty: 0,
              angle: 0
            }
            this._gesture = null
            this.setData({
              editing: true,
              activeTool: 'crop',
              editSrc: src,
              editBaseW: baseW,
              editBaseH: baseH,
              editImgLeft: frame.left + fw / 2 - baseW / 2,
              editImgTop: frame.top + fh / 2 - baseH / 2,
              frame,
              editHint: true
            })
            // 初始按 cover 摆正并夹取（tx/ty=0、zoom=1、angle=0）
            this._applyEdit(1, 0, 0, 0)
            resolve(true)
          },
          fail: () => {
            toast.warn({ title: '读取图片失败', icon: 'none' })
            resolve(false)
          }
        })
      })
    })
  },

  // 约束一组变换：① zoom 不小于「当前角度下铺满裁剪框」所需最小值（旋转后也不露白边），且不超过上限；
  // ② 平移不让裁剪框越出图片（把屏幕平移量转到图片本地坐标再夹取）。返回夹取后的 {zoom,tx,ty}。
  _clampTransform(zoom, tx, ty, angle) {
    const g = this._edit
    const rad = (angle * Math.PI) / 180
    const cosT = Math.cos(rad)
    const sinT = Math.sin(rad)
    const c = Math.abs(cosT)
    const s = Math.abs(sinT)
    const fw = g.frameW
    const fh = g.frameH
    // 旋转 angle 后，图片(baseW×baseH×zoom)要包住轴对齐的裁剪框(fw×fh)所需的最小 zoom
    const minZoom = Math.max(
      (fw * c + fh * s) / g.baseW,
      (fw * s + fh * c) / g.baseH
    )
    let z = Math.max(zoom, minZoom)
    z = Math.min(z, minZoom * MAX_ZOOM_FACTOR)
    const W = g.baseW * z
    const H = g.baseH * z
    // 裁剪框旋转到图片本地坐标后的半宽/半高
    const hx = (fw / 2) * c + (fh / 2) * s
    const hy = (fw / 2) * s + (fh / 2) * c
    // 屏幕平移(tx,ty) → 图片本地平移(lox,loy)
    let lox = tx * cosT + ty * sinT
    let loy = -tx * sinT + ty * cosT
    const maxLox = Math.max(0, W / 2 - hx)
    const maxLoy = Math.max(0, H / 2 - hy)
    lox = Math.max(-maxLox, Math.min(lox, maxLox))
    loy = Math.max(-maxLoy, Math.min(loy, maxLoy))
    // 本地平移 → 屏幕平移
    return {
      zoom: z,
      tx: lox * cosT - loy * sinT,
      ty: lox * sinT + loy * cosT
    }
  },

  // 应用一组变换：先夹取到合法范围，写回 this._edit，再把 transform 串（唯一高频字段）setData 刷新画面。
  _applyEdit(zoom, tx, ty, angle) {
    const g = this._edit
    if (!g) {
      return
    }
    const clamped = this._clampTransform(zoom, tx, ty, angle)
    g.zoom = clamped.zoom
    g.tx = clamped.tx
    g.ty = clamped.ty
    g.angle = angle
    this.setData({
      editTransform: `translate(${g.tx.toFixed(2)}px, ${g.ty.toFixed(2)}px) rotate(${angle.toFixed(2)}deg) scale(${g.zoom.toFixed(4)})`
    })
  },

  // 记录一次手势的初始基准（单指=平移，双指=缩放+旋转+随中点平移）。切换手指数时用它重新起手。
  _startGesture(touches) {
    const g = this._edit
    if (!g) {
      return
    }
    const base = { zoom: g.zoom, tx: g.tx, ty: g.ty, angle: g.angle }
    if (touches.length >= 2) {
      const a = touches[0]
      const b = touches[1]
      this._gesture = {
        mode: 'pinch',
        dist: Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY) || 1,
        ang: Math.atan2(b.clientY - a.clientY, b.clientX - a.clientX),
        midX: (a.clientX + b.clientX) / 2,
        midY: (a.clientY + b.clientY) / 2,
        base
      }
    } else {
      const t = touches[0]
      this._gesture = { mode: 'pan', x: t.clientX, y: t.clientY, base }
    }
  },

  onEditTouchStart(e) {
    if (!this._edit) {
      return
    }
    if (this.data.editHint) {
      this.setData({ editHint: false })
    }
    this._startGesture(e.touches)
  },

  // 手势移动：单指平移；双指同时缩放+旋转（绕图片中心）+随双指中点平移。变换即时夹取，框内永不露白边。
  onEditTouchMove(e) {
    const g = this._gesture
    if (!g || !this._edit) {
      return
    }
    const touches = e.touches
    if (touches.length >= 2) {
      if (g.mode !== 'pinch') {
        this._startGesture(touches) // 单指途中落下第二指：改记双指基准
        return
      }
      const a = touches[0]
      const b = touches[1]
      const dist = Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY) || 1
      const ang = Math.atan2(b.clientY - a.clientY, b.clientX - a.clientX)
      const midX = (a.clientX + b.clientX) / 2
      const midY = (a.clientY + b.clientY) / 2
      this._applyEdit(
        g.base.zoom * (dist / g.dist),
        g.base.tx + (midX - g.midX),
        g.base.ty + (midY - g.midY),
        g.base.angle + ((ang - g.ang) * 180) / Math.PI
      )
    } else {
      if (g.mode !== 'pan') {
        this._startGesture(touches) // 双指抬起一指后继续拖：改记单指基准
        return
      }
      const t = touches[0]
      this._applyEdit(
        g.base.zoom,
        g.base.tx + (t.clientX - g.x),
        g.base.ty + (t.clientY - g.y),
        g.base.angle
      )
    }
  },

  onEditTouchEnd(e) {
    // 还有手指没抬起（如双指松了一指）：以剩余手指重新起手，保证继续拖动跟手
    if (e.touches && e.touches.length >= 1) {
      this._startGesture(e.touches)
    } else {
      this._gesture = null
    }
  },

  // 旋转按钮：在当前角度基础上 +90°。夹取会自动把 zoom 提到「转 90° 后仍铺满裁剪框」所需值，不露白边。
  rotate90() {
    const g = this._edit
    if (!g) {
      return
    }
    this._applyEdit(g.zoom, g.tx, g.ty, g.angle + 90)
  },

  // 原图：二次确认后还原到最原始的图片（把处理过的图片源换回原图，退出编辑态）
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
        // 之前编辑过：把图片源还原回最初的原图。
        // 原图本是远程地址（再次投屏/云端图，编辑前没有本地文件）时要清空 tempFilePath 回落到 url：
        // 若把 https 地址塞进 tempFilePath，结果页会把它当本地文件上传（必失败），
        // 且再次投屏「imgBle 且无 tempFilePath 则直传设备帧」的判定也会失效。
        if (updated._origSrc) {
          updated.tempFilePath = /^https?:\/\//i.test(updated._origSrc)
            ? ''
            : updated._origSrc
        }
        // 还原即非处理态：清掉裁剪宽高与展示尺寸，photo-wrap 回到默认满铺
        updated.cropW = 0
        updated.cropH = 0
        updated.wrapStyle = ''
        next[activeIndex] = updated
        this._edit = null
        this._gesture = null
        this.setData({
          images: next,
          activeImage: updated,
          activeTool: 'origin',
          editing: false
        })
        this.persistPending(next)
      }
    })
  },

  // 保存编辑：把当前「裁剪框内所见」的画面（含平移/缩放/旋转）真正合成并导出为设备物理分辨率的新图，
  // 写回当前图片并持久化（保证投屏的「设备图传」与「后端上传」用的都是处理后的图）。
  savePhoto() {
    if (!this.data.editing) {
      return
    }
    this.applyEditToCanvas()
  },

  // 一次画布合成完成裁剪+缩放+旋转：canvas 尺寸=设备物理分辨率，其坐标系恰好对应裁剪框，
  // 按预览时图片相对裁剪框的 平移/旋转/缩放 反算到 canvas，drawImage 整张原图，框外自然被画布裁掉。
  // 直接导出到设备分辨率：后端按上传图像素量化成六色帧（帧字节数=宽×高÷2），上传图必须正好是设备尺寸。
  applyEditToCanvas() {
    const g = this._edit
    const { activeIndex, images } = this.data
    const src = g && g.src
    if (!g || !src) {
      this.setData({ editing: false, activeTool: '' })
      return
    }
    const dev = this.getDeviceCropSize()
    const outW = dev.width
    const outH = dev.height
    // 显示 px → canvas px 的放大系数（裁剪框宽 → 设备宽）。frame 已锁设备比例，故高度也自洽（frameH*k=outH）。
    const k = outW / g.frameW
    // 图片中心在裁剪框内的位置（显示坐标 → canvas 坐标）
    const cx = (g.frameW / 2 + g.tx) * k
    const cy = (g.frameH / 2 + g.ty) * k
    // 原图 px → canvas px：baseScale(显示/原图) × zoom × k
    const s = g.baseScale * g.zoom * k
    const rad = (g.angle * Math.PI) / 180

    wx.showLoading({ title: '处理中', mask: true })
    const query = wx.createSelectorQuery()
    query.select('#cropCanvas').fields({ node: true }).exec((res) => {
      const node = res && res[0] && res[0].node
      if (!node) {
        wx.hideLoading()
        toast.warn({ title: '处理失败：画布不可用', icon: 'none' })
        return
      }
      node.width = outW
      node.height = outH
      const ctx = node.getContext('2d')
      const img = node.createImage()
      img.onload = () => {
        ctx.clearRect(0, 0, outW, outH)
        fillWhite(ctx, outW, outH)
        ctx.save()
        ctx.translate(cx, cy)
        ctx.rotate(rad)
        ctx.scale(s, s)
        ctx.drawImage(img, -g.natW / 2, -g.natH / 2, g.natW, g.natH)
        ctx.restore()
        wx.canvasToTempFilePath({
          canvas: node,
          fileType: EXPORT_FILE_TYPE,
          quality: EXPORT_QUALITY,
          success: (r) => {
            const next = images.slice()
            const updated = Object.assign({}, next[activeIndex])
            // 首次编辑时备份原图源，供「原图」还原
            if (!updated._origSrc) {
              updated._origSrc = updated.tempFilePath || updated.url || ''
            }
            updated.tempFilePath = r.tempFilePath
            // 记录处理后真实宽高，并预算 photo-wrap 展示尺寸：展示当前图时按设备比例铺满
            updated.cropW = outW
            updated.cropH = outH
            updated.wrapStyle = this.computeWrapStyle(outW, outH)
            next[activeIndex] = updated
            this._edit = null
            this._gesture = null
            this.setData({
              images: next,
              activeImage: updated,
              editing: false,
              activeTool: ''
            })
            this.persistPending(next)
            wx.hideLoading()
            toast.show({ title: '已保存', icon: 'none' })
          },
          fail: () => {
            wx.hideLoading()
            toast.warn({ title: '导出失败', icon: 'none' })
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

  // 把当前 images 写回 Storage(pendingProjection)，保证结果页拿到的是处理后的图
  persistPending(images, performance) {
    const pending = wx.getStorageSync('pendingProjection') || {}
    pending.images = images
    pending.device = this.data.device || pending.device
    if (performance) {
      pending.performance = Object.assign({}, pending.performance, performance)
    }
    wx.setStorageSync('pendingProjection', pending)
  },

  // 把一张「没经用户编辑」的图，按设备比例做 aspectFill 中心裁切并导出为新临时文件。
  // 目的：用户不做任何编辑就投屏时，让上传后端/图传用的图与预览所见（photo-img mode=aspectFill
  // 铺满设备比例的 photo-wrap，即中心裁切）完全一致——后端即便按设备分辨率转码也不会再变形。
  // 返回 Promise<裁切后的 image>；读尺寸/画布/导出任一步失败都回退原 image（resolve，不阻断投屏）。
  coverCropOne(image) {
    return new Promise(resolve => {
      const src = image && (image.tempFilePath || image.url)
      if (!src) {
        resolve(image)
        return
      }
      wx.getImageInfo({
        src,
        success: info => {
          const natW = info.width
          const natH = info.height
          const size = this.getDeviceCropSize()
          const targetRatio = size.width / size.height
          if (!(natW > 0) || !(natH > 0) || !(targetRatio > 0)) {
            resolve(image)
            return
          }
          // aspectFill 中心裁切：从原图中心取「设备比例」的最大矩形，超出的边裁掉（与预览铺满一致）
          let sw
          let sh
          let sx
          let sy
          if (natW / natH > targetRatio) {
            // 原图偏宽：高取满，裁掉左右
            sh = natH
            sw = Math.round(natH * targetRatio)
            sx = Math.round((natW - sw) / 2)
            sy = 0
          } else {
            // 原图偏高（或相等）：宽取满，裁掉上下
            sw = natW
            sh = Math.round(natW / targetRatio)
            sx = 0
            sy = Math.round((natH - sh) / 2)
          }
          // 直接导出到设备物理分辨率：后端是按「上传图的像素」量化成六色帧的（帧字节数=宽×高÷2），
          // 上传图必须正好是设备尺寸，否则帧大小对不上设备、投屏必失败（如 725×1024→726×1024÷2=371712，
          // 设备 680×960 只要 326400）。裁剪矩形 sw×sh 已是设备比例，等比 fit 到设备尺寸即精确得到设备像素、
          // 比例一致不会变形；比设备小的图会放大（correctness 优先，画质本就受六色量化限制）。
          const fit = Math.min(size.width / sw, size.height / sh)
          const outW = Math.max(1, Math.round(sw * fit))
          const outH = Math.max(1, Math.round(sh * fit))
          const query = wx.createSelectorQuery()
          query.select('#cropCanvas').fields({ node: true }).exec(res => {
            const node = res && res[0] && res[0].node
            if (!node) {
              resolve(image)
              return
            }
            node.width = outW
            node.height = outH
            const ctx = node.getContext('2d')
            const img = node.createImage()
            img.onload = () => {
              ctx.clearRect(0, 0, outW, outH)
              fillWhite(ctx, outW, outH)
              ctx.drawImage(img, sx, sy, sw, sh, 0, 0, outW, outH)
              wx.canvasToTempFilePath({
                canvas: node,
                fileType: EXPORT_FILE_TYPE,
                quality: EXPORT_QUALITY,
                success: r => {
                  const updated = Object.assign({}, image)
                  // 备份原图源，供「原图」还原（与编辑导出一致，已备份则不覆盖）
                  if (!updated._origSrc) {
                    updated._origSrc = updated.tempFilePath || updated.url || ''
                  }
                  updated.tempFilePath = r.tempFilePath
                  updated.cropW = outW
                  updated.cropH = outH
                  updated.wrapStyle = this.computeWrapStyle(outW, outH)
                  resolve(updated)
                },
                fail: () => resolve(image)
              })
            }
            img.onerror = () => resolve(image)
            img.src = src
          })
        },
        fail: () => resolve(image)
      })
    })
  },

  // 遍历待投屏图：对「没做过编辑」的首次投屏图（无 cropW，含编辑后又「还原」回原图的）按设备比例
  // aspectFill 中心裁切成与预览一致的图。两类原样保留、不裁切：
  //   ① 用户已编辑过的图（cropW>0）：尊重其处理结果；
  //   ② 再次/重新投屏的直传帧（带 imgBle）：result.js 靠「有 imgBle 且无 tempFilePath」直传旧设备帧，
  //      绝不能给它生成 tempFilePath 打破直传（用户若在预览页重新编辑过，applyEditToCanvas 已产生 tempFilePath/cropW，走转换链路）。
  // 串行处理（共用单个离屏 #cropCanvas，避免并发抢画布）。任一张裁切失败回退原图，不阻断投屏。
  async coverCropUnedited(images) {
    const result = []
    for (let i = 0; i < images.length; i++) {
      const image = images[i]
      if (image && (image.cropW || image.imgBle)) {
        result.push(image)
      } else {
        result.push(await this.coverCropOne(image))
      }
    }
    return result
  },

  // 确认投屏：基础校验后跳到结果页，由结果页真实连接设备并走 BLE 图传（带真实进度）。
  // 设备空间是否够、能否连接，都在结果页用真实读到的容量/掩码与连接结果判断，这里不再用假数据预判。
  async confirmProjection() {
    // 编辑态下按钮置灰不可投屏，需先保存或还原退出编辑
    if (this.data.editing) {
      return
    }
    // 投屏中防连点（此前 projecting 状态位定义了、模板也引用了，但从未赋值）：
    // hideLoading 到 redirectTo 之间存在连点窗口，双跳转会报 routeDone 类错误
    if (this.data.projecting) {
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

    // 没做任何编辑的图：按预览的 aspectFill（设备比例中心裁切）先裁一次再传，做到「所见即所得」，
    // 后端即便按设备分辨率转码也不会再变形。已编辑过的图沿用其结果（见 coverCropUnedited）。
    this.setData({ projecting: true }) // 按钮切「投屏中」并锁定，跳转失败时在下方复位
    wx.showLoading({ title: '处理中', mask: true })
    const prepareStartedAt = Date.now()
    let images
    try {
      images = await this.coverCropUnedited(this.data.images)
    } catch (error) {
      images = this.data.images // 裁切异常不阻断投屏，退回原图
    }
    wx.hideLoading()
    const performance = {
      traceId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      previewPrepareMs: Date.now() - prepareStartedAt,
      preparedImages: images.length
    }
    console.log('[投屏性能] 预览处理完成', performance)

    // 把（编辑/自动 aspectFill 后的）图片写回 Storage，再跳结果页真实图传
    this.setData({ images })
    this.persistPending(images, performance)
    wx.redirectTo({
      url: '/subpackages/projection/result/result?status=progress',
      fail: () => {
        // 跳转失败（极少见）：复位锁，允许用户重试
        this.setData({ projecting: false })
      }
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
