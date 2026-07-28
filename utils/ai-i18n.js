// BoltStar AI 模块多语种错误文案 + 统一错误分发。
// 文案来源：assets/ai/BoltStar-i18n-Errors.json（后端只回 code，不回面向用户的文案，
// 文案由前端按当前语种管理，见 docs/reference/ai/BoltStar-API-Doc-v2-1.0.4.md §6.7）。
// 语种取 utils/language.getSelectedLanguage()（用户显式选过用用户的，否则跟随系统），
// 与后端接口的 language 码同一数据源，保证 AI 提示语种与全局一致。
//
// 用法：
//   const aiI18n = require('../../../utils/ai-i18n')
//   aiI18n.t('error.22002', { hours: 23 })       // 取文案并替换 {hours} 占位
//   aiI18n.handleAiError(err, { onRetry, onBanned }) // 按 code 区间分发 toast/弹窗/重试
const language = require('./language')
const toast = require('./toast')

// key 与 BoltStar-i18n-Errors.json 完全一致：info.10001 + error.xxxxx。
// 文档 JSON 的 zh-CN/zh-TW 对应本项目语种键 zh-Hans/zh-Hant。
const TEXTS = {
  'zh-Hans': {
    'info.10001': '对话记录已过期自动清除',
    'error.20003': '缺少用户标识',
    'error.20004': '缺少会话标识',
    'error.20005': '请输入内容',
    'error.20006': '请选择图片方向',
    'error.20007': '图片方向无效',
    'error.20008': '风格选项无效',
    'error.20009': '参数值超出范围',
    'error.20010': '请提供图片',
    'error.20011': '缺少消息标识',
    'error.20012': '一次最多处理 4 张图片',
    'error.20013': '会话数量已达上限（20 个），请先删除部分旧会话',
    'error.22001': '内容不符合规范，请修改后重试',
    'error.22002': '账号已被临时限制，{hours} 小时后恢复',
    'error.22003': '账号已被永久限制',
    'error.22005': '请求过于频繁，请稍后再试',
    'error.23001': '会话不存在或已删除',
    'error.23002': '消息不存在或已删除',
    'error.30001': '服务暂时不可用，请稍后重试',
    'error.30002': '响应超时，请稍后重试',
    'error.30003': '图片上传失败，请重试',
    'error.30004': '数据读取失败，请重试',
    'error.31001': '系统异常，请稍后重试'
  },
  'zh-Hant': {
    'info.10001': '對話記錄已過期自動清除',
    'error.20003': '缺少用戶標識',
    'error.20004': '缺少會話標識',
    'error.20005': '請輸入內容',
    'error.20006': '請選擇圖片方向',
    'error.20007': '圖片方向無效',
    'error.20008': '風格選項無效',
    'error.20009': '參數值超出範圍',
    'error.20010': '請提供圖片',
    'error.20011': '缺少訊息標識',
    'error.20012': '一次最多處理 4 張圖片',
    'error.20013': '會話數量已達上限（20 個），請先刪除部分舊會話',
    'error.22001': '內容不符合規範，請修改後重試',
    'error.22002': '帳號已被暫時限制，{hours} 小時後恢復',
    'error.22003': '帳號已被永久限制',
    'error.22005': '請求過於頻繁，請稍後再試',
    'error.23001': '會話不存在或已刪除',
    'error.23002': '訊息不存在或已刪除',
    'error.30001': '服務暫時不可用，請稍後重試',
    'error.30002': '回應逾時，請稍後重試',
    'error.30003': '圖片上傳失敗，請重試',
    'error.30004': '資料讀取失敗，請重試',
    'error.31001': '系統異常，請稍後重試'
  },
  en: {
    'info.10001': 'Chat history has expired and been cleared.',
    'error.20003': 'Missing user ID',
    'error.20004': 'Missing session ID',
    'error.20005': 'Please enter a message',
    'error.20006': 'Please select image orientation',
    'error.20007': 'Invalid image orientation',
    'error.20008': 'Invalid image style',
    'error.20009': 'Parameter out of range',
    'error.20010': 'Please provide an image',
    'error.20011': 'Missing message ID',
    'error.20012': 'You can process up to 4 images at a time',
    'error.20013': 'You have reached the limit of 20 sessions. Please delete some old ones first.',
    'error.22001': 'Content does not comply with guidelines. Please modify and try again.',
    'error.22002': 'Account temporarily restricted. Recovery in {hours} hours.',
    'error.22003': 'Account permanently restricted.',
    'error.22005': 'Too many requests. Please try again later.',
    'error.23001': 'Session not found or deleted.',
    'error.23002': 'Message not found or deleted.',
    'error.30001': 'Service temporarily unavailable. Please try again later.',
    'error.30002': 'Response timed out. Please try again later.',
    'error.30003': 'Image upload failed. Please try again.',
    'error.30004': 'Data read failed. Please try again.',
    'error.31001': 'System error. Please try again later.'
  },
  ja: {
    'info.10001': 'チャット履歴の有効期限が切れ、自動的に消去されました。',
    'error.20003': 'ユーザーIDがありません',
    'error.20004': 'セッションIDがありません',
    'error.20005': 'メッセージを入力してください',
    'error.20006': '画像の向きを選択してください',
    'error.20007': '無効な画像の向きです',
    'error.20008': '無効なスタイルです',
    'error.20009': 'パラメータが範囲外です',
    'error.20010': '画像を提供してください',
    'error.20011': 'メッセージIDがありません',
    'error.20012': '一度に処理できる画像は最大4枚です',
    'error.20013': 'セッション数が上限（20件）に達しました。古いセッションを削除してください',
    'error.22001': '内容がガイドラインに違反しています。修正して再試行してください',
    'error.22002': 'アカウントが一時的に制限されています。{hours}時間後に復旧します',
    'error.22003': 'アカウントが永久的に制限されました',
    'error.22005': 'リクエストが多すぎます。しばらくしてから再試行してください',
    'error.23001': 'セッションが存在しないか削除されました',
    'error.23002': 'メッセージが存在しないか削除されました',
    'error.30001': 'サービスが一時的に利用できません。しばらくしてから再試行してください',
    'error.30002': '応答がタイムアウトしました。しばらくしてから再試行してください',
    'error.30003': '画像のアップロードに失敗しました。再試行してください',
    'error.30004': 'データの読み取りに失敗しました。再試行してください',
    'error.31001': 'システムエラーが発生しました。しばらくしてから再試行してください'
  }
}

// 一键生图自动拼接的 message 文案（API 文档 §5.3.2：img_style 触发生图时 message 仍必填）
const GEN_MESSAGES = {
  'zh-Hans': { cartoon: '生成图片-卡通', landscape: '生成图片-风景', portrait: '生成图片-人像', anime: '生成图片-动漫' },
  'zh-Hant': { cartoon: '生成圖片-卡通', landscape: '生成圖片-風景', portrait: '生成圖片-人像', anime: '生成圖片-動漫' },
  en: { cartoon: 'Generate image - Cartoon', landscape: 'Generate image - Landscape', portrait: 'Generate image - Portrait', anime: 'Generate image - Anime' },
  ja: { cartoon: '画像を生成-漫画', landscape: '画像を生成-風景', portrait: '画像を生成-人物', anime: '画像を生成-アニメ' }
}

function currentTexts() {
  return TEXTS[language.getSelectedLanguage()] || TEXTS[language.DEFAULT_LANGUAGE]
}

// 取文案并替换 {hours} 之类的占位；key 不存在返回 ''（由调用方决定降级）
function t(key, params) {
  const template = currentTexts()[key] || ''
  return template.replace(/\{(\w+)\}/g, (raw, name) =>
    params && params[name] !== undefined && params[name] !== null ? String(params[name]) : raw
  )
}

// 错误码 → 文案；未知 code 降级到 31001「系统异常」
function textForCode(code, params) {
  return t(`error.${code}`, params) || t('error.31001')
}

// 统一错误分发（API 文档 §6.7 / §八「前端处理区间速查」）：
//   22002/22003 封禁       → 弹窗 + 回调 onBanned（页面据此禁用聊天输入；22003 无取消按钮）
//   20013 会话数达上限      → 传了 onSessionLimit 则弹「去清理」确认框（v1.0.4），否则 toast
//   30000~30999 上游错误    → 传了 onRetry 则弹「重试」确认框，否则 toast
//   其余(参数/违规/资源等)  → toast
// toast 走「接口-」来源前缀约定（该 AI 服务是后端接口，与 request.js 同类；弹窗类不加前缀）。
// err 形态：ai-api.js reject 出来的 { code, params, detail, userMessage? }；
// userMessage 只由 AI 请求层对明确白名单的网关错误生成，非标错误(网络失败等)按 30001 处理。
function handleAiError(err, options = {}) {
  const error = err || {}
  const code = Number(error.code) || 31001
  const userMessage =
    typeof error.userMessage === 'string' ? error.userMessage.trim() : ''
  const message = userMessage || textForCode(code, error.params)

  // detail 是开发者排障信息，严禁展示给用户，只打日志
  if (error.detail) {
    console.warn(`[BoltStar] code=${code}`, error.detail)
  }

  // 仅 AI 请求层确认过字段签名的固定网关错误可走这里，并且必须直接 toast，
  // 让 RequestId 留在用户截图中用于服务端定位；其它 detail 仍不得展示。
  if (userMessage) {
    toast.show({
      title: /^(接口-|设备-|小程序-)/.test(message)
        ? message
        : `接口-${message}`,
      icon: 'none',
      duration: 5000
    })
    return
  }

  if (code === 22002 || code === 22003) {
    wx.showModal({
      title: '提示',
      content: message,
      showCancel: false,
      confirmText: '知道了'
    })
    if (typeof options.onBanned === 'function') {
      options.onBanned(code)
    }
    return
  }

  // 20013 MAX_SESSIONS_REACHED（v1.0.4 新增，每用户上限 20 个会话）：文档要求「引导用户清理旧会话」。
  // 光 toast 用户不知道去哪清，所以页面传了 onSessionLimit 就弹确认框直接把人送到会话列表页去删；
  // 没传就退回 toast（与 30xxx 的 onRetry 同一套路）。重试对它没意义，故不走下面的重试分支。
  if (code === 20013 && typeof options.onSessionLimit === 'function') {
    wx.showModal({
      title: '提示',
      content: message,
      cancelText: '取消',
      confirmText: '去清理',
      success: res => {
        if (res.confirm) {
          options.onSessionLimit()
        }
      }
    })
    return
  }

  if (code >= 30000 && code < 31000 && typeof options.onRetry === 'function') {
    wx.showModal({
      title: '提示',
      content: message,
      cancelText: '取消',
      confirmText: '重试',
      success: res => {
        if (res.confirm) {
          options.onRetry()
        }
      }
    })
    return
  }

  toast.show({ title: /^(接口-|设备-|小程序-)/.test(message) ? message : `接口-${message}`, icon: 'none' })
}

// 一键生图按当前语种拼 message（如「生成图片-卡通」）
function genMessage(styleKey) {
  const map = GEN_MESSAGES[language.getSelectedLanguage()] || GEN_MESSAGES[language.DEFAULT_LANGUAGE]
  return map[styleKey] || map.cartoon
}

module.exports = {
  t,
  textForCode,
  handleAiError,
  genMessage
}
