// 业务接口集中定义层：每个方法对应一个后端接口，统一通过 request.js 发起。
// 第三个参数为请求选项，常用：loading 显示加载、auth:false 免登录、showError:false 静默错误。
const http = require('./request')

module.exports = {
  loginByWechat(data) {
    return http.post('/auth/wechat-login', data, {
      auth: false,
      showError: false
    })
  },

  bindPhone(data) {
    return http.post('/auth/phone', data)
  },

  resetPassword(data) {
    return http.post('/auth/reset-password', data, {
      auth: false,
      loading: true,
      loadingText: '重置中'
    })
  },

  modifyPassword(data) {
    return http.put('/auth/password', data, {
      loading: true,
      loadingText: '保存中'
    })
  },

  getUserProfile() {
    return http.get('/user/profile')
  },

  updateUserProfile(data) {
    return http.put('/user/profile', data)
  },

  bindEmail(email) {
    return http.post('/user/email', {
      email
    }, {
      loading: true,
      loadingText: '绑定中'
    })
  },

  changeEmail(email) {
    return http.put('/user/email', {
      email
    }, {
      loading: true,
      loadingText: '保存中'
    })
  },

  logout() {
    return http.post('/auth/logout')
  },

  deleteAccount() {
    return http.delete('/account')
  },

  getDevices() {
    return http.get('/devices')
  },

  getDeviceDetail(deviceId) {
    return http.get(`/devices/${deviceId}`)
  },

  bindDevice(device) {
    return http.post('/devices/bind', {
      device
    }, {
      loading: true,
      loadingText: '绑定中'
    })
  },

  renameDevice(deviceId, name) {
    return http.put(`/devices/${deviceId}`, {
      name
    })
  },

  updateDevicePlayback(deviceId, data) {
    return http.put(`/devices/${deviceId}/playback`, data)
  },

  formatDevice(deviceId) {
    return http.post(`/devices/${deviceId}/format`, null, {
      loading: true,
      loadingText: '格式化中'
    })
  },

  clearDevicePhotoCopies(deviceId) {
    return http.post(`/devices/${deviceId}/clear-photo-copies`, null, {
      loading: true,
      loadingText: '清理中'
    })
  },

  getDeviceFirmware(deviceId) {
    return http.get(`/devices/${deviceId}/firmware`)
  },

  reportDeviceFirmwareUpgrade(deviceId, data) {
    return http.post(`/devices/${deviceId}/firmware/upgrade-result`, data, {
      showError: false
    })
  },

  deleteDevice(deviceId) {
    return http.delete(`/devices/${deviceId}`, null, {
      loading: true,
      loadingText: '删除中'
    })
  },

  getAlbumPhotos() {
    return http.get('/album/photos')
  },

  deleteAlbumPhotos(ids) {
    return http.delete('/album/photos', {
      ids
    })
  },

  uploadProjection(data) {
    return http.post('/projection/upload', data, {
      loading: true,
      loadingText: '投屏中'
    })
  },

  getProjectionRecords() {
    return http.get('/projection/records')
  },

  deleteProjectionRecord(recordId) {
    return http.delete(`/projection/records/${recordId}`)
  }
}
