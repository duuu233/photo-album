// BoltStar AI 服务协议同意状态。
//
// 只按当前登录用户 ID 记本地缓存：换账号不会继承；退出、注销或登录态失效时由
// app.clearSession() 在清除 userInfo 前调用 clearCurrentUserConsent()。
// 协议版本写进缓存值，后续协议发生实质变更时只需更新 CONSENT_VERSION，即可让用户重新确认。
//
// 2026-08-13 由 v2 升到 v3：AI 上游供应商由「阿里云百炼 / 阿里云计算有限公司」改为
// 「火山引擎 / 北京火山引擎科技有限公司」，同意书里的数据接收方变了 —— 这正是必须**重新取得同意**
// 的那一类实质变更（用户当初同意的是把内容发给另一家公司），所以版本号一定要跟着改，
// 不能只改文案：不改版本，老用户会带着对旧条款的同意继续用新供应商。
//
// ⚠️ 同日稍后按产品新稿再改了一次文案（恢复「不会被存储」+ 新增**境外传输告知**），
// **仍留在 v3**：v3 是当天新建、尚未发布，没有任何线上用户带着 v3 的同意记录。
// 若 v3 已经发过版，这一次必须再升一版（境外传输是新的实质告知）。
const STORAGE_KEY = 'aiServiceConsentByUser'
const CONSENT_VERSION = '2026-08-13-v3'

const CONSENT_TITLE = 'BoltStar AI服务协议'
const CONSENT_REQUIRED_TITLE = '请先同意BoltStar AI服务协议'
const CONSENT_SERVICE_DESCRIPTION =
  '为了使用 AI 服务（包括文本对话、根据文字生成图片、以及上传图片进行美化），我们需要将您当前发送的内容（文字或图片）传输至“火山引擎”AI 服务进行处理，该服务由北京火山引擎科技有限公司提供。'
const CONSENT_DATA_NOTICE =
  '您发送的内容仅用于本次操作，不会被存储或用于模型训练。'
// 2026-08-13 追加：AI 网关部署在境外（新加坡），内容出境属于**单独告知**事项，
// 与「发给谁」同等重要 —— 详细口径（接收方、目的、行使权利的方式）在隐私政策第八节，
// 这里只做告知并指路，不在弹窗里复述整节法律文本。
const CONSENT_CROSS_BORDER_NOTICE =
  '因该 AI 服务网关部署于境外（新加坡），上述内容将传输至境外处理，详情请见《BoltStar 隐私政策》第八节。'
const CONSENT_SUMMARY = `${CONSENT_SERVICE_DESCRIPTION}\n\n${CONSENT_DATA_NOTICE}\n\n${CONSENT_CROSS_BORDER_NOTICE}`

function currentUserId() {
  try {
    const app = typeof getApp === 'function' ? getApp() : null
    const user =
      (app && app.globalData && app.globalData.userInfo) ||
      wx.getStorageSync('userInfo') ||
      {}
    const id = user.id || user.userNo || user.userId
    return id === undefined || id === null ? '' : String(id).trim()
  } catch (error) {
    return ''
  }
}

function readConsentMap() {
  try {
    const value = wx.getStorageSync(STORAGE_KEY)
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch (error) {
    return {}
  }
}

function hasCurrentUserConsent() {
  const userId = currentUserId()
  if (!userId) {
    return false
  }
  return readConsentMap()[userId] === CONSENT_VERSION
}

function grantCurrentUserConsent() {
  const userId = currentUserId()
  if (!userId) {
    return false
  }
  const consentMap = readConsentMap()
  consentMap[userId] = CONSENT_VERSION
  try {
    wx.setStorageSync(STORAGE_KEY, consentMap)
    return true
  } catch (error) {
    return false
  }
}

function clearCurrentUserConsent() {
  const userId = currentUserId()
  if (!userId) {
    return
  }
  const consentMap = readConsentMap()
  if (!Object.prototype.hasOwnProperty.call(consentMap, userId)) {
    return
  }
  delete consentMap[userId]
  try {
    if (Object.keys(consentMap).length) {
      wx.setStorageSync(STORAGE_KEY, consentMap)
    } else {
      wx.removeStorageSync(STORAGE_KEY)
    }
  } catch (error) {
    // 会话清理不能因本地 Storage 异常被阻断；下次读取不到同意记录会重新弹协议。
  }
}

module.exports = {
  STORAGE_KEY,
  CONSENT_VERSION,
  CONSENT_TITLE,
  CONSENT_REQUIRED_TITLE,
  CONSENT_SERVICE_DESCRIPTION,
  CONSENT_DATA_NOTICE,
  CONSENT_CROSS_BORDER_NOTICE,
  CONSENT_SUMMARY,
  currentUserId,
  hasCurrentUserConsent,
  grantCurrentUserConsent,
  clearCurrentUserConsent
}
