// AI 对话（星宝）主界面 —— 当前边界见 docs/architecture/ai-client.md，
// 接口见 docs/reference/ai/BoltStar-API-Doc-v2-1.0.4.md（当前对接版本；小程序只能走非流式 + 客户端打字机）。
// 2026-07-30 已按 assets/ai/UI 视觉稿重写；已有图标使用 assets/images/ai-*.png，缺失项继续用色块占位。
//
// 会话创建时机（2026-07-25 二次拍板，改动前请先看 createSession 上方注释）：
//   **只有「空态下发出第一条消息」才建会话**。进页面不建、点＋「新对话」不建（只把界面退回
//   AI 默认首页；已经在空态还点就提示「已经在新对话中」）、当前会话被删也只回空态。
//   道理很简单：还没说一句话就先占一条会话，用户看看就走就是一条空会话，v1.0.4 起上限 20 条，占不起。
//
// v1.0.3 图文多模态（§二「图片支持」/§5.1.4）：图片选好后以缩略图停在输入框内（每张可删、最多 4 张），
// 必须**配文字**一起发送（纯图片不可发）；发送即带 image_urls 走 POST /chat，服务端按
// 张数+生图关键词自行分流（1 张+关键词=图生图美化 / 多张+关键词=友好拒绝 / 其余=分析讨论）。
// 旧「选图后下一条输入 → /image/enhance」的单图链路随之下线（enhanceImage 接口仍保留作独立入口）。
//
// 2026-07-27 六项体验修复（详见 docs/changes/2026-07-24-AI模块开发进度.md 同日日志）：
//   1 上传前压到 ~100KB（media.compressToTarget）+ 图片按 img_orientation 预占高宽；
//   2 打字机改 ~60fps 递归 setTimeout + 贴底改 scroll-top（原 scroll-into-view 跟不上）；
//   3 AI 回复的文字与图渲染进**同一个气泡**（kind='rich'，图挂在 message.images 上）；
//   4 按住说话的动效改成**盖住整个输入区**（含展开的工具栏），且录音期间不显示识别文字；
//   5 首屏「先渲染 → 贴底 → 再显形」，图片占位防内容被顶飞；
//   6 AI 气泡去头像、按屏宽铺满（用户侧气泡维持原样）。
const aiApi = require('../../../utils/ai-api')
const aiI18n = require('../../../utils/ai-i18n')
const api = require('../../../utils/api')
const media = require('../../../utils/media')
const system = require('../../../utils/system')
const toast = require('../../../utils/toast')
const activeDevice = require('../../../utils/active-device')
const language = require('../../../utils/language')
const aiServiceConsent = require('../../../utils/ai-service-consent')

// 微信「同声传译」插件（WechatSI）：录音直接转文字，小程序里做语音输入的官方方案。
// ⚠️ 光在 app.json 声明还不够，必须先在**小程序后台**「设置 → 第三方设置 → 插件管理」
// 添加「微信同声传译」(appid wx069ba97219f66d99) 并通过，否则 requirePlugin 会抛错。
// 这里 try 住：没开通就降级成「只录音、转不了字」的原有行为，不至于整页白屏。
let speechPlugin = null
try {
  speechPlugin = requirePlugin('WechatSI')
} catch (error) {
  speechPlugin = null
}

// 项目语种 → WechatSI 的 lang 参数。插件只支持这几种，**没有日语**：
// ja 只能退到 zh_CN（说日语基本识别不出来，属于插件能力缺口，非本项目 bug）。
const SPEECH_LANG = {
  'zh-Hans': 'zh_CN',
  'zh-Hant': 'zh_HK',
  en: 'en_US',
  ja: 'zh_CN'
}

// 按住说话（仿微信）：手指相对起点上滑超过此距离(px)即进入「松开取消」态
const VOICE_CANCEL_DY = 80
// 单条语音最长时长(ms)，与文档 §5.1.2 建议一致
const VOICE_MAX_MS = 60000
// 在输入框上按住多久算「长按唤起语音」(ms)。短于它的触摸仍是普通点击（聚焦输入框打字）。
const INPUT_HOLD_MS = 350
// 长按判定的位移容差(px)：按住期间移动超过它就当作滑动/选字，取消长按计时
const INPUT_HOLD_MOVE_PX = 10

// Token 余额 demo：支付体系（Java 后端）未接，先用本地存储模拟「余额展示 + 每次对话扣 1 + 不足拦截」，
// 接入真实接口后把 readTokenBalance/spendToken 换成后端调用即可。
const TOKEN_STORAGE_KEY = 'aiTokenBalanceDemo'
const TOKEN_DEFAULT = 100

// 打字机（2026-07-27 优化顺滑度）。原实现是 setInterval(30ms) 每帧追 3 字 —— 30ms 一跳、
// 一跳 3 字，肉眼能看出「一顿一顿」。现在按 ~60fps 出字、每帧尽量只追 1 字，视觉上连续得多：
//   · TYPE_TICK_MS 16ms ≈ 一帧，用递归 setTimeout 自计时（setInterval 遇上 setData 慢会堆帧）；
//   · 每帧字数 = max(1, ceil(总字数 / TYPE_MAX_TICKS))，长回复自动加快，整段最长 ~6.7s 打完，
//     不至于让人对着几千字干等。
const TYPE_TICK_MS = 16
const TYPE_MAX_TICKS = 420

// 贴底滚动：scroll-top 给一个远超内容高度的值，让 scroll-view 自己夹到底部（不必量高度）。
// 两个相邻大值交替使用 —— 属性值没变化时组件不会重新滚动，连续贴底会被吃掉；差 1px 视觉无感。
const SCROLL_BOTTOM_A = 999998
const SCROLL_BOTTOM_B = 999999
// 打字期间贴底的节流间隔(ms)。每帧都 setData 一次 scrollTop 会和出字的 setData 抢主线程，
// 反而更卡；80ms 一次 ≈ 落后不到 5 个字，打完还会强制贴一次底。
const SCROLL_STICK_MS = 80
// 距底多少 px 以内算「还贴着底」。用户主动往上翻看历史时就别再把他拽回来了。
const SCROLL_STICK_PX = 60

// 图文多模态一次最多带 4 张图（文档 v1.0.3 §二 image_urls 上限；超出服务端回 20012）
const MAX_IMAGES = 4

// 会话标题截断长度：v1.0.4 §二「首条用户消息前 20 字自动填充，默认'新对话'」。
// 前端本地同步标题时按同一规则截，避免列表页重拉后标题突然变短。
const SESSION_TITLE_MAX = 20

// 一键生图风格（需求文案：漫画/风景/肖像/动漫；API 值：cartoon/landscape/portrait/anime）
const STYLE_OPTIONS = [
  { key: 'cartoon', label: '漫画' },
  { key: 'portrait', label: '人物' },
  { key: 'landscape', label: '风景' },
  { key: 'anime', label: '卡通' }
]

// 图片比例（需求：竖向/横向/方形；API img_orientation 必传）。
// pad = 高/宽×100，直接当占位盒的 padding-bottom 百分比用（见 IMAGE_PAD_DEFAULT 上方注释）。
const ORIENTATION_OPTIONS = [
  {
    key: 'vertical',
    label: '竖向',
    size: '1104×1472',
    pad: 133.33,
    icon: '/assets/images/ai-orientation-vertical-default.png',
    activeIcon: '/assets/images/ai-orientation-vertical-active.png'
  },
  {
    key: 'horizontal',
    label: '横向',
    size: '1472×1104',
    pad: 75,
    icon: '/assets/images/ai-orientation-horizontal.png',
    activeIcon: '/assets/images/ai-orientation-horizontal-active.png'
  },
  {
    key: 'square',
    label: '方形',
    size: '1328×1328',
    pad: 100,
    icon: '/assets/images/ai-orientation-square.png',
    activeIcon: '/assets/images/ai-orientation-square-active.png'
  }
]

// 用户可能按「landscape/portrait」这套叫法传/说方向，但接口只认 horizontal/square/vertical
// （文档 §八 20007 INVALID_IMAGE_ORIENTATION 明确「仅 horizontal/square/vertical」），
// 传别名过去必定报 20007。这里统一归一化，界面/存储用哪套都不影响发出去的值。
const ORIENTATION_ALIAS = {
  landscape: 'horizontal',
  portrait: 'vertical',
  '1:1': 'square',
  '16:9': 'horizontal',
  '9:16': 'vertical'
}

// 图片占位比例（2026-07-27 需求 1.2 / 5.2）：图片没加载完时先按已知比例把高度**占住**，
// 加载完不会把上面的内容顶飞。取值就是「高/宽×100」，wxml 里作为占位盒的 padding-bottom 百分比。
//
// ⚠️ 比例来源：按 API 文档 v1.0.4 §四/§参数速查表的实际出图尺寸算 ——
//    vertical 1104×1472(3:4) / horizontal 1472×1104(4:3) / square 1328×1328(1:1)。
//    用户口述的是 {square 1:1, landscape 16:9, portrait 9:16}，与文档的 4:3 / 3:4 **不一致**，
//    待后端确认到底出哪种；无论哪种都不会出错 —— 图片 bindload 回来会用**真实尺寸**改写这个比例
//    （见 onImageLoad），文档若变了只需改上面 ORIENTATION_OPTIONS 的 pad 三个数。
const IMAGE_PAD_DEFAULT = 133.33 // 历史消息取不到方向时按默认的竖向占位
const IMAGE_PAD_MIN = 40 // 过于扁/长的图钳一下，免得占位盒把整屏撑没了
const IMAGE_PAD_MAX = 240

// AI 页右上 Token 必须避开微信原生胶囊。把原生胶囊的实际 top/height/right 换成页面变量，
// Token 固定放在它左侧 8px，并与它垂直居中；取不到 API 时回退到普通自定义导航尺寸。
function getAiLayoutMetrics() {
  const metrics = system.getLayoutMetrics()
  const fallback = Object.assign({}, metrics, {
    menuButtonOffsetTop: 6,
    menuButtonHeight: 32,
    tokenRight: 16,
    navigationHeight: 44
  })
  if (!wx.getMenuButtonBoundingClientRect) {
    return fallback
  }
  try {
    const rect = wx.getMenuButtonBoundingClientRect()
    const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    if (!rect || !(rect.left >= 0) || !(rect.height > 0)) {
      return fallback
    }
    const offsetTop = Math.max(0, rect.top - metrics.statusBarHeight)
    return Object.assign({}, metrics, {
      menuButtonOffsetTop: offsetTop,
      menuButtonHeight: rect.height,
      tokenRight: Math.max(12, (info.windowWidth || rect.right) - rect.left + 8),
      navigationHeight: Math.max(44, offsetTop * 2 + rect.height)
    })
  } catch (error) {
    return fallback
  }
}

function clampPad(pad) {
  const value = Number(pad)
  if (!(value > 0)) {
    return IMAGE_PAD_DEFAULT
  }
  return Math.min(IMAGE_PAD_MAX, Math.max(IMAGE_PAD_MIN, Number(value.toFixed(2))))
}

// 由宽高算占位比例；拿不到尺寸就回 0，交给调用方决定用不用默认值
function padFromSize(width, height) {
  const w = Number(width) || 0
  const h = Number(height) || 0
  if (!(w > 0) || !(h > 0)) {
    return 0
  }
  return clampPad((h / w) * 100)
}

// AI 生成图的 OSS 地址，接口回的是 **http://**（见 API 文档 §四 images 示例），
// 而 `wx.downloadFile` 只认 https —— 这就是「下载/投屏一律提示图片过期」的头号原因：
// `<image>` 组件能显示 http 图（所以聊天里看得见），downloadFile 却直接失败。协议这里自动升级；
// ⚠️ 另一半必须在小程序后台配：「开发管理 → 服务器域名 → downloadFile 合法域名」加上图片所在
// OSS 域名（如 https://inkstar.oss-ap-southeast-1.aliyuncs.com），否则真机仍会 fail（开发者工具
// 勾了「不校验合法域名」时看不出来）。
function toHttpsUrl(url) {
  return String(url || '').trim().replace(/^http:\/\//i, 'https://')
}

// 把 downloadFile 的失败归类成人话。原先两处都硬写「图片过期」，把「域名没配」这类配置问题
// 也误报成过期，排查时会被带偏。
function describeDownloadFail(err) {
  const msg = (err && err.errMsg) || ''
  if (/domain list|not in domain|域名/i.test(msg)) {
    return '图片域名未配置（小程序后台 downloadFile 合法域名）'
  }
  if (/timeout|超时/i.test(msg)) {
    return '图片下载超时，请重试'
  }
  return '图片下载失败，请检查网络后重试'
}

function readTokenBalance() {
  const value = wx.getStorageSync(TOKEN_STORAGE_KEY)
  return typeof value === 'number' ? value : TOKEN_DEFAULT
}

// 会话标题经 URL 传参进来（会话列表页 encodeURIComponent），这里解回来。
// 必须 try 住：标题里带 % 时（或基础库版本已经替我们解过一次）decodeURIComponent 会抛 URIError，
// 抛在 onLoad 里就是整页白屏——解不开就原样显示，标题难看远好过打不开页面。
function safeDecodeTitle(value) {
  if (!value) {
    return ''
  }
  try {
    return decodeURIComponent(value)
  } catch (error) {
    return String(value)
  }
}

const MESSAGE_TIME_GAP_MS = 5 * 60 * 1000

function timestampMs(value) {
  const valueMs = new Date(value).getTime()
  return isNaN(valueMs) ? 0 : valueMs
}

// 视觉稿中的消息时间：今天只显示时分，昨天加「昨天」，更早显示月日。
function formatChatTime(value) {
  const date = new Date(value)
  if (isNaN(date.getTime())) {
    return ''
  }
  const now = new Date()
  const pad = n => (n < 10 ? `0${n}` : `${n}`)
  const hm = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const dateStart = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  if (dateStart === todayStart) {
    return hm
  }
  if (dateStart === todayStart - 24 * 60 * 60 * 1000) {
    return `昨天 ${hm}`
  }
  return `${date.getMonth() + 1}月${date.getDate()}日 ${hm}`
}

function nextMessageTimeMeta(messages, value) {
  const time = timestampMs(value)
  const last = messages && messages.length ? messages[messages.length - 1] : null
  const lastTime = Number(last && last.timestampMs) || 0
  return {
    timestampMs: time,
    timeLabel:
      time && (!lastTime || time - lastTime >= MESSAGE_TIME_GAP_MS)
        ? formatChatTime(time)
        : ''
  }
}

Page({
  data: {
    statusBarHeight: 20,
    safeBottom: 0,
    menuButtonOffsetTop: 6,
    menuButtonHeight: 32,
    tokenRight: 16,
    navigationHeight: 44,

    sessionId: '',
    sessionTitle: '新对话',
    tokenBalance: TOKEN_DEFAULT,
    consentDialogVisible: false,
    consentDialogTitle: aiServiceConsent.CONSENT_TITLE,
    consentServiceDescription: aiServiceConsent.CONSENT_SERVICE_DESCRIPTION,
    consentDataNotice: aiServiceConsent.CONSENT_DATA_NOTICE,

    // 消息模型：{ id, serverId, role: 'user'|'assistant',
    //            kind: 'text'(纯文字) | 'image'(纯图，仅用户侧) | 'rich'(AI 回复：文字+图同一个气泡),
    //            content(文本), images([{ url, serverId, pad }]), loading(三点动画), typing(打字机进行中),
    //            timestampMs/timeLabel(时间分隔), failed/failureTitle/failureDesc(可重试失败卡片) }
    //
    // AI 回复恒为 kind='rich'（2026-07-27 需求 3）：一次回复里的文字和图**必须同一个气泡**，
    // 所以图不再各自成一条消息，而是挂在同一条消息的 images 上；历史消息里连着的 assistant 图片行
    // 也会并回它前面那条（见 openSession），保证重进会话与刚回复时长得一样。
    messages: [],
    historyLoading: false,
    // 首屏「先定位到底部、再显形」用（需求 5.1）：false 时聊天区透明但已渲染 —— 必须已渲染，
    // 没布局就没法滚到底；显形前完成贴底，用户就看不到那一下「从头刷到尾」的下滑。
    chatReady: true,

    inputValue: '',
    // 待发送图片（v1.0.3 图文多模态）：{ id, url, tempFilePath, uploading, pad }，缩略图停在输入框内，
    // 每张可删、最多 MAX_IMAGES 张；发送时随文字一起以 image_urls 提交（纯图片不可发）。
    // pad = 相册回的高/宽×100，发出去后用户图片气泡靠它先占住高度（需求 5.2）。
    pendingImages: [],
    maxImages: MAX_IMAGES,
    sending: false, // 等待 AI 回复中（含打字机渲染期），期间禁止再次发送
    // 已点发送、但请求还没真正发出（正在确认服务协议/建会话）。见 guardedSend 注释。
    submitting: false,
    banned: false, // 22002/22003 封禁后禁用输入（文档 §八）

    voiceMode: false, // 键盘/按住说话切换（🎤 专属语音按钮）
    recording: false, // 录音中：动效盖住整个输入区（含展开的工具栏）
    voiceCancel: false, // 已上滑到取消区：动效转红、松手丢弃
    speechReady: false, // 同声传译插件可用（后台已开通）。false 时只能录音、转不了文字

    showTools: false, // 兼容旧交互字段；新版四个工具入口常驻输入卡片
    showOrientationPicker: false,
    showStylePicker: false,
    styleOptions: STYLE_OPTIONS,
    orientationOptions: ORIENTATION_OPTIONS,
    orientation: 'vertical', // 默认竖向（电子相框主流为竖屏）
    orientationLabel: '竖向',

    // 长按 AI 图片后显示视觉稿里的「下载 / 投屏 / 删除」内联操作条。
    activeImageMessageId: 0,
    activeImageIndex: -1,

    // 投屏设备选择弹窗（未连接时弹出已绑定设备列表，需求「投屏流程」）
    devicePicker: { show: false, loading: false, devices: [], selectedId: '' },

    // 贴底滚动（2026-07-27 需求 2.2/5.1 重做）：原先用 scroll-into-view + 「先清空再设锚点」
    // 两次 setData 触发，打字期间跟不上、首屏还会当着用户的面从头滚到尾。现在改 scroll-top
    // 交替大值，一次 setData 直接夹到底（见 SCROLL_BOTTOM_A 注释与 stickToBottom）。
    scrollTop: 0,
    scrollAnimate: false // 首屏定位/打字期间关动画（动画本身就是「赶不上」的来源），发消息时才开
  },

  onLoad(options) {
    this.setData(Object.assign({ tokenBalance: readTokenBalance() }, getAiLayoutMetrics()))
    this._uid = 0 // 本地消息自增 id
    this._pid = 0 // 待发送图片自增 id
    this._typeTimer = null
    this._stick = true // 视图是否还贴着底（用户上翻看历史时置 false，见 onChatScroll）
    this._lastStickAt = 0 // 上次贴底时间，打字期间按 SCROLL_STICK_MS 节流
    this._chatViewH = 0 // 聊天区可视高度，onReady 量一次，用来算「距底多远」
    this._chatReq = null // 进行中的 chat/enhance 请求，供「停止生成」abort
    this._createReq = null // 在途的建会话请求，连点发送时去重（见 createSession）
    this._retryByMessage = {} // 失败卡片 id → 原请求参数；只留内存，不持久化
    this._consentPrompt = null // AI 服务协议弹窗在途去重：首次进入与发送不能叠两层弹窗
    this._consentResolve = null // 自定义协议弹窗的 Promise 完成函数
    this._pendingProjectImage = '' // 设备弹窗确认前暂存的待投屏图片 URL
    this.initRecorder()

    // 带 sessionId 进来（从会话列表/深链）才载入那条会话；否则停在「新对话」空态，
    // **不建会话** —— 光是点进 AI 页就在服务端建一条，用户看看就走会留下一堆空会话
    // （v1.0.4 起每用户上限 20 条，更浪费不起）。建会话的时机见 createSession 上方注释。
    //
    // 会话列表页点某条会话走的就是这条路：它 **navigateTo 新开一个聊天页**（2026-07-25 用户要求
    // 「原路径返回」），所以本页的返回键天然退回会话列表。老实现是 navigateBack + Storage
    // 把下层聊天页就地换成那条会话，返回键就直接退出 AI 了。
    if (options && options.sessionId) {
      this.openSession(options.sessionId, safeDecodeTitle(options.title))
    }

    // 首次进入先确认 AI 服务协议，再检查设备绑定，避免两个 showModal 同时弹出互相覆盖。
    // 不同意仍可正常查看/输入；真正发送时会再次弹出同一引导，直到当前用户同意。
    this.requestAiServiceConsent(false).then(() => this.checkDeviceBound())
  },

  // AI 服务协议确认：同意状态按当前登录用户 ID 缓存；缓存丢失、换账号、退出/注销后都会重新弹。
  // sendAttempt=true 时标题直接提示「请先同意…」，但正文与首次进入完全一致。
  requestAiServiceConsent(sendAttempt) {
    if (aiServiceConsent.hasCurrentUserConsent()) {
      return Promise.resolve(true)
    }
    if (this._consentPrompt) {
      return this._consentPrompt
    }
    this._consentPrompt = new Promise((resolve) => {
      this._consentResolve = resolve
      this.setData({
        consentDialogVisible: true,
        consentDialogTitle: sendAttempt
          ? aiServiceConsent.CONSENT_REQUIRED_TITLE
          : aiServiceConsent.CONSENT_TITLE
      })
    }).then((accepted) => {
      this._consentPrompt = null
      return accepted
    }, () => {
      this._consentPrompt = null
      return false
    })
    return this._consentPrompt
  },

  onConsentDisagree() {
    this.resolveAiServiceConsent(false)
  },

  onConsentAgree() {
    this.resolveAiServiceConsent(true)
  },

  resolveAiServiceConsent(accepted) {
    const resolve = this._consentResolve
    if (!resolve) {
      return
    }
    this._consentResolve = null
    let granted = false
    if (accepted) {
      granted = aiServiceConsent.grantCurrentUserConsent()
      if (!granted) {
        toast.warn({ title: '登录信息异常，请重新登录后使用 AI 服务' })
      }
    }
    this.setData({ consentDialogVisible: false })
    resolve(granted)
  },

  async checkDeviceBound() {
    try {
      const app = getApp()
      if ((app.globalData && app.globalData.selectedDevice) || wx.getStorageSync('selectedDevice')) {
        return
      }
      const devices = await api.getDevices()
      if (devices && devices.length) {
        return
      }
      wx.showModal({
        title: '提示',
        content: '使用 AI 创作前请先绑定设备',
        cancelText: '返回',
        confirmText: '去绑定',
        success: res => {
          if (res.confirm) {
            wx.navigateTo({ url: '/subpackages/device/bind/bind' })
          } else {
            wx.navigateBack()
          }
        }
      })
    } catch (error) {
      // 查询失败（未登录/网络异常）不拦截，发送阶段的接口错误会如实提示
    }
  },

  // 2026-07-25：原先这里消费 Storage(aiOpenSession)，把会话列表页传回的「打开某会话/退回空态」
  // 意图应用到本页 —— 已整体废弃，会话列表页改成 navigateTo 新开聊天页 + 直接调页面实例方法
  // （见 applySessionFromList / resetFromList 上方注释）。
  //
  // 现在 onShow 只干一件事：把全局单例的语音回调抢回本页。页面栈里可能同时躺着好几个聊天页
  // （每从会话列表点开一条会话就多一页），后开的那页 onLoad 会把识别管理器的回调指向自己，
  // 退回下层聊天页后不抢回来，就表现为「按住说话没反应」。
  onShow() {
    this.bindSpeechHandlers()
  },

  // 量一次聊天区高度，供 onChatScroll 判断「用户是不是自己翻上去了」。
  // 量不到就保持 _stick=true（＝一直自动贴底，与改造前行为一致），不影响主流程。
  //
  // 为什么量一次就够：聊天区高度 = 屏高 - 输入区高度，而 onReady 这一刻输入区是**最矮**的
  // （没有待发图缩略图条、没展开工具栏、没有封禁横幅），所以这个值是聊天区能有的**最大**高度。
  // 之后输入区变高、聊天区变矮，这个偏大的值会让「距底距离」被算小 → 更容易判成「还贴着底」
  // ——偏向继续自动贴底，正是安全的那一侧（宁可多贴一次，也不要 AI 在回复而视图纹丝不动）。
  onReady() {
    this.measureChatView()
  },

  measureChatView() {
    try {
      wx.createSelectorQuery()
        .in(this)
        .select('.chat-scroll')
        .boundingClientRect(rect => {
          if (rect && rect.height > 0) {
            this._chatViewH = rect.height
          }
        })
        .exec()
    } catch (error) {
      this._chatViewH = 0
    }
  },

  onUnload() {
    // 系统返回手势可直接销毁页面；若协议弹窗还开着，必须结束在途 Promise，避免悬空。
    if (this._consentResolve) {
      const resolve = this._consentResolve
      this._consentResolve = null
      resolve(false)
    }
    this.stopGenerate(true)
    // 录音/长按计时器不清的话，回调会打在已销毁的页面上，麦克风也可能一直占着
    this.clearHoldTimer()
    if (this.data.recording) {
      this.endVoice(true)
    }
  },

  // ==================== 会话 ====================

  // 回到「新对话」空态：清消息/输入/待发图，sessionId 置空（招呼语 .welcome 随之显示）。
  // 只动本地状态，**不碰服务端**——建不建会话由调用方决定。
  // sending 也要归位：调用方（resetFromList）刚用 stopGenerate(true) 把在途请求掐了，
  // 而静默模式不动 sending，漏了这一下这一页就永远「正在回复中」、再也发不出消息。
  resetToNewSession() {
    this._stick = true // 空态没什么可滚的，但别把上一条会话「用户翻上去了」的状态带过来
    this._retryByMessage = {}
    this.setData({
      messages: [],
      sessionTitle: '新对话',
      sessionId: '',
      banned: false,
      sending: false,
      pendingImages: [],
      inputValue: '',
      showOrientationPicker: false,
      showStylePicker: false,
      activeImageMessageId: 0,
      activeImageIndex: -1,
      // 有可能是在某条会话「还没定位完」时被重置的（聊天页正载入时列表页把这条删了），
      // 漏了这一下招呼语就一直透明着，看着像白屏
      chatReady: true
    })
  },

  // ==== 会话列表页的两个入口（它从 getCurrentPages() 里拿到本页实例直接调）====
  //
  // 为什么不再走 Storage(aiOpenSession) 传意图（2026-07-25 废弃）：那是个**全局**标记，谁的 onShow
  // 先跑就被谁吃掉。列表页现在打开会话是新开一页聊天页，于是「删掉会话 A（标记：退回空态）→
  // 紧接着点开会话 B（新开页）」时，新页的 onShow 会把本该给下层那页的「退回空态」标记吃掉，
  // B 刚载入就被清成招呼语空白页 —— 正是「从会话列表回来变成 AI 首页」那个 bug。
  // 直接调页面实例方法则是点对点的：谁打开着这条会话就通知谁，不会误伤别的聊天页。

  // 就地切到另一条会话。仅用于**页面栈快满、不能再叠聊天页**的降级路径（见 sessions.goChat）。
  applySessionFromList(sessionId, title) {
    if (!sessionId || sessionId === this.data.sessionId) {
      return
    }
    this.stopGenerate(true)
    this._retryByMessage = {}
    this._stick = true // 换会话＝换内容，别把上一条会话「用户翻上去了」的状态带过来
    // sending: false 同 resetToNewSession —— 刚掐掉的在途回复不能把这一页锁在「正在回复中」
    this.setData({
      messages: [],
      banned: false,
      sending: false,
      pendingImages: [],
      inputValue: '',
      showOrientationPicker: false,
      showStylePicker: false,
      activeImageMessageId: 0,
      activeImageIndex: -1
    })
    this.openSession(sessionId, title)
  },

  // 本页打开着的会话在列表页被删了：退回「新对话」空态，免得用户继续往已删会话发消息。
  // **不建会话** —— 建会话只认「首次发送」这一个时机（见 createSession 注释）。
  resetFromList() {
    this.stopGenerate(true)
    this.resetToNewSession()
  },

  // 建会话（POST /session/new）。**只有一个触发点**（2026-07-25 二次拍板）：
  //   用户在「新对话」空态发出第一条消息 —— onSendTap / sendChat 里按「没有 sessionId 就先建」触发。
  // 进页面、点＋「新对话」、当前会话被删，**一律只重置界面不建**：
  // 任何「还没说一句话就先占一条会话」的做法都会留下空会话，v1.0.4 起每用户上限 20 条，占不起。
  //
  // 在途去重（_createReq）：发送按钮连点时两次 onSendTap 都会看到 sessionId still ''，
  // 不去重就会建出两条会话、后一条还是空的。复用同一个 promise，连点只建一条。
  createSession() {
    if (this._createReq) {
      return this._createReq
    }
    this._createReq = this._doCreateSession().then(() => {
      this._createReq = null
    })
    return this._createReq
  },

  async _doCreateSession() {
    try {
      const session = await aiApi.newSession()
      this.setData({ sessionId: session.session_id, sessionTitle: session.title || '新对话' })
    } catch (error) {
      // 建会话失败不阻塞界面（招呼语照常显示），下次发送会再试
      aiI18n.handleAiError(error, {
        onRetry: () => this.createSession(),
        // 20013 会话数已达上限（20 个，v1.0.4 §5.2）：重试没用，把人送到会话列表页删旧的
        onSessionLimit: () => this.goSessions()
      })
    }
  },

  // 打开历史会话并拉取消息。历史超 7 天已清除时接口回 10001，按文档 toast info.10001
  async openSession(sessionId, title) {
    this.setData({
      sessionId,
      sessionTitle: title || '对话',
      historyLoading: true,
      chatReady: false // 载入期间聊天区保持隐形，等定位到底部再显形（需求 5.1）
    })
    try {
      const history = await aiApi.getHistory(sessionId, 1, 100)
      if (history.expired) {
        toast.show({ title: aiI18n.t('info.10001'), icon: 'none' })
      }
      // 接口时间倒序，倒回正序渲染；assistant 且 content 以 http 开头 = 图片（文档 §6.5）
      //
      // ⚠️ 这三层嵌套就是需求 5.1 的全部要点：**先渲染 → 再贴底 → 最后显形**，
      // 一层都不能省，而且必须用 setData 的完成回调串（它才保证「界面已更新」，
      // wx.nextTick 只是下一个时间片，不保证渲染已落地）：
      //   · 消息得先真的渲染出来（有布局）才滚得动 → 所以只能透明，不能 wx:if 藏起来；
      //   · 显形放在贴底**渲染完成之后** → 用户就看不到「从最老一条一路飞到最新」那一下。
      this.setData({ messages: this.buildHistoryMessages(history.list), historyLoading: false }, () => {
        this.stickToBottom({ force: true, done: () => this.setData({ chatReady: true }) })
      })
    } catch (error) {
      this.setData({ historyLoading: false, chatReady: true })
      aiI18n.handleAiError(error, { onRetry: () => this.openSession(sessionId, title) })
    }
  },

  // 历史消息 → 页面消息模型。两件事：
  //   ① assistant 的图片行**并回它前面那条 assistant 消息**（需求 3：一次回复的图文同一个气泡）。
  //      一轮对话＝1 条 user + 1 条 assistant（文字）+ N 条 assistant（图），所以「连着的 assistant 行
  //      属于同一轮」这个前提是成立的，不会把两轮回复并到一起。
  //   ② 用户侧维持原样（需求 6.3）：文字一条、图片一条，各自成气泡。
  buildHistoryMessages(list) {
    const rows = (list || []).slice().reverse()
    const messages = []
    rows.forEach(row => {
      const isImage = /^https?:\/\//.test(row.content)
      if (row.role !== 'user' && isImage) {
        const last = messages[messages.length - 1]
        if (last && last.role !== 'user' && last.kind === 'rich') {
          last.images = last.images.concat([{ url: row.content, serverId: row.id, pad: IMAGE_PAD_DEFAULT }])
          return
        }
        // 前面没有可挂的文字气泡（纯图回复）：自己起一条无文字的 rich
        const timeMeta = nextMessageTimeMeta(messages, row.timestamp)
        messages.push({
          id: ++this._uid,
          serverId: '',
          role: row.role,
          kind: 'rich',
          content: '',
          images: [{ url: row.content, serverId: row.id, pad: IMAGE_PAD_DEFAULT }],
          loading: false,
          typing: false,
          failed: false,
          timestampMs: timeMeta.timestampMs,
          timeLabel: timeMeta.timeLabel
        })
        return
      }
      const timeMeta = nextMessageTimeMeta(messages, row.timestamp)
      messages.push({
        id: ++this._uid,
        serverId: row.id,
        role: row.role,
        kind: row.role === 'user' ? (isImage ? 'image' : 'text') : 'rich',
        content: isImage ? '' : row.content,
        // 用户图片消息：serverId 已在上一行记在消息本身上，images[0] 就别再记一遍，
        // 否则删这条会对同一个 message_id 打两次 DELETE
        images: isImage ? [{ url: row.content, serverId: '', pad: IMAGE_PAD_DEFAULT }] : [],
        loading: false,
        typing: false,
        failed: false,
        timestampMs: timeMeta.timestampMs,
        timeLabel: timeMeta.timeLabel
      })
    })
    return messages
  },

  goSessions() {
    wx.navigateTo({
      url: `/subpackages/ai/sessions/sessions?current=${this.data.sessionId}`,
      // 页面栈满（微信上限 10 层）时 navigateTo 只走 fail、界面毫无反应，如实说一声，
      // 别让用户以为按钮坏了。列表页那边也有对应的降级（见 sessions.goChat）。
      fail: () => toast.warn({ title: '页面层级已达上限，请先返回上一页' })
    })
  },

  // 已经停在「新对话」空态：没有会话、也没有任何消息。
  // 注意判据是「有没有开始对话」，不看输入框里的草稿——用户打了字还没发，仍算在新对话中，
  // 这时点＋只提示、不清草稿（清了等于白打一遍）。
  isPristineNewSession() {
    return !this.data.sessionId && !this.data.messages.length
  },

  // 「新对话」按钮（＋）：**只把界面退回 AI 默认首页，不建会话**。
  // 会话统一等用户发出第一条消息时才建（见 createSession 注释）——否则点一次＋就在服务端留一条
  // 空会话，连点几次就能把 20 条额度占满，正是本次要治的病。
  startNewSession() {
    // submitting 同 sending 一起挡：上一条正卡在「建会话」空窗时点＋，界面会退回空态，
    // 而那条消息随后仍会发进刚建出来的会话里——一次操作两个矛盾结果（见 guardedSend）。
    if (this.data.sending || this.data.submitting) {
      return
    }
    if (this.isPristineNewSession()) {
      toast.show({ title: '已经在新对话中', icon: 'none' })
      return
    }
    this.stopGenerate(true)
    this.resetToNewSession()
  },

  // ==================== 发送 ====================

  onInput(event) {
    this.setData({ inputValue: event.detail.value })
  },

  // 欢迎页灵感词只负责填入草稿，不自动发送，避免误触后直接创建会话或触发生图计费。
  useSuggestion(event) {
    const prompt = event.currentTarget.dataset.prompt || ''
    this.setData({ inputValue: prompt })
  },

  // 发送入口的**同步**闸（2026-07-29）。
  // 病灶：`sending` 要等 sendChat 内真正发出请求那一刻（追加 loading 气泡时）才置起，而在它之前
  // 还隔着「AI 服务协议确认 + 建会话」最多两次网络往返 —— **首次进入 AI 在空态发第一条消息**时
  // 这段空窗最长（必须先 POST /session/new），期间按钮仍是亮的、guard 里 sending 仍是 false，
  // 用户连点就能把同一条消息发出去好几遍（_createReq 只去重了「建会话」，没去重「发送」）。
  // 这里在任何 await 之前先同步置起 submitting（WXML 与 sending 一起决定按钮灰不灰），
  // 无论成功/失败/提前 return 都由 finally 归位。
  // 返回 false = 被闸挡下（调用方据此决定要不要回填草稿）。
  async guardedSend(task) {
    if (this.data.sending || this.data.submitting || this.data.banned) {
      return false
    }
    this.setData({ submitting: true })
    try {
      await task()
    } finally {
      this.setData({ submitting: false })
    }
    return true
  },

  async onSendTap() {
    if (this.data.sending || this.data.submitting || this.data.banned) {
      return
    }
    const text = String(this.data.inputValue || '').trim()
    const images = this.data.pendingImages
    // 纯图片不可发（v1.0.3 §5.1.4 状态机）：必须配文字一起发送
    if (!text) {
      toast.show({
        title: images.length ? '请输入文字后再发送（图片不能单独发送）' : aiI18n.t('error.20005'),
        icon: 'none'
      })
      return
    }
    await this.guardedSend(async () => {
      if (!(await this.requestAiServiceConsent(true))) {
        return // 草稿和待发图片原样保留；下次发送继续引导，直到同意
      }
      // 还有图片在上传：等 OSS URL 就绪再发，否则 image_urls 会缺图
      if (images.some(img => img.uploading)) {
        toast.show({ title: '图片上传中，请稍候…', icon: 'none' })
        return
      }
      // 带上 pad（选图时由相册回的宽高算出）：用户图片气泡也先把高度占住，不等图加载完再顶内容
      const sendImages = images.filter(img => img.url).map(img => ({ url: img.url, pad: img.pad }))
      // 先把会话建出来，**再清输入框**。顺序不能反：建会话可能失败（网络异常 / 20013 会话已达上限），
      // 先清的话用户打的字和选的图就白没了——而「首次发送才建会话」之后，每轮新对话的第一条都会走到这。
      if (!this.data.sessionId) {
        await this.createSession()
        if (!this.data.sessionId) {
          return // 错误提示已由 createSession 弹出；草稿原样留着，用户可直接重发
        }
      }
      this.setData({ inputValue: '', pendingImages: [] })
      // await：让 submitting 一直持有到请求真正发出（sendChat 内 sending 接棒），中间不留空窗
      await this.sendChat(text, undefined, sendImages)
    })
  },

  // 发送对话 / 一键生图 / 图文多模态。styleKey 仅一键生图传（cartoon/landscape/portrait/anime）；
  // imageUrls 为随文字一起发送的图片（≤4，v1.0.3），可传 URL 字符串数组，也可传
  // { url, pad } 数组（带上占位比例，图片气泡就不会在加载完时把内容顶飞）。
  // 先把用户消息（图片气泡+文字气泡）上屏，再交给 _dispatchChat 发请求
  // ——这样 30xxx 重试只重发请求、不重复堆用户气泡。
  async sendChat(message, styleKey, imageUrls) {
    if (this.data.sending || this.data.banned) {
      return
    }
    if (!(await this.requestAiServiceConsent(true))) {
      return
    }
    if (!this.guardToken()) {
      return
    }
    // 空态下发出第一条消息，这时才真正建会话——**全项目唯一的建会话时机**（见 createSession 注释）。
    // onSendTap 走到这之前已经建过了（它要先建再清输入框），这里主要给「一键生图」等其它入口兜底；
    // createSession 自带在途去重，重复调不会多建。失败就地打住，错误提示由 createSession 内部弹。
    if (!this.data.sessionId) {
      await this.createSession()
      if (!this.data.sessionId) {
        return
      }
    }

    // 入参兼容字符串数组与 { url, pad } 数组（见方法上方注释）
    const picked = (Array.isArray(imageUrls) ? imageUrls : [])
      .map(item => (typeof item === 'string' ? { url: item, pad: 0 } : item))
      .filter(item => item && item.url)
    const urls = picked.map(item => item.url)
    const sentAt = Date.now()
    const timeMeta = nextMessageTimeMeta(this.data.messages, sentAt)
    // 用户消息：先按张追加图片气泡（用户上传的原图 URL），再追加文字气泡（需求 6.3 用户侧维持原样）
    const userMsgs = picked.map((item, index) => ({
      id: ++this._uid,
      serverId: '',
      role: 'user',
      kind: 'image',
      content: '',
      images: [{ url: item.url, serverId: '', pad: clampPad(item.pad) }],
      loading: false,
      typing: false,
      failed: false,
      timestampMs: sentAt,
      timeLabel: index === 0 ? timeMeta.timeLabel : ''
    }))
    userMsgs.push({
      id: ++this._uid,
      serverId: '',
      role: 'user',
      kind: 'text',
      content: message,
      images: [],
      loading: false,
      typing: false,
      failed: false,
      timestampMs: sentAt,
      timeLabel: picked.length ? '' : timeMeta.timeLabel
    })
    this.setData({
      messages: this.data.messages.concat(userMsgs),
      // 首条消息后标题自动变为首条内容（与后端 session.title 行为一致，本地同步免重拉）。
      // v1.0.4 §二明确后端只取**前 20 字**，这里同样截断，免得列表页重拉后标题突然变短对不上。
      sessionTitle: this.data.sessionTitle === '新对话'
        ? message.slice(0, SESSION_TITLE_MAX)
        : this.data.sessionTitle
    })
    this.stickToBottom({ force: true, animate: true })
    this._dispatchChat(message, styleKey, urls)
  },

  // 发一次 /chat 请求并渲染回复（可被「重试」重复调用，不再追加用户气泡）
  async _dispatchChat(message, styleKey, urls) {
    // 占位气泡就是最终那一个气泡：文字打进它的 content，图片挂进它的 images（需求 3：图文同一气泡）
    const holder = {
      id: ++this._uid,
      serverId: '',
      role: 'assistant',
      kind: 'rich',
      content: '',
      images: [],
      loading: true,
      typing: false,
      failed: false,
      timestampMs: Date.now(),
      timeLabel: ''
    }
    this.setData({ messages: this.data.messages.concat([holder]), sending: true })
    this.stickToBottom({ force: true, animate: true })

    try {
      this._chatReq = aiApi.chat({
        sessionId: this.data.sessionId,
        message,
        imgOrientation: this.normalizedOrientation(),
        imgStyle: styleKey,
        imageUrls: urls
      })
      const reply = await this._chatReq
      this._chatReq = null
      this.spendToken()
      this.renderReply(holder.id, reply.text, reply.images)
    } catch (error) {
      this._chatReq = null
      if (error && error.code === 'ABORTED') {
        this.removeMessageById(holder.id)
        this.setData({ sending: false })
        return // 用户主动停止，静默
      }
      const code = Number(error && error.code) || 31001
      const showInlineFailure =
        !(error && error.userMessage) &&
        ((code >= 30000 && code < 31000) || code === 31001)
      if (showInlineFailure) {
        const index = this.data.messages.findIndex(item => item.id === holder.id)
        if (index >= 0) {
          this._retryByMessage[holder.id] = { message, styleKey, urls }
          if (error && error.detail) {
            console.warn(`[BoltStar] code=${code}`, error.detail)
          }
          this.setData({
            [`messages[${index}].loading`]: false,
            [`messages[${index}].failed`]: true,
            [`messages[${index}].failureTitle`]: '生成未完成',
            [`messages[${index}].failureDesc`]: '网络或服务繁忙，请稍后重试',
            sending: false
          })
          this.stickToBottom({ force: true, animate: true })
          return
        }
      }
      this.removeMessageById(holder.id)
      this.setData({ sending: false })
      aiI18n.handleAiError(error, {
        onRetry: () => this._dispatchChat(message, styleKey, urls),
        onBanned: () => this.setData({ banned: true })
      })
    }
  },

  async onRetryMessage(event) {
    const id = Number(event.currentTarget.dataset.id)
    const retry = this._retryByMessage[id]
    if (!retry || this.data.sending || this.data.submitting || this.data.banned) {
      return
    }
    await this.guardedSend(async () => {
      delete this._retryByMessage[id]
      this.removeMessageById(id)
      await this._dispatchChat(retry.message, retry.styleKey, retry.urls)
    })
  },

  onFailureDelete(event) {
    const id = Number(event.currentTarget.dataset.id)
    delete this._retryByMessage[id]
    this.removeMessageById(id)
  },

  // 回复渲染（需求 3：文字与图片渲染进**同一个气泡**）：文字走打字机，图片打完字后挂到同一条消息的
  // images 上。图片先按当前 img_orientation 占好高度（需求 1.2），加载完再用真实尺寸校正（onImageLoad）。
  renderReply(holderId, text, images) {
    const pad = this.orientationPad()
    const replyImages = (images || [])
      .filter(Boolean)
      .map(url => ({ url, serverId: '', pad }))

    const index = this.data.messages.findIndex(item => item.id === holderId)
    if (index < 0) {
      this.setData({ sending: false })
      return
    }

    if (!text) {
      // 只有图没有文字：占位气泡直接变成图片气泡（仍是同一个气泡）
      this.setData({
        [`messages[${index}].loading`]: false,
        [`messages[${index}].typing`]: false,
        [`messages[${index}].images`]: replyImages,
        sending: false
      })
      this.stickToBottom({ force: true, animate: true })
      return
    }

    this.setData({
      [`messages[${index}].loading`]: false,
      [`messages[${index}].typing`]: true
    })
    this.startTyping(holderId, text, replyImages)
  },

  // 客户端打字机。两点与旧实现不同（2026-07-27 需求 2.1「再顺滑一点」）：
  //   ① 递归 setTimeout 而非 setInterval —— setData 偶尔慢一点时 interval 会堆帧、追上来时一次吐一大段
  //      （就是那种「卡一下、蹦一截」的观感）；自计时永远是「渲染完再排下一帧」。
  //   ② Array.from 而不是 split('')：split 会把 emoji / 生僻字的**代理对**劈成两半，
  //      打到一半那一帧会渲染出乱码方块（AI 回复里 ✨ 之类相当常见）。
  startTyping(holderId, text, replyImages) {
    const chars = Array.from(text)
    const perTick = Math.max(1, Math.ceil(chars.length / TYPE_MAX_TICKS))
    let pos = 0
    let typed = ''

    const step = () => {
      this._typeTimer = null
      // 打字期间用户可能删掉了前面的消息导致数组下标变化，每帧按 id 重新定位
      const index = this.data.messages.findIndex(item => item.id === holderId)
      if (index < 0) {
        this.setData({ sending: false })
        return
      }
      if (pos >= chars.length) {
        const patch = { [`messages[${index}].typing`]: false, sending: false }
        if (replyImages.length) {
          patch[`messages[${index}].images`] = replyImages
        }
        this.setData(patch)
        this.stickToBottom({ force: true, animate: true })
        return
      }
      typed += chars.slice(pos, pos + perTick).join('')
      pos += perTick
      this.setData({ [`messages[${index}].content`]: typed })
      this.stickToBottom() // 内部按 SCROLL_STICK_MS 节流，并尊重「用户已上翻」
      this._typeTimer = setTimeout(step, TYPE_TICK_MS)
    }

    step()
  },

  // 停止生成：中断请求 + 结束打字机（已打出的内容保留）。silent=true 用于切会话/卸载时清理
  stopGenerate(silent) {
    if (this._chatReq && this._chatReq.abort) {
      this._chatReq.abort()
      this._chatReq = null
    }
    if (this._typeTimer) {
      clearTimeout(this._typeTimer) // 打字机现在是递归 setTimeout（见 startTyping）
      this._typeTimer = null
    }
    if (!silent) {
      const messages = this.data.messages
        .filter(item => !item.loading)
        .map(item => (item.typing ? Object.assign({}, item, { typing: false }) : item))
      this.setData({ messages, sending: false })
    }
  },

  onStopTap() {
    this.stopGenerate(false)
  },

  // Token 权限控制 demo（文档 §5.5）：不足时弹窗引导购买并拦截 AI 调用
  guardToken() {
    if (this.data.tokenBalance > 0) {
      return true
    }
    wx.showModal({
      title: 'Token 不足',
      content: '当前 Token 余额不足，请前往「个人中心-Token管理」购买后继续使用（支付模块开发中）',
      showCancel: false,
      confirmText: '知道了'
    })
    return false
  },

  spendToken() {
    const balance = Math.max(0, this.data.tokenBalance - 1)
    wx.setStorageSync(TOKEN_STORAGE_KEY, balance)
    this.setData({ tokenBalance: balance })
  },

  // ==================== 工具面板 ====================

  toggleTools() {
    this.toggleOrientationPicker()
  },

  // 点工具栏以外的地方就收起（2026-07-27 需求 2，仿底部弹框点外面关闭）。
  // 三个入口共用：聊天区 .chat-wrap 的 tap、顶部工具行 .ai-toolbar 的 tap、输入框 bindfocus
  // （键盘和工具栏不该同时占着底部）。没做成全屏遮罩层是因为遮罩会把拖动也吃掉，聊天记录就滑不动了。
  // 已经关着就别 setData，免得每次聚焦输入框、每次点聊天区都白跑一次渲染。
  closeTools() {
    if (
      this.data.showTools ||
      this.data.showOrientationPicker ||
      this.data.showStylePicker ||
      this.data.activeImageMessageId
    ) {
      this.setData({
        showTools: false,
        showOrientationPicker: false,
        showStylePicker: false,
        activeImageMessageId: 0,
        activeImageIndex: -1
      })
    }
  },

  // 🎤 / ⌨ 切换。切走时若还在录音，按取消处理——不然录音会挂在后台，界面却已经换成输入框了。
  toggleVoice() {
    if (this.data.recording) {
      this.endVoice(true)
    }
    this.clearHoldTimer()
    this.setData({
      voiceMode: !this.data.voiceMode,
      showTools: false,
      showOrientationPicker: false,
      showStylePicker: false
    })
  },

  toggleOrientationPicker() {
    this.setData({
      showOrientationPicker: !this.data.showOrientationPicker,
      showStylePicker: false
    })
  },

  onOrientationTap(event) {
    const key = event.currentTarget.dataset.key
    const option = ORIENTATION_OPTIONS.find(item => item.key === key)
    this.setData({
      orientation: key,
      orientationLabel: option ? option.label : '竖向',
      showOrientationPicker: false
    })
  },

  // 归一化到接口认的三个值（horizontal/square/vertical）。别名见 ORIENTATION_ALIAS，
  // 认不出来就退回默认竖向 —— 传个空/错值过去会被服务端回 20006/20007，白跑一趟还扣不到图。
  normalizedOrientation() {
    const key = String(this.data.orientation || '').toLowerCase()
    const mapped = ORIENTATION_ALIAS[key] || key
    return ORIENTATION_OPTIONS.some(item => item.key === mapped) ? mapped : 'vertical'
  },

  // 当前方向对应的图片占位比例（高/宽×100），生图回来时先按它把气泡里的图占好高度
  orientationPad() {
    const key = this.normalizedOrientation()
    const option = ORIENTATION_OPTIONS.find(item => item.key === key)
    return clampPad(option ? option.pad : IMAGE_PAD_DEFAULT)
  },

  openStylePicker() {
    this.setData({
      showStylePicker: !this.data.showStylePicker,
      showOrientationPicker: false
    })
  },

  closeStylePicker() {
    this.setData({ showStylePicker: false })
  },

  // 一键生图：按语种自动拼 message（如「生成图片-卡通」），img_style 触发生图（文档 §5.3.2）
  // 同样过一遍同步闸（见 guardedSend）：这条路径也要先建会话，连点样式一样会重复发。
  async onStyleTap(event) {
    const key = event.currentTarget.dataset.key
    this.setData({
      showStylePicker: false,
      showOrientationPicker: false,
      showTools: false
    })
    await this.guardedSend(() => this.sendChat(aiI18n.genMessage(key), key))
  },

  chooseAlbum() {
    this.pickImage('album')
  },

  chooseCamera() {
    this.pickImage('camera')
  },

  // 选图（相册可多选）→ 立即上传 OSS → 以缩略图停在输入框内（v1.0.3 §5.1.4）。
  // 不马上调接口，等用户输入文字点发送时随 image_urls 一起提交；最多 MAX_IMAGES 张。
  async pickImage(source) {
    this.setData({
      showTools: false,
      showOrientationPicker: false,
      showStylePicker: false
    })
    if (this.data.banned) {
      return
    }
    const remain = MAX_IMAGES - this.data.pendingImages.length
    if (remain <= 0) {
      toast.show({ title: `一次最多选择 ${MAX_IMAGES} 张图片`, icon: 'none' })
      return
    }
    let files
    try {
      files = source === 'camera' ? await media.chooseFromCamera() : await media.chooseFromAlbum(remain)
    } catch (error) {
      return // 用户取消选图
    }
    files = (files || []).filter(Boolean)
    if (!files.length) {
      return
    }
    // 客户端拦截超限（部分机型相册不严格限制张数），只取前 remain 张
    if (files.length > remain) {
      files = files.slice(0, remain)
      toast.show({ title: `一次最多选择 ${MAX_IMAGES} 张图片`, icon: 'none' })
    }
    // 先各插一张 uploading 缩略图占位，再逐张上传回填 URL（单张失败只移除该张）。
    // pad 用相册回的宽高先算好：发出去后用户图片气泡就能先占住高度，不等图加载完再顶内容（需求 5.2）。
    const items = files.map(file => ({
      id: ++this._pid,
      tempFilePath: file.tempFilePath,
      url: '',
      uploading: true,
      pad: padFromSize(file.width, file.height) || IMAGE_PAD_DEFAULT
    }))
    this.setData({ pendingImages: this.data.pendingImages.concat(items) })
    items.forEach(item => this.uploadPending(item))
  },

  // 单张上传到 OSS，成功回填 url、清 uploading；失败/无地址移除该缩略图。
  // 上传前先压到 ~100KB（需求 1.1）：AI 只需要看清内容，原图动辄 3~8MB，纯粹在浪费上传时间和流量。
  // 压缩失败/压不动会原样返回原图（见 media.compressToTarget），绝不因此发不出图。
  async uploadPending(item) {
    try {
      const shrunk = await media.compressToTarget(item.tempFilePath)
      console.log(
        `[AI] 待发图压缩：${(shrunk.bytes / 1024).toFixed(0)}KB` +
          `${shrunk.compressed ? '（已压缩）' : '（未压缩/原图）'} file=${shrunk.filePath}`
      )
      // 上传期间用户可能已把这张删了，压缩是异步的，压完先确认它还在
      if (this.data.pendingImages.findIndex(p => p.id === item.id) < 0) {
        return
      }
      const uploaded = await api.setFileUpload({ filePaths: [shrunk.filePath] })
      const url = this.extractUrl(uploaded)
      const index = this.data.pendingImages.findIndex(p => p.id === item.id)
      if (index < 0) {
        return // 上传期间用户已删掉这张
      }
      if (!url) {
        this.setData({ pendingImages: this.data.pendingImages.filter(p => p.id !== item.id) })
        toast.warn({ title: '图片上传未返回地址', icon: 'none' })
        return
      }
      this.setData({
        [`pendingImages[${index}].url`]: url,
        [`pendingImages[${index}].uploading`]: false
      })
    } catch (error) {
      // setFileUpload 走 request.js，失败提示已带「接口-」前缀，这里只移除占位
      this.setData({ pendingImages: this.data.pendingImages.filter(p => p.id !== item.id) })
    }
  },

  // 删除输入框内的某张待发送图片
  removePendingImage(event) {
    const index = event.currentTarget.dataset.index
    const list = this.data.pendingImages.slice()
    if (index >= 0 && index < list.length) {
      list.splice(index, 1)
      this.setData({ pendingImages: list })
    }
  },

  // 上传接口返回形态兼容（string / {url} / [{url}]，同 api.js extractUploadUrl 的思路）
  extractUrl(result) {
    const item = Array.isArray(result) ? result[0] : result
    if (typeof item === 'string') {
      return item
    }
    if (!item || typeof item !== 'object') {
      return ''
    }
    return item.url || item.fileUrl || item.filePath || item.path || ''
  },

  // ==================== 语音（按住说话，仿微信） ====================
  //
  // 交互（需求文档「语音输入：支持长按输入框区域或专属语音按钮」+ 用户要求「参照微信」）：
  //   · 按住 → 开始录音，弹出居中浮层，实时显示识别到的文字；
  //   · 按住不放往上滑 → 超过 VOICE_CANCEL_DY 转「松开取消」，浮层变红；
  //   · 松手 → 在取消区则丢弃，否则把识别结果**直接发送**（文档 §5.1.2「松手直接发送」）。
  // 两个入口共用下面同一套 onVoice* 处理：① 🎤 切到语音模式后的「按住说话」条；
  // ② 直接长按输入框（onInputTouch*，短按仍是普通聚焦打字）。

  initRecorder() {
    this._speech = null
    this._recorder = null
    this._voiceCancelled = false
    this._holdTimer = null // 输入框长按计时器
    this._holdStart = null // 输入框长按起手点
    this._holdFired = false // 本次触摸已经把语音唤起来了

    if (speechPlugin && typeof speechPlugin.getRecordRecognitionManager === 'function') {
      this._speech = speechPlugin.getRecordRecognitionManager()
      this.bindSpeechHandlers()
      this.setData({ speechReady: true })
      return
    }

    // 降级：插件没开通就只能录音、转不了文字，如实告诉用户，别让人以为是自己没说清
    this._recorder = wx.getRecorderManager ? wx.getRecorderManager() : null
    if (!this._recorder) {
      return
    }
    // ⚠️ 录音管理器的 onStop/onError 是**累加**注册（不像识别管理器是属性赋值），只能在 onLoad 挂一次，
    // 所以这里靠 isTopPage() 把不可见页面的回调挡掉，不能像 bindSpeechHandlers 那样在 onShow 重挂。
    this._recorder.onStop(() => this.isTopPage() && this.finishVoice('', true))
    this._recorder.onError(() => this.isTopPage() && this.onSpeechError())
  },

  // 识别管理器的回调（属性赋值，重复调用无副作用，onShow 里会重挂一遍）。
  // 页面栈里可能同时躺着多个聊天页（从会话列表点开一条会话＝新开一页），而录音/识别管理器是
  // **全局单例**：后开的页面会盖掉先前页面的回调，回调也可能打在已隐藏的页面上。
  // 于是两手都做：可见页在 onShow 抢回回调 + 每个回调再自查 isTopPage（否则隐藏页也会跟着
  // setData／弹提示／甚至把这段语音再发一次）。
  bindSpeechHandlers() {
    if (!this._speech) {
      return
    }
    // ⚠️ 2026-07-27 需求 4.3：**不要**再把中间识别结果显示在麦克风/输入框位置。
    // 用户明确说「松开麦克风时麦克风位置会显示文字，去掉这个，只有用户松开手后直接发送的文字」
    // ——即录音过程中一个字都不上屏，松手后识别结果直接变成一条发出去的用户消息（参考 deepseek）。
    // 所以这里不挂 onRecognize（挂了就必然要显示，否则纯属白跑），最终结果从 onStop 拿。
    this._speech.onStop = res => this.isTopPage() && this.onSpeechStop(res)
    this._speech.onError = err => this.isTopPage() && this.onSpeechError(err)
  },

  // 本页是否是页面栈栈顶（＝用户正看着的那一页）
  isTopPage() {
    const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : []
    return !pages.length || pages[pages.length - 1] === this
  },

  // 开始录音（两个入口共用）。返回是否真的起来了，供输入框长按决定要不要拦截后续手势。
  beginVoice() {
    // submitting 同 sending 一起挡：上一条正卡在「建会话」空窗时不该再录一句叠上来
    if (this.data.recording || this.data.sending || this.data.submitting || this.data.banned) {
      return false
    }
    if (!this._speech && !this._recorder) {
      toast.warn({ title: '当前设备不支持录音', icon: 'none' })
      return false
    }
    this._voiceCancelled = false
    this.setData({ recording: true, voiceCancel: false })
    if (wx.vibrateShort) {
      wx.vibrateShort({ type: 'light' }) // 起手震一下，与预览页长按拖拽同一套反馈
    }
    if (this._speech) {
      this._speech.start({ duration: VOICE_MAX_MS, lang: this.speechLang() })
    } else {
      this._recorder.start({ duration: VOICE_MAX_MS, format: 'mp3' })
    }
    return true
  },

  speechLang() {
    return SPEECH_LANG[language.getSelectedLanguage()] || SPEECH_LANG['zh-Hans']
  },

  // 结束录音：cancel=true 表示上滑取消（丢弃，不发不填）
  endVoice(cancel) {
    if (!this.data.recording) {
      return
    }
    this._voiceCancelled = !!cancel
    if (this._speech) {
      this._speech.stop() // 结果稍后从 onStop 回来
    } else if (this._recorder) {
      this._recorder.stop()
    }
  },

  onSpeechStop(res) {
    this.finishVoice(((res && res.result) || '').trim(), false)
  },

  // 收尾（识别成功/降级录音/出错都汇到这里）：清浮层状态，再决定发不发。
  // noSpeech=true 表示压根没有识别能力（降级录音），给一句明确提示而不是「没听清」。
  finishVoice(text, noSpeech) {
    const cancelled = this._voiceCancelled
    this._voiceCancelled = false
    if (this.data.recording) {
      this.setData({ recording: false, voiceCancel: false })
    }
    if (cancelled) {
      return // 上滑取消：安静丢弃
    }
    if (noSpeech) {
      toast.warn({ title: '语音转文字未开通，请在小程序后台添加「微信同声传译」插件', icon: 'none' })
      return
    }
    if (!text) {
      toast.show({ title: '没听清，请再说一次', icon: 'none' })
      return
    }
    this.sendVoiceText(text)
  },

  onSpeechError(err) {
    const msg = (err && (err.errMsg || err.msg)) || ''
    this._voiceCancelled = false
    if (this.data.recording) {
      this.setData({ recording: false, voiceCancel: false })
    }
    if (/auth|deny|permission/i.test(msg)) {
      wx.showModal({
        title: '需要麦克风权限',
        content: '请在设置中允许使用麦克风后再按住说话',
        confirmText: '去设置',
        success: r => r.confirm && wx.openSetting()
      })
      return
    }
    toast.warn({ title: '录音失败，请重试', icon: 'none' })
  },

  // 识别结果直接发送（文档 §5.1.2「按住说话，松手直接发送」）。
  // 顺序与 onSendTap 一致：先确保会话再清待发图；任何一步发不出去都把文字**回填输入框**，
  // 别让用户白说一遍——语音内容重打一遍的代价比打字高得多。
  async sendVoiceText(text) {
    // 与发送按钮同一把同步闸（见 guardedSend）：语音松手也会走建会话那段空窗，
    // 期间再按住说一句同样能重复发出去。被闸挡下时按本方法约定把文字回填输入框。
    const passed = await this.guardedSend(async () => {
      if (!(await this.requestAiServiceConsent(true))) {
        this.setData({ inputValue: text })
        return
      }
      const images = this.data.pendingImages
      if (images.some(img => img.uploading)) {
        this.setData({ inputValue: text })
        toast.show({ title: '图片上传中，请稍候…', icon: 'none' })
        return
      }
      const imageUrls = images.map(img => img.url).filter(Boolean)
      if (!this.data.sessionId) {
        await this.createSession()
        if (!this.data.sessionId) {
          this.setData({ inputValue: text })
          return
        }
      }
      this.setData({ inputValue: '', pendingImages: [] })
      await this.sendChat(text, undefined, imageUrls)
    })
    if (!passed) {
      this.setData({ inputValue: text })
    }
  },

  // —— 「按住说话」条（🎤 语音模式）——
  onVoiceStart(event) {
    this._voiceAnchorY = this.touchY(event)
    this.beginVoice()
  },

  onVoiceMove(event) {
    if (!this.data.recording) {
      return
    }
    const cancel = this._voiceAnchorY - this.touchY(event) > VOICE_CANCEL_DY
    if (cancel !== this.data.voiceCancel) {
      this.setData({ voiceCancel: cancel })
    }
  },

  onVoiceEnd() {
    this.endVoice(this.data.voiceCancel)
  },

  touchY(event) {
    const touch = event && ((event.touches && event.touches[0]) || (event.changedTouches && event.changedTouches[0]))
    return touch ? touch.clientY : 0
  },

  // —— 直接长按输入框唤起语音（需求「支持长按输入框区域」）——
  // 用 bind（不是 catch）绑在输入框外层，短按照常穿透给 <input> 聚焦打字；
  // 按住超过 INPUT_HOLD_MS 且几乎没动才唤起语音，唤起后本次触摸的移动/松手复用 onVoice* 逻辑。
  onInputTouchStart(event) {
    if (this.data.voiceMode || this.data.banned) {
      return // 已经在语音模式：那条「按住说话」自己有手势，不重复挂
    }
    this._holdFired = false
    this._holdStart = { x: this.touchX(event), y: this.touchY(event) }
    this._voiceAnchorY = this._holdStart.y
    this.clearHoldTimer()
    this._holdTimer = setTimeout(() => {
      this._holdTimer = null
      this._holdFired = this.beginVoice()
      if (this._holdFired) {
        // 长按前可能正打着字（键盘已开）：唤起语音的同时把键盘收掉，录音浮层不和键盘叠着
        this.hideKeyboard()
      }
    }, INPUT_HOLD_MS)
  },

  onInputTouchMove(event) {
    if (this._holdFired) {
      this.onVoiceMove(event)
      return
    }
    if (!this._holdStart) {
      return
    }
    // 还没到时间就移动了 → 当作滑动/选字，取消长按
    const dx = this.touchX(event) - this._holdStart.x
    const dy = this.touchY(event) - this._holdStart.y
    if (Math.abs(dx) > INPUT_HOLD_MOVE_PX || Math.abs(dy) > INPUT_HOLD_MOVE_PX) {
      this.clearHoldTimer()
    }
  },

  onInputTouchEnd() {
    this.clearHoldTimer()
    this._holdStart = null
    if (this._holdFired) {
      this._holdFired = false
      this.onVoiceEnd()
      // 松手那一下若仍触发了 <input> 原生聚焦（disabled 对「已开始的本次触摸」在部分机型
      // 不一定拦得住），延迟一拍把键盘压回去；正常被 disabled 拦住时这句是空操作。
      setTimeout(() => this.hideKeyboard(), 100)
    }
  },

  // 收起软键盘：基础库 2.21.0 起才有 wx.hideKeyboard，低版本静默跳过（唯一后果是保底不生效）
  hideKeyboard() {
    if (wx.hideKeyboard) {
      wx.hideKeyboard({})
    }
  },

  clearHoldTimer() {
    if (this._holdTimer) {
      clearTimeout(this._holdTimer)
      this._holdTimer = null
    }
  },

  touchX(event) {
    const touch = event && ((event.touches && event.touches[0]) || (event.changedTouches && event.changedTouches[0]))
    return touch ? touch.clientX : 0
  },

  // ==================== 消息长按菜单 ====================

  // 长按气泡本体：用户纯图气泡→下载/投屏/删除；其余（文字 / AI 图文气泡）→删除整条。
  // AI 气泡里**某一张图**的长按走 onImageLongPress（在图上 catchlongpress，不冒泡到这里），
  // 否则「图文同一个气泡」之后就没法只针对某张图下载/投屏了。
  onBubbleLongPress(event) {
    const id = event.currentTarget.dataset.id
    const message = this.data.messages.find(item => item.id === id)
    if (!message || message.loading || message.typing) {
      return
    }

    const onlyImage = message.kind === 'image' && message.images.length === 1
    const items = onlyImage ? ['下载', '投屏', '删除'] : ['删除']
    wx.showActionSheet({
      itemList: items,
      success: res => {
        const action = items[res.tapIndex]
        if (action === '删除') {
          this.deleteMessage(message)
        } else if (action === '下载') {
          this.downloadImage(message.images[0].url)
        } else if (action === '投屏') {
          this.projectImage(message.images[0].url)
        }
      }
    })
  },

  // 长按 AI 气泡里的单张图：展开视觉稿中的内联操作条。
  onImageLongPress(event) {
    const { id, index } = event.currentTarget.dataset
    const message = this.data.messages.find(item => item.id === id)
    if (!message || message.loading || message.typing) {
      return
    }
    const image = message.images[index]
    if (!image) {
      return
    }
    this.setData({
      activeImageMessageId: message.id,
      activeImageIndex: Number(index),
      showOrientationPicker: false,
      showStylePicker: false
    })
  },

  onImageActionTap(event) {
    const { action, url } = event.currentTarget.dataset
    const id = Number(event.currentTarget.dataset.id)
    const index = Number(event.currentTarget.dataset.index)
    const message = this.data.messages.find(item => item.id === id)
    this.setData({ activeImageMessageId: 0, activeImageIndex: -1 })
    if (!message || !message.images[index]) {
      return
    }
    if (action === 'download') {
      this.downloadImage(url)
    } else if (action === 'project') {
      this.projectImage(url)
    } else if (action === 'delete') {
      this.deleteBubbleImage(message, index)
    }
  },

  // 删整条消息。图文合并进一个气泡后一条消息可能对应**多个** message_id
  //（文字行 + 每张图各一行），逐个删掉，漏一个就会重进会话时诡异地只剩半条。
  async deleteMessage(message) {
    // 历史消息带服务端 id 走接口删除；本轮新产生的消息接口未回 id，仅本地移除
    //（重进会话会重新出现，待后端在 /chat 响应中带回 message_id 后可彻底删除）
    const serverIds = [message.serverId]
      .concat((message.images || []).map(img => img.serverId))
      .filter(Boolean)
    try {
      for (const serverId of serverIds) {
        await aiApi.deleteMessage(this.data.sessionId, serverId)
      }
      this.removeMessageById(message.id)
      toast.show({ title: '已删除', icon: 'none' })
    } catch (error) {
      aiI18n.handleAiError(error)
    }
  },

  // 只删气泡里的某一张图
  async deleteBubbleImage(message, index) {
    const image = message.images[index]
    if (!image) {
      return
    }
    try {
      if (image.serverId) {
        await aiApi.deleteMessage(this.data.sessionId, image.serverId)
      }
    } catch (error) {
      aiI18n.handleAiError(error)
      return
    }
    const rest = message.images.filter((item, i) => i !== index)
    // 文字和图都没了，这个气泡就该整条消失，别留个空白框
    if (!rest.length && !message.content) {
      this.removeMessageById(message.id)
    } else {
      const msgIndex = this.data.messages.findIndex(item => item.id === message.id)
      if (msgIndex >= 0) {
        this.setData({ [`messages[${msgIndex}].images`]: rest })
      }
    }
    toast.show({ title: '已删除', icon: 'none' })
  },

  removeMessageById(id) {
    if (this._retryByMessage) {
      delete this._retryByMessage[id]
    }
    const clearsImageMenu = this.data.activeImageMessageId === id
    this.setData({ messages: this.data.messages.filter(item => item.id !== id) })
    if (clearsImageMenu) {
      this.setData({ activeImageMessageId: 0, activeImageIndex: -1 })
    }
  },

  onImageTap(event) {
    const url = event.currentTarget.dataset.url
    wx.previewImage({ urls: [url], current: url })
  },

  // 图片加载完成：用**真实宽高**改写占位比例（需求 1.2/5.2）。
  // 占位比例发图/生图时是「按 img_orientation 猜的」、历史消息更是只能用默认竖向，
  // 这里落地成真实值，图片就不会在加载完那一刻把上面的内容顶掉一截。
  // 已贴底的情况下顺手再贴一次：多张图陆续加载完时，视图始终停在最新一条上。
  onImageLoad(event) {
    const { id, index } = event.currentTarget.dataset
    const detail = event.detail || {}
    const pad = padFromSize(detail.width, detail.height)
    if (!pad) {
      return
    }
    const msgIndex = this.data.messages.findIndex(item => item.id === id)
    if (msgIndex < 0) {
      return
    }
    const image = this.data.messages[msgIndex].images[index]
    // 差不到 1% 就别 setData 了：一张图一次 setData，多图气泡上纯属白刷
    if (!image || Math.abs(Number(image.pad) - pad) < 1) {
      return
    }
    this.setData({ [`messages[${msgIndex}].images[${index}].pad`]: pad })
    this.stickToBottom()
  },

  // 统一下载 AI 生成图，resolve 本地临时文件路径。下载与投屏共用同一份，避免两处各写一遍。
  // 两个坑都在这里挡住：
  //   ① 接口回的是 http:// 地址，downloadFile 不认 → toHttpsUrl 升级协议；
  //   ② downloadFile 的 success **只代表请求完成**，404/403 也会走 success，
  //      不看 statusCode 的话会把一份错误页当图片存进相册 / 传去投屏。
  downloadAiImage(url) {
    return new Promise((resolve, reject) => {
      const target = toHttpsUrl(url)
      if (!target) {
        reject(new Error('图片地址为空'))
        return
      }
      wx.downloadFile({
        url: target,
        success: res => {
          if (res.statusCode === 200 && res.tempFilePath) {
            resolve(res.tempFilePath)
          } else if (res.statusCode === 403 || res.statusCode === 404) {
            reject(new Error('图片已过期（生成图 24 小时后失效）'))
          } else {
            reject(new Error(`图片下载失败（HTTP ${res.statusCode}）`))
          }
        },
        fail: err => reject(new Error(describeDownloadFail(err)))
      })
    })
  },

  // 下载：保存到系统相册（拒权时引导去设置开启）
  async downloadImage(url) {
    wx.showLoading({ title: '下载中', mask: true })
    let filePath
    try {
      filePath = await this.downloadAiImage(url)
    } catch (error) {
      wx.hideLoading()
      toast.warn({ title: error.message, icon: 'none' })
      return
    }
    wx.hideLoading()
    wx.saveImageToPhotosAlbum({
      filePath,
      success: () => toast.show({ title: '已保存到相册', icon: 'success' }),
      fail: err => {
        const msg = (err && err.errMsg) || ''
        if (msg.indexOf('cancel') > -1) {
          return // 用户自己取消了保存，不提示
        }
        if (msg.indexOf('auth') > -1 || msg.indexOf('deny') > -1) {
          wx.showModal({
            title: '需要相册权限',
            content: '请在设置中允许保存图片到相册',
            confirmText: '去设置',
            success: r => r.confirm && wx.openSetting()
          })
          return
        }
        toast.warn({ title: '保存失败，请重试', icon: 'none' })
      }
    })
  },

  // ==================== 投屏（复用现有投屏链路） ====================
  // 需求：已连接→直接进投屏流程；未连接→弹已绑定设备列表，选择后自动连接进投屏。
  // 做法：AI 生成图（OSS URL）先下载成本地临时文件，包装成与首页手选照片同形态的
  // pendingProjection 写 Storage，跳投屏预览页 —— 预览页会预热连接、结果页 ensureConnection
  // 真正自动连接，链路与手选照片完全一致。
  async projectImage(url) {
    const device = activeDevice.getActiveDevice()
    if (device && activeDevice.isDeviceConnected(device)) {
      this.startProjection(device, url)
      return
    }

    // 未连接：弹已绑定设备列表
    this._pendingProjectImage = url
    const selectedId = device && device.id != null ? String(device.id) : ''
    this.setData({
      devicePicker: {
        show: true,
        loading: true,
        devices: [],
        selectedId
      }
    })
    try {
      const devices = await api.getDevices()
      if (!devices.length) {
        this.setData({ 'devicePicker.show': false })
        toast.show({ title: '暂无已绑定设备，请先绑定设备', icon: 'none' })
        return
      }
      const pickerDevices = devices.map((item, index) =>
        Object.assign({}, item, {
          pickerId: String(
            item.id != null
              ? item.id
              : (item.deviceId || item.deviceNo || item.name || index)
          )
        })
      )
      this.setData({
        devicePicker: {
          show: true,
          loading: false,
          devices: pickerDevices,
          selectedId
        }
      })
    } catch (error) {
      this.setData({ 'devicePicker.show': false })
    }
  },

  onDevicePickerSelect(event) {
    const index = event.currentTarget.dataset.index
    const device = this.data.devicePicker.devices[index]
    this.setData({ 'devicePicker.show': false })
    if (device) {
      this.startProjection(device, this._pendingProjectImage)
    }
  },

  closeDevicePicker() {
    this._pendingProjectImage = ''
    this.setData({ 'devicePicker.show': false })
  },

  async startProjection(device, url) {
    wx.showLoading({ title: '准备投屏', mask: true })
    let tempFilePath
    try {
      tempFilePath = await this.downloadAiImage(url)
    } catch (error) {
      wx.hideLoading()
      toast.warn({ title: error.message, icon: 'none' })
      return
    }
    wx.hideLoading()
    wx.setStorageSync('pendingProjection', {
      device,
      images: [
        {
          tempFilePath,
          name: 'AI 生成图',
          sizeMb: 2.5
        }
      ]
    })
    wx.navigateTo({ url: '/subpackages/projection/preview/preview' })
  },

  // 弹层内部点击阻止冒泡到遮罩（项目惯例 catchtap="noop"）
  noop() {},

  // ==================== 滚动 ====================

  // 贴到底部。options：
  //   force  —— 忽略节流、也忽略「用户已上翻」，并把贴底状态复位（发消息/首屏定位/打字结束时用）；
  //   animate —— 是否带滚动动画。打字期间必须 **false**：动画本身就是「滚动赶不上打字机」的来源，
  //             一帧一帧地补动画会越追越远；发消息那一下开动画才好看；
  //   done   —— 贴底**渲染完成后**的回调（首屏靠它决定何时显形）。只在 force 时用得上：
  //             非 force 会被节流/上翻判断提前 return，那种情况下不保证被调用。
  //
  // 原实现用 scroll-into-view + 「先清空锚点再设锚点」触发，一次贴底两次 setData，
  // 打字期间根本跟不上。现在一次 setData 交替 scroll-top 大值，由组件自己夹到底部。
  stickToBottom(options) {
    const opts = options || {}
    if (opts.force) {
      this._stick = true
    } else {
      if (!this._stick) {
        return // 用户正在往上翻看历史，别把他拽回来
      }
      const now = Date.now()
      if (now - this._lastStickAt < SCROLL_STICK_MS) {
        return
      }
    }
    this._lastStickAt = Date.now()
    const next = this.data.scrollTop === SCROLL_BOTTOM_A ? SCROLL_BOTTOM_B : SCROLL_BOTTOM_A
    this.setData({ scrollAnimate: !!opts.animate, scrollTop: next }, opts.done)
  },

  // 记录「用户是不是自己翻上去了」。量不到聊天区高度时保持自动贴底（＝改造前的行为），
  // 宁可多贴一次底，也别出现「AI 在回复、视图却纹丝不动」。
  onChatScroll(event) {
    if (!this._chatViewH) {
      return
    }
    const detail = event.detail || {}
    const distance = (detail.scrollHeight || 0) - (detail.scrollTop || 0) - this._chatViewH
    this._stick = distance <= SCROLL_STICK_PX
  }
})
