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
const lowBattery = require('../../../utils/low-battery')
const api = require('../../../utils/api')
const toast = require('../../../utils/toast')

const app = getApp()

// 顶部大图的占位比例（高/宽×100）。3:4 与图库列表的 DEFAULT_RATIO 同源：后端列表/详情都还没下发
// 图片宽高，只能先占一个常见比例，等 bindload 报回真实尺寸再校正这一张。
const HERO_PAD_DEFAULT = 133.33
// 极端比例钳一下：太扁的图（<40）大图会缩成一条、白卡几乎顶到导航栏；太长的图（>240）
// 下半截本来就在屏幕外（大图 absolute 不跟着滚），再长只是把白卡推得更远、什么也换不来。
const HERO_PAD_MIN = 40
const HERO_PAD_MAX = 240

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
    // 顶部大图的高度占位（2026-08-13 需求 4）：值是「图片高/宽×100」，wxml 里当 vw 用，
    // 于是盒子比例＝图片比例，aspectFill 一个像素都裁不掉。
    // 首屏用 3:4 兜底（与图库列表 DEFAULT_RATIO 同源——后端列表/详情都还没给宽高，
    // 见 utils/gallery-api.js 文件头的后端缺口清单），bindload 拿到真实尺寸后校正。
    heroPad: HERO_PAD_DEFAULT,
    projecting: false,
    // 选中态在 device-picker-sheet 组件内部持有（2026-08-13 需求 3 起不再默认选中）
    devicePicker: {
      show: false,
      loading: false,
      devices: []
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

  // 顶部大图加载完成：用真实宽高校正占位比例（2026-08-13 需求 4）。
  // 只有这里能拿到尺寸——后端列表/详情都不下发图片宽高。
  onHeroLoad(event) {
    const detail = (event && event.detail) || {}
    const width = Number(detail.width) || 0
    const height = Number(detail.height) || 0
    if (!width || !height) {
      return // 读不到尺寸就保持兜底比例，别把大图算成 0 高
    }
    const pad = Math.min(
      HERO_PAD_MAX,
      Math.max(HERO_PAD_MIN, Number(((height / width) * 100).toFixed(2)))
    )
    if (pad !== this.data.heroPad) {
      this.setData({ heroPad: pad })
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

    // 未连接：弹已绑定设备列表。不预置选中项（2026-08-13 需求 3，口径同 AI 对话页）：
    // 投屏是往设备写图，端上替用户选好、他顺手一点就投到了别的设备上。
    this.setData({
      devicePicker: { show: true, loading: true, devices: [] }
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
        devicePicker: { show: true, loading: false, devices: pickerDevices }
      })
    } catch (error) {
      this.setData({ 'devicePicker.show': false })
    }
  },

  // 弹层里按下「连接并投屏」才真正开投（选中只是选中，见 device-picker-sheet）
  onDevicePickerConfirm(event) {
    const device = event.detail && event.detail.device
    this.setData({ 'devicePicker.show': false })
    if (device) {
      this.startProjection(device)
    }
  },

  closeDevicePicker() {
    this.setData({ 'devicePicker.show': false })
  },

  async startProjection(device) {
    // 先占住重入闸再弹提醒：低电量弹窗期间这一按钮保持「投屏中」态，点不出第二次投屏。
    this._projecting = true
    this.setData({ projecting: true })
    // 主动点「投屏 / 连接并投屏」：这台设备此刻已连接（电量读得到）且 ≤10% 就先提醒一次（2026-08-21）。
    // 口径同 AI 对话页——未连接那一支的连接发生在预览/结果页，属自动连接，不弹。
    await lowBattery.warnIfLow(activeDevice.findConnectedDeviceId(device), { device })
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
