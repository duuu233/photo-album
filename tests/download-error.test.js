// 下载失败提示一律中文（2026-09-21 产品：「下载超时提示修改，小程序尽量不要用英文，改中文就行」）。
// 官方图库投屏、结果页取原图、固件包下载、AI 对话下载/投屏共用 utils/download-error.js。
const assert = require('assert')
const { describeDownloadFail, isTimeout } = require('../utils/download-error')

// 超时：微信几种写法都认
assert.strictEqual(
  describeDownloadFail({ errMsg: 'downloadFile:fail timeout' }, '图片'),
  '图片下载超时，请检查网络后重试'
)
assert.strictEqual(
  describeDownloadFail({ errMsg: 'downloadFile:fail time out' }, '原图'),
  '原图下载超时，请检查网络后重试'
)
assert.strictEqual(
  describeDownloadFail({ errMsg: 'downloadFile:fail socket timeout' }, '固件包'),
  '固件包下载超时，请检查网络后重试'
)

// 合法域名没配：是配置问题，单独说，不笼统成网络问题
assert.strictEqual(
  describeDownloadFail({ errMsg: 'downloadFile:fail url not in domain list' }, '图片'),
  '图片域名未配置（小程序后台 downloadFile 合法域名）'
)

// 其它失败 / 没有原文 / subject 缺省
assert.strictEqual(
  describeDownloadFail({ errMsg: 'downloadFile:fail ERR_CONNECTION_RESET' }, '图片'),
  '图片下载失败，请检查网络后重试'
)
assert.strictEqual(describeDownloadFail(null), '图片下载失败，请检查网络后重试')
assert.strictEqual(describeDownloadFail(new Error('downloadFile:fail timeout')), '图片下载超时，请检查网络后重试')

// 提示里不再出现英文（域名那条除外——它要写明后台配置项的原名）
;['downloadFile:fail timeout', 'downloadFile:fail ERR_CONNECTION_RESET', ''].forEach(errMsg => {
  const text = describeDownloadFail({ errMsg }, '图片')
  assert.ok(!/[A-Za-z]/.test(text), `不该有英文：${text}`)
})

assert.strictEqual(isTimeout('uploadFile:fail timeout'), true)
assert.strictEqual(isTimeout('应答超时'), true)
assert.strictEqual(isTimeout('downloadFile:fail'), false)

console.log('download-error.test.js: all passed')
