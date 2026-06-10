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

  // ===== 用户前端-用户接口（真实 BoltFox 接口，mock:false）=====
  // 公共参数 device/terminal/language/userToken 由 request.js 统一写入 headers，业务方法只传业务字段。
  // 密码相关字段（password/confirmPassword/oldPassword）需调用方先做 md5(32 位小写) 再传入。

  getUserInfo() {
    return http.get('/Client/User/getUserInfo', {}, {
      mock: false
    })
  },

  changeAvatar(avatar) {
    const payload = typeof avatar === 'object' ? avatar : { avatar }

    return http.post('/Client/User/changeAvatar', payload, {
      mock: false,
      loading: true,
      loadingText: '保存中'
    })
  },

  changeNickName(nickName) {
    const payload = typeof nickName === 'object' ? nickName : { nickName }

    return http.post('/Client/User/changeNickName', payload, {
      mock: false,
      loading: true,
      loadingText: '保存中'
    })
  },

  // data: { password, confirmPassword, verifyCode }
  changePassword(data = {}) {
    return http.post('/Client/User/changePassword', data, {
      mock: false,
      loading: true,
      loadingText: '保存中'
    })
  },

  // 修改邮箱/绑定邮箱 data: { userEmail, verifyCode, password?, confirmPassword? }
  changeUserEmail(data = {}) {
    return http.post('/Client/User/changeUserEmail', data, {
      mock: false,
      loading: true,
      loadingText: '保存中'
    })
  },

  // 校验邮箱是否不存在，存在则返回异常码；静默处理由调用方判断
  chkUserEmailNotExist(userEmail) {
    const payload = typeof userEmail === 'object' ? userEmail : { userEmail }

    return http.post('/Client/User/chkUserEmailNotExist', payload, {
      auth: false,
      mock: false,
      showError: false
    })
  },

  loginOut() {
    return http.post('/Client/User/loginOut', {}, {
      mock: false
    })
  },

  // 忘记密码-重置密码(未登录) data: { userEmail, password, confirmPassword, verifyCode }
  // 命名避开旧的 mock resetPassword，避免对象重复键。
  resetPasswordByEmail(data = {}) {
    return http.post('/Client/User/resetPassword', data, {
      auth: false,
      mock: false,
      loading: true,
      loadingText: '重置中'
    })
  },

  // 微信小程序授权手机号一键登录，返回 userToken data: { code, wxEncrypData, wxIvData }
  wechatAppLogin(data = {}) {
    return http.post('/Client/User/setWechatAppLogin', data, {
      auth: false,
      mock: false,
      loading: true,
      loadingText: '登录中'
    })
  },

  userOff() {
    return http.post('/Client/User/userOff', {}, {
      mock: false,
      loading: true,
      loadingText: '注销中'
    })
  },

  // 用户注册-邮箱 data: { userEmail, password, confirmPassword, verifyCode, countryId? }
  userRegister(data = {}) {
    return http.post('/Client/User/userRegister', data, {
      auth: false,
      mock: false,
      loading: true,
      loadingText: '注册中'
    })
  },

  // ===== 用户前端-设备接口（真实 BoltFox 接口，mock:false）=====

  // params: pageIndex、pageSize、keyword、startDate、endDate
  getUserProductList(params = {}) {
    return http.get('/Client/UserProduct/getUserProductList', params, {
      mock: false
    })
  },

  // 可直接传 userProductId，也可传 { userProductId, productVersionNo }
  getUserProductDetail(params) {
    const query = typeof params === 'object' ? params : { userProductId: params }

    return http.get('/Client/UserProduct/getUserProductDetail', query, {
      mock: false
    })
  },

  getUserProductImgList(params = {}) {
    return http.get('/Client/UserProduct/getUserProductImgList', params, {
      mock: false
    })
  },

  // 添加用户设备 data: { productId, deviceId, productName }
  addUserProduct(data = {}) {
    return http.post('/Client/UserProduct/addUserProduct', data, {
      mock: false,
      loading: true,
      loadingText: '绑定中'
    })
  },

  // 编辑设备信息 data: { userProductId, productName }
  editUserProduct(data = {}) {
    return http.post('/Client/UserProduct/editUserProduct', data, {
      mock: false,
      loading: true,
      loadingText: '保存中'
    })
  },

  // 删除设备，id=userProductId
  delUserProduct(id) {
    const payload = typeof id === 'object' ? id : { id }

    return http.post('/Client/UserProduct/delUserProduct', payload, {
      mock: false,
      loading: true,
      loadingText: '删除中'
    })
  },

  // 一键清除设备图片，id=userProductId
  clearUserProductImg(id) {
    const payload = typeof id === 'object' ? id : { id }

    return http.post('/Client/UserProduct/clearUserProductImg', payload, {
      mock: false,
      loading: true,
      loadingText: '清除中'
    })
  },

  // 删除产品图片，idList=uProductImgId 数组，例：[1,2,3]
  delUserProductImg(idList) {
    const payload = Array.isArray(idList) ? { idList } : (idList || {})

    return http.post('/Client/UserProduct/delUserProductImg', payload, {
      mock: false,
      loading: true,
      loadingText: '删除中'
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
