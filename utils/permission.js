const toast = require('./toast')

// 用户曾拒绝授权后，引导其跳转到小程序设置页手动开启；返回最新的授权结果
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

// 确保某项权限已授权：已授权直接通过；未授权先弹系统授权；曾被拒则引导去设置页
// 始终 resolve 布尔值（不会 reject），调用方只需判断 true/false
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
          // 拒绝后 wx.authorize 不会再次弹窗，只能走 openSetting 让用户手动开启
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
      toast.warn({
        title: '定位获取失败',
        icon: 'none'
      })
      return null
    }
  }
}
