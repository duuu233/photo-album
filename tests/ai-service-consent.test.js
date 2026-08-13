const assert = require('node:assert/strict')

const storage = {}
let currentUser = { id: 'user-a' }

global.wx = {
  getStorageSync(key) {
    return storage[key]
  },
  setStorageSync(key, value) {
    storage[key] = value
  },
  removeStorageSync(key) {
    delete storage[key]
  }
}

global.getApp = () => ({
  globalData: {
    userInfo: currentUser
  }
})

const consent = require('../utils/ai-service-consent')

assert.equal(consent.hasCurrentUserConsent(), false)
assert.equal(consent.grantCurrentUserConsent(), true)
assert.equal(consent.hasCurrentUserConsent(), true)

currentUser = { id: 'user-b' }
assert.equal(consent.hasCurrentUserConsent(), false, '切换用户不能继承上一用户的同意状态')
assert.equal(consent.grantCurrentUserConsent(), true)
assert.equal(consent.hasCurrentUserConsent(), true)

consent.clearCurrentUserConsent()
assert.equal(consent.hasCurrentUserConsent(), false, '退出/注销清理后应重新确认')

currentUser = { id: 'user-a' }
assert.equal(consent.hasCurrentUserConsent(), true, '清理当前用户不能误删其他用户的记录')

delete storage[consent.STORAGE_KEY]
assert.equal(consent.hasCurrentUserConsent(), false, '缓存丢失后应重新确认')

// ── AI 上游供应商换成火山引擎（2026-08-13 需求 5/6）────────────────────────────
// 这两条不是「文案洁癖」：同意书里的**数据接收方**是法律要件，端上任何一处还写着旧供应商，
// 用户看到的告知与实际接收方就对不上。
const fs = require('node:fs')
const path = require('node:path')
const readCode = rel =>
  fs.readFileSync(path.join(__dirname, '..', rel), 'utf8')

// 判的是**用户看得到的字**：弹窗取模块导出的常量，协议正文取 wxml 里 <view> 的文本，
// 都不含注释——注释里为了讲清来龙去脉，仍会提到旧供应商的名字。
const agreementCopy = readCode('subpackages/settings/ai-agreement/ai-agreement.wxml')
  .replace(/<!--[\s\S]*?-->/g, '')
;[
  ['同意弹窗', consent.CONSENT_SUMMARY],
  ['AI服务协议正文', agreementCopy]
].forEach(([label, text]) => {
  assert.ok(
    !/阿里云百炼|阿里云计算有限公司/.test(text),
    `${label} 里不该再出现旧供应商（阿里云百炼/阿里云计算有限公司）`
  )
  assert.ok(/火山引擎/.test(text), `${label} 应写明新供应商「火山引擎」`)
})

// 弹窗文案逐字锁住（产品给的原文），顺带钉死主体全称
assert.equal(
  consent.CONSENT_SERVICE_DESCRIPTION,
  '为了使用 AI 服务（包括文本对话、根据文字生成图片、以及上传图片进行美化），我们需要将您当前发送的内容（文字或图片）传输至“火山引擎”AI 服务进行处理，该服务由北京火山引擎科技有限公司提供。',
  '同意弹窗必须逐字按产品原文，并写明数据接收方的全称'
)
assert.equal(
  consent.CONSENT_DATA_NOTICE,
  '您发送的内容仅用于本次操作，不会被存储或用于模型训练。',
  '数据用途那句按产品原文'
)
// 境外传输是**单独告知**事项：网关在新加坡，内容出境。少了这一段，用户同意的就不是实际发生的事。
assert.equal(
  consent.CONSENT_CROSS_BORDER_NOTICE,
  '因该 AI 服务网关部署于境外（新加坡），上述内容将传输至境外处理，详情请见《BoltStar 隐私政策》第八节。',
  '境外传输告知必须逐字保留，并指向隐私政策第八节'
)
assert.ok(
  consent.CONSENT_SUMMARY.includes(consent.CONSENT_CROSS_BORDER_NOTICE),
  '弹窗正文（CONSENT_SUMMARY）必须包含境外传输告知'
)
// 弹窗是三段：漏画任何一段，用户看到的告知就与实际不符
const chatConsentMarkup = readCode('subpackages/ai/chat/chat.wxml')
;['consentServiceDescription', 'consentDataNotice', 'consentCrossBorderNotice'].forEach(
  field => {
    assert.ok(
      chatConsentMarkup.includes(`{{${field}}}`),
      `同意弹窗必须画出 ${field} 这一段`
    )
  }
)

const consentSource = readCode('utils/ai-service-consent.js')

// ⚠️ 换供应商必须同时抬版本号：不抬的话，老用户带着「同意发给阿里云」的旧记录，
// 直接就把内容发给了另一家公司 —— 端上再也不会问他第二次。
assert.ok(
  /CONSENT_VERSION = '2026-08-13-v3'/.test(consentSource),
  '供应商变更属于实质变更，CONSENT_VERSION 必须升版让老用户重新确认'
)

console.log('ai service consent tests passed')
