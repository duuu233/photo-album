const IMAGE_SRC = '/assets/images/1.png'
const OUTPUT_SIZE = 800

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function normalizeAngle(value) {
  let angle = Number(value) || 0
  while (angle > 180) angle -= 360
  while (angle < -180) angle += 360
  return Math.round(angle)
}

function getDistance(touches) {
  if (!touches || touches.length < 2) return 0
  const dx = touches[0].clientX - touches[1].clientX
  const dy = touches[0].clientY - touches[1].clientY
  return Math.sqrt(dx * dx + dy * dy)
}

Page({
  data: {
    ready: false,
    frameStyle: '',
    canvasWidth: 0,
    canvasHeight: 0,
    cropLeft: 0,
    cropTop: 0,
    cropSize: 0,
    scaleMin: 60,
    scaleMax: 220,
    scaleValue: 100,
    angle: 0,
    offsetX: 0,
    offsetY: 0,
    previewPath: ''
  },

  onReady() {
    this.initCanvas()
  },

  initCanvas() {
    const query = wx.createSelectorQuery().in(this)
    query.select('#cropCanvas').fields({ node: true, size: true })
    query.select('#exportCanvas').fields({ node: true, size: true })
    query.exec((res) => {
      const editor = res[0]
      const exporter = res[1]
      if (!editor || !editor.node || !exporter || !exporter.node) {
        wx.showToast({ title: 'Canvas 初始化失败', icon: 'none' })
        return
      }

      const systemInfo = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
      this.pixelRatio = systemInfo.pixelRatio || 1
      this.cropCanvas = editor.node
      this.cropContext = this.cropCanvas.getContext('2d')
      this.exportCanvas = exporter.node
      this.exportContext = this.exportCanvas.getContext('2d')

      this.canvasWidth = editor.width
      this.canvasHeight = editor.height
      this.cropCanvas.width = editor.width * this.pixelRatio
      this.cropCanvas.height = editor.height * this.pixelRatio
      this.cropContext.scale(this.pixelRatio, this.pixelRatio)

      const cropSize = Math.round(Math.min(editor.width, editor.height) * 0.72)
      const cropLeft = Math.round((editor.width - cropSize) / 2)
      const cropTop = Math.round((editor.height - cropSize) / 2)
      const frameStyle = `left: ${cropLeft}px; top: ${cropTop}px; width: ${cropSize}px; height: ${cropSize}px;`

      this.setData({
        canvasWidth: editor.width,
        canvasHeight: editor.height,
        cropLeft,
        cropTop,
        cropSize,
        frameStyle
      })

      this.loadSourceImage()
    })
  },

  loadSourceImage() {
    const image = this.cropCanvas.createImage()
    image.onload = () => {
      this.sourceImage = image
      this.setData({ ready: true }, () => this.drawPreview())
    }
    image.onerror = () => {
      wx.showToast({ title: '图片加载失败', icon: 'none' })
    }
    image.src = IMAGE_SRC
  },

  getImageScale() {
    if (!this.sourceImage) return 1
    const baseScale = Math.max(
      this.data.cropSize / this.sourceImage.width,
      this.data.cropSize / this.sourceImage.height
    )
    return baseScale * (this.data.scaleValue / 100)
  },

  drawImage(ctx) {
    const { canvasWidth, canvasHeight, offsetX, offsetY, angle } = this.data
    const image = this.sourceImage
    if (!image) return

    ctx.save()
    ctx.translate(canvasWidth / 2 + offsetX, canvasHeight / 2 + offsetY)
    ctx.rotate((angle * Math.PI) / 180)
    ctx.scale(this.getImageScale(), this.getImageScale())
    ctx.drawImage(image, -image.width / 2, -image.height / 2)
    ctx.restore()
  },

  drawPreview() {
    if (!this.cropContext || !this.sourceImage) return

    const ctx = this.cropContext
    const { canvasWidth, canvasHeight } = this.data
    ctx.clearRect(0, 0, canvasWidth, canvasHeight)
    ctx.fillStyle = '#111827'
    ctx.fillRect(0, 0, canvasWidth, canvasHeight)
    this.drawImage(ctx)
  },

  updateTransform(nextData) {
    this.setData(nextData, () => this.drawPreview())
  },

  handleScaleChange(event) {
    const value = clamp(Number(event.detail.value), this.data.scaleMin, this.data.scaleMax)
    this.updateTransform({ scaleValue: Math.round(value) })
  },

  handleAngleChange(event) {
    this.updateTransform({ angle: normalizeAngle(event.detail.value) })
  },

  handleOffsetXChange(event) {
    this.updateTransform({ offsetX: clamp(Math.round(event.detail.value), -220, 220) })
  },

  handleOffsetYChange(event) {
    this.updateTransform({ offsetY: clamp(Math.round(event.detail.value), -220, 220) })
  },

  handleTouchStart(event) {
    const touches = event.touches || []
    if (touches.length === 1) {
      this.touchState = {
        mode: 'move',
        startX: touches[0].clientX,
        startY: touches[0].clientY,
        offsetX: this.data.offsetX,
        offsetY: this.data.offsetY
      }
      return
    }

    if (touches.length >= 2) {
      this.touchState = {
        mode: 'scale',
        distance: getDistance(touches),
        scaleValue: this.data.scaleValue
      }
    }
  },

  handleTouchMove(event) {
    if (!this.touchState) return
    const touches = event.touches || []

    if (this.touchState.mode === 'move' && touches.length === 1) {
      const offsetX = this.touchState.offsetX + touches[0].clientX - this.touchState.startX
      const offsetY = this.touchState.offsetY + touches[0].clientY - this.touchState.startY
      this.updateTransform({
        offsetX: clamp(Math.round(offsetX), -220, 220),
        offsetY: clamp(Math.round(offsetY), -220, 220)
      })
      return
    }

    if (this.touchState.mode === 'scale' && touches.length >= 2) {
      const distance = getDistance(touches)
      if (!this.touchState.distance || !distance) return
      const scaleValue = this.touchState.scaleValue * (distance / this.touchState.distance)
      this.updateTransform({
        scaleValue: Math.round(clamp(scaleValue, this.data.scaleMin, this.data.scaleMax))
      })
    }
  },

  handleTouchEnd() {
    this.touchState = null
  },

  rotateLeft() {
    this.updateTransform({ angle: normalizeAngle(this.data.angle - 90) })
  },

  rotateRight() {
    this.updateTransform({ angle: normalizeAngle(this.data.angle + 90) })
  },

  resetTransform() {
    this.updateTransform({
      scaleValue: 100,
      angle: 0,
      offsetX: 0,
      offsetY: 0,
      previewPath: ''
    })
  },

  exportCrop() {
    if (!this.sourceImage || !this.exportCanvas || !this.exportContext) {
      wx.showToast({ title: '图片未准备好', icon: 'none' })
      return
    }

    wx.showLoading({ title: '生成中' })

    const { cropLeft, cropTop, cropSize } = this.data
    const ctx = this.exportContext
    this.exportCanvas.width = OUTPUT_SIZE
    this.exportCanvas.height = OUTPUT_SIZE
    ctx.clearRect(0, 0, OUTPUT_SIZE, OUTPUT_SIZE)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, OUTPUT_SIZE, OUTPUT_SIZE)

    const exportScale = OUTPUT_SIZE / cropSize
    ctx.save()
    ctx.scale(exportScale, exportScale)
    ctx.translate(-cropLeft, -cropTop)
    this.drawImage(ctx)
    ctx.restore()

    wx.canvasToTempFilePath({
      canvas: this.exportCanvas,
      fileType: 'png',
      destWidth: OUTPUT_SIZE,
      destHeight: OUTPUT_SIZE,
      success: (res) => {
        this.setData({ previewPath: res.tempFilePath })
        wx.hideLoading()
      },
      fail: () => {
        wx.hideLoading()
        wx.showToast({ title: '生成失败', icon: 'none' })
      }
    })
  }
})
