// 业务接口集中定义层：每个方法对应一个后端接口，统一通过 request.js 发起。
// 第三个参数为请求选项，常用：loading 显示加载、auth:false 免登录、showError:false 静默错误。
const http = require('./request')
const { md5 } = require('./md5')

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

function pageData(data) {
  if (Array.isArray(data)) {
    return data
  }
  if (data && Array.isArray(data.pageData)) {
    return data.pageData
  }
  if (data && Array.isArray(data.list)) {
    return data.list
  }
  if (data && Array.isArray(data.rows)) {
    return data.rows
  }
  return []
}

function firstValue() {
  for (let i = 0; i < arguments.length; i++) {
    const value = arguments[i]
    if (value !== undefined && value !== null && value !== '') {
      return value
    }
  }
  return ''
}

function normalizeNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function normalizeUserProfile(user = {}) {
  return {
    id: firstValue(user.userNo, user.userId, user.id),
    userNo: firstValue(user.userNo, user.userId, user.id),
    nickName: firstValue(user.nickName, user.nickname, ''),
    avatar: firstValue(user.avatar, user.avatarUrl, ''),
    avatarUrl: firstValue(user.avatar, user.avatarUrl, ''),
    userEmail: firstValue(user.userEmail, user.email, ''),
    email: firstValue(user.userEmail, user.email, ''),
    phone: firstValue(user.userMobile, user.phone, ''),
    imgCount: normalizeNumber(user.imgCount, 0),
    productCount: normalizeNumber(user.productCount, 0),
    userToken: user.userToken || ''
  }
}

function normalizeDevice(device = {}) {
  const userProductId = firstValue(device.userProductId, device.id)
  const bleDeviceId = firstValue(
    device.bleDeviceId,
    device.wxDeviceId,
    device.bluetoothDeviceId,
    device.bleId
  )
  const productDeviceId = firstValue(
    device.productDeviceId,
    device.deviceNo,
    device.serialNo,
    device.productSerialNo,
    bleDeviceId ? device.backendDeviceId : device.deviceId
  )
  const usedMemory = normalizeNumber(
    firstValue(device.usedMemory, device.imgCount),
    0
  )
  const totalMemory = normalizeNumber(
    firstValue(device.totalMemory, device.capacity),
    0
  )
  const intervalSeconds = normalizeNumber(device.intervalSeconds, 0)
  const isUpdate = normalizeNumber(device.isUpdate, 0)
  // 升级方式：后端 updateType 约定 1=强制升级 / 其它(含 2=提醒)=提醒升级（字段名/取值待后端最终确认，仅改此一处即可）。
  // 归一为 upgradeMode: 'force'(强制) | 'remind'(提醒) | ''(无更新)，供启动全局检测与升级入口判断。
  const updateType = normalizeNumber(
    firstValue(device.updateType, device.upgradeType, device.forceType),
    0
  )
  const upgradeMode = isUpdate === 1 ? (updateType === 1 ? 'force' : 'remind') : ''
  const newVersionNo = firstValue(
    device.newVersionNo,
    device.latestVersion,
    device.versionNo
  )
  const downloadPath = firstValue(
    device.downloadPath,
    device.packageUrl,
    device.firmwareUrl,
    device.url
  )

  return Object.assign({}, device, {
    id: String(firstValue(userProductId, productDeviceId, bleDeviceId)),
    userProductId,
    // deviceId 在页面里用于微信 BLE 连接；后端的设备唯一号保存在 deviceNo/productDeviceId。
    deviceId: bleDeviceId,
    productDeviceId,
    deviceNo: productDeviceId,
    name: firstValue(
      device.name,
      device.productName,
      device.screen,
      '智能相框'
    ),
    productName: firstValue(
      device.productName,
      device.name,
      device.screen,
      '智能相框'
    ),
    icon: firstValue(
      device.productImg,
      device.icon,
      '/assets/images/mine-icon03.png'
    ),
    battery: typeof device.battery === 'number' ? device.battery : null,
    connected: !!(device.connected && bleDeviceId),
    usedMemory,
    totalMemory,
    playbackMode: firstValue(device.playbackMode, device.playMode, 'order'),
    intervalSeconds,
    intervalHours: normalizeNumber(
      device.intervalHours,
      intervalSeconds ? Math.max(1, Math.round(intervalSeconds / 3600)) : 2
    ),
    isUpdate,
    hasUpdate: isUpdate === 1,
    updateType,
    upgradeMode,
    newVersionNo,
    downloadPath,
    carouselEnabled: device.carouselEnabled !== false
  })
}

function normalizePhoto(photo = {}, index = 0) {
  const id = firstValue(
    photo.uProductImgId,
    photo.uproductImgId,
    photo.id,
    `photo_${index}`
  )
  return Object.assign({}, photo, {
    id: String(id),
    uProductImgId: firstValue(photo.uProductImgId, photo.uproductImgId, id),
    deviceId: firstValue(photo.userProductId, photo.deviceId, ''),
    deviceName: firstValue(photo.productName, photo.deviceName, '相框'),
    title: firstValue(photo.title, photo.productName, `照片 ${index + 1}`),
    url: firstValue(photo.img, photo.url, ''),
    createdAt: firstValue(photo.upTime, photo.joinTime, photo.createdAt, ''),
    onDevice: photo.onDevice !== false
  })
}

function normalizeProjectionRecord(record = {}, index = 0) {
  const state = Number(record.deviceUploadState)
  const stateText = String(record.deviceUploadStateMsg || record.status || '')
  const success = record.status
    ? record.status === 'success'
    : Number.isFinite(state)
      ? state === 1
      : stateText.indexOf('成功') > -1
  const status = success ? 'success' : 'fail'

  return Object.assign({}, record, {
    id: String(firstValue(record.upirId, record.id, `record_${index}`)),
    status,
    statusText: status === 'success' ? '投屏成功' : '投屏失败',
    message: firstValue(
      record.deviceUploadStateMsg,
      record.message,
      status === 'success' ? '投屏成功' : '投屏失败'
    ),
    createdAt: firstValue(record.upTime, record.joinTime, record.createdAt, ''),
    deviceName: firstValue(record.productName, record.deviceName, '相框'),
    thumbUrl: firstValue(record.img, record.thumbUrl, record.url, ''),
    imageCount: normalizeNumber(record.imageCount, 1)
  })
}

function isLocalFile(path) {
  return !!path && !/^https?:\/\//i.test(path) && !/^\/assets\//.test(path)
}

function extractUploadUrl(result) {
  const item = Array.isArray(result) ? result[0] : result

  if (typeof item === 'string') {
    return item
  }
  if (!item || typeof item !== 'object') {
    return ''
  }

  return firstValue(
    item.url,
    item.fileUrl,
    item.filePath,
    item.path,
    item.img,
    item.data && item.data.url
  )
}

function productScore(product, scan) {
  const text = [
    product.productName,
    product.model,
    product.screen,
    product.width,
    product.height
  ]
    .join(' ')
    .toLowerCase()
  const terms = [scan.model, scan.screen, scan.name]
    .filter(Boolean)
    .map(item => String(item).toLowerCase())

  return terms.reduce(
    (score, term) => score + (text.indexOf(term) > -1 ? 1 : 0),
    0
  )
}

module.exports = {
  getProductList(params = {}) {
    return http.get('/Client/Product/getProductList', params, {
      mock: false
    })
  },

  // 拉取产品列表里每个产品的 broadcastId（广播名），用于蓝牙搜索时按它过滤目标相框。
  // 返回去重后的非空字符串数组；拉取失败由调用方兜底（不在此处吞错）。
  async getProductBroadcastIds() {
    const data = await module.exports.getProductList({ pageIndex: 1, pageSize: 100 })
    const ids = pageData(data)
      .map(item => String((item && item.broadcastId) || '').trim())
      .filter(Boolean)
    return ids.filter((id, index) => ids.indexOf(id) === index)
  },

  getProductFaqList(params = {}) {
    return http.get('/Client/Product/getProductFaqList', params, {
      mock: false
    })
  },

  getProductFaqDetail(faqIdOrParams) {
    const params =
      typeof faqIdOrParams === 'object'
        ? faqIdOrParams
        : { faqId: faqIdOrParams }

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

  // BLE 图片转换上传：form-data 上传原图，后端按 targetWidth×targetHeight 把图片转换成设备需要的帧数据(.bin)
  // 并存到 OSS，返回 { url(可下载的 .bin 地址)、taskId(任务id，更新设备上传状态用)、upirId(投屏记录id)、name }。
  // device/terminal/language/userToken 由 request.js 经 header/query 自动注入，业务只传文件与目标宽高。
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
        deviceUploadState: options.deviceUploadState,
        targetWidth: options.targetWidth,
        targetHeight: options.targetHeight,
        // 后端压缩恒开：1=后端把它存的图压到约300-400KB。原先预览页有个「压缩」开关可传 0（原图），
        // 开关已下线（产品定为默认且只能压缩），这里固定 1，不再由调用方控制。
        // ⚠️ 字段名 isCompress 为约定假设，待后端确认（确认后只需改这一处）。
        isCompress: 1
      },
      formData: options.formData,
      mock: false,
      // 投屏结果页自管进度文案(setData desc)，按需传 loading:false 关掉全局 loading 遮罩、showError:false 自行处理错误
      loading: options.loading !== false,
      loadingText: options.loadingText || '上传中',
      showError: options.showError
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
    return http.get(
      '/Client/User/getUserInfo',
      {},
      {
        mock: false
      }
    )
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
    return http.post(
      '/Client/User/loginOut',
      {},
      {
        mock: false
      }
    )
  },

  // 用户注销（销户）
  userOff() {
    return http.post(
      '/Client/User/userOff',
      {},
      {
        mock: false,
        loading: true,
        loadingText: '注销中'
      }
    )
  },

  // —— 设备接口（UserProduct）——
  // 添加/绑定用户设备。data: { productId(必传), productName, deviceId }
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

  // 获取设备一键清除状态，id=userProductId。retData: 0=未清除, 1=已清除。
  // 图库页进入/切换设备时后台查询用：失败静默（showError:false），下次切换设备会再查。
  getUserProductClearImg(userProductId) {
    const params =
      typeof userProductId === 'object' ? userProductId : { id: userProductId }

    return http.get('/Client/UserProduct/getUserProductClearImg', params, {
      mock: false,
      showError: false
    })
  },

  // 用户产品图片列表（我的图库）。params 支持分页与 userProductId 过滤
  getUserProductImgList(params = {}) {
    return http.get('/Client/UserProduct/getUserProductImgList', params, {
      mock: false
    })
  },

  // 删除产品图片，支持多选，id=uProductImgId。可传单 id、id 数组或 { idList }/{ ids }。
  // 后端约定的字段名是 idList（不是 ids）。
  delUserProductImg(ids) {
    const list = Array.isArray(ids)
      ? ids
      : ids && Array.isArray(ids.idList)
        ? ids.idList
        : ids && Array.isArray(ids.ids)
          ? ids.ids
          : [ids]

    return http.post(
      '/Client/UserProduct/delUserProductImg',
      { idList: list.filter(item => item !== undefined && item !== null) },
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

  // 编辑投屏记录：BLE 图传到设备成功后调用，用上传接口返回的 taskId/upirId 把该条投屏记录的
  // 设备上传状态置为成功(deviceUploadState=1)。设备图传失败则不调用（记录保持失败态）。
  // body 只传业务字段；device/language/terminal/userToken 由 request.js 经 header/query 注入。
  editUserProductImgRecord(data = {}) {
    return http.post(
      '/Client/UserProduct/editUserProductImgRecord',
      {
        upirId: data.upirId,
        taskId: data.taskId,
        deviceUploadState: data.deviceUploadState
      },
      {
        mock: false,
        showError: data.showError
      }
    )
  },

  // 添加投屏记录：再次投屏（记录页用 imgBle 直传设备，不再走后端转码上传）设备图传成功后调用，
  // 新增一条投屏记录。body 只传业务字段，按当前有的值赋值（taskId 再次投屏链路没有，传 undefined 会被序列化丢弃）；
  // device/language/terminal/userToken 由 request.js 经 header/query 注入。
  addUserProductImgRecord(data = {}) {
    return http.post(
      '/Client/UserProduct/addUserProductImgRecord',
      {
        upirId: data.upirId,
        userProductId: data.userProductId,
        img: data.img,
        imgBle: data.imgBle,
        taskId: data.taskId,
        deviceUploadState: data.deviceUploadState
      },
      {
        mock: false,
        showError: data.showError
      }
    )
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

  wechatAppLogin(data) {
    return module.exports.setWechatAppLogin(data)
  },

  loginByWechat(data) {
    return module.exports.setWechatAppLogin(data)
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
    return module.exports.getUserInfo().then(normalizeUserProfile)
  },

  async updateUserProfile(data = {}) {
    const nickName = String(data.nickName || '').trim()
    let avatar = data.avatar || data.avatarUrl || ''

    if (avatar && isLocalFile(avatar)) {
      const uploadResult = await module.exports.setFileUpload({
        filePath: avatar
      })
      avatar = extractUploadUrl(uploadResult) || avatar
    }

    const tasks = []
    if (nickName) {
      tasks.push(module.exports.changeNickName(nickName))
    }
    if (avatar) {
      tasks.push(module.exports.changeAvatar(avatar))
    }

    if (tasks.length) {
      await Promise.all(tasks)
    }

    return module.exports.getUserProfile()
  },

  // 修改/绑定邮箱，POST /Client/User/changeUserEmail。
  // body: userEmail、verifyCode、password、confirmPassword；密码以 md5(32位小写) 加密后传输。
  // device/language/terminal/userToken 由 request.js 经 header/query 自动传递。
  // 小程序绑定与修改邮箱共用此接口，绑定后邮箱+密码可用于 App 登录。
  changeUserEmail(data = {}) {
    const payload = typeof data === 'string' ? { userEmail: data } : data || {}
    const verifyCode =
      payload.verifyCode != null ? payload.verifyCode : payload.code
    const password = payload.password || ''
    const confirmPassword =
      payload.confirmPassword != null ? payload.confirmPassword : password

    return http.post(
      '/Client/User/changeUserEmail',
      {
        userEmail: payload.userEmail,
        verifyCode,
        password: password ? md5(password) : '',
        confirmPassword: confirmPassword ? md5(confirmPassword) : ''
      },
      {
        mock: false,
        loading: true,
        loadingText: '保存中'
      }
    )
  },

  // 兼容旧方法名：绑定/修改邮箱统一走真实的 changeUserEmail
  bindEmail(data) {
    return module.exports.changeUserEmail(data)
  },

  changeEmail(data) {
    return module.exports.changeUserEmail(data)
  },

  logout() {
    return module.exports.loginOut()
  },

  deleteAccount() {
    return module.exports.userOff()
  },

  getDevices() {
    return module.exports
      .getUserProductList({
        pageIndex: 1,
        pageSize: 100
      })
      .then(data => pageData(data).map(normalizeDevice))
  },

  getDeviceDetail(deviceId) {
    return module.exports.getUserProductDetail(deviceId).then(device =>
      normalizeDevice(
        Object.assign({}, device, {
          userProductId: firstValue(device && device.userProductId, deviceId)
        })
      )
    )
  },

  async bindDevice(device) {
    const scan = device && device.device ? device.device : device || {}
    // productId 是 addUserProduct 的必传参数，来源是产品列表接口 /Client/Product/getProductList。
    // 蓝牙扫描到的设备本身不带 productId：每次绑定附近设备都先拉「全部产品列表」，
    // 再用本地蓝牙搜索到的设备去逐条匹配，匹配出对应产品的 productId 后才调用添加设备接口。
    let list = []
    try {
      const products = await module.exports.getProductList({
        pageIndex: 1,
        pageSize: 100
      })
      list = pageData(products)
    } catch (error) {
      throw new Error('获取产品列表失败，无法确定产品(productId)，请稍后重试')
    }

    // 用本地蓝牙搜索到的设备(型号/屏幕/名称)和产品列表逐条比对，取匹配度最高的一条作为它对应的产品。
    const matched = list
      .slice()
      .sort((a, b) => productScore(b, scan) - productScore(a, scan))[0]
    const productId = matched && matched.productId

    // productId 必传：匹配不到就中止绑定并明确提示，避免缺 productId 还往后端发请求。
    if (!productId) {
      throw new Error(
        '未匹配到对应产品(productId)，请确认该设备在产品列表中存在'
      )
    }

    const productName = firstValue(
      scan.productName,
      scan.name,
      scan.model,
      scan.screen,
      '智能相框'
    )
    const productDeviceId = firstValue(
      scan.deviceNo,
      scan.hardwareDeviceId,
      scan.productSerialNo,
      scan.deviceId
    )
    const payload = {
      productId, // 必传，已在上面确保非空
      productName,
      deviceId: productDeviceId
    }

    const saved = await module.exports.addUserProduct(payload)
    return normalizeDevice(
      Object.assign({}, scan, saved, {
        bleDeviceId: scan.deviceId,
        productDeviceId,
        deviceNo: productDeviceId,
        productName
      })
    )
  },

  // 重命名设备（纯后端存储：名称以用户为维度，不写设备固件、不影响蓝牙连接/广播，连不连接都可改）。
  // 注意：editUserProduct 返回精简对象，这里不再拼装成 device 返回——之前拼出的对象缺
  // bleDeviceId/productDeviceId，调用方拿去整体替换现有 device 会造成假断联。
  // 调用方应自行把新名字合并进已有 device 对象。
  renameDevice(deviceId, name) {
    return module.exports.editUserProduct({
      userProductId: deviceId,
      productName: name
    })
  },

  updateDevicePlayback(deviceId, data) {
    return Promise.resolve(
      normalizeDevice(
        Object.assign(
          {
            userProductId: deviceId
          },
          data
        )
      )
    )
  },

  formatDevice(deviceId) {
    return module.exports.clearUserProductImg(deviceId)
  },

  clearDevicePhotoCopies(deviceId) {
    return module.exports.clearUserProductImg(deviceId)
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
    return module.exports.delUserProduct(deviceId)
  },

  getAlbumPhotos() {
    return module.exports
      .getUserProductImgList({
        pageIndex: 1,
        pageSize: 100
      })
      .then(data => pageData(data).map(normalizePhoto))
  },

  deleteAlbumPhotos(ids) {
    return module.exports.delUserProductImg(ids)
  },

  uploadProjection(data) {
    const files = data && data.images ? data.images : []
    return module.exports.setUserProductUpload({
      filePaths: files
        .map(item => item.tempFilePath || item.url)
        .filter(Boolean),
      userProductId: data && data.deviceId,
      deviceUploadState: data && data.deviceUploadState
    })
  },

  // 投屏记录列表。可传 deviceUploadState 过滤设备上传状态：1=成功 / 0=失败；不传则取全部。
  getProjectionRecords(params = {}) {
    const query = {
      pageIndex: 1,
      pageSize: 100
    }
    // 仅在明确传 0/1 时带上该参数，避免把 undefined 发给后端
    if (params.deviceUploadState === 0 || params.deviceUploadState === 1) {
      query.deviceUploadState = params.deviceUploadState
    }

    return module.exports
      .getUserProductImgRecordList(query)
      .then(data => pageData(data).map(normalizeProjectionRecord))
  },

  deleteProjectionRecord(recordId) {
    return module.exports.delUserProductImgRecord(recordId)
  }
}
