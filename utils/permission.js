function showOpenSettingModal(content) {
  return new Promise(resolve => {
    wx.showModal({
      title: '需要授权',
      content,
      confirmText: '去设置',
      success(res) {
        if (!res.confirm) {
          resolve(false)
          return
        }

        wx.openSetting({
          success(settingRes) {
            resolve(settingRes.authSetting)
          },
          fail() {
            resolve(false)
          }
        })
      },
      fail() {
        resolve(false)
      }
    })
  })
}

function authorize(scope, deniedText) {
  return new Promise(resolve => {
    wx.getSetting({
      success(settingRes) {
        if (settingRes.authSetting[scope]) {
          resolve(true)
          return
        }

        wx.authorize({
          scope,
          success() {
            resolve(true)
          },
          async fail() {
            const authSetting = await showOpenSettingModal(deniedText)
            resolve(Boolean(authSetting && authSetting[scope]))
          }
        })
      },
      fail() {
        resolve(false)
      }
    })
  })
}

function getLocation() {
  return new Promise((resolve, reject) => {
    wx.getLocation({
      type: 'gcj02',
      success: resolve,
      fail: reject
    })
  })
}

module.exports = {
  ensureAlbumPermission() {
    return authorize('scope.writePhotosAlbum', '保存处理后的照片需要相册权限。')
  },

  ensureLocationPermission() {
    return authorize('scope.userLocation', '搜索附近蓝牙相框需要位置权限。')
  },

  async getCurrentLocation() {
    const authorized = await authorize('scope.userLocation', '搜索附近蓝牙相框需要位置权限。')

    if (!authorized) {
      return null
    }

    try {
      return await getLocation()
    } catch (error) {
      wx.showToast({
        title: '定位获取失败',
        icon: 'none'
      })
      return null
    }
  }
}
