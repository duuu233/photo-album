// BoltStar AI 服务协议同意状态。
//
// 只按当前登录用户 ID 记本地缓存：换账号不会继承；退出、注销或登录态失效时由
// app.clearSession() 在清除 userInfo 前调用 clearCurrentUserConsent()。
// 协议版本写进缓存值，后续协议发生实质变更时只需更新 CONSENT_VERSION，即可让用户重新确认。
const STORAGE_KEY = 'aiServiceConsentByUser'
const CONSENT_VERSION = '2026-07-28'

const CONSENT_TITLE = 'BoltStar AI服务协议'
const CONSENT_REQUIRED_TITLE = '请先同意BoltStar AI服务协议'
const CONSENT_SERVICE_DESCRIPTION =
  '为了使用 AI 服务（包括文本对话、根据文字生成图片、以及上传图片进行美化），我们需要将你当前发送的内容（文字或图片）传输至“阿里云百炼”AI 服务进行处理，该服务由阿里云计算有限公司提供。'
const CONSENT_DATA_NOTICE =
  '你发送的内容仅用于本次操作，不会被存储或用于模型训练。'
const CONSENT_SUMMARY = `${CONSENT_SERVICE_DESCRIPTION}\n\n${CONSENT_DATA_NOTICE}`

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
  CONSENT_SUMMARY,
  currentUserId,
  hasCurrentUserConsent,
  grantCurrentUserConsent,
  clearCurrentUserConsent
}
