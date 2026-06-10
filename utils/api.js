// 业务接口集中定义层：每个方法对应一个后端接口，统一通过 request.js 发起。
// 第三个参数为请求选项，常用：loading 显示加载、auth:false 免登录、showError:false 静默错误。
const http = require('./request')

function normalizeFilePaths(input) {
  const files = Array.isArray(input) ? input : [input]

  return files
    .map(file => {
      if (typeof file === 'string') {
        return file
      }

      return file && (file.tempFilePath || file.path || file.url)
    })
    .filter(Boolean)
}

module.exports = {
  getProductList(params = {}) {
    return http.get('/Client/Product/getProductList', params, {
      mock: false
    })
  },

  getProductFaqList(params = {}) {
    return http.get('/Client/Product/getProductFaqList', params, {
      mock: false
    })
  },

  getProductFaqDetail(faqIdOrParams) {
    const params =
      typeof faqIdOrParams === 'object' ? faqIdOrParams : { faqId: faqIdOrParams }

    return http.get('/Client/Product/getProductFaqDetail', params, {
      mock: false
    })
  },

  sendEmail(data) {
    const payload = typeof data === 'string' ? { userEmail: data } : data || {}

    return http.post('/Client/Basic/sendEmail', payload, {
      auth: false,
      mock: false,
      loading: true,
      loadingText: '发送中'
    })
  },

  sendEmailToken(data = {}) {
    return http.post('/Client/Basic/sendEmailToken', data, {
      mock: false,
      loading: true,
      loadingText: '发送中'
    })
  },

  setUserProductUpload(options = {}) {
    const filePaths = normalizeFilePaths(
      options.filePaths || options.files || options.filePath
    )

    return http.upload({
      url: '/Client/Basic/setUserProductUpload',
      filePaths,
      name: 'fileParam',
      query: {
        userProductId: options.userProductId,
        deviceUploadState: options.deviceUploadState
      },
      formData: options.formData,
      mock: false,
      loading: true,
      loadingText: '上传中'
    })
  },

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
