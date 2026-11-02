// 抖动出帧 2026-10-23 起改调我方后端 /Client/Basic/imageDitheringBinDownload（参数同原第三方接口）；
// 2026-10-29 起地址改为 https://api.yikaltd.com/api 下同一路径，参数不变；
// 2026-11-02 起基地址由 GET https://iot.boltfox.cn/api/device/download-endpoint 的 data.endpoint 下发
// （data 形如 { region: 'CN', endpoint: 'https://apirp.boltstar.net' }；data 直接是地址字符串也兼容），
// 请求 基地址 + /Client/Basic/imageDitheringBinDownload，参数不变。
//
// 锁五件事：
//   ① 请求发到 request.clientRequestParts 给的地址与 header（公共参数 + 用户自己的 userToken；baseURL 为下发的基地址），
//      不再带第三方 token，也不再去取 getXTYUserToken；multipart 里 color/imageDitheringModes/type/file 原样；
//   ② 二进制响应原样交回；
//   ③ 业务 JSON 报错：抛「接口-」+ retMsg，不当成帧、不重试；401/406 走统一登出；
//   ④ 网络失败退避重试，共 3 次；
//   ⑤ 取基地址：Header 带 userToken、取 data.endpoint（兼容字符串）去尾 /、成功缓存；失败（网络 / code≠0 / data 非 http 地址）回落 https://api.boltfox.cn 且不缓存。
const assert = require('node:assert/strict')

const effects = []
let respond = null
const ENDPOINT_URL = 'https://iot.boltfox.cn/api/device/download-endpoint'
let endpointRespond = options =>
  options.success({ statusCode: 200, data: { code: 0, msg: 'ok', data: { region: 'CN', endpoint: 'https://api.boltfox.cn/' } } })

function stub(request, exports) {
  const filename = require.resolve(request)
  require.cache[filename] = { id: filename, filename, loaded: true, exports }
}

stub('../utils/request', {
  clientRequestParts: (url, header, options) => ({
    url: `${(options && options.baseURL) || 'https://api.example.test'}${url}?userToken=user-token`,
    header: Object.assign({ userToken: 'user-token' }, header)
  }),
  expireSession: () => effects.push(['expire'])
})

global.wx = {
  getFileSystemManager: () => ({
    readFile: ({ success }) => success({ data: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer })
  }),
  getStorageSync: key => (key === 'token' ? 'user-token' : ''),
  request: options => {
    if (options.url === ENDPOINT_URL) {
      effects.push(['endpoint', options])
      endpointRespond(options)
      return
    }
    effects.push(['request', options])
    respond(options)
  }
}

const dithering = require('../utils/dithering')

function jsonBody(body) {
  return new TextEncoder().encode(JSON.stringify(body)).buffer
}

function requests() {
  return effects.filter(item => item[0] === 'request').map(item => item[1])
}

function endpointCalls() {
  return effects.filter(item => item[0] === 'endpoint').map(item => item[1])
}

async function main() {
  // ── ① ② 正常出帧 ─────────────────────────────────────
  const frame = new Uint8Array(64).map((_, i) => i)
  respond = options =>
    options.success({ statusCode: 200, header: { 'Content-Type': 'application/octet-stream' }, data: frame.buffer })
  const bytes = await dithering.requestFrameBin({ filePath: 'wxfile://image.jpg', type: '1' })
  assert.deepEqual(Array.from(bytes), Array.from(frame))
  const sent = requests()
  assert.equal(sent.length, 1)
  assert.equal(sent[0].method, 'POST')
  assert.equal(sent[0].url, 'https://api.boltfox.cn/Client/Basic/imageDitheringBinDownload?userToken=user-token', '基地址取自 download-endpoint 的 data.endpoint（去尾 /），公共参数照常带')
  assert.equal(endpointCalls().length, 1, '先取一次出帧基地址')
  assert.equal(endpointCalls()[0].method, 'GET')
  assert.equal(endpointCalls()[0].header.userToken, 'user-token', 'IoT 接口 Header 带 userToken')
  assert.equal(sent[0].responseType, 'arraybuffer')
  assert.equal(sent[0].header.userToken, 'user-token')
  assert.match(sent[0].header['content-type'], /^multipart\/form-data; boundary=/)
  assert.ok(!/seekink/.test(sent[0].url), '不再调第三方接口')
  const body = Buffer.from(sent[0].data).toString('latin1')
  assert.ok(body.includes('name="color"\r\n\r\nBWRYGB'))
  assert.ok(body.includes('name="imageDitheringModes"\r\n\r\n2'))
  assert.ok(body.includes('name="type"\r\n\r\n1'))
  assert.ok(body.includes('name="file"; filename="image.jpg"'))
  assert.equal(dithering.prefetchAuthToken, undefined, '第三方 token 预热已删除')

  // ── ③ 业务报错 / 登录过期 ─────────────────────────────
  effects.length = 0
  respond = options =>
    options.success({
      statusCode: 200,
      header: { 'Content-Type': 'application/json' },
      data: jsonBody({ retCode: 500, retMsg: '图片处理失败' })
    })
  await assert.rejects(
    dithering.requestFrameBin({ filePath: 'wxfile://image.jpg', type: '0' }),
    error => error.message === '接口-图片处理失败'
  )
  assert.equal(requests().length, 1, '业务报错不重试')
  assert.ok(!effects.some(item => item[0] === 'expire'))

  effects.length = 0
  respond = options =>
    options.success({
      statusCode: 200,
      header: { 'Content-Type': 'application/json' },
      data: jsonBody({ retCode: 406, retMsg: '登录已过期' })
    })
  await assert.rejects(dithering.requestFrameBin({ filePath: 'wxfile://image.jpg', type: '0' }))
  assert.ok(effects.some(item => item[0] === 'expire'), '401/406 走统一登出')
  assert.equal(requests().length, 1)

  // ── ④ 网络失败重试 ───────────────────────────────────
  effects.length = 0
  respond = options => options.fail({ errMsg: 'request:fail fail:time out' })
  await assert.rejects(
    dithering.requestFrameBin({ filePath: 'wxfile://image.jpg', type: '0' }),
    error => error.message === '接口-网络超时，图片转化失败，请重新尝试'
  )
  assert.equal(requests().length, 3)

  // ── ⑤ 基地址缓存 / 反代域名 / 失败回落 ─────────────────
  // ③④ 那几次出帧（effects 每段清空过）都没再取基地址：走的是 ① 缓存下来的
  assert.equal(endpointCalls().length, 0, '成功的基地址会缓存，后续出帧不再重取')

  respond = options =>
    options.success({ statusCode: 200, header: { 'Content-Type': 'application/octet-stream' }, data: frame.buffer })

  effects.length = 0
  dithering._resetEndpointCache()
  endpointRespond = options =>
    options.success({ statusCode: 200, data: { code: 0, msg: 'ok', data: { region: 'CN', endpoint: 'https://proxy.example.com/api/' } } })
  await dithering.requestFrameBin({ filePath: 'wxfile://image.jpg', type: '0' })
  assert.equal(requests()[0].url, 'https://proxy.example.com/api/Client/Basic/imageDitheringBinDownload?userToken=user-token', '反代域名带路径也照拼')

  // 联调实测的返回（2026-11-02）：data 为 { region, endpoint }
  effects.length = 0
  dithering._resetEndpointCache()
  endpointRespond = options =>
    options.success({ statusCode: 200, data: { code: 0, msg: 'ok', data: { region: 'CN', endpoint: 'https://apirp.boltstar.net' } } })
  await dithering.requestFrameBin({ filePath: 'wxfile://image.jpg', type: '0' })
  assert.equal(requests()[0].url, 'https://apirp.boltstar.net/Client/Basic/imageDitheringBinDownload?userToken=user-token', '取 data.endpoint 拼出帧路径')

  // 兼容：data 直接是地址字符串
  effects.length = 0
  dithering._resetEndpointCache()
  endpointRespond = options =>
    options.success({ statusCode: 200, data: { code: 0, msg: 'ok', data: 'https://str.example.com/' } })
  await dithering.requestFrameBin({ filePath: 'wxfile://image.jpg', type: '0' })
  assert.equal(requests()[0].url, 'https://str.example.com/Client/Basic/imageDitheringBinDownload?userToken=user-token', 'data 是字符串也认')

  // data 对象里没有 endpoint：回落默认
  effects.length = 0
  dithering._resetEndpointCache()
  endpointRespond = options => options.success({ statusCode: 200, data: { code: 0, data: { region: 'CN' } } })
  await dithering.requestFrameBin({ filePath: 'wxfile://image.jpg', type: '0' })
  assert.ok(requests()[0].url.startsWith('https://api.boltfox.cn/Client/'), 'data 没有 endpoint 时回落默认域名')

  effects.length = 0
  dithering._resetEndpointCache()
  endpointRespond = options => options.fail({ errMsg: 'request:fail timeout' })
  await dithering.requestFrameBin({ filePath: 'wxfile://image.jpg', type: '0' })
  assert.equal(requests()[0].url, 'https://api.boltfox.cn/Client/Basic/imageDitheringBinDownload?userToken=user-token', '取地址网络失败回落默认域名')
  await dithering.requestFrameBin({ filePath: 'wxfile://image.jpg', type: '0' })
  assert.equal(endpointCalls().length, 2, '失败不缓存，下次重新取')

  effects.length = 0
  dithering._resetEndpointCache()
  endpointRespond = options => options.success({ statusCode: 200, data: { code: 500, msg: 'error', data: null } })
  await dithering.requestFrameBin({ filePath: 'wxfile://image.jpg', type: '0' })
  assert.equal(requests()[0].url, 'https://api.boltfox.cn/Client/Basic/imageDitheringBinDownload?userToken=user-token', 'code≠0 回落默认域名')

  effects.length = 0
  dithering._resetEndpointCache()
  endpointRespond = options => options.success({ statusCode: 200, data: { code: 0, data: 'not-a-url' } })
  await dithering.requestFrameBin({ filePath: 'wxfile://image.jpg', type: '0' })
  assert.ok(requests()[0].url.startsWith('https://api.boltfox.cn/Client/'), 'data 不是 http 地址时回落默认域名')

  console.log('dithering-backend: ok')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
