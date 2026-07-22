const system = require('../../../utils/system')
const toast = require('../../../utils/toast')
const deviceBle = require('../../../utils/device-ble')
const protocol = require('../../../utils/frame-protocol')

// 设备屏幕分辨率（width×height）：列表/详情接口都会返回，取景框据此锁定宽高比（如 500x500 → 1:1）。
// 接口暂未返回该字段，这里先给默认值便于联调测试（如需 1:1 改成 { width: 500, height: 500 }）。
const DEFAULT_DEVICE_SIZE = { width: 480, height: 720 }

// 预览舞台（.preview-stage）的可用区域，单位 rpx：宽 = 屏宽 750 - 左右各 46 边距；
// 高与 wxss 里 .preview-stage 的 height 保持一致（改一处务必同步另一处）。
// 烘焙后按此区域把图片「等比缩放」铺满 photo-wrap（fallback 展示用），保证整张图完整显示且不留白。
const STAGE_W_RPX = 658
const STAGE_H_RPX = 680

// 画布导出格式（性能优化，2026-07-13）。canvasToTempFilePath 的 fileType 默认是 png——
// 照片存 png 是同画质 jpg 的 5~10 倍（长边 2000 的照片常到 5MB+）。而本页导出的这个临时文件
// 正是投屏要上传给后端转码的源图：真机 trace 里 uploadConvertMs 高达 5.7s，几乎全耗在传这个大 png 上。
// 统一导出 jpg：后端拿到后还要缩到设备分辨率（如 480×720）并量化成六色，q=0.92 对最终成像完全无损，
// 体积却只有 1/10。jpg 不支持透明，导出前先铺白底，避免透明区域变黑（照片无 alpha，纯属兜底）。
const EXPORT_FILE_TYPE = 'jpg'
const EXPORT_QUALITY = 0.92

// 编辑态里图片相对「铺满取景框(cover)」还能再放大的上限倍数（防止无限放大成马赛克）
const MAX_ZOOM_FACTOR = 8

// 取景方向（2026-07-22 需求调整，替代原 VIEW_SWAPPED 总开关）：由图片下方的「竖向/横向」
// 分段控制器按张选择。两种方向改变的都只是「可视区域（取景框）」，图片本身不动；
// 点「开始投屏」才把框内所见烘焙成上传图（见 prepareProjectionImages / bakeEditedImage）。
//   · 竖向 portrait —— 取景框 = 设备物理比例（竖向），导出画进设备分辨率画布；
//   · 横向 landscape —— 取景框 = 设备宽高对调后的横向比例（相框躺着摆），
//     导出画进对调分辨率（横向）画布。
// 两种方向都**不做任何旋转**：框内所见即导出文件（2026-07-22 用户拍板去掉横向导出的 270°
// 旋转链路，改为把可视区域裁剪图原样上传，横向图的方向适配交给接口侧处理）。
// ⚠️ 历史教训（07-20，见 docs/2026-07-22-照片预览需求调整.md 操作日志）：后端曾按「上传图
// 像素」直接量化出帧且忽略 targetWidth/Height，横向尺寸(如 960×680)帧字节数与竖向相同、
// 后端不报错，但设备按竖向行宽解析会整幅花屏且无任何报错。若真机复现花屏，先查接口侧
// 是否已适配横向图；旧「导出竖 + 270°」方案可从 git / docs 07-20 日志找回。
const ORIENT_PORTRAIT = 'portrait'
const ORIENT_LANDSCAPE = 'landscape'
const DEFAULT_ORIENTATION = ORIENT_PORTRAIT

// —— 临时联调（2026-07-22）：seekink 抖动 bin 接口 → 直传设备 ——
// 点工具栏「抖动Bin」：把当前预览图出成设备分辨率文件（复用投屏的烘焙/中心裁切链路）→
// multipart POST 给抖动接口拿回**二进制 bin（响应体即文件流）** → 校验字节数（须= 设备宽×高÷2
// 的六色 4bpp 帧）→ 走现有 BLE 图传（deviceBle.uploadImage）写入空闲槽位并 0x24 刷屏显示。
// 实现要点/注意：
//   · 响应是二进制 → 不能用 wx.uploadFile（它的 res.data 恒为字符串会把 bin 打烂）；
//     改为手工拼 multipart 体 + wx.request(responseType:'arraybuffer')；
//   · 请求头按对方要求带 AcceptLanguage=en（原话键名无中划线，另补一份标准 Accept-Language 兜底）；
//   · 域名是 http 且未加小程序合法域名白名单：开发者工具勾「不校验合法域名」/真机开调试模式；
//   · Authorization 为写死的联调 token，接入正式流程前必须移除；
//   · ⚠️ bin 的像素格式（六色索引映射/扫描顺序）是否与设备一致未验证——字节数对得上只保证
//     「尺寸对」，真机若显示花屏/串色，需对照 v1.5 协议核对 seekink 的调色板顺序。
const DITHERING_API = 'http://cloud.seekink.cn:8091/prod-api/api/v1/label/imageDitheringBinDownload'
const DITHERING_AUTH =
  'Bearer eyJhbGciOiJIUzUxMiJ9.eyJsb2dpbl91c2VyX2tleSI6IjkwMGJjOTZhLWU4MjktNGNkMi1hYmU1LWNhNDY0NDJhYzc2MCJ9.UgsZD93o2WvqGcov_U0FRx2S4NCBJKNF4Rl5Ekkh2KRvdHcKjQLJcQMx7OncNHNKPhuHvgRgmaKORsu6pqym2g'

// multipart 骨架文本转字节：boundary/字段名/文件名全是 ASCII，直接取低 8 位即可（勿放中文）
function asciiBytes(str) {
  const out = new Uint8Array(str.length)
  for (let i = 0; i < str.length; i++) {
    out[i] = str.charCodeAt(i) & 0xff
  }
  return out
}

// 手工拼 multipart/form-data 请求体（wx.request 才能收 arraybuffer 响应，但它不会帮拼表单）：
// fields=[{name,value}] 文本字段 + file={name,filename,contentType,data:Uint8Array} 文件字段
function buildMultipartBody(boundary, fields, file) {
  const CRLF = '\r\n'
  const chunks = []
  fields.forEach((f) => {
    chunks.push(
      asciiBytes(`--${boundary}${CRLF}Content-Disposition: form-data; name="${f.name}"${CRLF}${CRLF}${f.value}${CRLF}`)
    )
  })
  chunks.push(
    asciiBytes(
      `--${boundary}${CRLF}Content-Disposition: form-data; name="${file.name}"; filename="${file.filename}"${CRLF}` +
        `Content-Type: ${file.contentType}${CRLF}${CRLF}`
    )
  )
  chunks.push(file.data)
  chunks.push(asciiBytes(`${CRLF}--${boundary}--${CRLF}`))
  let total = 0
  chunks.forEach((c) => {
    total += c.length
  })
  const body = new Uint8Array(total)
  let offset = 0
  chunks.forEach((c) => {
    body.set(c, offset)
    offset += c.length
  })
  return body
}

// UTF-8 字节 → 字符串（小程序低版本基础库没有 TextDecoder）：仅用于把接口的 JSON 错误体打进日志
function utf8BytesToString(bytes) {
  let out = ''
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i]
    if (b < 0x80) {
      out += String.fromCharCode(b)
      i += 1
    } else if (b < 0xe0) {
      out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f))
      i += 2
    } else if (b < 0xf0) {
      out += String.fromCharCode(((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f))
      i += 3
    } else {
      const cp =
        ((b & 0x07) << 18) | ((bytes[i + 1] & 0x3f) << 12) | ((bytes[i + 2] & 0x3f) << 6) | (bytes[i + 3] & 0x3f)
      const u = cp - 0x10000
      out += String.fromCharCode(0xd800 + (u >> 10), 0xdc00 + (u & 0x3ff))
      i += 4
    }
  }
  return out
}

// 在画布上铺一层白底（jpg 无 alpha 通道，不铺底的话透明像素会被压成黑色）
function fillWhite(ctx, width, height) {
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)
}

// 判断一组编辑状态是否「什么都没动」：方向仍是默认竖向、没缩放、没平移、旋转角为整圈。
// 这类图与未编辑图完全等价，投屏时走 coverCropOne（中心裁切）即可，不必过画布再烘焙一遍——
// 也顺带保住了「再次投屏 imgBle 直传」的判定（见 prepareProjectionImages）。
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
    activeIndex: 0,
    imageCount: 0,
    projecting: false,

    // 常驻编辑态（2026-07-22）：进入页面/切换图片即自动对当前图开启编辑——单指平移、
    // 双指缩放+旋转、右上角按钮转90°。没有「保存」按钮，点「开始投屏」自动按框内所见烘焙上传。
    editing: false,
    orientation: DEFAULT_ORIENTATION, // 当前图的取景方向（竖向/横向分段控制器）
    editSrc: '', // 正在编辑的图片源
    editBaseW: 0, // 图片「铺满取景框(cover)」时的显示宽(px)，作为 zoom=1 基准
    editBaseH: 0, // 同上，高
    editImgLeft: 0, // 图片元素左上角 X(px，相对可视区容器 .edit-clip)：使其中心落在可视区中心
    editImgTop: 0, // 同上，Y
    editTransform: '', // translate/rotate/scale 组合串——仅此字段随手势高频 setData
    frame: null, // 可视区域 {left,top,width,height}(px，相对编辑层)，锁定当前方向比例、居中不动；
    // 定位 .edit-clip（区外内容被它 overflow:hidden 裁掉）与右上角转90°按钮
    editHint: true, // 手势提示：整个页面实例只出一次，触摸后隐藏

    deviceWrapStyle: '' // 编辑层没起来时 fallback 展示用：按设备（竖向）比例铺
  },

  onLoad() {
    this.setData(system.getLayoutMetrics())
    // 每张图的编辑状态（非破坏性）：index → _edit 快照。切图时存进来，切回时原样恢复，
    // 真正落文件统一等到点「开始投屏」（prepareProjectionImages）。
    this._states = {}
    this._edit = null // 当前图编辑数值真值（手势里不读 setData 后的异步 data）
    this._gesture = null
    this._editSeq = 0 // enterEdit 防串台序号：异步量尺寸/读图期间用户又切了图，旧流程作废
    this._stageRect = null // 舞台 px 尺寸缓存（布局固定，只量一次）
    this._hintShown = false

    // 待投屏的设备与图片由上个页面通过 Storage 传入（见首页/相册的 openPreview）
    const pending = wx.getStorageSync('pendingProjection') || {}
    const images = pending.images || []
    const device = pending.device || null
    this.updateImageState(images, device, 0)

    // 压缩图片：产品要求恒为开启，页面已隐藏开关入口，故不再读取 Storage 覆盖（保持 data 默认 true）

    // 预热连接：用户在预览页构图/确认的这几秒里，后台先把设备连上。
    // 这样点「确认投屏」后，结果页的 ensureConnection 能直接复用已就绪的会话，
    // 省掉「投屏中」开头那段最耗时的连接等待。失败静默忽略，结果页仍会正常重连。
    if (device && device.deviceId) {
      deviceBle.ensureConnection(device.deviceId).catch(() => {})
    }
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
    this.setData({
      device,
      images,
      activeIndex: safeIndex,
      activeImage: images[safeIndex] || null,
      imageCount: images.length,
      deviceWrapStyle: this.computeWrapStyle(size.width, size.height)
    })
  },

  // 上一张/下一张（2026-07-22：替代左右滑动切图）。切图前先把当前图的编辑状态存进 _states
  //（只记变换+方向，不落文件），切回来时原样恢复。
  prevImage() {
    this.switchImage(this.data.activeIndex - 1)
  },

  nextImage() {
    this.switchImage(this.data.activeIndex + 1)
  },

  switchImage(index) {
    const { images, activeIndex } = this.data
    if (index < 0 || index >= images.length || index === activeIndex) {
      return
    }
    this._saveEditState()
    // 编辑层等 enterEdit 量好新图再刷新：期间旧画面保留（不闪 fallback），_edit 置空使手势自动失效
    this._edit = null
    this._gesture = null
    this.setData({
      activeIndex: index,
      activeImage: images[index] || null
    })
    this.enterEdit()
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

  // 由一组宽高算出 photo-wrap 在舞台内等比缩放后的展示尺寸（rpx）。
  // 返回 {dispW, dispH}；宽高非法时返回 null。
  computeWrapSize(w, h) {
    if (!(w > 0) || !(h > 0)) {
      return null
    }
    const aspect = w / h
    let dispW = STAGE_W_RPX
    let dispH = dispW / aspect
    if (dispH > STAGE_H_RPX) {
      dispH = STAGE_H_RPX
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

  // 量取编辑舞台（.preview-stage）的 px 尺寸：页面布局固定，只量一次后缓存（切图/换向都不变）
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
        this.setData({ editing: false })
        resolve(false)
        return
      }
      // 已在编辑同一张图：直接复用当前变换，不重置
      if (this.data.editing && this._edit && this._edit.src === src) {
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
            this.setData({ editing: false })
          }
          resolve(false)
          return
        }
        wx.getImageInfo({
          src,
          success: (info) => {
            if (seq !== this._editSeq) {
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
            this._gesture = null
            this.setData({
              editing: true,
              orientation,
              editSrc: src,
              editBaseW: baseW,
              editBaseH: baseH,
              editImgLeft: frame.width / 2 - baseW / 2,
              editImgTop: frame.height / 2 - baseH / 2,
              frame,
              editHint: !this._hintShown
            })
            this._applyEdit(this._edit.zoom, this._edit.tx, this._edit.ty, this._edit.angle)
            resolve(true)
          },
          fail: () => {
            if (seq === this._editSeq) {
              this.setData({ editing: false })
            }
            resolve(false)
          }
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
    this._gesture = null
    this.setData({
      orientation: orient,
      frame,
      editBaseW: g.baseW,
      editBaseH: g.baseH,
      editImgLeft: frame.width / 2 - g.baseW / 2,
      editImgTop: frame.height / 2 - g.baseH / 2
    })
    this._applyEdit(keepZoom, g.tx, g.ty, g.angle)
  },

  // 约束一组变换：① zoom 不小于「当前角度下铺满取景框」所需最小值（旋转后也不露白边），且不超过上限；
  // ② 平移不让取景框越出图片（把屏幕平移量转到图片本地坐标再夹取）。返回夹取后的 {zoom,tx,ty}。
  _clampTransform(zoom, tx, ty, angle) {
    const g = this._edit
    const rad = (angle * Math.PI) / 180
    const cosT = Math.cos(rad)
    const sinT = Math.sin(rad)
    const c = Math.abs(cosT)
    const s = Math.abs(sinT)
    const fw = g.frameW
    const fh = g.frameH
    // 旋转 angle 后，图片(baseW×baseH×zoom)要包住轴对齐的取景框(fw×fh)所需的最小 zoom
    const minZoom = Math.max(
      (fw * c + fh * s) / g.baseW,
      (fw * s + fh * c) / g.baseH
    )
    let z = Math.max(zoom, minZoom)
    z = Math.min(z, minZoom * MAX_ZOOM_FACTOR)
    const W = g.baseW * z
    const H = g.baseH * z
    // 取景框旋转到图片本地坐标后的半宽/半高
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
      this._hintShown = true // 手势提示整个页面实例只出一次，切图不再重复弹
      this.setData({ editHint: false })
    }
    this._startGesture(e.touches)
  },

  // 手势移动：双指 → 缩放+旋转+随中点平移；单指 → 平移（横向取景时超出可视区的部分就靠它拖动调整）。
  // 变换即时夹取，框内永不露白边。
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
      return
    }

    const t = touches[0]
    if (g.mode !== 'pan') {
      this._startGesture(touches) // 双指抬起一指后继续拖：改记单指基准
      return
    }
    this._applyEdit(g.base.zoom, g.base.tx + (t.clientX - g.x), g.base.ty + (t.clientY - g.y), g.base.angle)
  },

  onEditTouchEnd(e) {
    // 还有手指没抬起（如双指松了一指）：以剩余手指重新起手，保证继续拖动跟手
    if (e.touches && e.touches.length >= 1) {
      this._startGesture(e.touches)
    } else {
      this._gesture = null
    }
  },

  // 图右上角悬浮按钮：在当前角度基础上顺时针 +90°。
  // 夹取会自动把 zoom 提到「转 90° 后仍铺满取景框」所需值，不露白边。
  rotate90() {
    const g = this._edit
    if (!g) {
      return
    }
    this._applyEdit(g.zoom, g.tx, g.ty, g.angle + 90)
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
        delete this._states[activeIndex]
        this._edit = null
        this._gesture = null
        this.setData({
          images: next,
          activeImage: updated,
          orientation: DEFAULT_ORIENTATION,
          editing: false
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

  // 把一组编辑状态（取景框内所见：方向+平移+旋转+缩放）一次画布合成，烘焙为「可视区域分辨率」新图。
  // canvas 尺寸 = 取景方向的可视区域（竖向=设备物理分辨率，横向=宽高对调），所见即所得、
  // 不做任何旋转（2026-07-22 去掉 270° 链路，见文件头说明）；放大系数 k = outW / frameW
  //（取景框宽 → 画布宽，两者比例恒相同）。横向图的方向适配交给接口侧。
  // 失败 resolve 原图（不阻断投屏），console.warn 留痕。
  bakeEditedImage(image, g) {
    const view = this.getViewSize(g.orientation)
    const outW = view.width
    const outH = view.height
    const k = outW / g.frameW
    // 原图 px → canvas px：baseScale(显示/原图) × zoom × k
    const s = g.baseScale * g.zoom * k
    const rad = (g.angle * Math.PI) / 180
    return this._exportCanvas(outW, outH, g.src, (ctx, img) => {
      ctx.save()
      // 先落到画布中心：此后坐标系就等价于取景框，
      // 图片相对取景框中心的平移(tx,ty)、用户自己的旋转(rad)、缩放(s) 都能原样套用。
      ctx.translate(outW / 2, outH / 2)
      ctx.translate(g.tx * k, g.ty * k)
      ctx.rotate(rad)
      ctx.scale(s, s)
      ctx.drawImage(img, -g.natW / 2, -g.natH / 2, g.natW, g.natH)
      ctx.restore()
    }).then((tempFilePath) => {
      const updated = Object.assign({}, image)
      // 首次落文件时备份原图源，供「原图」还原
      if (!updated._origSrc) {
        updated._origSrc = updated.tempFilePath || updated.url || ''
      }
      updated.tempFilePath = tempFilePath
      // cropW/cropH 记的是**文件真实像素**（=可视区域分辨率），结果页按 cropW>0 走转换链路。
      // 成图即所见（无旋转），photo-wrap 按同一宽高等比铺满即可。
      updated.cropW = outW
      updated.cropH = outH
      updated.wrapStyle = this.computeWrapStyle(outW, outH)
      return updated
    }).catch((err) => {
      console.warn('[预览] 编辑烘焙失败，该图回退原图投屏', err)
      return image
    })
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
            // cropW/cropH = 文件真实像素（设备物理分辨率，竖向）
            updated.cropW = size.width
            updated.cropH = size.height
            updated.wrapStyle = this.computeWrapStyle(size.width, size.height)
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
  //      · 已烘焙过（cropW>0）或再次投屏直传帧（imgBle）→ 原样保留。
  //        绝不能给 imgBle 的图生成 tempFilePath 打破「imgBle 且无 tempFilePath 直传设备帧」；
  //        用户真编辑过的 imgBle 图走 ①，产生 tempFilePath/cropW 改走转换链路，这是有意为之。
  //      · 其余 → coverCropOne 按设备（竖向）比例中心裁切，与预览所见一致。
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
        result.push(await this.bakeEditedImage(image, state))
      } else if (image && (image.cropW || image.imgBle)) {
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

  // 远程 url → 本地临时文件（wx.getFileSystemManager 只能读本地路径）
  _downloadToLocal(url) {
    return new Promise((resolve, reject) => {
      wx.downloadFile({
        url,
        success: (res) => {
          if (res.statusCode === 200 && res.tempFilePath) {
            resolve(res.tempFilePath)
          } else {
            reject(new Error(`原图下载失败（${res.statusCode}）`))
          }
        },
        fail: (err) => reject(new Error((err && err.errMsg) || '原图下载失败'))
      })
    })
  },

  // 把当前预览图出成「设备分辨率」的本地文件（抖动接口按上传图像素出帧，帧字节数要正好=设备
  // 宽×高÷2，与后端转码同一条铁律，见 memory projection-upload-must-be-device-resolution）。
  // 分支逻辑对齐 prepareProjectionImages 的单张处理：真编辑过→烘焙；已是设备分辨率(cropW)→原样；
  // 其余→中心裁切。只产出临时文件，不写回 images/_states，不影响正常投屏链路。
  async _prepareActiveDeviceResFile() {
    const { images, activeIndex } = this.data
    const image = images[activeIndex]
    const src = image && (image.tempFilePath || image.url)
    if (!src) {
      throw new Error('当前没有可用图片')
    }
    const state = this._edit && this._edit.src === src ? this._edit : this._states[activeIndex]
    const edited = state && state.src === src && !isPristineEdit(state)
    let out = image
    if (edited) {
      out = await this.bakeEditedImage(image, state)
    } else if (!image.cropW) {
      out = await this.coverCropOne(image)
    }
    const path = out.tempFilePath || out.url
    if (!path) {
      throw new Error('图片文件不可用')
    }
    return /^https?:\/\//i.test(path) ? this._downloadToLocal(path) : path
  },

  // 调抖动接口：图片文件 multipart 上传 → 收回二进制 bin（Uint8Array）。
  // 返回内容全部打印到控制台；接口回的是 JSON/文本（业务报错）时抛错不往设备发。
  async _requestDitheringBin(filePath) {
    const fileBytes = await new Promise((resolve, reject) => {
      wx.getFileSystemManager().readFile({
        filePath,
        success: (r) => resolve(new Uint8Array(r.data)),
        fail: () => reject(new Error('图片读取失败'))
      })
    })
    const boundary = `----wxmp${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
    const body = buildMultipartBody(
      boundary,
      [
        { name: 'color', value: 'BWRYGB' },
        { name: 'imageDitheringModes', value: '2' }
      ],
      { name: 'file', filename: 'image.jpg', contentType: 'image/jpeg', data: fileBytes }
    )
    const res = await new Promise((resolve, reject) => {
      wx.request({
        url: DITHERING_API,
        method: 'POST',
        header: {
          'content-type': `multipart/form-data; boundary=${boundary}`,
          Authorization: DITHERING_AUTH,
          AcceptLanguage: 'en', // 对方给的键名（无中划线），原样带上
          'Accept-Language': 'en' // 标准头兜底：后端若走通用 i18n 解析读的是它
        },
        data: body.buffer,
        responseType: 'arraybuffer',
        timeout: 20000, // 与 request.js 上传超时约定一致
        success: resolve,
        fail: (err) => reject(new Error(`接口-抖动bin转换失败：${(err && err.errMsg) || '网络异常'}`))
      })
    })
    const bytes = res.data instanceof ArrayBuffer ? new Uint8Array(res.data) : new Uint8Array(0)
    console.log('[抖动bin] statusCode:', res.statusCode)
    console.log('[抖动bin] header:', res.header)
    console.log('[抖动bin] body 字节数:', bytes.length, '头16=', protocol.bytesToHex(bytes.subarray(0, 16)))
    // 业务报错通常回小体积 JSON（content-type 标 json/text，或首字符 { / [）：解码打印并抛错
    const contentType = String((res.header && (res.header['Content-Type'] || res.header['content-type'])) || '')
    const looksText =
      /json|text/i.test(contentType) ||
      (bytes.length > 0 && bytes.length < 4096 && (bytes[0] === 0x7b || bytes[0] === 0x5b))
    if (looksText) {
      const text = utf8BytesToString(bytes)
      console.log('[抖动bin] body(文本):', text)
      throw new Error(`接口-抖动bin转换失败：${text.slice(0, 60) || `HTTP ${res.statusCode}`}`)
    }
    if (res.statusCode !== 200 || !bytes.length) {
      throw new Error(`接口-抖动bin转换失败：HTTP ${res.statusCode}`)
    }
    return bytes
  },

  // 把 bin 帧发给设备：连接 → 0x01 读屏幕信息 → 字节数校验（宽×高÷2 铁闸，错帧绝不发）→
  // 选空闲槽位 → 0x20/0x21/0x22 图传 → 0x24 刷屏显示（异步不 await，应答要等墨水屏刷完 ~4s）。
  // 复用 result.js runRealProjection 的骨架，去掉了后端记账/批量/预取。返回写入的槽位 index。
  async _sendFrameToDevice(frameData) {
    const device = this.data.device
    const deviceId = device && device.deviceId
    if (!deviceId) {
      throw new Error('设备未连接，请重新绑定后再投屏')
    }
    wx.showLoading({ title: '连接设备中', mask: true })
    await deviceBle.ensureConnection(deviceId)
    const info = await deviceBle.readTransferInfo(deviceId)
    console.log('[抖动bin] 设备信息:', {
      screenType: info.screenType,
      width: info.width,
      height: info.height,
      capacity: info.capacity,
      imgCount: info.imgCount
    })
    if (info.screenType === 0x03) {
      throw new Error('该型号暂不支持图传')
    }
    if (!info.width || !info.height) {
      throw new Error('设备未连接，请检查手机或设备连接后继续')
    }
    const expected = Math.ceil((info.width * info.height) / 2)
    if (frameData.length !== expected) {
      throw new Error(
        `接口-抖动bin尺寸不符：收到 ${frameData.length} 字节，设备 ${info.width}×${info.height} 需六色4bpp ${expected} 字节`
      )
    }
    const index = protocol.firstFreeIndex(info.imgMask, info.capacity)
    if (index < 0) {
      throw new Error('设备内存已满，请清理后继续。')
    }
    // 连接间隔切图传极速档（best-effort，与正常投屏一致；失败只是传得慢，不阻断）
    try {
      await deviceBle.optimizeConnectionIntervalForTransfer(deviceId)
    } catch (e) {
      console.warn('[抖动bin] 连接间隔优化失败(忽略):', e)
    }
    wx.showLoading({ title: '传输中 0%', mask: true })
    let lastAt = 0
    let lastPercent = -1
    try {
      await deviceBle.uploadImage(deviceId, {
        screenType: info.screenType,
        index,
        width: info.width,
        height: info.height,
        data: frameData,
        onProgress: (done, totalPackets) => {
          const percent = totalPackets ? Math.min(100, Math.floor((done / totalPackets) * 100)) : 0
          const now = Date.now()
          if (percent !== 100 && (percent === lastPercent || now - lastAt < 200)) {
            return
          }
          lastAt = now
          lastPercent = percent
          wx.showLoading({ title: `传输中 ${percent}%`, mask: true })
        }
      })
    } catch (error) {
      // 图传失败回滚删掉半写入的槽位（与 result.js 一致），回滚失败不覆盖原始错误
      await deviceBle.deleteImage(deviceId, [index]).catch(() => {})
      throw error
    }
    deviceBle.refreshScreen(deviceId, index).catch((err) => console.warn('[抖动bin] 刷屏失败(异步):', err))
    return index
  },

  // 临时联调（2026-07-22）：出设备分辨率图 → 抖动接口拿 bin → BLE 图传上设备（见文件头 DITHERING_API 说明）
  async fetchDitheringBin() {
    if (this._ditherBusy) {
      return
    }
    this._ditherBusy = true
    try {
      wx.showLoading({ title: '处理图片中', mask: true })
      const filePath = await this._prepareActiveDeviceResFile()
      wx.showLoading({ title: '转换中', mask: true })
      const frameData = await this._requestDitheringBin(filePath)
      const index = await this._sendFrameToDevice(frameData)
      wx.hideLoading()
      console.log(`[抖动bin] 完成：已写入设备槽位 ${index}，刷屏进行中`)
      toast.show(`已传到设备槽位 ${index}，屏幕刷新中`)
    } catch (error) {
      wx.hideLoading()
      console.warn('[抖动bin] 流程失败', error)
      // 设备/蓝牙错误已带「设备-」前缀，接口错误上面拼了「接口-」，其余本地错误由 warn 补「小程序-」
      toast.warn({ title: (error && error.message) || '抖动bin流程失败' })
    } finally {
      this._ditherBusy = false
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
