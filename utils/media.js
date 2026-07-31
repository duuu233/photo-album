const uploadLimit = require('./upload-limit')

// 旧版微信无 wx.chooseMedia 时的降级方案，使用已废弃的 wx.chooseImage
function chooseImageByLegacy(sourceType, count) {
  return new Promise((resolve, reject) => {
    wx.chooseImage({
      count,
      sourceType,
      sizeType: ['original'], // 取原图，避免上屏发糊（旧版降级路径，同新版一致）
      success(res) {
        const images = res.tempFilePaths.map((path, index) => ({
          tempFilePath: path,
          name: `照片 ${index + 1}`,
          sizeMb: 2.5
        }))
        resolve(images)
      },
      fail: reject
    })
  })
}

// 统一的选图入口：新版用 wx.chooseMedia，旧版自动降级；返回结构统一为业务字段
function chooseMedia(sourceType, count) {
  if (!wx.chooseMedia) {
    return chooseImageByLegacy(sourceType, count)
  }

  return new Promise((resolve, reject) => {
    wx.chooseMedia({
      count,
      mediaType: ['image'],
      sourceType,
      // 取原图而非微信压缩版：compressed 会先降分辨率+重压，是投屏「发糊」最大来源；
      // 原图偏大时由 result.js 的 shrinkIfHuge 仅做防 OOM 的轻量预缩（与 APP 一致走原图）。
      sizeType: ['original'],
      success(res) {
        const images = res.tempFiles.map((file, index) => ({
          tempFilePath: file.tempFilePath,
          name: `照片 ${index + 1}`,
          // 字节转 MB 并保留两位，拿不到大小时兜底 2.5MB（供投屏估算内存占用）
          sizeMb: Number(((file.size || 0) / 1024 / 1024).toFixed(2)) || 2.5,
          width: file.width || 0,
          height: file.height || 0
        }))
        resolve(images)
      },
      fail: reject
    })
  })
}

// ==================== 压到目标体积（AI 图文多模态上传前用） ====================
//
// ⚠️ 别和 subpackages/projection/result.js 的 compressForUpload 搞混，两者目标相反：
//   · 投屏那套：缩到「设备物理分辨率」，为的是**保画质**（六色抖动帧靠它出细节），不看体积；
//   · 这一套：压到「目标字节数」，为的是**省流量 / 加快上传**（AI 只需看清内容，不上屏）。
// 任一步失败（老基础库没有 compressImage / 取不到尺寸 / 压缩报错 / 压完反而更大）都回退原图，
// 绝不阻断发送 —— 图片发不出去比图片大得多更糟。
const TARGET_BYTES_DEFAULT = 100 * 1024 // 100KB（2026-07-27 用户指定）
// 先按长边封顶缩分辨率：AI 视觉分析用不到 4000px 的原图，这一步通常就把体积拉到目标附近，
// 比一味降 quality 画质更好（降质会糊掉文字/细节，AI 反而看不清）。
const MAX_LONG_EDGE = 1600
// 逐档降质重试；压到 <= 目标就收手。走到 QUALITY_FLOOR_INDEX 之后还没达标就再砍一半分辨率
//（PNG 走 compressImage 时 quality 是**无效**的，只有分辨率这条路能压下来）。
const QUALITY_STEPS = [80, 62, 48, 36, 26]
const QUALITY_FLOOR_INDEX = 2

function getFileBytes(filePath) {
  return new Promise(resolve => {
    try {
      wx.getFileSystemManager().getFileInfo({
        filePath,
        success: res => resolve(Number(res.size) || 0),
        fail: () => resolve(0)
      })
    } catch (error) {
      resolve(0)
    }
  })
}

function getImageSize(src) {
  return new Promise((resolve, reject) => {
    wx.getImageInfo({ src, success: resolve, fail: reject })
  })
}

// 单次压缩。compressedWidth/Height 需基础库 2.26.0+，老版本会失败 —— 这时退回「只降质不缩放」，
// 至少还能压一点，而不是整条链路作废。
function compressOnce(src, quality, width, height) {
  const run = options =>
    new Promise((resolve, reject) => {
      wx.compressImage(Object.assign({ src, success: resolve, fail: reject }, options))
    })
  if (!(width > 0) || !(height > 0)) {
    return run({ quality })
  }
  return run({ quality, compressedWidth: width, compressedHeight: height }).catch(() => run({ quality }))
}

async function compressToTarget(filePath, targetBytes = TARGET_BYTES_DEFAULT) {
  const source = { filePath, bytes: await getFileBytes(filePath), compressed: false }
  if (!wx.compressImage) {
    return source
  }
  // 本来就够小：不动它，别白丢一道质
  if (source.bytes && source.bytes <= targetBytes) {
    return source
  }

  let width = 0
  let height = 0
  try {
    const size = await getImageSize(filePath)
    width = Number(size.width) || 0
    height = Number(size.height) || 0
    const longEdge = Math.max(width, height)
    if (longEdge > MAX_LONG_EDGE) {
      const ratio = MAX_LONG_EDGE / longEdge
      width = Math.max(1, Math.round(width * ratio))
      height = Math.max(1, Math.round(height * ratio))
    }
  } catch (error) {
    width = 0 // 取不到尺寸就只降质（compressOnce 会走无尺寸分支）
    height = 0
  }

  let best = null
  for (let i = 0; i < QUALITY_STEPS.length; i++) {
    let result
    try {
      result = await compressOnce(filePath, QUALITY_STEPS[i], width, height)
    } catch (error) {
      break // 连压缩都调不通，用原图
    }
    const bytes = await getFileBytes(result.tempFilePath)
    if (bytes && (!best || bytes < best.bytes)) {
      best = { filePath: result.tempFilePath, bytes, compressed: true }
    }
    if (bytes && bytes <= targetBytes) {
      break
    }
    // 降质已到底还压不下来（多为高清照片/PNG）→ 再砍一半分辨率继续试
    if (i >= QUALITY_FLOOR_INDEX && width > 0 && height > 0) {
      width = Math.max(1, Math.round(width / 2))
      height = Math.max(1, Math.round(height / 2))
    }
  }

  // 压完反而更大 / 读不到大小：用原图，别赌
  if (!best || (source.bytes && best.bytes >= source.bytes)) {
    return source
  }
  return best
}

module.exports = {
  // 拍照：仅相机来源，单张
  chooseFromCamera() {
    return chooseMedia(['camera'], 1)
  },

  // 从相册选择：不传张数时用「当前用户的投屏批量上限」（常规 5 张，白名单用户 100 张，
  // 见 utils/upload-limit.js）；AI 图文多模态显式传 4（BoltStar image_urls 上限），不受白名单影响。
  chooseFromAlbum(count) {
    const limit = count === undefined ? uploadLimit.albumPickLimit() : count
    return chooseMedia(['album'], limit > 0 ? limit : 1)
  },

  TARGET_BYTES_DEFAULT,

  // 压到目标体积，resolve { filePath, bytes, compressed }。达不到目标也会返回「已压到最小的那一版」，
  // 只有真的一点都压不动（或压完更大）才回原图 —— 调用方无需判断成败，直接用 filePath。
  compressToTarget
}
