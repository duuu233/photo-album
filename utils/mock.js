// 本地模拟后端：用一份存在 Storage 里的“数据库”模拟全部接口，无需真实服务端即可联调。
// 入口是底部的 handle(options)，按 url/method 路由到对应处理函数；config.useMock 控制是否启用。
const STORE_KEY = 'mockPhotoAlbumDb' // 模拟数据库在本地缓存中的键名

const DEFAULT_USER = {
  id: 'u_mock_001',
  nickName: '微信用户',
  avatarUrl: '',
  phone: '',
  email: '',
  language: 'zh-Hans'
}

const DEVICE_SEED = [
  {
    id: 'd_living_001',
    name: '房间相册',
    deviceNo: 'FRAME-123456',
    macAddress: '123456',
    firmwareVersion: '1.2.0',
    connected: true,
    battery: 80,
    totalMemory: 100,
    usedMemory: 68,
    playbackMode: 'order',
    carouselEnabled: true,
    intervalHours: 24,
    lastOnline: '刚刚'
  },
  {
    id: 'd_bedroom_002',
    name: '客厅相册',
    deviceNo: 'FRAME-2026-002',
    macAddress: '123456',
    firmwareVersion: '1.2.0',
    connected: false,
    battery: 0,
    totalMemory: 100,
    usedMemory: 38,
    playbackMode: 'random',
    carouselEnabled: false,
    intervalHours: 24,
    lastOnline: '今天 08:30'
  },
  {
    id: 'd_study_003',
    name: '书房厅相册',
    deviceNo: 'FRAME-2026-003',
    macAddress: '123456',
    firmwareVersion: '1.2.0',
    connected: false,
    battery: 0,
    totalMemory: 100,
    usedMemory: 12,
    playbackMode: 'order',
    carouselEnabled: false,
    intervalHours: 24,
    lastOnline: '今天 08:30'
  }
]

const PHOTO_SEED = [
  {
    id: 'p_001',
    deviceId: 'd_living_001',
    deviceName: '房间相册',
    title: '家庭相册 01',
    url: '',
    tone: 'blue',
    size: 3.2,
    storageKey: 'photos/u_mock_001/p_001.jpg',
    createdAt: '2026-05-12 09:20',
    ownerId: 'u_mock_001',
    onDevice: true
  },
  {
    id: 'p_002',
    deviceId: 'd_living_001',
    deviceName: '房间相册',
    title: '旅行相册 02',
    url: '',
    tone: 'amber',
    size: 2.8,
    storageKey: 'photos/u_mock_001/p_002.jpg',
    createdAt: '2026-05-11 19:45',
    ownerId: 'u_mock_001',
    onDevice: true
  },
  {
    id: 'p_003',
    deviceId: 'd_bedroom_002',
    deviceName: '客厅相册',
    title: '纪念日 03',
    url: '',
    tone: 'rose',
    size: 4.1,
    storageKey: 'photos/u_mock_001/p_003.jpg',
    createdAt: '2026-05-10 14:12',
    ownerId: 'u_mock_001',
    onDevice: true
  }
]

const RECORD_SEED = [
  {
    id: 'r_001',
    deviceId: 'd_living_001',
    deviceName: '房间相框',
    imageCount: 1,
    status: 'success',
    createdAt: '2026-05-19 12:20',
    message: '投屏成功'
  },
  {
    id: 'r_002',
    deviceId: 'd_living_001',
    deviceName: '房间相框',
    imageCount: 1,
    status: 'success',
    createdAt: '2026-05-19 12:20',
    message: '投屏成功'
  },
  {
    id: 'r_003',
    deviceId: 'd_living_001',
    deviceName: '房间相框',
    imageCount: 1,
    status: 'success',
    createdAt: '2026-05-19 12:20',
    message: '投屏成功'
  },
  {
    id: 'r_004',
    deviceId: 'd_living_001',
    deviceName: '房间相框',
    imageCount: 1,
    status: 'success',
    createdAt: '2026-05-19 12:20',
    message: '投屏成功'
  },
  {
    id: 'r_005',
    deviceId: 'd_bedroom_002',
    deviceName: '房间相框',
    imageCount: 1,
    status: 'fail',
    createdAt: '2026-05-19 12:20',
    message: '设备已离线'
  },
  {
    id: 'r_006',
    deviceId: 'd_bedroom_002',
    deviceName: '房间相框',
    imageCount: 1,
    status: 'fail',
    createdAt: '2026-05-19 12:20',
    message: '蓝牙连接中断'
  }
]

// 深拷贝，避免返回的数据被外部修改后污染内存中的 store
function clone(data) {
  return JSON.parse(JSON.stringify(data))
}

function nowText() {
  const date = new Date()
  const pad = value => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

// 读取模拟数据库；首次使用或版本不符时用种子数据初始化并写回
function readStore() {
  const store = wx.getStorageSync(STORE_KEY)

  if (store && store.version === 1) {
    return store
  }

  const initialStore = {
    version: 1,
    user: clone(DEFAULT_USER),
    devices: clone(DEVICE_SEED),
    photos: clone(PHOTO_SEED),
    records: clone(RECORD_SEED)
  }
  wx.setStorageSync(STORE_KEY, initialStore)
  return initialStore
}

function writeStore(store) {
  wx.setStorageSync(STORE_KEY, store)
}

// 模拟网络延迟返回成功数据（返回拷贝，防止外部改动影响 store）
function delay(data, timeout = 220) {
  return new Promise(resolve => {
    setTimeout(() => resolve(clone(data)), timeout)
  })
}

function fail(message, code = 400) {
  return Promise.reject({
    code,
    message
  })
}

function getDeviceById(store, deviceId) {
  return store.devices.find(item => item.id === deviceId)
}

function normalizeImage(image, index, device) {
  return {
    id: `p_${Date.now()}_${index}`,
    deviceId: device.id,
    deviceName: device.name,
    title: image.name || `照片 ${index + 1}`,
    url: image.tempFilePath || image.url || '',
    tone: ['blue', 'amber', 'green', 'rose'][index % 4],
    size: Number(image.sizeMb || image.size || 2.5),
    storageKey: `photos/u_mock_001/${Date.now()}_${index}.jpg`,
    createdAt: nowText(),
    ownerId: 'u_mock_001',
    onDevice: true
  }
}

function loginByWechat(data) {
  const store = readStore()
  if (data.language) {
    store.user.language = data.language
    writeStore(store)
  }

  return delay({
    token: `mock_token_${data.code || Date.now()}`,
    user: store.user
  })
}

function bindPhone(data) {
  const store = readStore()
  store.user.phone = data.phone || '138****2026'
  writeStore(store)
  return delay(store.user)
}

function resetPassword(data) {
  if (!data.phone || !data.code || !data.password) {
    return fail('请补全重置信息')
  }

  return delay({
    success: true
  })
}

function modifyPassword(data) {
  if (!data.oldPassword || !data.newPassword) {
    return fail('请补全密码信息')
  }

  return delay({
    success: true
  })
}

function updateUser(data) {
  const store = readStore()
  store.user = Object.assign({}, store.user, data)
  writeStore(store)
  return delay(store.user)
}

function bindEmail(data) {
  const store = readStore()
  store.user.email = data.email
  writeStore(store)
  return delay(store.user)
}

function scanBluetoothDevices() {
  return delay([
    {
      id: 'scan_001',
      name: 'PHOTO-FRAME-A8',
      deviceNo: 'FRAME-2026-A8',
      RSSI: -42
    },
    {
      id: 'scan_002',
      name: 'PHOTO-FRAME-C1',
      deviceNo: 'FRAME-2026-C1',
      RSSI: -63
    }
  ], 600)
}

function bindDevice(data) {
  const store = readStore()
  const scanDevice = data.device || data
  const existed = store.devices.find(item => item.deviceNo === scanDevice.deviceNo)

  if (existed) {
    existed.connected = true
    existed.lastOnline = '刚刚'
    writeStore(store)
    return delay(existed)
  }

  const device = {
    id: `d_${Date.now()}`,
    name: scanDevice.name || '新相框',
    deviceNo: scanDevice.deviceNo || `FRAME-${Date.now()}`,
    connected: true,
    battery: 100,
    totalMemory: 512,
    usedMemory: 0,
    playbackMode: 'order',
    carouselEnabled: false,
    intervalHours: 2,
    lastOnline: '刚刚'
  }
  store.devices.unshift(device)
  writeStore(store)
  return delay(device)
}

function renameDevice(deviceId, data) {
  const store = readStore()
  const device = getDeviceById(store, deviceId)

  if (!device) {
    return fail('设备不存在', 404)
  }

  device.name = data.name
  store.photos.forEach(photo => {
    if (photo.deviceId === deviceId) {
      photo.deviceName = data.name
    }
  })
  store.records.forEach(record => {
    if (record.deviceId === deviceId) {
      record.deviceName = data.name
    }
  })
  writeStore(store)
  return delay(device)
}

function updateDevicePlayback(deviceId, data) {
  const store = readStore()
  const device = getDeviceById(store, deviceId)

  if (!device) {
    return fail('设备不存在', 404)
  }

  Object.assign(device, data)
  writeStore(store)
  return delay(device)
}

function formatDevice(deviceId) {
  const store = readStore()
  const device = getDeviceById(store, deviceId)

  if (!device) {
    return fail('设备不存在', 404)
  }

  device.usedMemory = 0
  store.photos = store.photos.filter(photo => photo.deviceId !== deviceId)
  writeStore(store)
  return delay({
    success: true
  })
}

function clearDevicePhotoCopies(deviceId) {
  const store = readStore()
  const device = getDeviceById(store, deviceId)

  if (!device) {
    return fail('设备不存在', 404)
  }

  device.usedMemory = 0
  store.photos.forEach(photo => {
    if (photo.deviceId === deviceId) {
      photo.onDevice = false
    }
  })
  writeStore(store)
  return delay({
    success: true
  })
}

function deleteDevice(deviceId) {
  const store = readStore()
  const existed = getDeviceById(store, deviceId)

  if (!existed) {
    return fail('设备不存在', 404)
  }

  store.devices = store.devices.filter(item => item.id !== deviceId)
  store.photos = store.photos.filter(photo => photo.deviceId !== deviceId)
  store.records = store.records.filter(record => record.deviceId !== deviceId)
  writeStore(store)
  return delay({
    success: true
  })
}

function deleteAlbumPhotos(data) {
  const store = readStore()
  const removeSet = (data.ids || []).reduce((map, id) => {
    map[id] = true
    return map
  }, {})
  store.photos = store.photos.filter(photo => !removeSet[photo.id])
  writeStore(store)
  return delay({
    success: true
  })
}

// 模拟投屏：校验设备在线与内存，成功则写入照片并更新已用内存，同时记录一条投屏记录
function uploadProjection(data) {
  const store = readStore()
  const device = getDeviceById(store, data.deviceId)

  if (!device) {
    return fail('设备不存在', 404)
  }

  // 设备离线：写一条失败记录后返回错误（便于用户在记录页看到失败原因）
  if (!device.connected) {
    store.records.unshift({
      id: `r_${Date.now()}`,
      deviceId: device.id,
      deviceName: device.name,
      imageCount: data.images.length,
      status: 'fail',
      createdAt: nowText(),
      message: '设备未连接'
    })
    writeStore(store)
    return fail('设备未连接')
  }

  // 估算本次上传总大小，超过设备剩余容量则拒绝
  const estimatedSize = data.images.reduce((sum, image) => sum + Number(image.sizeMb || image.size || 2.5), 0)

  if (device.usedMemory + estimatedSize > device.totalMemory) {
    return fail('设备内存不足，请先清理相框照片')
  }

  const photos = data.images.map((image, index) => normalizeImage(image, index, device))
  store.photos = photos.concat(store.photos)
  device.usedMemory = Math.min(device.totalMemory, device.usedMemory + estimatedSize)
  device.lastOnline = '刚刚'
  store.records.unshift({
    id: `r_${Date.now()}`,
    deviceId: device.id,
    deviceName: device.name,
    imageCount: data.images.length,
    status: 'success',
    createdAt: nowText(),
    message: '投屏成功'
  })
  writeStore(store)

  return delay({
    success: true,
    photos
  }, 500)
}

function deleteProjectionRecord(recordId) {
  const store = readStore()
  store.records = store.records.filter(item => item.id !== recordId)
  writeStore(store)
  return delay({
    success: true
  })
}

function deleteAccount() {
  wx.removeStorageSync('token')
  wx.removeStorageSync('userInfo')
  wx.removeStorageSync('selectedDevice')
  wx.removeStorageSync(STORE_KEY)
  return delay({
    success: true
  })
}

// 模拟接口路由总入口：按 path + method 匹配到对应处理函数，未匹配则返回 404
function handle(options) {
  const store = readStore()
  const url = options.url
  const method = options.method
  const data = options.data || {}
  const path = url.split('?')[0] // 去掉查询串只保留路径用于匹配

  if (path === '/auth/wechat-login' && method === 'POST') return loginByWechat(data)
  if (path === '/auth/phone' && method === 'POST') return bindPhone(data)
  if (path === '/auth/reset-password' && method === 'POST') return resetPassword(data)
  if (path === '/auth/password' && method === 'PUT') return modifyPassword(data)
  if (path === '/user/profile' && method === 'GET') return delay(store.user)
  if (path === '/user/profile' && method === 'PUT') return updateUser(data)
  if (path === '/user/email' && (method === 'POST' || method === 'PUT')) return bindEmail(data)
  if (path === '/auth/logout' && method === 'POST') return delay({ success: true })
  if (path === '/account' && method === 'DELETE') return deleteAccount()

  if (path === '/devices' && method === 'GET') return delay(store.devices)
  if (path === '/devices/scan' && method === 'GET') return scanBluetoothDevices()
  if (path === '/devices/bind' && method === 'POST') return bindDevice(data)

  const deviceDetailMatch = path.match(/^\/devices\/([^/]+)$/)
  if (deviceDetailMatch && method === 'GET') {
    return delay(getDeviceById(store, deviceDetailMatch[1]) || null)
  }
  if (deviceDetailMatch && method === 'PUT') {
    return renameDevice(deviceDetailMatch[1], data)
  }
  if (deviceDetailMatch && method === 'DELETE') {
    return deleteDevice(deviceDetailMatch[1])
  }

  const playbackMatch = path.match(/^\/devices\/([^/]+)\/playback$/)
  if (playbackMatch && method === 'PUT') return updateDevicePlayback(playbackMatch[1], data)

  const formatMatch = path.match(/^\/devices\/([^/]+)\/format$/)
  if (formatMatch && method === 'POST') return formatDevice(formatMatch[1])

  const clearCopyMatch = path.match(/^\/devices\/([^/]+)\/clear-photo-copies$/)
  if (clearCopyMatch && method === 'POST') return clearDevicePhotoCopies(clearCopyMatch[1])

  if (path === '/album/photos' && method === 'GET') return delay(store.photos)
  if (path === '/album/photos' && method === 'DELETE') return deleteAlbumPhotos(data)

  if (path === '/projection/upload' && method === 'POST') return uploadProjection(data)
  if (path === '/projection/records' && method === 'GET') return delay(store.records)

  const recordMatch = path.match(/^\/projection\/records\/([^/]+)$/)
  if (recordMatch && method === 'DELETE') return deleteProjectionRecord(recordMatch[1])

  return fail(`未匹配的模拟接口：${method} ${path}`, 404)
}

module.exports = {
  handle
}
