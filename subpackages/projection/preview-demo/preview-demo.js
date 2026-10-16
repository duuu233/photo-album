const createPreviewPage = require('../preview/preview-page')
const system = require('../../../utils/system')
const toast = require('../../../utils/toast')

const SAMPLE_IMAGES = [
  'https://images.unsplash.com/photo-1470770841072-f978cf4d019e?auto=format&fit=crop&w=1600&q=85',
  'https://images.unsplash.com/photo-1500534623283-312aade485b7?auto=format&fit=crop&w=1200&q=85'
]

const options = createPreviewPage({
  readPreviewInput(query = {}) {
    const round = query.shape !== 'rectangle'
    return {
      device: {
        id: 'preview-demo',
        name: round ? '圆形预览演示' : '方形预览演示',
        shapeType: round ? 1 : 0,
        width: round ? 500 : 480,
        height: round ? 500 : 720,
        rotationDegree: 270,
        verticalRotation: 0
      },
      images: SAMPLE_IMAGES.map((url, index) => ({ url, name: `演示照片 ${index + 1}` }))
    }
  },

  warmupPreview() {},

  persistPending() {
    this._saveEditState()
  },

  async confirmProjection() {
    if (!this._demoEnabled || this.data.projecting || !this.data.images.length) {
      return
    }
    this.setData({ projecting: true })
    this._clearPrebake()
    wx.showLoading({ title: '生成本地预览', mask: true })
    try {
      const images = await this.prepareProjectionImages()
      if (this._unloaded) return
      const size = this.getDeviceCropSize()
      if (images.some(image => image.cropW !== size.width || image.cropH !== size.height)) {
        throw new Error('演示图片处理失败，请检查网络和开发工具域名设置')
      }
      const urls = images.map(image => image.tempFilePath)
      wx.previewImage({ current: urls[this.data.activeIndex], urls })
    } catch (error) {
      if (!this._unloaded) {
        toast.warn({ title: error.message || '生成演示预览失败', icon: 'none' })
      }
    } finally {
      wx.hideLoading()
      if (!this._unloaded) this.setData({ projecting: false })
    }
  }
})

const onLoad = options.onLoad
const onReady = options.onReady

options.onLoad = function (query) {
  this._demoEnabled = system.isDevEnv()
  if (!this._demoEnabled) {
    wx.switchTab({ url: '/pages/home/home' })
    return
  }
  onLoad.call(this, query)
}

options.onReady = function () {
  if (this._demoEnabled) return onReady.call(this)
}

Page(options)
