function chooseImageByLegacy(sourceType, count) {
  return new Promise((resolve, reject) => {
    wx.chooseImage({
      count,
      sourceType,
      sizeType: ['compressed'],
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

function chooseMedia(sourceType, count) {
  if (!wx.chooseMedia) {
    return chooseImageByLegacy(sourceType, count)
  }

  return new Promise((resolve, reject) => {
    wx.chooseMedia({
      count,
      mediaType: ['image'],
      sourceType,
      sizeType: ['compressed'],
      success(res) {
        const images = res.tempFiles.map((file, index) => ({
          tempFilePath: file.tempFilePath,
          name: `照片 ${index + 1}`,
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
  chooseFromCamera() {
    return chooseMedia(['camera'], 1)
  },

  chooseFromAlbum() {
    return chooseMedia(['album'], 9)
  }
}
