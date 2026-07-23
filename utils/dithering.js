// seekink 抖动接口封装：把「设备分辨率的图片文件」multipart 上传，收回**二进制六色 4bpp 帧(.bin)**，
// 直接喂给 device-ble.uploadImage 走 BLE 图传（2026-07-22 起替代后端 setUserProductUpload 的转码结果）。
// 实现要点/注意：
//   · 响应体即文件流 → 不能用 wx.uploadFile（它的 res.data 恒为字符串会把 bin 打烂）；
//     只能手工拼 multipart 请求体 + wx.request(responseType:'arraybuffer')；
//   · 请求头按对方要求带 AcceptLanguage=en（原话键名无中划线，另补标准 Accept-Language 兜底）；
//   · 域名是 http 且未加小程序合法域名白名单：开发者工具勾「不校验合法域名」/真机开调试模式；
//   · Authorization = Bearer+空格+token，token 由 /Client/Basic/getXTYUserToken 动态获取
//     （2026-07-23 替代写死的联调 token）：会话级内存缓存一次取用整程复用，预览页 onLoad 预热
//     （prefetchAuthToken），接口回 401/token 类报错时清缓存自动刷新重试一次（长会话过期自愈）；
//   · ⚠️ bin 的像素格式（六色索引映射/扫描顺序）是否与设备一致未真机验证——调用方必须继续用
//     「字节数 = 宽×高÷2」铁闸校验；真机若花屏/串色，对照 v1.5 协议核对 seekink 的调色板顺序。
const protocol = require('./frame-protocol')
const api = require('./api')

const DITHERING_API = 'http://cloud.seekink.cn:8091/prod-api/api/v1/label/imageDitheringBinDownload'

// —— seekink token（/Client/Basic/getXTYUserToken）——
// 会话级内存缓存：小程序本次启动内所有投屏复用同一个 token，不落 Storage（有效期未知，
// 杀进程自然失效重取最稳）；过期由 requestFrameBin 的 401 刷新兜底，无需预判有效期。
let authTokenCache = ''
let authTokenInFlight = null // 取 token 的在途请求：预热与投屏并发要 token 时只发一次

// 兼容后端可能的返回形态：data 直接是 token 串，或对象包字段（⚠️字段名为假设，待联调确认）；
// 若返回已带 Bearer 前缀则剥掉，统一由本模块拼「Bearer+空格+token」
function normalizeAuthToken(data) {
  const raw =
    typeof data === 'string'
      ? data
      : (data &&
          (data.token || data.xtyToken || data.userToken || data.accessToken || data.access_token)) ||
        ''
  return String(raw).replace(/^Bearer\s+/i, '').trim()
}

function ensureAuthToken() {
  if (authTokenCache) {
    return Promise.resolve(authTokenCache)
  }
  if (!authTokenInFlight) {
    authTokenInFlight = api
      .getXTYUserToken()
      .then((data) => {
        authTokenInFlight = null
        const token = normalizeAuthToken(data)
        if (!token) {
          throw new Error('接口-抖动token获取失败：返回为空')
        }
        authTokenCache = token
        console.log('[抖动bin] token 已就绪（会话级缓存）')
        return token
      })
      .catch((error) => {
        authTokenInFlight = null
        throw error
      })
  }
  return authTokenInFlight
}

// 预热：进投屏预览页时前置调用（与预热设备连接同理），用户构图期间先把 token 取回缓存，
// 点「开始投屏」后出帧请求零等待。失败静默——真正投屏时 ensureAuthToken 会再取并正常报错。
function prefetchAuthToken() {
  ensureAuthToken().catch(() => {})
}

// 与 request.js 上传超时约定一致；网络类失败退避重试（接口是纯转换、无服务端记账副作用，重试安全）
const REQUEST_TIMEOUT_MS = 20000
const RETRY_ATTEMPTS = 3
const RETRY_DELAY_MS = 800

// multipart 骨架文本转字节：boundary/字段名/文件名全是 ASCII，直接取低 8 位即可（勿放中文）
function asciiBytes(str) {
  const out = new Uint8Array(str.length)
  for (let i = 0; i < str.length; i++) {
    out[i] = str.charCodeAt(i) & 0xff
  }
  return out
}

// 手工拼 multipart/form-data 请求体：fields=[{name,value}] 文本字段 +
// file={name,filename,contentType,data:Uint8Array} 文件字段
function buildMultipartBody(boundary, fields, file) {
  const CRLF = '\r\n'
  const chunks = []
  fields.forEach((f) => {
    chunks.push(
      asciiBytes(`--${boundary}${CRLF}Content-Disposition: form-data; name="${f.name}"${CRLF}${CRLF}${f.value}${CRLF}`)
    )
  })
  chunks.push(
    asciiBytes(
      `--${boundary}${CRLF}Content-Disposition: form-data; name="${file.name}"; filename="${file.filename}"${CRLF}` +
        `Content-Type: ${file.contentType}${CRLF}${CRLF}`
    )
  )
  chunks.push(file.data)
  chunks.push(asciiBytes(`${CRLF}--${boundary}--${CRLF}`))
  let total = 0
  chunks.forEach((c) => {
    total += c.length
  })
  const body = new Uint8Array(total)
  let offset = 0
  chunks.forEach((c) => {
    body.set(c, offset)
    offset += c.length
  })
  return body
}

// UTF-8 字节 → 字符串（小程序低版本基础库没有 TextDecoder）：仅用于把接口的 JSON 错误体打进日志
function utf8BytesToString(bytes) {
  let out = ''
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i]
    if (b < 0x80) {
      out += String.fromCharCode(b)
      i += 1
    } else if (b < 0xe0) {
      out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f))
      i += 2
    } else if (b < 0xf0) {
      out += String.fromCharCode(((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f))
      i += 3
    } else {
      const cp =
        ((b & 0x07) << 18) | ((bytes[i + 1] & 0x3f) << 12) | ((bytes[i + 2] & 0x3f) << 6) | (bytes[i + 3] & 0x3f)
      const u = cp - 0x10000
      out += String.fromCharCode(0xd800 + (u >> 10), 0xdc00 + (u & 0x3ff))
      i += 4
    }
  }
  return out
}

// 抖动接口的 type 参数：0=5.8寸大设备(EF6-589 680×960)、1=3.7寸小设备(EF6-370 480×720)。
// 按目标分辨率判型（与投屏出图的目标尺寸同源，保证 type 与实际上传的图片尺寸一致）。
// 上传图恒为竖向设备分辨率（横向取景的内容已在预览导出时转 270° 进竖向画布），
// 宽高对调的匹配只是兜底。小设备尺寸引用协议表，勿写死数字。
function typeForDevice(info) {
  const small = protocol.SCREEN_TYPES[0x01] // 3.7寸 EF6-370
  const w = Number(info && info.width)
  const h = Number(info && info.height)
  const isSmall =
    (w === small.width && h === small.height) || (w === small.height && h === small.width)
  return isSmall ? '1' : '0'
}

// 读本地文件为 Uint8Array
function readFileBytes(filePath) {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().readFile({
      filePath,
      success: (r) => resolve(new Uint8Array(r.data)),
      fail: () => reject(new Error('接口-抖动bin转换失败：图片读取失败'))
    })
  })
}

function requestOnce(body, boundary, token) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: DITHERING_API,
      method: 'POST',
      header: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        Authorization: `Bearer ${token}`,
        AcceptLanguage: 'en', // 对方给的键名（无中划线），原样带上
        'Accept-Language': 'en' // 标准头兜底：后端若走通用 i18n 解析读的是它
      },
      data: body.buffer,
      responseType: 'arraybuffer',
      timeout: REQUEST_TIMEOUT_MS,
      success: resolve,
      fail: (err) => reject(new Error(`接口-抖动bin转换失败：${(err && err.errMsg) || '网络异常'}`))
    })
  })
}

// 图片文件 → 设备帧 bin(Uint8Array)。{ filePath, type } 必传；接口回 JSON/文本（业务报错）时
// 解码打日志并抛错（确定性失败不重试），网络类失败（timeout/连接）自动退避重试。
async function requestFrameBin({ filePath, type }) {
  const fileBytes = await readFileBytes(filePath)
  console.log(`[抖动bin] 请求：color=BWRYGB imageDitheringModes=2 type=${type} 上传=${fileBytes.length}字节`)
  const boundary = `----wxmp${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
  const body = buildMultipartBody(
    boundary,
    [
      { name: 'color', value: 'BWRYGB' },
      { name: 'imageDitheringModes', value: '2' },
      { name: 'type', value: String(type) }
    ],
    { name: 'file', filename: 'image.jpg', contentType: 'image/jpeg', data: fileBytes }
  )

  let authRetried = false // 鉴权刷新只做一次：接口侧真拒绝（如账号无权限）时不能打转
  const run = async (left) => {
    const token = await ensureAuthToken()
    let res
    try {
      res = await requestOnce(body, boundary, token)
    } catch (error) {
      // wx.request fail = 没拿到响应（超时/断网/域名拦截），弱网下退避重试
      if (left > 1 && /timeout|connect|网络|ERR_/i.test(error.message || '')) {
        console.warn(`[抖动bin] 网络失败，将重试（剩余 ${left - 1} 次）：`, error.message)
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS))
        return run(left - 1)
      }
      throw error
    }
    const bytes = res.data instanceof ArrayBuffer ? new Uint8Array(res.data) : new Uint8Array(0)
    console.log(
      `[抖动bin] 返回：statusCode=${res.statusCode} 字节数=${bytes.length} ` +
        `头16=${protocol.bytesToHex(bytes.subarray(0, 16))}`
    )
    // 业务报错通常回小体积 JSON（content-type 标 json/text，或首字符 { / [）：解码打印并抛错，不重试
    const contentType = String((res.header && (res.header['Content-Type'] || res.header['content-type'])) || '')
    const looksText =
      /json|text/i.test(contentType) ||
      (bytes.length > 0 && bytes.length < 4096 && (bytes[0] === 0x7b || bytes[0] === 0x5b))
    const text = looksText ? utf8BytesToString(bytes) : ''
    // 鉴权失败（HTTP 401，或业务 JSON 报 token/授权类错误）：会话缓存的 token 可能已过期，
    // 清缓存重取一次再发本请求（不消耗网络重试次数）
    if (
      !authRetried &&
      (res.statusCode === 401 ||
        (looksText && /401|token|unauthorized|授权|过期|expired/i.test(text)))
    ) {
      authRetried = true
      authTokenCache = ''
      console.warn('[抖动bin] 鉴权失败，刷新 token 重试一次：', text || `HTTP ${res.statusCode}`)
      return run(left)
    }
    if (looksText) {
      console.warn('[抖动bin] 返回文本(业务报错):', text)
      throw new Error(`接口-抖动bin转换失败：${text.slice(0, 60) || `HTTP ${res.statusCode}`}`)
    }
    if (res.statusCode !== 200 || !bytes.length) {
      throw new Error(`接口-抖动bin转换失败：HTTP ${res.statusCode}`)
    }
    return bytes
  }
  return run(RETRY_ATTEMPTS)
}

module.exports = {
  typeForDevice,
  requestFrameBin,
  prefetchAuthToken
}
