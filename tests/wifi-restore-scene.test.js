// restore-builtin 新增选填 scene（2026-11-10）：原入参与返回不变，scene 有值才带、原样传；
// 删光照片后调用（WiFi 详情一键清空、「我的上传」全删）传 DELETE_ALL_PHOTOS，删除设备不传。
// 页面侧的调用见 tests/wifi-tf-local-mode.test.js（一键清空 / 删除设备）与 tests/album-wifi-delete.test.js ⑥（我的上传全删）。
const assert = require('assert')

const stubModule = (request, exports) => {
  const filename = require.resolve(request)
  require.cache[filename] = { id: filename, filename, loaded: true, children: [], paths: [], exports }
}

const posts = []
stubModule('../utils/iot-request', {
  post: (url, data, options) => {
    posts.push({ url, data, options })
    return Promise.resolve({ deviceNo: data.deviceNo, status: 'SENT' })
  }
})
const iotApi = require('../utils/iot-api')

;(async () => {
  assert.strictEqual(iotApi.RESTORE_SCENE_DELETE_ALL_PHOTOS, 'DELETE_ALL_PHOTOS')

  await iotApi.restoreBuiltin({ deviceNo: 'd0:cf:13:f0:2f:f8', renderMode: 'fpga16' }, { showError: false })
  assert.deepStrictEqual(posts[0].url, '/api/device/restore-builtin')
  assert.deepStrictEqual(posts[0].data, { deviceNo: 'D0CF13F02FF8', renderMode: 'fpga16' }, '不给 scene：body 与原来一致')
  assert.strictEqual(posts[0].options.showError, false)

  await iotApi.restoreBuiltin({ deviceNo: 'D0CF13F02FF8', renderMode: 'fpga16', scene: iotApi.RESTORE_SCENE_DELETE_ALL_PHOTOS })
  assert.deepStrictEqual(posts[1].data, { deviceNo: 'D0CF13F02FF8', renderMode: 'fpga16', scene: 'DELETE_ALL_PHOTOS' }, '带 scene')

  await iotApi.restoreBuiltin({ deviceNo: 'D0CF13F02FF8', scene: '' })
  assert.deepStrictEqual(posts[2].data, { deviceNo: 'D0CF13F02FF8' }, '空 scene / 无 renderMode 都不带')

  console.log('PASS restore-builtin scene 选填')
  console.log('wifi-restore-scene: 1 group passed')
})().catch(error => { console.error(error); process.exitCode = 1 })
