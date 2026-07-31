const system = require('../../../utils/system')
const toast = require('../../../utils/toast')
const activeDevice = require('../../../utils/active-device')
const dithering = require('../../../utils/dithering')
const deviceRotation = require('../../../utils/device-rotation')

// 设备屏幕分辨率（width×height）：列表/详情接口都会返回，取景框据此锁定宽高比（如 500x500 → 1:1）。
// 接口暂未返回该字段，这里先给默认值便于联调测试（如需 1:1 改成 { width: 500, height: 500 }）。
const DEFAULT_DEVICE_SIZE = { width: 480, height: 720 }

// 预览舞台（.preview-stage）的可用区域，单位 rpx：宽 = 屏宽 750 - 左右各 46 边距；
// 高度与 Flutter 的 Expanded + LayoutBuilder 对齐：680rpx 只是短屏下限，长屏会占满页面剩余空间。
// fallback / 烘焙预览必须使用 _measureStage 实测后的高度，不能再把 680rpx 当成固定上限。
const STAGE_W_RPX = 658
const STAGE_MIN_H_RPX = 680

// 画布导出格式（性能优化，2026-07-13）。canvasToTempFilePath 的 fileType 默认是 png——
// 照片存 png 是同画质 jpg 的 5~10 倍（长边 2000 的照片常到 5MB+）。而本页导出的这个临时文件
// 正是投屏要上传给转换方（2026-07-22 起为 seekink 抖动接口）出设备帧的源图：真机 trace 里
// 上传耗时曾高达 5.7s，几乎全耗在传大 png 上。统一导出 jpg：转换方在设备分辨率上量化成六色，
// q=0.92 对最终成像完全无损，体积却只有 1/10。jpg 不支持透明，导出前先铺白底，
// 避免透明区域变黑（照片无 alpha，纯属兜底）。
const EXPORT_FILE_TYPE = 'jpg'
const EXPORT_QUALITY = 0.92

// 编辑态缩放范围：允许把图片自由缩小、露出白色画布，导出时与预览保持所见即所得。
// 0.02 已接近“任意缩小”且避免 scale=0 导致手势无法恢复；放大仍保留像素保护上限。
const MIN_ZOOM_FACTOR = 0.02
const MAX_ZOOM_FACTOR = 8

// 长按拖拽（2026-07-24，仿苹果相册长按取图）：单指按住 LONG_PRESS_MS 毫秒且几乎不动 →
// 进入拖拽态（伴随图片放大回弹 + 震动反馈），此后单指移动才平移图片，松手即结束。
// 2026-07-31：产品要求 0.5s 后进入单指移动；改这里需同步 wxml 手势说明。
const LONG_PRESS_MS = 500
// 长按判定的位移容差(px)：按住期间移动超过它，即认定用户在「左右滑动切图」，取消长按计时。
const MOVE_CANCEL_PX = 12
// 左右滑动切图的提交阈值(px)：单指横向滑动累计超过它，松手切到上一张/下一张。
const SWIPE_COMMIT_PX = 50
// Banner 过场时长(ms)：松手后轨道补完剩下那段路要花的时间。
// ⚠️ 必须与 preview.wxss 里 .slide-track.is-animating 的 transition 时长同值——
//    JS 靠定时器等它走完才把 activeIndex 换掉，两边不一致就会出现「还没滑完就换图」或多等一截。
const SLIDE_MS = 300
// 已经是第一张还往右滑 / 最后一张还往左滑时的阻尼系数：滑得动（有反馈），但明显滑不过去。
const SLIDE_RUBBER = 3

// 切图后等待编辑层图片解码完成的兜底超时(ms)：正常由 <image> 的 bindload 回调放行，
// 但「新旧 src 恰好相同」等情况小程序不会再抛 load 事件，没有兜底就会永远停在过场态。
const EDIT_READY_TIMEOUT_MS = 800
// 手势/换向停下后多久把当前构图预烘焙进 previewSrc 缓存(ms)。
// 目的：把「切图那一刻才出图」的 showLoading('处理中') 提前到空闲期做掉，滑动切图就不再被打断。
const PREBAKE_IDLE_MS = 800

// 取景方向（2026-07-22 需求调整，替代原 VIEW_SWAPPED 总开关）：由图片下方的「竖向/横向」
// 分段控制器按张选择。两种方向改变的都只是「可视区域（取景框）」，图片本身不动，
// **页面展示交互两方向完全一致**；点「开始投屏」才把框内所见烘焙成上传图
//（见 prepareProjectionImages / bakeEditedImage）。
//   · 竖向 portrait —— 取景框 = 设备物理比例（竖向），导出直接画进设备分辨率画布，不旋转；
//   · 横向 landscape —— 取景框 = 设备宽高对调后的横向比例（相框躺着摆），展示照旧横向，
//     仅导出时整幅按设备 rotationDegree 旋转后画进**竖向设备分辨率**画布（2026-07-22 用户拍板恢复：
//     曾短暂改为「对调分辨率直出、方向交给接口侧」，接口侧不适配横向图，已回到本方案）。
const ORIENT_PORTRAIT = 'portrait'
const ORIENT_LANDSCAPE = 'landscape'
const DEFAULT_ORIENTATION = ORIENT_PORTRAIT

// 横向导出时整幅构图的旋转量（度，顺时针）由设备接口字段 rotationDegree 决定。
// 历史设备/旧缓存拿不到该字段时继续按 270° 处理，保持既有真机方向不变。
// 同一角度同时用于画布导出与手机端反向预览，绝不能在两处分别取值，否则会出现
// 「设备上正了、手机预览里倒了」。
//
// ⚠️ 横向取景的导出绝不能直接输出横向尺寸（如 960×680）：像素总数与竖向相同、帧字节数(宽×高÷2)
// 也相同，所以**转换接口不会报错**——但设备按 680px 一行解析，拿到 960px 一行的数据会整幅错位/斜切，
// 表现为花屏且无任何报错，极难排查。务必保持「取景横、导出竖 + 旋转」这个组合。
// 在画布上铺一层白底（jpg 无 alpha 通道，不铺底的话透明像素会被压成黑色）
function fillWhite(ctx, width, height) {
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)
}

// 判断一组编辑状态是否「什么都没动」：方向仍是默认竖向、没缩放、没平移、旋转角为整圈。
// 这类图与未编辑图完全等价，投屏时走 coverCropOne（中心裁切）即可，不必过画布再烘焙一遍。
function isPristineEdit(state) {
  if (!state || state.orientation !== DEFAULT_ORIENTATION) {
    return false
  }
  const angle = ((state.angle % 360) + 360) % 360
  return (
    Math.abs(state.zoom - 1) < 0.001 &&
    Math.abs(state.tx) < 0.5 &&
    Math.abs(state.ty) < 0.5 &&
    (angle < 0.01 || angle > 359.99)
  )
}

Page({
  data: {
    statusBarHeight: 20,
    safeBottom: 0,
    device: null,
    images: [],
    activeImage: null,
    // Banner 轨道左右两格要渲染的图（没有上一张/下一张时为 null，对应格子不渲染）。
    // 与 activeIndex 同步维护，统一走 _neighborPatch。
    prevImage: null,
    nextImage: null,
    activeIndex: 0,
    imageCount: 0,
    projecting: false,
    exportRotationDegree: deviceRotation.DEFAULT_ROTATION_DEG,

    // 常驻编辑态（2026-07-22）：进入页面/切换图片即自动对当前图开启编辑——单指平移、
    // 双指缩放+旋转、右上角按钮转90°。没有「保存」按钮，点「开始投屏」自动按框内所见烘焙上传。
    editing: false,
    // 编辑层的图片是否已解码可见（2026-07-25 修「来回切图闪一下」）：切图后编辑层先挂着但透明，
    // 等 <image> 的 bindload 到了才显形、同时藏掉当前格底图。二者交接期间始终有一层在画，不再露白。
    editReady: false,
    orientation: DEFAULT_ORIENTATION, // 当前图的取景方向（竖向/横向工具按钮，高亮对应图标）
    dragging: false, // 长按已进入拖拽态（.edit-clip 加浮起阴影）
    sliding: false, // Banner 过场进行中：期间不接新手势，等落位后才换 activeIndex 并重建编辑层
    slideDx: 0, // 轨道横向平移量(px)：跟手时逐帧下发，松手时置成 ±舞台宽补完过场
    slideAnimating: false, // 轨道是否挂着 CSS 过渡（跟手时必须 false，逐帧跟指头才不粘滞）
    editPickup: false, // 拖拽起手的一次性「放大回弹」动画标记（340ms 后自动清）
    editSrc: '', // 正在编辑的图片源
    editBaseW: 0, // 图片「铺满取景框(cover)」时的显示宽(px)，作为 zoom=1 基准
    editBaseH: 0, // 同上，高
    editImgLeft: 0, // 图片元素左上角 X(px，相对可视区容器 .edit-clip)：使其中心落在可视区中心
    editImgTop: 0, // 同上，Y
    editTransform: '', // translate/rotate/scale 组合串——仅此字段随手势高频 setData
    frame: null, // 可视区域 {left,top,width,height}(px，相对编辑层)，锁定当前方向比例、居中不动；
    // 定位 .edit-clip（区外内容被它 overflow:hidden 裁掉）与右上角转90°按钮

    deviceWrapStyle: '' // 编辑层没起来时 fallback 展示用：按设备（竖向）比例铺
  },

  onLoad() {
    this._unloaded = false
    this.setData(system.getLayoutMetrics())
    // 每张图的编辑状态（非破坏性）：index → _edit 快照。切图时存进来，切回时原样恢复，
    // 真正落文件统一等到点「开始投屏」（prepareProjectionImages）。
    this._states = {}
    this._edit = null // 当前图编辑数值真值（手势里不读 setData 后的异步 data）
    this._editSeq = 0 // enterEdit 防串台序号：异步量尺寸/读图期间用户又切了图，旧流程作废
    this._stageRect = null // 舞台 px 尺寸缓存（布局固定，只量一次）
    // 图片原始宽高缓存（src → {width,height}）：同一张图的像素尺寸不会变，没必要每次切回来都重量。
    // wx.getImageInfo 对远程 url 会走一次下载，不缓存的话「来回切换」每次都要重新等，正是闪烁的成因之一。
    this._infoCache = {}

    // 触摸手势状态机（2026-07-24）：'none' | 'idle'(单指按住等长按) | 'swipe'(左右切图)
    // | 'drag'(长按后拖拽) | 'pinch'(双指缩放旋转)
    this._mode = 'none'
    this._touch = null // 单指起手点 {startX,startY}
    this._pinch = null // 双指基准
    this._dragAnchor = null // 拖拽起手点 + 基准变换
    this._swipeDx = 0 // 本次单指横向累计位移（松手判定切图方向）
    this._switching = false // 切图在途锁（切之前可能要先烘焙预览缓存，防连续快滑排队）
    this._lpTimer = null // 长按计时器
    this._pickupTimer = null // 「放大回弹」动画清除计时器
    this._slideTimer = null // 切图滑动过场结束后重建编辑层的计时器
    this._readyTimer = null // editReady 兜底计时器（bindload 迟迟不来时强制放行）
    this._prebakeTimer = null // 空闲预烘焙计时器（手势停下 PREBAKE_IDLE_MS 后触发）
    this._bakeChain = null // 烘焙串行链：预烘焙与切图烘焙共用离屏画布，不能并发

    // 待投屏的设备与图片由上个页面通过 Storage 传入（见首页/相册的 openPreview）
    const pending = wx.getStorageSync('pendingProjection') || {}
    const images = pending.images || []
    const device = pending.device || null
    this.updateImageState(images, device, 0)

    // 压缩图片：产品要求恒为开启，页面已隐藏开关入口，故不再读取 Storage 覆盖（保持 data 默认 true）

    // 预热连接：必须按设备记录的完整身份查找/连接，不能直接复用 Storage 里的 BLE 句柄。
    // 旧缓存若曾把 B 的句柄写进 A，直接 ensureConnection(handle) 会在预览页悄悄连到 B。
    // 失败静默忽略，结果页还会走同一套身份校验后重连。
    if (
      device &&
      (device.deviceId ||
        device.bleDeviceId ||
        device.deviceNo ||
        device.productDeviceId)
    ) {
      activeDevice
        .ensureDeviceConnected(device, { showLoading: false })
        .then(deviceId => {
          if (this._unloaded) {
            return
          }
          const verified = Object.assign({}, device, {
            deviceId,
            bleDeviceId: deviceId,
            connected: true
          })
          this.setData({ device: verified })
        })
        .catch(() => {})
    }

    // 同理预热 seekink 抖动接口 token（getXTYUserToken，会话级缓存整程复用）：
    // 已有缓存时是空操作；失败静默，投屏出帧时会自动重取
    dithering.prefetchAuthToken()
  },

  onReady() {
    // 常驻编辑：首屏渲染完（舞台可测量）立即对当前图开启编辑态。
    // 放 onReady 是因为 enterEdit 要 boundingClientRect 量舞台，onLoad 时节点尚未渲染量不到。
    this.enterEdit()
  },

  // 统一刷新图片相关状态：当前预览图与张数（设备空间是否够由结果页按真实容量/掩码判断）
  updateImageState(images, device, activeIndex) {
    const safeIndex = Math.max(0, Math.min(activeIndex, images.length - 1)) // 防止下标越界
    // fallback（编辑层没起来时）的展示比例 = 设备物理（竖向）比例
    const size = this.getDeviceCropSize(device)
    this.setData(
      Object.assign(
        {
          device,
          exportRotationDegree: deviceRotation.degreeFor(device),
          images,
          activeIndex: safeIndex,
          activeImage: images[safeIndex] || null,
          imageCount: images.length,
          deviceWrapStyle: this.computeWrapStyle(size.width, size.height)
        },
        this._neighborPatch(images, safeIndex)
      )
    )
  },

  // Banner 轨道左右两格的数据源。没有上一张/下一张时给 null，模板里对应格子整块不渲染
  //（不能渲染成空格子：那样滑到边界会先露出一块灰底再弹回来）。
  _neighborPatch(images, index) {
    const list = images || []
    return {
      prevImage: list[index - 1] || null,
      nextImage: list[index + 1] || null
    }
  },

  // 直接换到某张图（无过场）。Banner 轨道量不到舞台宽等极端情况下的兜底路径；
  // 正常的左右滑动切图走 _slideToNeighbor（跟手 + 补完过场）后再落到这里收尾。
  // 切图前先把当前图的编辑状态存进 _states（只记变换+方向，不落文件），切回来时原样恢复。
  // 2026-07-25：这里**不再置 editing=false**——编辑层用 wx:if 销毁重建会连带把 <image> 拆掉，
  // 切回来必然重新下载解码（用户看到的「闪一下像重新加载」）。改为整层常驻、只切透明度。
  switchImage(index) {
    const { images, activeIndex } = this.data
    if (index < 0 || index >= images.length || index === activeIndex) {
      return
    }
    this._saveEditState()
    this._edit = null // 置空使手势自动失效
    this._mode = 'none'
    this._clearLongPress()
    this._clearPrebake()
    if (this._slideTimer) {
      clearTimeout(this._slideTimer)
      this._slideTimer = null
    }
    this.setData(
      Object.assign(
        {
          activeIndex: index,
          activeImage: images[index] || null,
          // 编辑层让位，露出当前格底图（静态、已解码）；交接期间始终有一层在画，不露白
          editReady: false,
          sliding: false,
          // 先摘过渡再把轨道归零，否则会看到轨道又「滑回来」一趟
          slideAnimating: false,
          slideDx: 0,
          dragging: false,
          editPickup: false
        },
        this._neighborPatch(images, index)
      )
    )
    this.enterEdit()
  },

  // 跟手平移轨道：滑到头（第一张再往右 / 最后一张再往左）时给阻尼，滑得动但明显滑不过去。
  _applySlideOffset(dx) {
    const { activeIndex, images } = this.data
    const atHead = dx > 0 && activeIndex <= 0
    const atTail = dx < 0 && activeIndex >= images.length - 1
    const offset = Math.round(atHead || atTail ? dx / SLIDE_RUBBER : dx)
    if (offset === this.data.slideDx && !this.data.slideAnimating) {
      return // 同一像素不重复 setData：手势期每帧都会调到这里
    }
    // 跟手期间绝不能挂着过渡，否则画面会拖在指头后面一截
    this.setData({ slideDx: offset, slideAnimating: false })
  },

  // 轨道弹回原位（没滑够阈值 / 已经滑到头）：挂上过渡平滑归零，走完再摘掉过渡标记。
  _springBackSlide() {
    if (!this.data.slideDx) {
      return
    }
    this.setData({ slideDx: 0, slideAnimating: true })
    if (this._slideTimer) {
      clearTimeout(this._slideTimer)
    }
    this._slideTimer = setTimeout(() => {
      this._slideTimer = null
      this.setData({ slideAnimating: false })
    }, SLIDE_MS)
  },

  // 松手后补完 Banner 过场并落到相邻那张。
  //
  // 关键顺序（这三步就是「切换不闪」的全部）：
  //   ① 轨道带过渡滑到 ∓一屏：滑走的是**编辑层此刻正显示的画面**，起手零跳变；
  //      进场那张由邻格承担，它整段过场都在屏上，落位时早已解码完毕；
  //   ② 过场同时静默烘焙当前构图（不弹「处理中」——那层蒙层本身就是一次闪）；
  //      烘焙只改当前格底图的 src，而底图此刻被编辑层盖着，看不见；
  //   ③ 过场走完后原地换 activeIndex、轨道无动画归零：进场那张从邻格变成当前格底图，
  //      同一个 src、同一套 wrapStyle、同一个位置，肉眼看不出接缝。
  async _slideToNeighbor(target, dir) {
    if (this._switching) {
      return
    }
    const stage = this._stageRect || (await this._measureStage())
    const width = (stage && stage.width) || 0
    if (!width) {
      this.switchImage(target) // 量不到舞台宽：退回无过场直切，功能不受影响
      return
    }
    this._switching = true
    // 过场期间不再接新手势：_edit 还留着（烘焙要用），靠 sliding 挡住 touch 分流
    this._mode = 'none'
    this._clearLongPress()
    this._clearPrebake()
    this.setData({
      sliding: true,
      slideAnimating: true,
      slideDx: -dir * width,
      dragging: false,
      editPickup: false
    })
    // 与过场并行：把当前构图烘焙进 previewSrc，滑回来时底图就是刚构好的画面而不是原图
    const baking = this.bakePreviewForActive({ silent: true }).catch((error) => {
      console.warn('[预览] 过场中的构图烘焙失败，滑回来会退回原图', error)
    })
    await new Promise((resolve) => {
      if (this._slideTimer) {
        clearTimeout(this._slideTimer)
      }
      this._slideTimer = setTimeout(resolve, SLIDE_MS)
    })
    this._slideTimer = null
    await baking // 正常已在过场期间做完；没做完就多等一下，别让 _saveEditState 抢在它前面
    this._switching = false
    this.switchImage(target)
  },

  // 把当前图的编辑数值快照进 _states（整个 _edit 存下来：烘焙要用 frame/baseScale 等几何量）
  _saveEditState() {
    const g = this._edit
    if (!g) {
      return
    }
    this._states[this.data.activeIndex] = Object.assign({}, g)
  },

  // 当前连接设备的屏幕分辨率(width×height)：列表/详情接口都会返回，这里直接取投屏页拿到的设备对象。
  // 接口未就绪/字段缺省时退回默认值，保证取景比例始终可用（便于联调测试）。
  getDeviceCropSize(device) {
    const d = device || this.data.device || {}
    const w = Number(d.width)
    const h = Number(d.height)
    return {
      width: w > 0 ? w : DEFAULT_DEVICE_SIZE.width,
      height: h > 0 ? h : DEFAULT_DEVICE_SIZE.height
    }
  },

  // 指定取景方向下的可视区域宽高：竖向 = 设备物理分辨率；横向 = 宽高对调。
  // 取景框比例、烘焙导出画布尺寸、photo-wrap 展示尺寸都以它为准（2026-07-22 起导出=所见，无旋转）。
  getViewSize(orientation, device) {
    const dev = this.getDeviceCropSize(device)
    return orientation === ORIENT_LANDSCAPE
      ? { width: dev.height, height: dev.width }
      : { width: dev.width, height: dev.height }
  },

  // 把实测舞台 px 尺寸换算成 rpx。首屏尚未测量时才回退到 658×680rpx；
  // 测量完成后与编辑层共用同一个真实舞台，避免 fallback 比取景框明显偏小。
  _stageSizeRpx() {
    const stage = this._stageRect
    if (stage && stage.width > 0 && stage.height > 0) {
      const rpxPerPx = STAGE_W_RPX / stage.width
      return {
        width: STAGE_W_RPX,
        height: stage.height * rpxPerPx
      }
    }
    return { width: STAGE_W_RPX, height: STAGE_MIN_H_RPX }
  },

  // 由一组宽高算出 photo-wrap 在舞台内等比缩放后的展示尺寸（rpx）。
  // 返回 {dispW, dispH}；宽高非法时返回 null。
  computeWrapSize(w, h) {
    if (!(w > 0) || !(h > 0)) {
      return null
    }
    const stage = this._stageSizeRpx()
    const aspect = w / h
    let dispW = stage.width
    let dispH = dispW / aspect
    if (dispH > stage.height) {
      dispH = stage.height
      dispW = dispH * aspect
    }
    return { dispW, dispH }
  },

  // 由处理后图片的真实像素宽高，算出 photo-wrap 的展示尺寸（rpx）：在舞台内等比缩放。
  // 返回内联 style 字符串；未处理(传入非法宽高)时返回空串，让 photo-wrap 回到 CSS 默认尺寸。
  computeWrapStyle(w, h) {
    const size = this.computeWrapSize(w, h)
    if (!size) {
      return ''
    }
    return `width:${size.dispW.toFixed(2)}rpx;height:${size.dispH.toFixed(2)}rpx;`
  },

  // 已按设备 rotationDegree 转过的横向成图（导出结果），在预览里要**反向转回来**展示，
  // 否则用户看到的是躺倒/颠倒的照片——文件本身是竖向（如 680×960）、内容是横的，直接铺进横向
  // photo-wrap 会又转又裁。做法：图片元素用「对调后的尺寸」(竖向 dispH×dispW)，绕中心反向旋转，
  // 转完正好铺满横向的 wrap。photo-wrap 已是 position:relative + overflow:hidden（见 wxss）。
  computeRotatedImgStyle(viewW, viewH) {
    const size = this.computeWrapSize(viewW, viewH)
    if (!size) {
      return ''
    }
    return (
      `position:absolute;left:50%;top:50%;` +
      `width:${size.dispH.toFixed(2)}rpx;height:${size.dispW.toFixed(2)}rpx;` +
      `transform:translate(-50%,-50%) rotate(${-this.data.exportRotationDegree}deg);`
    )
  },

  // 量取编辑舞台（.preview-stage）的 px 尺寸：页面初始布局完成后只量一次，
  // 切图/换向期间尺寸不变；实测高度同时用于 fallback photo-wrap。
  _measureStage() {
    return new Promise((resolve) => {
      if (this._stageRect) {
        resolve(this._stageRect)
        return
      }
      const query = wx.createSelectorQuery()
      query.select('.preview-stage').boundingClientRect()
      query.exec((res) => {
        const rect = res && res[0]
        if (rect && rect.width) {
          this._stageRect = { width: rect.width, height: rect.height }
          const size = this.getDeviceCropSize(this.data.device)
          const deviceWrapStyle = this.computeWrapStyle(size.width, size.height)
          if (deviceWrapStyle !== this.data.deviceWrapStyle) {
            this.setData({ deviceWrapStyle })
          }
        }
        resolve(this._stageRect || null)
      })
    })
  },

  // 舞台内「指定方向可视区域比例」的最大居中矩形 = 固定可视区域。
  // 区外内容由 .edit-clip 的 overflow:hidden 直接裁掉（2026-07-22 优化：不再画裁剪框/九宫格/遮罩）。
  _frameFor(stage, orientation) {
    const view = this.getViewSize(orientation)
    const ratio = view.width / view.height
    let fw = stage.width
    let fh = fw / ratio
    if (fh > stage.height) {
      fh = stage.height
      fw = fh * ratio
    }
    return {
      left: (stage.width - fw) / 2,
      top: (stage.height - fh) / 2,
      width: fw,
      height: fh
    }
  },

  // 读一张图的原始像素宽高，带进程内缓存（src → {width,height}）。
  // 同一个 src 的尺寸恒定，缓存后「来回切图」第二次起是同步命中，省掉一次 getImageInfo 往返
  //（远程 url 更是省掉一次下载），编辑层几乎能与 Banner 过场无缝接上。失败 resolve(null)，调用方回退。
  _getImageInfo(src) {
    return new Promise((resolve) => {
      const cached = this._infoCache[src]
      if (cached) {
        resolve(cached)
        return
      }
      wx.getImageInfo({
        src,
        success: (info) => {
          if (info && info.width > 0 && info.height > 0) {
            this._infoCache[src] = { width: info.width, height: info.height }
            resolve(this._infoCache[src])
          } else {
            resolve(null)
          }
        },
        fail: () => resolve(null)
      })
    })
  },

  // 预读相邻图片的尺寸（并顺带把远程图暖进微信的图片缓存），让第一次滑到它时也不用等。
  _prefetchNeighbors(index) {
    const images = this.data.images
    ;[index - 1, index + 1].forEach((i) => {
      const image = images[i]
      // 用 enterEdit 取源的同一套优先级（tempFilePath || url），预读的才是下次真正要量的那张
      const src = image && (image.tempFilePath || image.url)
      if (src && !this._infoCache[src]) {
        this._getImageInfo(src)
      }
    })
  },

  // 编辑层图片解码完成：此刻才让编辑层显形、当前格底图隐去（交接期间始终有一层在画，不露白底）。
  // 失败也照样放行，否则会永远停在过场态（编辑层透明 + 底图显示原图，等于没进编辑）。
  _markEditReady() {
    if (this._readyTimer) {
      clearTimeout(this._readyTimer)
      this._readyTimer = null
    }
    if (!this.data.editReady) {
      this.setData({ editReady: true })
    }
  },

  onEditImageLoad() {
    this._markEditReady()
  },

  onEditImageError() {
    this._markEditReady()
  },

  // 进入常驻编辑态：量出舞台尺寸 + 图片真实尺寸，摆好「固定取景框(按当前方向锁比例) + 铺满该框的图片」。
  // 之后单指平移 / 双指缩放+旋转 / 右上角按钮转90°，图片在框下自由变换，框不动，框内即最终成像。
  // 页面加载与「上一张/下一张」都会自动调用；同一张图已有编辑状态（_states）则原样恢复。
  // 失败（无图/量不到舞台/读图失败）不打扰用户：静默停在 fallback 普通预览，投屏走未编辑链路。
  enterEdit() {
    return new Promise((resolve) => {
      const index = this.data.activeIndex
      const image = this.data.images[index]
      const src = image && (image.tempFilePath || image.url)
      if (!src) {
        this.setData({ editing: false, editReady: false })
        resolve(false)
        return
      }
      // 已在编辑同一张图：直接复用当前变换，不重置（图片节点也不动，自然没有重新解码）
      if (this.data.editing && this._edit && this._edit.src === src) {
        this._markEditReady()
        resolve(true)
        return
      }
      // 之前存过状态且图片源没变（没被还原/烘焙过）才恢复，否则从头来
      const saved = this._states[index]
      const state = saved && saved.src === src ? saved : null
      const orientation = state ? state.orientation : DEFAULT_ORIENTATION
      const seq = ++this._editSeq
      this._measureStage().then((stage) => {
        if (!stage || seq !== this._editSeq) {
          if (!stage) {
            this.setData({ editing: false, editReady: false })
          }
          resolve(false)
          return
        }
        this._getImageInfo(src).then((info) => {
          if (seq !== this._editSeq) {
            resolve(false)
            return
          }
          if (!info) {
            this.setData({ editing: false, editReady: false })
            resolve(false)
            return
          }
          const frame = this._frameFor(stage, orientation)
          // cover：图片刚好铺满取景框的基准显示尺寸（zoom=1 时的显示 px/原图 px）
          const baseScale = Math.max(frame.width / info.width, frame.height / info.height)
          const baseW = info.width * baseScale
          const baseH = info.height * baseScale
          this._edit = {
            src,
            natW: info.width,
            natH: info.height,
            stageW: stage.width,
            stageH: stage.height,
            orientation,
            baseScale,
            baseW,
            baseH,
            frameLeft: frame.left,
            frameTop: frame.top,
            frameW: frame.width,
            frameH: frame.height,
            zoom: state ? state.zoom : 1,
            tx: state ? state.tx : 0,
            ty: state ? state.ty : 0,
            angle: state ? state.angle : 0
          }
          this._mode = 'none'
          this._clearLongPress()
          // 图片源没换（如「还原原图」还原成了同一个文件）时不会再抛 bindload，直接放行；
          // 换了源就先保持编辑层透明，等 bindload/兜底超时到了再显形（见 _markEditReady）。
          const sameSrc = this.data.editSrc === src
          this.setData({
            editing: true,
            editReady: sameSrc,
            orientation,
            editSrc: src,
            editBaseW: baseW,
            editBaseH: baseH,
            editImgLeft: frame.width / 2 - baseW / 2,
            editImgTop: frame.height / 2 - baseH / 2,
            frame,
            dragging: false,
            editPickup: false
          })
          this._applyEdit(this._edit.zoom, this._edit.tx, this._edit.ty, this._edit.angle)
          if (!sameSrc) {
            if (this._readyTimer) {
              clearTimeout(this._readyTimer)
            }
            this._readyTimer = setTimeout(() => {
              this._readyTimer = null
              this._markEditReady()
            }, EDIT_READY_TIMEOUT_MS)
          }
          this._prefetchNeighbors(index)
          resolve(true)
        })
      })
    })
  },

  // 「竖向/横向」分段控制器：只换取景框（可视区域），图片的位置/大小/角度原地保持不变——
  // 需求语义是「横竖切换改变的只是可视区域，对图片本身没有改动」。换框后 baseScale 变了，
  // 用 zoom 反向补偿保住绝对显示尺寸；_applyEdit 的夹取会在新框盖不满时自动把 zoom 顶上去。
  setOrientation(e) {
    const orient = e.currentTarget.dataset.orient
    if ((orient !== ORIENT_PORTRAIT && orient !== ORIENT_LANDSCAPE) || orient === this.data.orientation) {
      return
    }
    const g = this._edit
    if (!g) {
      this.setData({ orientation: orient }) // 编辑层没起来（读图失败等）：只记 UI 状态
      return
    }
    const frame = this._frameFor({ width: g.stageW, height: g.stageH }, orient)
    const newBaseScale = Math.max(frame.width / g.natW, frame.height / g.natH)
    const keepZoom = (g.baseScale * g.zoom) / newBaseScale
    g.orientation = orient
    g.frameLeft = frame.left
    g.frameTop = frame.top
    g.frameW = frame.width
    g.frameH = frame.height
    g.baseScale = newBaseScale
    g.baseW = g.natW * newBaseScale
    g.baseH = g.natH * newBaseScale
    this._mode = 'none'
    this._clearLongPress()
    this.setData({
      orientation: orient,
      frame,
      editBaseW: g.baseW,
      editBaseH: g.baseH,
      editImgLeft: frame.width / 2 - g.baseW / 2,
      editImgTop: frame.height / 2 - g.baseH / 2
    })
    this._applyEdit(keepZoom, g.tx, g.ty, g.angle)
    this._schedulePrebake()
  },

  // 约束一组变换：只限制极小/极大的缩放值，不再强制 cover，也不再把平移夹在图片边缘内。
  // 因而图片可任意缩小、可在白色画布中自由构图；离屏画布同样铺白底，预览与输出所见即所得。
  _clampTransform(zoom, tx, ty, angle) {
    return {
      zoom: Math.max(MIN_ZOOM_FACTOR, Math.min(Number(zoom) || 1, MAX_ZOOM_FACTOR)),
      tx: Number(tx) || 0,
      ty: Number(ty) || 0
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

  // —— 触摸手势（2026-07-24 重构，一层 catch 全部触摸再分流）——
  //  单指：默认判为「左右滑动切图」；若按住几乎不动满 LONG_PRESS_MS → 进入拖拽态后单指平移图片。
  //  双指：随时进入缩放 + 旋转（不需长按），与切图/拖拽互不影响（需求 6）。

  _clearLongPress() {
    if (this._lpTimer) {
      clearTimeout(this._lpTimer)
      this._lpTimer = null
    }
  },

  // 记录双指基准（缩放 + 旋转 + 随中点平移）
  _beginPinch(touches) {
    const g = this._edit
    const a = touches[0]
    const b = touches[1]
    // 单指横滑到一半又落下第二指：这一路不会再走 _commitSwipe，轨道得自己弹回原位，
    // 否则会歪着停在偏移位置上（2026-08-01）
    this._swipeDx = 0
    this._springBackSlide()
    this._mode = 'pinch'
    this._pinch = {
      dist: Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY) || 1,
      ang: Math.atan2(b.clientY - a.clientY, b.clientX - a.clientX),
      midX: (a.clientX + b.clientX) / 2,
      midY: (a.clientY + b.clientY) / 2,
      base: { zoom: g.zoom, tx: g.tx, ty: g.ty, angle: g.angle }
    }
  },

  // 长按满 2s：进入拖拽态，给「拿起」反馈（图片放大回弹 + 震动，仿苹果相册）
  _armDrag() {
    this._lpTimer = null
    if (this._mode !== 'idle' || !this._edit) {
      return
    }
    const g = this._edit
    this._mode = 'drag'
    this._dragAnchor = {
      x: this._touch.startX,
      y: this._touch.startY,
      base: { zoom: g.zoom, tx: g.tx, ty: g.ty, angle: g.angle }
    }
    if (wx.vibrateShort) {
      wx.vibrateShort({ type: 'medium' })
    }
    this.setData({ dragging: true, editPickup: true })
    if (this._pickupTimer) {
      clearTimeout(this._pickupTimer)
    }
    this._pickupTimer = setTimeout(() => {
      this._pickupTimer = null
      this.setData({ editPickup: false })
    }, 340)
  },

  onEditTouchStart(e) {
    // 过场进行中不接新手势：此刻 _edit 还指着「正在滑走的那张」，接下去只会把状态搅乱
    if (!this._edit || this.data.sliding) {
      return
    }
    const touches = e.touches
    if (touches.length >= 2) {
      this._clearLongPress()
      this._beginPinch(touches)
      return
    }
    const t = touches[0]
    this._singleAfterPinch = false
    this._mode = 'idle'
    this._touch = { startX: t.clientX, startY: t.clientY }
    this._swipeDx = 0
    this._clearLongPress()
    this._clearPrebake() // 手又动了：推迟空闲预烘焙，别在手势中途抢画布
    this._lpTimer = setTimeout(() => this._armDrag(), LONG_PRESS_MS)
  },

  onEditTouchMove(e) {
    if (!this._edit || this.data.sliding) {
      return
    }
    const touches = e.touches
    // 双指：随时进入 / 保持缩放 + 旋转
    if (touches.length >= 2) {
      if (this._mode !== 'pinch') {
        this._clearLongPress()
        this._beginPinch(touches) // 单指途中落下第二指：改记双指基准
        return
      }
      const a = touches[0]
      const b = touches[1]
      const dist = Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY) || 1
      const ang = Math.atan2(b.clientY - a.clientY, b.clientX - a.clientX)
      const midX = (a.clientX + b.clientX) / 2
      const midY = (a.clientY + b.clientY) / 2
      const p = this._pinch
      this._applyEdit(
        p.base.zoom * (dist / p.dist),
        p.base.tx + (midX - p.midX),
        p.base.ty + (midY - p.midY),
        p.base.angle + ((ang - p.ang) * 180) / Math.PI
      )
      return
    }

    const t = touches[0]
    // 双指抬起一指后重新进入 0.5s 长按判定，不允许剩余单指直接平移。
    if (this._mode === 'pinch' || !this._touch) {
      this._mode = 'idle'
      this._touch = { startX: t.clientX, startY: t.clientY }
      this._singleAfterPinch = true
      this._clearLongPress()
      this._lpTimer = setTimeout(() => this._armDrag(), LONG_PRESS_MS)
      return
    }
    const dx = t.clientX - this._touch.startX
    const dy = t.clientY - this._touch.startY

    if (this._mode === 'idle') {
      // 长按还没满就移动了 → 认定为「左右滑动切图」，取消长按计时
      if (Math.hypot(dx, dy) > MOVE_CANCEL_PX) {
        this._clearLongPress()
        // 从双指缩放落成单指后，移动只取消长按，不触发平移/切图；重新触摸才恢复左右切图。
        this._mode = this._singleAfterPinch ? 'none' : 'swipe'
      } else {
        return // 仍在原地按住，继续等长按
      }
    }

    if (this._mode === 'drag') {
      const a = this._dragAnchor
      this._applyEdit(
        a.base.zoom,
        a.base.tx + (t.clientX - a.x),
        a.base.ty + (t.clientY - a.y),
        a.base.angle
      )
      return
    }

    if (this._mode === 'swipe') {
      this._swipeDx = dx
      // 跟手：整条 Banner 轨道随指头平移（2026-08-01）。此前只记录 dx、画面纹丝不动，
      // 松手才「啪」地播一段过场——那不是 banner，是跳帧。
      this._applySlideOffset(dx)
    }
  },

  onEditTouchEnd(e) {
    this._clearLongPress()
    const touches = e.touches
    // 还有手指没抬（双指松掉一指）：重新等待 0.5s 长按，不能直接拖动。
    if (touches && touches.length >= 1 && this._edit) {
      const t = touches[0]
      this._mode = 'idle'
      this._touch = { startX: t.clientX, startY: t.clientY }
      this._singleAfterPinch = true
      this._lpTimer = setTimeout(() => this._armDrag(), LONG_PRESS_MS)
      return
    }
    const mode = this._mode
    this._mode = 'none'
    this._pinch = null
    if (this.data.dragging) {
      this.setData({ dragging: false })
    }
    if (mode === 'swipe') {
      this._commitSwipe(this._swipeDx || 0)
    } else if (mode === 'drag' || mode === 'pinch') {
      this._schedulePrebake() // 构图刚改完：空闲期先把预览缓存出好，下次切图就不用等
    }
    this._swipeDx = 0
    this._singleAfterPinch = false
  },

  // 松手结算：滑够阈值且方向上还有图 → 补完 Banner 过场切过去；否则轨道弹回原位。
  // 向右滑 → 上一张，向左滑 → 下一张。
  _commitSwipe(dx) {
    const { imageCount, activeIndex, images } = this.data
    const dir = dx > 0 ? -1 : 1
    const target = activeIndex + dir
    const canSwitch =
      imageCount > 1 &&
      Math.abs(dx) >= SWIPE_COMMIT_PX &&
      target >= 0 &&
      target < images.length
    if (!canSwitch) {
      this._springBackSlide() // 没滑够 / 到头了：平滑弹回，不要「啪」地跳回原位
      return
    }
    this._slideToNeighbor(target, dir)
  },

  // 图右上角悬浮按钮：在当前角度基础上顺时针 +90°，保留当前自由缩放与位置。
  rotate90() {
    const g = this._edit
    if (!g) {
      return
    }
    this._applyEdit(g.zoom, g.tx, g.ty, g.angle + 90)
    this._schedulePrebake()
  },

  // 原图：二次确认后清掉当前图的全部编辑（含之前烘焙过的文件），还原最初的图片并重新进入编辑态
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
        // 之前烘焙过：把图片源还原回最初的原图。
        // 原图本是远程地址（再次投屏/云端图，编辑前没有本地文件）时要清空 tempFilePath 回落到 url：
        // 若把 https 地址塞进 tempFilePath，结果页会把它当本地文件上传（必失败）。
        if (updated._origSrc) {
          updated.tempFilePath = /^https?:\/\//i.test(updated._origSrc)
            ? ''
            : updated._origSrc
        }
        // 还原即非处理态：清掉裁剪宽高与展示尺寸，photo-wrap 回到默认满铺
        updated.cropW = 0
        updated.cropH = 0
        updated.wrapStyle = ''
        updated.imgStyle = ''
        // 连同滑动切图的预览缓存一并作废，否则过场里还会闪出还原前的构图
        updated.previewSrc = ''
        updated._bakedKey = ''
        next[activeIndex] = updated
        delete this._states[activeIndex]
        this._edit = null
        this._mode = 'none'
        this._clearLongPress()
        this._clearPrebake()
        this.setData({
          images: next,
          activeImage: updated,
          orientation: DEFAULT_ORIENTATION,
          dragging: false,
          editPickup: false,
          editing: false,
          editReady: false
        })
        this.persistPending(next)
        this.enterEdit() // 还原后立刻对原图重新开启常驻编辑
      }
    })
  },

  // 共用离屏画布导出：把 src 载入后交给 draw(ctx, img) 绘制，导出为 outW×outH 的 jpg 临时文件。
  // 画布不可用/图片加载失败/导出失败都 reject，由调用方决定回退策略。串行使用（勿并发抢画布）。
  _exportCanvas(outW, outH, src, draw) {
    return new Promise((resolve, reject) => {
      const query = wx.createSelectorQuery()
      query.select('#cropCanvas').fields({ node: true }).exec((res) => {
        const node = res && res[0] && res[0].node
        if (!node) {
          reject(new Error('画布不可用'))
          return
        }
        node.width = outW
        node.height = outH
        const ctx = node.getContext('2d')
        const img = node.createImage()
        img.onload = () => {
          ctx.clearRect(0, 0, outW, outH)
          fillWhite(ctx, outW, outH)
          draw(ctx, img)
          wx.canvasToTempFilePath({
            canvas: node,
            fileType: EXPORT_FILE_TYPE,
            quality: EXPORT_QUALITY,
            success: (r) => resolve(r.tempFilePath),
            fail: reject
          })
        }
        img.onerror = () => reject(new Error('图片加载失败'))
        img.src = src
      })
    })
  },

  // 把一组编辑状态（取景框内所见：方向+平移+旋转+缩放）一次画布合成，烘焙为设备物理分辨率的新图。
  // canvas 尺寸=设备物理分辨率（竖向）：转换方（seekink 抖动接口）按上传图像素量化六色帧
  //（帧字节数=宽×高÷2），上传图必须正好是设备尺寸，这是硬约束。
  //   · 竖向：画布坐标系直接对应取景框，放大系数 k = outW / frameW；
  //   · 横向：先把整幅构图按设备 rotationDegree 旋转再画，k 按「取景框宽 → 画布高」算。
  // 失败 resolve 原图（不阻断投屏），console.warn 留痕。
  bakeEditedImage(image, g) {
    return this._bakeToFile(g)
      .then((tempFilePath) => this._applyBakedFile(image, g, tempFilePath))
      .catch((err) => {
        console.warn('[预览] 编辑烘焙失败，该图回退原图投屏', err)
        return image
      })
  },

  // 只出文件：把取景框内所见画进「竖向设备物理分辨率」画布并导出临时文件（几何见 bakeEditedImage 注释）。
  // 正式投屏出图与「滑动切图前的预览缓存」共用这一份，保证两者像素完全一致。
  _bakeToFile(g) {
    const dev = this.getDeviceCropSize()
    const outW = dev.width
    const outH = dev.height
    const landscape = g.orientation === ORIENT_LANDSCAPE
    const k = landscape ? outH / g.frameW : outW / g.frameW
    // 原图 px → canvas px：baseScale(显示/原图) × zoom × k
    const s = g.baseScale * g.zoom * k
    const rad = (g.angle * Math.PI) / 180
    const exportRotateRad = (this.data.exportRotationDegree * Math.PI) / 180
    return this._exportCanvas(outW, outH, g.src, (ctx, img) => {
      ctx.save()
      // 先落到画布中心（横向再按设备 rotationDegree 旋转整幅构图）：此后坐标系就等价于取景框，
      // 图片相对取景框中心的平移(tx,ty)、用户自己的旋转(rad)、缩放(s) 都能原样套用。
      ctx.translate(outW / 2, outH / 2)
      if (landscape) {
        ctx.rotate(exportRotateRad)
      }
      ctx.translate(g.tx * k, g.ty * k)
      ctx.rotate(rad)
      ctx.scale(s, s)
      ctx.drawImage(img, -g.natW / 2, -g.natH / 2, g.natW, g.natH)
      ctx.restore()
    })
  },

  // 把烘焙产物落到 image 上（正式投屏用）：换图片源 + 记尺寸 + 算展示样式。
  _applyBakedFile(image, g, tempFilePath) {
    const dev = this.getDeviceCropSize()
    const view = this.getViewSize(g.orientation)
    const updated = Object.assign({}, image)
    // 首次落文件时备份原图源，供「原图」还原
    if (!updated._origSrc) {
      updated._origSrc = updated.tempFilePath || updated.url || ''
    }
    updated.tempFilePath = tempFilePath
    // cropW/cropH 记的是**文件真实像素**（设备物理分辨率，竖向），别改成可视区域尺寸。
    // 展示按取景方向铺；横向成图是按设备角度转过的竖向文件，要再给图片元素一个反向旋转
    // 把它摆正（见 computeRotatedImgStyle），保证 fallback 展示仍是用户构图的样子。
    updated.cropW = dev.width
    updated.cropH = dev.height
    updated.wrapStyle = this.computeWrapStyle(view.width, view.height)
    updated.imgStyle = g.orientation === ORIENT_LANDSCAPE
      ? this.computeRotatedImgStyle(view.width, view.height)
      : ''
    // 预览缓存已并入正式产物，清掉避免再被当缓存复用（此时 tempFilePath 已是烘焙图）
    updated.previewSrc = ''
    updated._bakedKey = ''
    return updated
  },

  // 一组编辑状态的指纹：变了才需要重新烘焙（滑动切图的预览缓存、投屏出图复用都靠它判定）。
  _editSignature(g) {
    return [
      g.src,
      g.orientation,
      g.zoom.toFixed(4),
      g.tx.toFixed(2),
      g.ty.toFixed(2),
      g.angle.toFixed(2),
      g.frameW.toFixed(2),
      g.baseScale.toFixed(6)
    ].join('|')
  },

  // 切图前把当前图「按取景框内所见」烘焙成预览缓存（previewSrc），让 Banner 轨道里显示的
  // 就是用户刚刚构好的图（2026-07-25 修「左右滑动会闪回未裁剪原图」）。
  //   · 没编辑/没动过 → 不烘焙（底图显示原图，与编辑层所见本就一致），顺手清掉过期缓存；
  //   · 编辑过且指纹变了 → showLoading 后烘焙一次，结果存 previewSrc（**不动 tempFilePath**，
  //     原图仍是编辑的基准，切回来能继续拖，也避免横向成图被当原图再转一次）。
  // 缓存指纹与投屏出图共用，prepareProjectionImages 命中即直接复用，不再重复出图。
  //
  // 2026-07-25 再调整：加 options.silent（空闲预烘焙用，不弹 showLoading），并把所有烘焙串到
  // 一条链上——预烘焙与切图烘焙共用同一个离屏 #cropCanvas，并发会互相改画布尺寸、出图错乱。
  bakePreviewForActive(options) {
    const run = () => this._bakePreviewOnce(options || {})
    this._bakeChain = this._bakeChain ? this._bakeChain.then(run, run) : run()
    return this._bakeChain
  },

  async _bakePreviewOnce(options) {
    const index = this.data.activeIndex
    const g = this._edit
    const image = this.data.images[index]
    if (!image) {
      return
    }
    if (!g || isPristineEdit(g)) {
      // 还原/回到未编辑态：清掉可能残留的旧缓存，切图时露出原图
      if (image.previewSrc) {
        this._updateImageAt(index, { previewSrc: '', _bakedKey: '', wrapStyle: '', imgStyle: '' })
      }
      return
    }
    const key = this._editSignature(g)
    if (image._bakedKey === key && image.previewSrc) {
      return // 缓存仍新鲜
    }
    const silent = !!options.silent
    if (!silent) {
      wx.showLoading({ title: '处理中', mask: true })
    }
    try {
      const filePath = await this._bakeToFile(g)
      const view = this.getViewSize(g.orientation)
      this._updateImageAt(index, {
        previewSrc: filePath,
        _bakedKey: key,
        wrapStyle: this.computeWrapStyle(view.width, view.height),
        imgStyle: g.orientation === ORIENT_LANDSCAPE
          ? this.computeRotatedImgStyle(view.width, view.height)
          : ''
      })
    } catch (err) {
      // 烘焙失败不挡切图：过场里退回原图显示（会有一次视觉跳变，但功能不受影响）
      console.warn('[预览] 切图前预览烘焙失败，过场回退原图', err)
    } finally {
      if (!silent) {
        wx.hideLoading()
      }
    }
  },

  // 手势/换向停下后，空闲期悄悄把当前构图烘焙进 previewSrc 缓存（silent，不弹 showLoading）。
  // 这样真正滑动切图时 bakePreviewForActive 多半直接命中缓存秒返回，不再有「处理中」蒙层打断，
  // 「开始投屏」也能复用同一份缓存少出一次图。指纹没变则整个是空操作。
  _schedulePrebake() {
    this._clearPrebake()
    this._prebakeTimer = setTimeout(() => {
      this._prebakeTimer = null
      this.bakePreviewForActive({ silent: true })
    }, PREBAKE_IDLE_MS)
  },

  _clearPrebake() {
    if (this._prebakeTimer) {
      clearTimeout(this._prebakeTimer)
      this._prebakeTimer = null
    }
  },

  // 局部更新某张图片并同步回 Storage（保持 images/activeImage/邻格 一致）
  _updateImageAt(index, patch) {
    const next = this.data.images.slice()
    if (!next[index]) {
      return
    }
    next[index] = Object.assign({}, next[index], patch)
    this.setData(
      Object.assign(
        {
          images: next,
          activeImage:
            index === this.data.activeIndex ? next[index] : this.data.activeImage
        },
        // 邻格渲染的是快照对象，不跟着 images 自动更新：改的正好是左右那张时必须一起刷，
        // 否则轨道里露出的还是它更新前的旧图
        this._neighborPatch(next, this.data.activeIndex)
      )
    )
    this.persistPending(next)
  },

  // 把一张「没经用户编辑」的图，按设备（竖向）比例做 aspectFill 中心裁切并导出为新临时文件。
  // 目的：用户不做任何编辑就投屏时，让上传后端/图传用的图与预览所见（取景框 cover 铺满，即中心裁切）
  // 完全一致——后端即便按设备分辨率转码也不会再变形。
  // 只处理竖向：横向取景的图必然带编辑状态（用户切过分段控制器），走 bakeEditedImage。
  // 返回 Promise<裁切后的 image>；任一步失败都回退原 image（resolve，不阻断投屏）。
  coverCropOne(image) {
    return new Promise((resolve) => {
      const src = image && (image.tempFilePath || image.url)
      if (!src) {
        resolve(image)
        return
      }
      wx.getImageInfo({
        src,
        success: (info) => {
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
          // 导出画布恒为设备物理分辨率：后端按「上传图的像素」量化成六色帧（帧字节数=宽×高÷2），
          // 上传图必须正好是设备尺寸，否则帧大小对不上设备、投屏必失败（如 725×1024→371712 字节，
          // 设备 680×960 只要 326400）。比设备小的图会放大（correctness 优先，画质本就受六色量化限制）。
          this._exportCanvas(size.width, size.height, src, (ctx, img) => {
            ctx.drawImage(img, sx, sy, sw, sh, 0, 0, size.width, size.height)
          }).then((tempFilePath) => {
            const updated = Object.assign({}, image)
            // 备份原图源，供「原图」还原（与编辑烘焙一致，已备份则不覆盖）
            if (!updated._origSrc) {
              updated._origSrc = updated.tempFilePath || updated.url || ''
            }
            updated.tempFilePath = tempFilePath
            // cropW/cropH = 文件真实像素（设备物理分辨率，竖向）；竖向成图无需反向转正
            updated.cropW = size.width
            updated.cropH = size.height
            updated.wrapStyle = this.computeWrapStyle(size.width, size.height)
            updated.imgStyle = ''
            resolve(updated)
          }).catch(() => resolve(image))
        },
        fail: () => resolve(image)
      })
    })
  },

  // 投屏前统一出图（串行，共用单个离屏 #cropCanvas，避免并发抢画布）：
  //   ① 有编辑状态且真的动过（缩放/平移/旋转/切了横向）→ 按「取景框内所见」烘焙成
  //      可视区域分辨率新图（竖=设备分辨率、横=对调；即「点开始投屏自动保存当前效果」）；
  //   ② 什么都没动的图（isPristineEdit）与从没看过的图，等价于未编辑：
  //      · 已烘焙过（cropW>0）→ 原样保留；
  //      · 其余 → coverCropOne 按设备（竖向）比例中心裁切，与预览所见一致。
  //（2026-07-23：再次投屏的图与手选图已无差别——旧「imgBle 直传帧原样保留」判定随 .bin 链路一并删除）
  // 任一张失败回退原图，不阻断投屏。
  async prepareProjectionImages() {
    const { images, activeIndex } = this.data
    const result = []
    for (let i = 0; i < images.length; i++) {
      const image = images[i]
      const src = image && (image.tempFilePath || image.url)
      // 当前图优先取活的 _edit（最新手势）；切图瞬间 _edit 尚未建好时退回 _states 快照
      const state = (i === activeIndex && this._edit) ? this._edit : this._states[i]
      const edited = state && state.src === src && !isPristineEdit(state)
      if (edited) {
        // 滑动切图时已按同一组几何烘焙过、且之后没再动过 → 直接复用那份缓存，不重复出图
        if (image.previewSrc && image._bakedKey === this._editSignature(state)) {
          result.push(this._applyBakedFile(image, state, image.previewSrc))
        } else {
          result.push(await this.bakeEditedImage(image, state))
        }
      } else if (image && image.cropW) {
        result.push(image)
      } else {
        result.push(await this.coverCropOne(image))
      }
    }
    return result
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

  // 确认投屏：基础校验后统一出图（自动保存当前编辑效果）再跳结果页，由结果页真实连接设备并走
  // BLE 图传（带真实进度）。设备空间是否够、能否连接，都在结果页用真实读到的容量/掩码与连接结果判断。
  async confirmProjection() {
    // 投屏中防连点（hideLoading 到 redirectTo 之间存在连点窗口，双跳转会报 routeDone 类错误）
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

    this.setData({ projecting: true }) // 按钮切「投屏中」并锁定，跳转失败时在下方复位
    wx.showLoading({ title: '处理中', mask: true })
    const prepareStartedAt = Date.now()
    let images
    try {
      // 空闲预烘焙可能正排队/在途：取消未触发的，并等在途那次跑完再出图——
      // 两边都用同一个离屏 #cropCanvas，并发会互改画布尺寸导致出图错乱。
      this._clearPrebake()
      if (this._bakeChain) {
        await this._bakeChain.catch(() => {})
      }
      images = await this.prepareProjectionImages()
    } catch (error) {
      images = this.data.images // 出图异常不阻断投屏，退回原图
    }
    wx.hideLoading()
    const performance = {
      traceId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      previewPrepareMs: Date.now() - prepareStartedAt,
      preparedImages: images.length
    }
    console.log('[投屏性能] 预览处理完成', performance)

    // 把（编辑烘焙/自动 aspectFill 后的）图片写回 Storage，再跳结果页真实图传
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

  // 离开页面：清掉所有计时器，避免回调在已销毁页面上 setData
  onUnload() {
    this._unloaded = true
    this._clearLongPress()
    this._clearPrebake()
    if (this._pickupTimer) {
      clearTimeout(this._pickupTimer)
      this._pickupTimer = null
    }
    if (this._slideTimer) {
      clearTimeout(this._slideTimer)
      this._slideTimer = null
    }
    if (this._readyTimer) {
      clearTimeout(this._readyTimer)
      this._readyTimer = null
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
  }
})
