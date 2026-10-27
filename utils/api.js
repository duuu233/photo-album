// 业务接口集中定义层：每个方法对应一个后端接口，统一通过 request.js 发起。
// 第三个参数为请求选项，常用：loading 显示加载、auth:false 免登录、showError:false 静默错误。
const http = require('./request')
const deviceIdUtil = require('./device-id')
const deviceThumb = require('./device-thumb')
const { md5 } = require('./md5')

// setUserProductUpload 里请求后端把它存的那张图压到多大（KB）。后端默认约 300-400KB，
// 图库/再次投屏预览看着偏肉，放宽到 1MB 上下（2026-07-14）。见下方 setUserProductUpload 的字段说明。
const UPLOAD_COMPRESS_SIZE_KB = 1024

// 统计「投屏成功记录条数」时的翻页参数：单页 100 条与列表页同口径；
// MAX_PAGES 是后端分页元数据异常（recordCount/pageCount 都不回）时的死循环保险丝。
const RECORD_COUNT_PAGE_SIZE = 100
const RECORD_COUNT_MAX_PAGES = 20

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

// 轮播设置的权威来源是后端 carouselInterval（分钟）。设备 0x01 读回值、本地缓存值只作
// 后端缺字段时的兜底；真正下发 0x10 前统一在这里换算成秒，避免连接后被设备旧值反向覆盖。
function resolveCarouselIntervalSeconds(device = {}, fallbackSeconds = 0) {
  const carouselMinutes = normalizeNumber(device.carouselInterval, 0)
  if (carouselMinutes > 0) {
    return Math.max(1, Math.round(carouselMinutes * 60))
  }

  const fallback = normalizeNumber(fallbackSeconds, 0)
  return fallback > 0 ? Math.max(1, Math.round(fallback)) : 0
}

// 设备图片槽位索引 → 接口入参：后端约定 String 类型。
// ⚠️ 0 是合法槽位（相框第一个位置），不能当空值丢掉；只有「本次没有索引可上报」才返回
// undefined（序列化时被丢弃，后端按不传处理）。
function imgIndexParam(value) {
  // ⚠️ 必须先挡掉 undefined/null/''：Number(null) 和 Number('') 都等于 0，
  // 不挡的话「没有索引」会被误报成「0 号位」，反过来污染相框第一个位置的记录。
  if (value === undefined || value === null || value === '') {
    return undefined
  }
  const index = Number(value)
  return Number.isInteger(index) && index >= 0 ? String(index) : undefined
}

// 可用 Token 余额（2026-08-11 起后端在 UserInfoApiOut / UserInfoDetailApiOut 里下发，String 类型）。
// ⚠️ 必须区分「后端没给这个字段」和「余额真的是 0」：
//    前者返回 null，调用方据此回退去调 /Client/Order/getUserAccount（灰度期间老后端仍可能不下发）；
//    后者是合法的 0，绝不能被当成缺失去多打一次接口，更不能显示成上一次的旧余额。
function normalizeAvailableToken(value) {
  if (value === undefined || value === null || value === '') {
    return null
  }
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, number) : null
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
    // 可用 Token 余额；null = 本次响应没带这个字段（见 normalizeAvailableToken）
    availableToken: normalizeAvailableToken(user.availableToken),
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
  const deviceIdCandidates = [
    device.productDeviceId,
    device.deviceNo,
    device.serialNo,
    device.productSerialNo,
    bleDeviceId ? device.backendDeviceId : device.deviceId
  ]
  // 完整 6 字节的候选优先，不让靠前但残缺的字段把它挡掉：老记录常同时带历史 4 字节
  // deviceNo(广播短 ID) 与完整的 deviceId，按「第一个非空」取会取到短的、canonical 归零，
  // 于是设备明明有完整 ID，连接/升级仍被身份闸报「缺少完整的6字节设备ID，请删除后重新绑定」。
  // 一个完整候选都没有时保持原样取第一个非空值，留给 rawProductDeviceId/deviceIdentityInvalid 排查。
  const rawProductDeviceId =
    deviceIdCandidates.filter(deviceIdUtil.isComplete)[0] ||
    firstValue.apply(null, deviceIdCandidates)
  // 后端稳定设备身份只接收完整 6 字节 ID。历史 4 字节广播短 ID 保留在
  // rawProductDeviceId 便于排查，但不得继续进入匹配、展示或后续绑定链路。
  const productDeviceId = deviceIdUtil.canonical(rawProductDeviceId)
  const usedMemory = normalizeNumber(
    firstValue(device.usedMemory, device.imgCount),
    0
  )
  const totalMemory = normalizeNumber(
    firstValue(device.totalMemory, device.capacity),
    0
  )
  // 轮播间隔：后端 carouselInterval 的单位 2026-08-03 起由「小时」改为「分钟」。
  // 端上一律换算成秒存 intervalSeconds —— 下发固件的 0x10 本来就是秒，中间绝不能再经过
  // 「整数小时」这一层：5 分钟按小时取整会变成 1 小时甚至 0，用户点一下开关就把设备改了。
  // 列表接口不下发 carouselInterval，回落到 intervalSeconds（BLE 0x01 读回的真实值）；
  // 再兜底历史 intervalHours，兼容本地缓存里已归一化过的旧设备记录。
  const legacyIntervalHours = normalizeNumber(device.intervalHours, 0)
  const fallbackIntervalSeconds =
    normalizeNumber(device.intervalSeconds, 0) ||
    (legacyIntervalHours > 0
      ? Math.max(1, Math.round(legacyIntervalHours * 3600))
      : 0)
  const intervalSeconds = resolveCarouselIntervalSeconds(
    device,
    fallbackIntervalSeconds
  )
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

  const normalized = Object.assign({}, device, {
    id: String(firstValue(userProductId, productDeviceId, bleDeviceId)),
    userProductId,
    // deviceId 在页面里用于微信 BLE 连接；后端的设备唯一号保存在 deviceNo/productDeviceId。
    deviceId: bleDeviceId,
    productDeviceId,
    deviceNo: productDeviceId,
    rawProductDeviceId,
    deviceIdentityInvalid: !!rawProductDeviceId && !productDeviceId,
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
    // 仅供展示/选择器下标派生，不参与下发：必须保留小数（5 分钟 = 0.0833 小时），
    // 一旦在这里 Math.round 成整数小时，分钟级间隔就再也回不来了。
    intervalHours: intervalSeconds ? intervalSeconds / 3600 : 2,
    isUpdate,
    hasUpdate: isUpdate === 1,
    updateType,
    upgradeMode,
    newVersionNo,
    downloadPath,
    carouselEnabled: device.carouselEnabled !== false
  })
  // 设备图按机型区分（2026-10-22），六处展示统一读这个字段，见 utils/device-thumb.js
  normalized.thumb = deviceThumb.thumbOf(normalized)
  return normalized
}

// 2026-08-17 删除：`normalizePhoto`（「我的图库」列表项归一化）。随 getAlbumPhotos 一起下线，
// 端上已无图库列表的消费方；投屏记录的归一化在下面的 normalizeProjectionRecord。

function normalizeProjectionRecord(record = {}, index = 0) {
  const state = Number(record.deviceUploadState)
  const stateText = String(record.deviceUploadStateMsg || record.status || '')
  const success = record.status
    ? record.status === 'success'
    : Number.isFinite(state)
      ? state === 1
      : stateText.indexOf('成功') > -1
  const status = success ? 'success' : 'fail'
  const rawProductDeviceId = firstValue(
    record.productDeviceId,
    record.deviceNo,
    record.serialNo
  )
  const productDeviceId = deviceIdUtil.canonical(rawProductDeviceId)

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
    productDeviceId,
    deviceNo: productDeviceId,
    rawProductDeviceId,
    deviceIdentityInvalid: !!rawProductDeviceId && !productDeviceId,
    thumbUrl: firstValue(record.img, record.thumbUrl, record.url, ''),
    // 投屏管理列表小图专用：优先后端新字段 imgThumb（缩略图），旧数据回退 img/url 避免空图。
    // thumbUrl 保持整图，仍供「再次投屏」兜底用（见 records.js 的 imageUrl）。
    imgThumb: firstValue(record.imgThumb, record.img, record.thumbUrl, record.url, ''),
    // 这条记录当次投屏占用的设备槽位索引（String，0 合法）。记录页本身不读它——
    // 再次/重新投屏都是重新找空位；保留透传是为了排查时能对上设备实际位置。
    imgIndex: firstValue(record.imgIndex, ''),
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

// 产品列表缓存：设备图按机型区分要用产品的 broadcastId。设备列表接口已下发 productId 与 broadcastId，
// 这里只给没带 broadcastId 的记录（如详情接口、旧缓存）按 productId 回查兜底。
// 成功才缓存（整次会话复用），失败静默返回空数组、不弹错误提示——查不到只是设备图退回默认那张，
// 不能因此挡住设备列表/详情。绑定时 bindDevice 会顺手用最新拉到的列表刷新它。
let productCatalog = null
let productCatalogLoading = null

// 设备列表/详情最多为产品列表多等这么久（请求层超时 + 静默重试能拖到半分钟）：
// 超时就先按已有信息出图，请求本身照常跑完，成功了下次进页面就用上。
const PRODUCT_CATALOG_WAIT_MS = 3000

function loadProductCatalog() {
  if (productCatalog) {
    return Promise.resolve(productCatalog)
  }
  if (!productCatalogLoading) {
    productCatalogLoading = Promise.resolve()
      .then(() =>
        http.get(
          '/Client/Product/getProductList',
          { pageIndex: 1, pageSize: 100 },
          { mock: false, showError: false }
        )
      )
      .then(data => {
        const list = pageData(data)
        if (list.length) {
          productCatalog = list
        }
        return list
      })
      .catch(() => [])
      .then(list => {
        productCatalogLoading = null
        return list
      })
  }
  return productCatalogLoading
}

// 最多等 ms：超时按 fallback 先返回，请求本身照常跑完
function settleWithin(promise, ms, fallback) {
  let timer = null
  return Promise.race([
    promise,
    new Promise(resolve => {
      timer = setTimeout(() => resolve(fallback), ms)
    })
  ]).then(value => {
    clearTimeout(timer)
    return value
  })
}

function productCatalogWithin(ms) {
  return settleWithin(loadProductCatalog(), ms, [])
}

// broadcastId 是否为产品列表里某个产品的广播名（去首尾空白、不区分大小写）
function isProductBroadcastId(broadcastId, products) {
  const own = String(broadcastId || '').trim().toUpperCase()
  return (
    !!own &&
    products.some(item => item && String(item.broadcastId || '').trim().toUpperCase() === own)
  )
}

// 给设备记录补上所属产品的 broadcastId：记录自带、且是产品列表里认得的广播名就不动；
// 没带，或带的不是任何产品的广播名（字段口径对不上时）才按 productId 精确匹配产品列表覆盖。
function withProductBroadcastId(device, products) {
  if (!device || !products.length) {
    return device
  }
  if (isProductBroadcastId(device.broadcastId, products)) {
    return device
  }
  const productId = device.productId
  if (productId === undefined || productId === null || productId === '') {
    return device
  }
  const matched = products.find(item => item && String(item.productId) === String(productId))
  const broadcastId = String((matched && matched.broadcastId) || '').trim()
  return broadcastId ? Object.assign({}, device, { broadcastId }) : device
}

// 设备列表记录按上面仍认不出机型时，按 userProductId 调一次详情接口补（2026-10-23）。
// 反馈：EC-370 详情页设备图/容量都对，首页与我的设备不对——同一条绑定记录，详情接口认得出机型、
// 列表接口那条没有可用的 productId / broadcastId。只给认不出的记录调；详情正常返回的结果
// （认不出记为空串）整次会话复用，绑定记录的机型不会变；请求失败静默、不缓存，下次再试。
const detailBroadcastIds = {}

function withDetailBroadcastId(device, products) {
  const userProductId = String(firstValue(device && device.userProductId, ''))
  if (!userProductId || !products.length || isProductBroadcastId(device.broadcastId, products)) {
    return Promise.resolve(device)
  }
  const apply = broadcastId =>
    broadcastId ? Object.assign({}, device, { broadcastId }) : device
  if (Object.prototype.hasOwnProperty.call(detailBroadcastIds, userProductId)) {
    return Promise.resolve(apply(detailBroadcastIds[userProductId]))
  }
  return http
    .get(
      '/Client/UserProduct/getUserProductDetail',
      { userProductId },
      { mock: false, showError: false }
    )
    .then(detail => {
      const resolved = withProductBroadcastId(detail || {}, products)
      const broadcastId = isProductBroadcastId(resolved.broadcastId, products)
        ? String(resolved.broadcastId).trim()
        : ''
      detailBroadcastIds[userProductId] = broadcastId
      return apply(broadcastId)
    })
    .catch(() => device)
}

// 搜索结果（绑定前、还没有设备记录）的屏幕尺寸：蓝牙广播名 name / localName 包含哪个产品的
// broadcastId（去首尾空白、大小写不敏感，与扫描白名单/bindDevice 同口径），就取该产品后台配置的
// sizeModel（2026-10-23）。多个命中取 broadcastId 最长的那个（更具体）；没命中或没配返回空串，不展示。
function scanSizeModel(scan, products) {
  const names = [scan && scan.name, scan && scan.localName]
    .filter(Boolean)
    .map(name => String(name).toLowerCase())
  let best = null
  ;(products || []).forEach(product => {
    const broadcastId = String((product && product.broadcastId) || '').trim().toLowerCase()
    if (!broadcastId || !names.some(name => name.indexOf(broadcastId) > -1)) {
      return
    }
    if (!best || broadcastId.length > best.broadcastId.length) {
      best = { broadcastId, sizeModel: product.sizeModel }
    }
  })
  return best ? String(best.sizeModel || '').trim() : ''
}

// getProductByDevice 的返回归一成产品对象；查不到返回 null。兼容直接回对象或回列表（取第一条）两种形状。
// 「查到」只认产品身份：有效的 productId（非空、非 0）或非空的产品名。空数据、空对象、字段全是
// null / 0 的空壳记录一律算查不到（2026-10-26 收紧：原先只要 sizeModel 有值、或 productId 为 0 也算查到，
// 后端对未开通设备回一条默认值记录时会被当成已开通，「未知设备」就拦不住）。
// 还没拿到真实返回样例，外面再包一层的常见形状一并兼容：分页（list / records / rows）、
// 或包在 product / productInfo / data 字段里。
function unwrapWifiProduct(data) {
  let raw = data
  for (let depth = 0; depth < 3 && raw && typeof raw === 'object'; depth++) {
    if (Array.isArray(raw)) {
      raw = raw[0]
      continue
    }
    const list = [raw.list, raw.records, raw.rows].find(Array.isArray)
    if (list) {
      raw = list[0]
      continue
    }
    const inner = [raw.product, raw.productInfo, raw.data].find(
      value => value && typeof value === 'object'
    )
    if (inner && raw.productId === undefined && raw.sizeModel === undefined) {
      raw = inner
      continue
    }
    break
  }
  return raw
}

// 接口成功但算「没查到」时的原因（给联调看，见 lookupProductByDevice）
function describeWifiProductMiss(data) {
  const raw = unwrapWifiProduct(data)
  if (raw === null || raw === undefined || raw === '') {
    return '返回为空'
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return `返回格式不认识：${JSON.stringify(data)}`
  }
  if (!Object.keys(raw).length) {
    return '返回为空对象'
  }
  return `返回里没有产品 ID 和产品名称：${JSON.stringify(data).slice(0, 200)}`
}

function normalizeWifiProduct(data) {
  const raw = unwrapWifiProduct(data)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null
  }
  const productName = String(firstValue(raw.productName, raw.name, raw.model, '')).trim()
  const sizeModel = String(firstValue(raw.sizeModel, '')).trim()
  const productId = firstValue(raw.productId, raw.id, '')
  const hasProductId = productId !== '' && String(productId).trim() !== '0'
  if (!hasProductId && !productName) {
    return null
  }
  return Object.assign({}, raw, { productId, productName, sizeModel })
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

  // 蓝牙广播名里含产品列表(/Client/Product/getProductList)的 broadcastId，是最直接的机型依据，
  // 权重压过名称/型号的零散命中：与扫描白名单同口径（去首尾空白、大小写不敏感的包含匹配），
  // 广播名带后缀（EC-370-XXXX）也认得出；也不再靠列表顺序打破平分（EC-370 的屏型若按 3.7 寸上报，
  // 型号会同时命中 EF6-370）。
  const broadcastId = String(product.broadcastId || '').trim().toLowerCase()
  const broadcastHit =
    !!broadcastId &&
    [scan.name, scan.localName]
      .filter(Boolean)
      .some(name => String(name).toLowerCase().indexOf(broadcastId) > -1)

  return terms.reduce(
    (score, term) => score + (text.indexOf(term) > -1 ? 1 : 0),
    broadcastHit ? 10 : 0
  )
}

module.exports = {
  resolveCarouselIntervalSeconds,
  scanSizeModel,
  normalizeWifiProduct,
  // 产品列表（会话缓存、失败静默返回空数组，见 loadProductCatalog）
  getProductCatalog() {
    return loadProductCatalog()
  },
  getProductList(params = {}) {
    return http.get('/Client/Product/getProductList', params, {
      mock: false
    })
  },

  // WiFi 版设备按 deviceId 查产品规格（尺寸、旋转、方向等，老服务接口，2026-10-26），带上没查到的原因。
  // 返回 { product, reason }：查到时 product 为产品对象、reason 为空；没查到时 product 为 null，reason 说明原因，
  // 如「E348C21ED428：接口失败：500 系统异常」。不抛错。
  // 静默（不弹错误）、不做网络重试：失败 / 超时由调用方直接按「未知设备」处理。
  // 设备 ID 只传不带冒号的 12 位（E348C21ED428，即广播名里取出的 deviceNo）：2026-10-27 产品定传给后端查询的设备ID
  // 不加冒号（原 10-26 口径为查不到再用带冒号的写法查一次，已取消）；传进来带冒号也先去掉。
  // 不做结果缓存，每次都实时查（2026-10-26 产品口径，与老接口一致）；同一次搜索里每台只查一次由
  // 搜索页自己按 deviceNo 记账（见 bind.js lookupWifiProduct），重新搜索全部重查。
  async lookupProductByDevice(deviceNo) {
    const plain = String(deviceNo || '').replace(/[:\-\s]/g, '').trim().toUpperCase()
    if (!plain) {
      return { product: null, reason: '设备ID为空' }
    }
    const keys = [plain]
    const reasons = []
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]
      let data = null
      try {
        data = await http.get(
          '/Client/Product/getProductByDevice',
          { deviceNo: key },
          { mock: false, showError: false, retry: false }
        )
      } catch (error) {
        const code = error && error.code !== undefined ? `${error.code} ` : ''
        const message = String((error && error.message) || error || '').replace(/^接口-/, '')
        reasons.push(`${key}：接口失败：${code}${message}`)
        console.warn('[WiFi规格查询]', key, '接口失败', code, message)
        continue
      }
      const product = normalizeWifiProduct(data)
      // 联调期保留：原始返回与归一结果一起打出来，规格显示不对时直接对照（真机 vConsole / 开发者工具可见）
      console.log('[WiFi规格查询]', key, JSON.stringify(data), product ? `→ 查到 sizeModel=${product.sizeModel || '(空)'}` : '→ 这种写法没查到')
      if (product) {
        return { product, reason: '' }
      }
      reasons.push(`${key}：${describeWifiProductMiss(data)}`)
    }
    return { product: null, reason: reasons.join('；') }
  },

  // 只要产品对象的简写：查到返回产品，没查到返回 null（原因见 lookupProductByDevice）
  async getProductByDevice(deviceNo) {
    return (await module.exports.lookupProductByDevice(deviceNo)).product
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
        // 后端压缩恒开：1=后端压它存的那张图（原先预览页有个「压缩」开关可传 0=原图，开关已下线，
        // 产品定为默认且只能压缩，这里固定 1，不再由调用方控制）。
        // compressSize=期望的压缩后大小(KB)：后端默认压到约 300-400KB，画质偏肉，改为放宽到 1MB 上下。
        // ⚠️ 字段名 isCompress / compressSize 与 compressSize 的单位(KB)均为约定假设，待后端确认：
        //    后端若不认 compressSize 会忽略它、仍按 300-400KB 压（改这一处即可对齐后端真实字段）。
        isCompress: 1,
        compressSize: UPLOAD_COMPRESS_SIZE_KB
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
    const payload = Object.assign({}, data, {
      // 绑定入库只允许 0x01 返回的完整 6 字节 Device_ID；禁止广播短 ID / BLE 句柄兜底。
      deviceId: deviceIdUtil.requireComplete(
        data.deviceId,
        '电子纸设备-绑定失败：未读取到完整的6字节电子纸设备ID'
      )
    })
    return http.post('/Client/UserProduct/addUserProduct', payload, {
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

  // 产品投屏记录列表（成功/失败投屏）。params 支持分页、keyword 搜索图片地址、userProductId
  getUserProductImgRecordList(params = {}) {
    return http.get('/Client/UserProduct/getUserProductImgRecordList', params, {
      mock: false
    })
  },

  // 编辑投屏记录：BLE 图传到设备成功后调用，用上传接口返回的 taskId/upirId 把该条投屏记录的
  // 设备上传状态置为成功(deviceUploadState=1)。设备图传失败则不调用（记录保持失败态）。
  // imgIndex=这张图实际写入设备的物理槽位索引，供图库删除/刷新屏幕定位（见 docs/decisions/image-slot-index.md）。
  // body 只传业务字段；device/language/terminal/userToken 由 request.js 经 header/query 注入。
  editUserProductImgRecord(data = {}) {
    return http.post(
      '/Client/UserProduct/editUserProductImgRecord',
      {
        upirId: data.upirId,
        taskId: data.taskId,
        deviceUploadState: data.deviceUploadState,
        imgIndex: imgIndexParam(data.imgIndex)
      },
      {
        mock: false,
        showError: data.showError
      }
    )
  },

  // 添加投屏记录。⚠️ 2026-07-23 起小程序已无调用方：再次/重新投屏改走正常链路
  //（setUserProductUpload 建记录 + editUserProductImgRecord 记账），旧「imgBle 直传后补记」
  // 场景随 .bin 链路删除。方法保留（后端接口仍在；Flutter 侧同名封装同样保留、同样无调用方）。
  // body 只传业务字段（undefined 会被序列化丢弃）；imgIndex 语义同 editUserProductImgRecord。
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
        deviceUploadState: data.deviceUploadState,
        imgIndex: imgIndexParam(data.imgIndex)
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
    return Promise.all([
      module.exports.getUserProductList({
        pageIndex: 1,
        pageSize: 100
      }),
      productCatalogWithin(PRODUCT_CATALOG_WAIT_MS)
    ]).then(([data, products]) => {
      const rows = pageData(data).map(device => withProductBroadcastId(device, products))
      // 详情补机型最多再等 PRODUCT_CATALOG_WAIT_MS，超时先按已有信息出图，成功了下次进页面就用上
      return settleWithin(
        Promise.all(rows.map(device => withDetailBroadcastId(device, products))),
        PRODUCT_CATALOG_WAIT_MS,
        rows
      ).then(list => list.map(normalizeDevice))
    })
  },

  getDeviceDetail(deviceId) {
    return Promise.all([
      module.exports.getUserProductDetail(deviceId),
      productCatalogWithin(PRODUCT_CATALOG_WAIT_MS)
    ]).then(([device, products]) =>
      normalizeDevice(
        withProductBroadcastId(
          Object.assign({}, device, {
            userProductId: firstValue(device && device.userProductId, deviceId)
          }),
          products
        )
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
      if (list.length) {
        productCatalog = list
      }
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
        '未匹配到对应产品(productId)，请确认该电子纸设备在产品列表中存在'
      )
    }

    const productName = firstValue(
      scan.productName,
      scan.name,
      scan.model,
      scan.screen,
      '智能相框'
    )
    const productDeviceId = deviceIdUtil.requireComplete(
      firstValue(
        scan.deviceNo,
        scan.productDeviceId,
        scan.hardwareDeviceId,
        scan.productSerialNo
      ),
      '电子纸设备-绑定失败：未读取到完整的6字节电子纸设备ID'
    )
    const payload = {
      productId, // 必传，已在上面确保非空
      productName,
      deviceId: productDeviceId
    }

    const saved = await module.exports.addUserProduct(payload)
    // 2026-08-12（后端改动）：**解除绑定后再次添加时，addUserProduct 会把上次保存的昵称原样回带**
    //（出参 ClientUserProductDetailApiOut.productName）。它比端上按型号/广播名拼的默认名贴用户得多，
    // 绑定后的命名弹窗要带出它。
    // ⚠️ 必须**连 name 一起盖**：normalizeDevice 的 name 取「第一个非空」，而 scan.name（蓝牙广播名）
    //    排在 productName 前面 —— 只改 productName 的话，弹窗里带出来的仍是广播名。
    // 首次绑定不受影响：那时后端回的就是我们刚提交上去的 productName，两者本来就一样。
    const savedName = String((saved && saved.productName) || '').trim()
    const merged = Object.assign({}, scan, saved, {
      bleDeviceId: scan.deviceId,
      productDeviceId,
      deviceNo: productDeviceId,
      productName: savedName || productName,
      // 绑定到哪个产品就是哪个机型：设备图据此区分（见 utils/device-thumb.js）
      broadcastId: String(matched.broadcastId || '').trim()
    })
    if (savedName) {
      merged.name = savedName
    }
    return normalizeDevice(merged)
  },

  // 绑定 WiFi 版设备（2026-10-26，配网 STEP 2）：走老服务同一个 addUserProduct。
  //   · deviceId 用 12 位 deviceNo 转成的 AA:BB:CC:DD:EE:FF（与蓝牙版同口径；2026-10-27 产品再次确认统一加冒号）。
  //     查询类接口（getProductByDevice、IoT 在线 / 设备信息）仍传不带冒号的 12 位；
  //   · productId / 产品名取搜索时 getProductByDevice 查到的产品，不再按广播名打分匹配；
  //   · 先查已绑定列表：同一台已绑定过（重配网 / 上次绑定成功但联网失败）就复用那条，不重复绑定；
  //   · 新绑定后回查列表补真实 userProductId（addUserProduct 的返回不含可靠主键，同蓝牙版 bind.js 的处理）。
  // 不弹 loading / 错误提示：配网状态页自己展示进度和错误。返回归一化后的设备记录（带 commType: 'WIFI'）。
  async bindWifiDevice(options = {}) {
    const productDeviceId = deviceIdUtil.requireComplete(
      options.deviceNo,
      '设备ID格式不正确，无法绑定'
    )
    const serial = productDeviceId.replace(/:/g, '')
    const sameDevice = item =>
      [item && item.deviceNo, item && item.productDeviceId].some(
        value => String(value || '').replace(/[:\-\s]/g, '').toUpperCase() === serial
      )
    // 查不到列表按未绑定处理
    const findBound = async () => {
      try {
        const list = await module.exports.getDevices()
        return list.find(sameDevice) || null
      } catch (error) {
        return null
      }
    }
    const wifiFields = {
      commType: 'WIFI',
      wifiDeviceNo: serial,
      broadcastName: options.broadcastName || ''
    }

    const existed = await findBound()
    if (existed) {
      return Object.assign({}, existed, wifiFields)
    }

    // 默认昵称 = 完整蓝牙广播名（如 IJ_E348C21ED428，2026-10-27 产品口径），与蓝牙版一致；
    // 之前传的是产品名，同款 WiFi 设备绑定后全叫一个名字。广播名取不到才回落产品名。
    const productName = String(options.broadcastName || options.productName || '智能相框').trim()
    const saved = await http.post(
      '/Client/UserProduct/addUserProduct',
      { productId: options.productId, productName, deviceId: productDeviceId },
      { mock: false, showError: false }
    )
    const savedName = String((saved && saved.productName) || '').trim()
    let device = normalizeDevice(
      Object.assign({}, saved, {
        productId: options.productId,
        productDeviceId,
        deviceNo: productDeviceId,
        productName: savedName || productName,
        name: savedName || productName,
        sizeModel: options.sizeModel || (saved && saved.sizeModel) || ''
      })
    )
    const persisted = await findBound()
    if (persisted && persisted.id) {
      device = Object.assign({}, device, {
        id: String(persisted.id),
        userProductId: persisted.userProductId || persisted.id
      })
    }
    return Object.assign(device, wifiFields)
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

  // 2026-08-13 删除：`getDeviceFirmware` / `reportDeviceFirmwareUpgrade`（`/devices/:id/firmware*`）。
  // 那是 mock 时代的假接口，真实后端只有 `/Client/...`，07-16 关掉 mock 总开关后它们每次都是 404
  // （靠 showError:false + .catch 静默着，没人看得见）。固件版本信息现在由 `getDeviceDetail` 的
  // `newVersionNo`/`downloadPath` 提供；**升级结果按产品口径不需要通知后端**，故不另找替代接口。

  deleteDevice(deviceId) {
    return module.exports.delUserProduct(deviceId)
  },

  // 2026-08-17 删除：`getAlbumPhotos` / `deleteAlbumPhotos` 及其底层
  // `getUserProductImgList` / `delUserProductImg`（「我的图库」列表与删除）。
  // 端上已经没有任何页面渲染图库列表：「我的相册」铺的是**投屏成功记录**，删除只认记录自己的
  // `imgIndex`（2026-08-10 起），再次投屏直接用记录自己的 `img`（2026-07-22 起上传的就是原图）。
  // 图库照片的清理归后端。要恢复得先想清楚谁消费它，别只为「以前有」而接回来。

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

  // 投屏记录列表。可按上传状态与绑定设备筛选。
  getProjectionRecords(params = {}) {
    const query = {
      pageIndex: 1,
      pageSize: 100
    }
    // 仅在明确传 0/1 时带上该参数，避免把 undefined 发给后端
    if (params.deviceUploadState === 0 || params.deviceUploadState === 1) {
      query.deviceUploadState = params.deviceUploadState
    }
    if (params.userProductId) {
      query.userProductId = params.userProductId
    }

    return module.exports
      .getUserProductImgRecordList(query)
      .then(data => pageData(data).map(normalizeProjectionRecord))
  },

  // 「我的」页「我的相册」卡片上的数字：**全部设备**的投屏成功记录条数。
  // 与该页列表同口径（deviceUploadState=1 + 端上按 status 兜底），只是不带 userProductId
  // ——卡片统计的是全部设备的合计，不是当前选中的那台。
  //
  // 这里只要数字不要数据，所以尽量少打请求：
  // · 后端认 deviceUploadState 时（回来的整页都是成功记录），直接用分页元数据 recordCount，
  //   一次请求就拿到真实总数，超过一页也不会被截断；
  // · 后端忽略它时 recordCount 是「成功+失败」的合计，不能当成功数用，只能逐页翻并按 status 数。
  //   判停优先看 pageCount/recordCount，不能拿「回包条数 < 请求的 pageSize」当依据：
  //   后端可能无视 pageSize 按自己的默认值分页（见 guide.js fetchAllFaq 踩过的同款坑）。
  getProjectionSuccessCount() {
    const readPage = (pageIndex, scanned, counted) =>
      module.exports
        .getUserProductImgRecordList({
          pageIndex,
          pageSize: RECORD_COUNT_PAGE_SIZE,
          deviceUploadState: 1
        })
        .then(data => {
          const rows = pageData(data)
          // 成功判定收口到 normalizeProjectionRecord，与列表页同一套字段兼容规则
          const success = rows.filter(
            row => normalizeProjectionRecord(row).status === 'success'
          )
          const seen = scanned + rows.length
          const total = counted + success.length
          const recordCount = Number(data && data.recordCount) || 0
          const pageCount = Number(data && data.pageCount) || 0

          // 整页都是成功记录 → 后端确实按 deviceUploadState 过滤了，recordCount 即成功总数
          if (recordCount && rows.length && success.length === rows.length) {
            return recordCount
          }

          const done =
            !rows.length ||
            pageIndex >= RECORD_COUNT_MAX_PAGES ||
            (pageCount && pageIndex >= pageCount) ||
            (!pageCount && recordCount && seen >= recordCount) ||
            (!pageCount && !recordCount && rows.length < RECORD_COUNT_PAGE_SIZE)

          return done ? total : readPage(pageIndex + 1, seen, total)
        })

    return readPage(1, 0, 0)
  },

  deleteProjectionRecord(recordId) {
    return module.exports.delUserProductImgRecord(recordId)
  },

  // 批量删除投屏记录（「我的相册」删照片时连同来源记录一并删，否则删掉的照片还会留在列表里）。
  // 后端没有批量删接口，这里串行逐条调用；单条关掉 loading 与自动错误提示——
  // 批量删 10 张会闪 10 次「删除中」、失败时弹 10 条 toast，统一由调用方一次 loading + 一次提示。
  // 返回 { total, failed }：允许部分失败（设备与相册记录已删成功时不能整体回滚），由调用方决定文案。
  deleteProjectionRecords(ids) {
    const list = (Array.isArray(ids) ? ids : [ids]).filter(
      id => id !== undefined && id !== null && id !== ''
    )

    return list.reduce(
      (chain, id) =>
        chain.then(result =>
          http
            .post(
              '/Client/UserProduct/delUserProductImgRecord',
              { id },
              { mock: false, showError: false }
            )
            .then(
              () => result,
              () => Object.assign(result, { failed: result.failed + 1 })
            )
        ),
      Promise.resolve({ total: list.length, failed: 0 })
    )
  }
}
