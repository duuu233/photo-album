// 抖动出帧接口封装：把「设备分辨率的图片文件」multipart 上传，收回**二进制六色 4bpp 帧(.bin)**，
// 直接喂给 device-ble.uploadImage 走 BLE 图传。
// 2026-10-23 起改调我方后端 /Client/Basic/imageDitheringBinDownload（form-data，参数与原第三方
// seekink 接口一致：color / imageDitheringModes / type / file），原第三方接口及其 token
// （/Client/Basic/getXTYUserToken）不再使用。
// 2026-10-29 起地址改为 https://api.yikaltd.com/api/Client/Basic/imageDitheringBinDownload，参数（公共参数、
// 鉴权头、form-data 字段）全部不变，只换域名与前缀。
// 实现要点/注意：
//   · 公共参数 device/terminal/language/userToken 与其它接口同口径注入（request.clientRequestParts），
//     userToken 是本 App 用户自己的登录令牌；登录过期（401/406）走 request 统一登出引导；
//   · 报错前缀为「接口-」（我方后端），不再是「接口(第三方)-」；
//   · 响应体即文件流 → 不能用 wx.uploadFile（它的 res.data 恒为字符串会把 bin 打烂）；
//     只能手工拼 multipart 请求体 + wx.request(responseType:'arraybuffer')；
//   · 调用方必须继续用「字节数 = 宽×高÷2」铁闸校验返回帧。
const protocol = require('./frame-protocol')
const http = require('./request')

const DITHERING_BASE_URL = 'https://api.yikaltd.com/api'
const DITHERING_PATH = '/Client/Basic/imageDitheringBinDownload'

// 网络类失败的用户侧文案：微信透传的英文原文（`request:fail fail:time out` 之类）用户看不懂，
// 原文写进 error.raw 并打日志，排查看 vConsole（判读表见 docs/architecture/image-projection-pipeline.md）。
const NETWORK_FAIL_TEXT = '接口-网络超时，图片转化失败，请重新尝试'
const BUSINESS_FAIL_TEXT = '接口-图片转化失败，请重新尝试'

// raw：给日志/重试判定用的原始报错（英文 errMsg、业务 JSON 原文、HTTP 码），只进日志不进 UI
function ditheringError(message, raw) {
  const error = new Error(message)
  error.raw = String(raw || '')
  return error
}

// 与 request.js 上传超时约定一致；网络类失败退避重试（接口是纯转换、无记账副作用，重试安全）
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

// 抖动接口 type（2026-07-22 对接第三方时定义，迁到我方后端后数值不变、后端按此对齐）：
// 0=5.8寸大设备(EF6-589 680×960)、1=3.7寸小设备(EF6-370 480×720)；是出帧策略，不是旋转角，
// 与后台屏幕方向、固件型号也不是同一枚举。480×720 用 1，其余（含新机型）沿用 0。
// 请求仍上传目标实际像素（如圆屏 400×400），不把图片扩成旧大屏尺寸；返回帧必须通过实际尺寸校验。
// 按目标分辨率选择既有策略；输出像素尺寸由上传图片决定，并由调用方按实际分辨率校验。
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
      // 这条是本地读文件失败，不是接口的锅，按来源前缀约定归「小程序-」
      fail: () => reject(new Error('小程序-抖动bin转换失败：图片读取失败'))
    })
  })
}

function requestOnce(body, boundary) {
  // 每次发送现取公共参数：重试期间登录态若变化，以当前为准
  const parts = http.clientRequestParts(
    DITHERING_PATH,
    { 'content-type': `multipart/form-data; boundary=${boundary}` },
    { baseURL: DITHERING_BASE_URL }
  )
  return new Promise((resolve, reject) => {
    wx.request({
      url: parts.url,
      method: 'POST',
      header: parts.header,
      data: body.buffer,
      responseType: 'arraybuffer',
      timeout: REQUEST_TIMEOUT_MS,
      success: resolve,
      fail: (err) => reject(ditheringError(NETWORK_FAIL_TEXT, (err && err.errMsg) || '网络异常'))
    })
  })
}

// 业务报错的 JSON 体（{ retCode, retMsg }）；解析不了返回 null
function parseJsonBody(text) {
  try {
    const body = JSON.parse(text)
    return body && typeof body === 'object' ? body : null
  } catch (error) {
    return null
  }
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

  const run = async (left) => {
    let res
    try {
      res = await requestOnce(body, boundary)
    } catch (error) {
      // wx.request fail = 没拿到响应（超时/断网/域名拦截），弱网下退避重试。
      // 判定必须看 error.raw（微信原文），message 已被归一成中文；`time\s*-?out` 是因为安卓
      // 报的是 `request:fail fail:time out`（带空格）。
      const raw = error.raw || error.message || ''
      if (left > 1 && /time\s*-?out|connect|网络|ERR_/i.test(raw)) {
        console.warn(`[抖动bin] 网络失败，将重试（剩余 ${left - 1} 次）：`, raw)
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
    // 业务报错回小体积 JSON（content-type 标 json/text，或首字符 { / [）：解码打印并抛错，不重试
    const contentType = String((res.header && (res.header['Content-Type'] || res.header['content-type'])) || '')
    const looksText =
      /json|text/i.test(contentType) ||
      (bytes.length > 0 && bytes.length < 4096 && (bytes[0] === 0x7b || bytes[0] === 0x5b))
    const text = looksText ? utf8BytesToString(bytes) : ''
    const json = looksText ? parseJsonBody(text) : null
    const retCode = json ? (json.retCode !== undefined ? json.retCode : json.code) : undefined
    const retMsg = json ? String(json.retMsg || json.message || '').trim() : ''
    // 登录过期：与其它接口同一判定（HTTP 401 / 业务码 401、406），清会话并引导重登
    if (res.statusCode === 401 || retCode === 401 || retCode === 406) {
      console.warn('[抖动bin] 登录已过期：', text || `HTTP ${res.statusCode}`)
      http.expireSession()
      throw ditheringError(`接口-${retMsg || '登录已过期'}`, text || `HTTP ${res.statusCode}`)
    }
    if (looksText) {
      console.warn('[抖动bin] 返回文本(业务报错):', text)
      throw ditheringError(retMsg ? `接口-${retMsg}` : BUSINESS_FAIL_TEXT, text.slice(0, 200) || `HTTP ${res.statusCode}`)
    }
    if (res.statusCode !== 200 || !bytes.length) {
      throw ditheringError(BUSINESS_FAIL_TEXT, `HTTP ${res.statusCode} 字节数=${bytes.length}`)
    }
    return bytes
  }
  return run(RETRY_ATTEMPTS)
}

module.exports = {
  typeForDevice,
  requestFrameBin
}
