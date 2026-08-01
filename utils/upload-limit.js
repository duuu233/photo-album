// 一次投屏可选照片张数的上限。
//
// 常规用户 10 张（2026-08-02 产品要求由 5 张放宽）；白名单用户放宽到 100 张——
// 2026-08-01 产品要求：登录接口返回的 userInfo.userNo 命中 WHITELIST 时，
// 该账号用于内部批量压测/展会演示，需要一次投几十上百张。
//
// ⚠️ 这是**端上放宽选图张数**，不是后端额度：后端若另有单账号图片总数限制，仍以后端为准。
// ⚠️ userNo 由登录接口下发（见 utils/api.js normalizeUserProfile / app.js normalizeUserInfo），
//    与后端账号一一对应；换白名单账号只改下面这一处数组。
const WHITELIST = ['EF7293235']

// 常规上限：与产品「一次最多投 10 张」口径一致（2026-08-02 由 5 张调整）
const DEFAULT_LIMIT = 10

// 白名单上限
const WHITELIST_LIMIT = 100

// 取当前登录用户的 userNo。app 未就绪 / 未登录时返回空串（按常规上限处理）。
function currentUserNo() {
  try {
    const app = getApp()
    const user = (app && app.globalData && app.globalData.userInfo) || null
    if (user && user.userNo) {
      return String(user.userNo).trim()
    }
    // globalData 还没灌上时（冷启动首帧）回落本地缓存，避免白名单用户开屏第一次选图被按常规上限限
    const cached = wx.getStorageSync('userInfo')
    return cached && cached.userNo ? String(cached.userNo).trim() : ''
  } catch (error) {
    return ''
  }
}

// 当前用户是否在放宽白名单内
function isWhitelisted() {
  const userNo = currentUserNo()
  return !!userNo && WHITELIST.indexOf(userNo) > -1
}

// 一次从相册可选的照片张数上限
function albumPickLimit() {
  return isWhitelisted() ? WHITELIST_LIMIT : DEFAULT_LIMIT
}

module.exports = {
  WHITELIST,
  DEFAULT_LIMIT,
  WHITELIST_LIMIT,
  currentUserNo,
  isWhitelisted,
  albumPickLimit
}
