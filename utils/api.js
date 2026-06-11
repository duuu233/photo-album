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

  // ==================== BoltFox 真实接口（小程序）====================
  // 以下方法均直连后端真实接口（mock:false）。公共参数 device/terminal/language/userToken
  // 由 request.js 通过 headers 注入，业务方法只需传业务字段；DTO 中的 userToken 无需在 body 重复。

  // —— 基础功能接口 ——
  // 获取基础数据（配置/字典等），具体字段以后端返回为准
  getBasicData(params = {}) {
    return http.get('/Client/Basic/getBasicData', params, {
      mock: false
    })
  },

  // 基础文件上传（与设备业务无关，如头像等通用文件），form-data 字段名 fileParam
  setFileUpload(options = {}) {
    const filePaths = normalizeFilePaths(
      options.filePaths || options.files || options.filePath
    )

    return http.upload({
      url: '/Client/Basic/setFileUpload',
      filePaths,
      name: 'fileParam',
      formData: options.formData,
      mock: false,
      loading: true,
      loadingText: '上传中'
    })
  },

  // —— 用户接口 ——
  // 微信小程序授权手机号一键登录，返回登录 token。data: { code, phoneEncrypted/encryptedData, iv }
  setWechatAppLogin(data = {}) {
    return http.post('/Client/User/setWechatAppLogin', data, {
      auth: false,
      mock: false,
      loading: true,
      loadingText: '登录中'
    })
  },

  // 获取用户信息（昵称、头像、ID 等），userToken 走 header
  getUserInfo() {
    return http.get('/Client/User/getUserInfo', {}, {
      mock: false
    })
  },

  // 修改昵称，限制 1-10 字。可传字符串或 { nickName }
  changeNickName(nickName) {
    const payload = typeof nickName === 'string' ? { nickName } : nickName || {}

    return http.post('/Client/User/changeNickName', payload, {
      mock: false,
      loading: true,
      loadingText: '保存中'
    })
  },

  // 修改头像。可传头像地址字符串或 { avatar }
  changeAvatar(avatar) {
    const payload = typeof avatar === 'string' ? { avatar } : avatar || {}

    return http.post('/Client/User/changeAvatar', payload, {
      mock: false,
      loading: true,
      loadingText: '保存中'
    })
  },

  // 退出登录
  loginOut() {
    return http.post('/Client/User/loginOut', {}, {
      mock: false
    })
  },

  // 用户注销（销户）
  userOff() {
    return http.post('/Client/User/userOff', {}, {
      mock: false,
      loading: true,
      loadingText: '注销中'
    })
  },

  // —— 设备接口（UserProduct）——
  // 添加/绑定用户设备。data: { productId, productName, productSerialNo }
  addUserProduct(data = {}) {
    return http.post('/Client/UserProduct/addUserProduct', data, {
      mock: false,
      loading: true,
      loadingText: '绑定中'
    })
  },

  // 获取用户设备列表。params: pageIndex、pageSize、keyword、startDate、endDate
  getUserProductList(params = {}) {
    return http.get('/Client/UserProduct/getUserProductList', params, {
      mock: false
    })
  },

  // 获取用户设备详情。可传 userProductId 或 { userProductId, productVersionNo }
  getUserProductDetail(params) {
    const query =
      typeof params === 'object' ? params : { userProductId: params }

    return http.get('/Client/UserProduct/getUserProductDetail', query, {
      mock: false
    })
  },

  // 编辑设备信息（重命名）。data: { userProductId, productName }
  editUserProduct(data = {}) {
    return http.post('/Client/UserProduct/editUserProduct', data, {
      mock: false,
      loading: true,
      loadingText: '保存中'
    })
  },

  // 删除设备，id=userProductId。可传 id 或 { id }
  delUserProduct(userProductId) {
    const payload =
      typeof userProductId === 'object' ? userProductId : { id: userProductId }

    return http.post('/Client/UserProduct/delUserProduct', payload, {
      mock: false,
      loading: true,
      loadingText: '删除中'
    })
  },

  // 一键清除设备图片（格式化），id=userProductId。可传 id 或 { id }
  clearUserProductImg(userProductId) {
    const payload =
      typeof userProductId === 'object' ? userProductId : { id: userProductId }

    return http.post('/Client/UserProduct/clearUserProductImg', payload, {
      mock: false,
      loading: true,
      loadingText: '清空中'
    })
  },

  // 用户产品图片列表（我的图库）。params 支持分页与 userProductId 过滤
  getUserProductImgList(params = {}) {
    return http.get('/Client/UserProduct/getUserProductImgList', params, {
      mock: false
    })
  },

  // 删除产品图片，支持多选，id=uProductImgId。可传单 id、id 数组或 { ids }
  delUserProductImg(ids) {
    const list = Array.isArray(ids)
      ? ids
      : ids && Array.isArray(ids.ids)
        ? ids.ids
        : [ids]

    return http.post(
      '/Client/UserProduct/delUserProductImg',
      { ids: list.filter(item => item !== undefined && item !== null) },
      {
        mock: false,
        loading: true,
        loadingText: '删除中'
      }
    )
  },

  // 产品投屏记录列表（成功/失败投屏）。params 支持分页、keyword 搜索图片地址、userProductId
  getUserProductImgRecordList(params = {}) {
    return http.get('/Client/UserProduct/getUserProductImgRecordList', params, {
      mock: false
    })
  },

  // 删除产品投屏记录，id=upirId。可传 id 或 { id }
  delUserProductImgRecord(upirId) {
    const payload = typeof upirId === 'object' ? upirId : { id: upirId }

    return http.post('/Client/UserProduct/delUserProductImgRecord', payload, {
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
