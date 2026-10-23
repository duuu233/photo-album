// 抖动出帧 2026-10-23 起改调我方后端 /Client/Basic/imageDitheringBinDownload（参数同原第三方接口）。
//
// 锁四件事：
//   ① 请求发到 request.clientRequestParts 给的地址与 header（公共参数 + 用户自己的 userToken），
//      不再带第三方 token，也不再去取 getXTYUserToken；multipart 里 color/imageDitheringModes/type/file 原样；
//   ② 二进制响应原样交回；
//   ③ 业务 JSON 报错：抛「接口-」+ retMsg，不当成帧、不重试；401/406 走统一登出；
//   ④ 网络失败退避重试，共 3 次。
const assert = require('node:assert/strict')

const effects = []
let respond = null

function stub(request, exports) {
  const filename = require.resolve(request)
  require.cache[filename] = { id: filename, filename, loaded: true, exports }
}

stub('../utils/request', {
  clientRequestParts: (url, header) => ({
    url: `https://api.example.test${url}?userToken=user-token`,
    header: Object.assign({ userToken: 'user-token' }, header)
  }),
  expireSession: () => effects.push(['expire'])
})

global.wx = {
  getFileSystemManager: () => ({
    readFile: ({ success }) => success({ data: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer })
  }),
  request: options => {
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
  assert.equal(sent[0].url, 'https://api.example.test/Client/Basic/imageDitheringBinDownload?userToken=user-token')
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

  console.log('dithering-backend: ok')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
