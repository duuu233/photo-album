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

module.exports = {
  // 拍照：仅相机来源，单张
  chooseFromCamera() {
    return chooseMedia(['camera'], 1)
  },

  // 从相册选择：默认一次最多 5 张（投屏批量上限）；AI 图文多模态传 4（BoltStar image_urls 上限）
  chooseFromAlbum(count = 5) {
    return chooseMedia(['album'], count > 0 ? count : 1)
  }
}
