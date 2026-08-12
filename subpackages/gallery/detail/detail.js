// 图片详情（设计稿：assets/ai/UI页面/图片详情-{未收藏,已收藏}.png）
//
// 投屏走**统一投屏链路**，与 AI 对话页完全一致（需求原文「投屏交互与 AI 对话模块一致」）：
//   已连接 → 直接进投屏流程；未连接 → 弹已绑定设备列表，选完自动连接。
//   做法都是把图片下载成本地临时文件、包装成与手选照片同形态的 `pendingProjection` 写 Storage，
//   再进 preview 页；预热连接与 ensureConnection 由 preview/result 负责，这里不碰 BLE。
//   见 docs/architecture/image-projection-pipeline.md。
//
// 2026-08-12：图片数据与收藏关系由 mock 切到真实后端
// （`GET /Client/Product/getProductImgDetail`、`POST /Client/Product/setImgCollected`，
//  详见 utils/gallery-api.js）。详情是**唯一**能直接读到收藏态的接口（`isAlreadyCollected`），
//  列表那边只能靠收藏列表在端上标记。
const fold = require('../../../utils/fold-adapt')
const galleryApi = require('../../../utils/gallery-api')
const activeDevice = require('../../../utils/active-device')
const api = require('../../../utils/api')
const toast = require('../../../utils/toast')

const app = getApp()

Page(fold.adapt({
  data: {
    // sizes 不再进页面数据：「适用设备尺寸」区块 2026-08-12 已按产品要求去掉
    //（接口/mock 仍下发该字段，只是端上不渲染，见 detail.wxml 里的注释）。
    photo: {
      id: '',
      title: '',
      desc: '',
      url: '',
      favorited: false
    },
    projecting: false,
    devicePicker: {
      show: false,
      loading: false,
      devices: [],
      selectedId: ''
    }
  },

  onLoad(query) {
    this.photoId = (query && query.id) || ''
    this.loadDetail()
  },

  async loadDetail() {
    if (!this.photoId) {
      toast.show('图片不存在')
      setTimeout(() => wx.navigateBack(), 1200)
      return
    }
    try {
      const photo = await galleryApi.getPhotoDetail(this.photoId)
      this.setData({ photo })
    } catch (error) {
      toast.show((error && error.message) || '图片加载失败')
      setTimeout(() => wx.navigateBack(), 1200)
    }
  },

  async onToggleFavorite() {
    if (!app.requireLogin()) {
      return
    }
    // 同步闸：连点会让本地态与服务端来回打架
    if (this._toggling) {
      return
    }
    this._toggling = true
    try {
      const favorited = await galleryApi.toggleFavorite(
        this.data.photo.id,
        this.data.photo.favorited
      )
      this.setData({ 'photo.favorited': favorited })
      toast.show(favorited ? '已收藏' : '已取消收藏')
    } catch (error) {
      toast.warn('操作失败，请重试')
    } finally {
      this._toggling = false
    }
  },

  // ==================== 投屏 ====================

  async onProject() {
    if (this.data.projecting || this._projecting) {
      return
    }
    if (!this.data.photo.url) {
      return
    }
    if (!app.requireLogin()) {
      return
    }

    const device = activeDevice.getActiveDevice()
    if (device && activeDevice.isDeviceConnected(device)) {
      this.startProjection(device)
      return
    }

    // 未连接：弹已绑定设备列表
    const selectedId = device && device.id != null ? String(device.id) : ''
    this.setData({
      devicePicker: { show: true, loading: true, devices: [], selectedId }
    })
    try {
      const devices = await api.getDevices()
      if (!devices.length) {
        this.setData({ 'devicePicker.show': false })
        toast.show('暂无已绑定电子纸设备，请先绑定电子纸设备')
        return
      }
      // pickerId 兜底链与 AI 对话页一致：后端记录主键缺失时才退到 deviceId/名称，
      // 它只用于「这一屏里选中了哪一行」，不是设备物理身份（身份必须是完整 6 字节 ID）。
      const pickerDevices = devices.map((item, index) =>
        Object.assign({}, item, {
          pickerId: String(
            item.id != null ? item.id : (item.deviceId || item.deviceNo || item.name || index)
          )
        })
      )
      this.setData({
        devicePicker: { show: true, loading: false, devices: pickerDevices, selectedId }
      })
    } catch (error) {
      this.setData({ 'devicePicker.show': false })
    }
  },

  onDevicePickerSelect(event) {
    const index = event.currentTarget.dataset.index
    const device = this.data.devicePicker.devices[index]
    this.setData({ 'devicePicker.show': false })
    if (device) {
      this.startProjection(device)
    }
  },

  closeDevicePicker() {
    this.setData({ 'devicePicker.show': false })
  },

  async startProjection(device) {
    this._projecting = true
    this.setData({ projecting: true })
    wx.showLoading({ title: '准备投屏', mask: true })

    let tempFilePath
    try {
      tempFilePath = await this.downloadPhoto(this.data.photo.url)
    } catch (error) {
      wx.hideLoading()
      this._projecting = false
      this.setData({ projecting: false })
      toast.warn((error && error.message) || '图片下载失败')
      return
    }

    wx.hideLoading()
    this._projecting = false
    this.setData({ projecting: false })

    // 与手选照片同形态：preview 页按设备比例做非破坏性构图，result 页重新确认设备身份再出帧
    wx.setStorageSync('pendingProjection', {
      device,
      images: [
        {
          tempFilePath,
          name: this.data.photo.title || '官方图库',
          sizeMb: 2.5
        }
      ]
    })
    wx.navigateTo({ url: '/subpackages/projection/preview/preview' })
  },

  downloadPhoto(url) {
    return new Promise((resolve, reject) => {
      if (!url) {
        reject(new Error('图片地址为空'))
        return
      }
      wx.downloadFile({
        url,
        success: (res) => {
          if (res.statusCode === 200 && res.tempFilePath) {
            resolve(res.tempFilePath)
          } else if (res.statusCode === 403 || res.statusCode === 404) {
            reject(new Error('图片已下架或无访问权限'))
          } else {
            reject(new Error(`图片下载失败（HTTP ${res.statusCode}）`))
          }
        },
        fail: (err) => reject(new Error((err && err.errMsg) || '图片下载失败'))
      })
    })
  },

  // 弹层内部点击阻止冒泡到遮罩（项目惯例）
  noop() {}
}))
