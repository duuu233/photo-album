// AI 对话（星宝）主界面 —— 当前边界见 docs/architecture/ai-client.md，
// 接口见 docs/reference/ai/BoltStar-API-Doc-v2-1.0.4.md（当前对接版本；小程序只能走非流式 + 客户端打字机）。
// 2026-07-30 已按 assets/ai/UI 视觉稿重写；已有图标使用 assets/images/ai-*.png，缺失项继续用色块占位。
//
// 会话创建时机（2026-07-25 二次拍板，改动前请先看 createSession 上方注释）：
//   **只有「空态下发出第一条消息」才建会话**。进页面不建、点＋「新对话」不建（只把界面退回
//   AI 默认首页；已经在空态还点就提示「已经在新对话中」）、当前会话被删也只回空态。
//   道理很简单：还没说一句话就先占一条会话，用户看看就走就是一条空会话，v1.0.4 起上限 20 条，占不起。
//
// v1.0.3 图文多模态（§二「图片支持」/§5.1.4）：图片选好后以缩略图停在输入框内
//（每张可删、最多 MAX_IMAGES 张，2026-08-12 起为 5 张），
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
const aiToken = require('../../../utils/ai-token')
const api = require('../../../utils/api')
const media = require('../../../utils/media')
const system = require('../../../utils/system')
const toast = require('../../../utils/toast')
const activeDevice = require('../../../utils/active-device')
const lowBattery = require('../../../utils/low-battery')
const language = require('../../../utils/language')
const aiServiceConsent = require('../../../utils/ai-service-consent')
const aiLastSession = require('../../../utils/ai-last-session')
const fold = require('../../../utils/fold-adapt')

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

// 星币（原文案「Token」，2026-08-12 全站改称）余额收在 utils/ai-token.js
//（2026-08-10 提取；2026-08-11 由本地 demo 切到**真实账户**）。
// 余额展示本身已从本页顶栏移除（需求 1.3：标题要屏幕居中，余额胶囊占着位置就居不了中），
// 展示位在「历史会话」页顶部；这里只剩「发送前拦截（guardAiDialogue，服务端裁决）+ 调用后刷新」两处调用。

// 打字机（2026-07-27 优化顺滑度）。原实现是 setInterval(30ms) 每帧追 3 字 —— 30ms 一跳、
// 一跳 3 字，肉眼能看出「一顿一顿」。现在按 ~60fps 出字、每帧尽量只追 1 字，视觉上连续得多：
//   · TYPE_TICK_MS 16ms ≈ 一帧，用递归 setTimeout 自计时（setInterval 遇上 setData 慢会堆帧）；
//   · 每帧字数 = max(1, ceil(总字数 / TYPE_MAX_TICKS))，长回复自动加快，整段最长 ~6.7s 打完，
//     不至于让人对着几千字干等。
const TYPE_TICK_MS = 16
const TYPE_MAX_TICKS = 420

// 流式打字机（2026-08-06 SSE 接入）：服务端一段一段推 text 事件，打字机不再一次拿到全文，
// 而是「一路追着积压的字打」。每帧字数 = max(1, ceil(未打字数 / STREAM_TYPE_TICKS))
// —— 即任意时刻的积压都在约 STREAM_TYPE_TICKS 帧内打完：来得慢就一字一字（最顺滑），
// 突然来一大段也不会落下十几秒的尾巴。
//
// 2026-08-07 从 60（≈1s）放慢到 180（≈2.9s）：图下面那段描述**没有打字机效果**的观感就出在这。
// 服务端的 text 事件往往是连着涌进来的（尤其响应体一次性到达、靠 unescapeEventSeparators
// 兜底解析的那条路，所有事件在同一帧解析完），积压瞬间就是全文 —— 压在 1 秒内打完，
// 100 字就是每帧 2 字、0.8 秒冲完，肉眼基本看不出在打字。
// 换算：100 字积压 → 1 字/帧 ≈ 1.6s；1000 字积压 → 6 字/帧 ≈ 2.7s（长回复照样不拖尾）。
// 非流式那条老路是 TYPE_MAX_TICKS=420(≈6.7s)，放慢后两条路的观感也接近了。
const STREAM_TYPE_TICKS = 180
// 字打完了但流还没结束时的空转间隔(ms)。这时候没内容可渲染，没必要还按 16ms 空跑。
const STREAM_IDLE_TICK_MS = 60

// 进度条文案。**优先直接用服务端 progress 事件里的 `message` 字段**
//（2026-08-07 服务端新增：`{"type":"progress","progress":35,"stage":"generating","message":"正在创作图片"}`）
// —— 文案归后端管，前端不再自己翻译 stage，改文案不用发版。
//
// 下面两级只是兜底，别删：老部署、以及 pre_text/done 这种本来就没有 message 的场合还要靠它们，
// 否则占位盒里会空着一行。
//
// 兜底第一级：按 stage 映射（文档「-改」版 §四 对照表）。
// **认 stage 而不只看数值**：progress=5 有 starting / request_sent 两种 stage，光看数字分不开；
// 而 85(downloading) 与 80(completed) 的文案在文档里是分开的。
const STAGE_LABELS = {
  starting: '正在连接生图引擎…',
  request_sent: '正在连接生图引擎…',
  generating: 'AI 正在创作中…',
  partial_succeeded: '初稿已完成 ✨',
  completed: '正在优化细节…',
  downloading: '正在下载图片…',
  uploaded: '正在下载图片…',
  done: '生成完成'
}

// 兜底第二级：stage 也缺（纯文字流、老服务端、或补间途中的中间值）时按数值回落到同一张表的分档。
// 分档边界与 STAGE_LABELS 对齐，所以「45→50 爬到一半」和「刚好落在 50」不会给出矛盾的两句话。
function progressLabel(progress, stage, message) {
  // 服务端给了就直接用（trim 一下：空串/纯空格当没给，否则占位盒里会空一行）
  const fromServer = typeof message === 'string' ? message.trim() : ''
  if (fromServer) {
    return fromServer
  }
  const byStage = stage ? STAGE_LABELS[stage] : ''
  if (byStage) {
    return byStage
  }
  if (progress < 5) {
    return '正在连接生图引擎…'
  }
  if (progress < 50) {
    return 'AI 正在创作中…'
  }
  if (progress < 80) {
    return '初稿已完成 ✨'
  }
  if (progress < 85) {
    return '正在优化细节…'
  }
  if (progress < 100) {
    return '正在下载图片…'
  }
  return '生成完成'
}

// 进度补间（接入文档「-改」版 §三「后端只发里程碑，前端负责平滑动画」）。
// 后端只推 5/15/30/45/50/80/85/90/100 这几级，而占位盒正中间摆的是一个**数字**——
// 数字没法像进度条宽度那样靠 CSS 过渡抹平，直接贴上去就是 45→50→80 地跳。
// 这里按文档给的节奏每 PROGRESS_TICK_MS 走一步（离目标远时一步 3、近了一步 1），
// 把台阶补成 46、47、48… 的连续读数（设计稿 assets/demo.png 上的 47% 就是这么来的）。
// ⚠️ 只补到服务端给的目标值，绝不自己往前跑：宁可停在 45% 等下一条，也不能爬到 99% 再倒回去。
const PROGRESS_TICK_MS = 80
const PROGRESS_STEP_FAR = 3
const PROGRESS_STEP_NEAR = 1
const PROGRESS_NEAR_GAP = 20

// 贴底滚动：scroll-top 给一个远超内容高度的值，让 scroll-view 自己夹到底部（不必量高度）。
// 两个相邻大值交替使用 —— 属性值没变化时组件不会重新滚动，连续贴底会被吃掉；差 1px 视觉无感。
const SCROLL_BOTTOM_A = 999998
const SCROLL_BOTTOM_B = 999999
// 打字期间贴底的节流间隔(ms)。原来是 80ms + 关动画：每 80ms 硬生生把视图**瞬移**到底，
// 一秒十几下，看着就是一闪一闪的顿挫（2026-08-07 反馈「太快、像卡顿」）。现在改成开动画
// 滑过去，节流间隔跟着抬到 260ms —— 与组件自带的滚动动画时长(≈300ms)基本同步，一次滑行
// 快走完了下一次才发起，动画就不会被反复打断（打断＝原地重启，正是「顿挫」的来源）。
// 落后一点点没关系：回复期间底部本来就留着空带(.bottom-anchor--sending)，看不出来。
const SCROLL_STICK_MS = 260
// 距底多少 px 以内算「还贴着底」。用户主动往上翻看历史时就别再把他拽回来了。
const SCROLL_STICK_PX = 60
// 手指离开后还认多久的滚动事件（惯性滑行期）。见 onChatScroll：只有**用户自己**滑出来的
// 滚动才拿来判断「是不是翻上去了」，我们自己发起的贴底动画不能算——动画中途距底可能有
// 好几百 px，拿它去判会当场把自己判成「用户上翻」，之后整条回复就再也不跟着滚了。
const SCROLL_FLING_MS = 700

// 图文多模态一次最多带几张图。2026-08-12 产品由 4 张放宽到 5 张
//（文档 v1.0.3/v1.0.4 §二 image_urls 写的仍是 4 张，尚未同步；超出服务端回 20012）。
// ⚠️ 改这个数要连着改 utils/ai-i18n.js 的 error.20012 文案（四语种都写着张数）。
const MAX_IMAGES = 5

// 星币数字的展示口径：后端给的是浮点（真机实测「最低余额：30.0」），照抄进提示里
// 就是「至少需要 30.0 星币」——星币是整数计价的，那个 .0 只会让人以为还有小数位。
// 整数去掉小数点，真有小数则最多留两位（30.5 保留、30.50 收成 30.5）。
function formatTokenAmount(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) {
    return ''
  }
  return Number.isInteger(number) ? String(number) : String(Number(number.toFixed(2)))
}

// 会话标题截断长度：v1.0.4 §二「首条用户消息前 20 字自动填充，默认'新对话'」。
// 前端本地同步标题时按同一规则截，避免列表页重拉后标题突然变短。
const SESSION_TITLE_MAX = 20

// 一键生图风格。key 就是 API 的 img_style，同时决定自动拼接的 message（utils/ai-i18n.js
// 的 GEN_MESSAGES），所以 label 与 key 必须按语义对上，不能按列表顺序对。
//
// ⚠️ 文档 v1.0.3 §5.3.2 的中文对应关系是固定的：
//      cartoon = 卡通「生成图片-卡通」   anime = 动漫「生成图片-动漫」
//      landscape = 风景                 portrait = 人像
//    「漫画」属于 anime 那一档（同一份文档里 cartoon 的日文文案才是「画像を生成-漫画」）。
//    这里原来把 漫画→cartoon、卡通→anime 反着绑，结果点「漫画」发出去的是「生成图片-卡通」、
//    点「卡通」发出去的是「生成图片-动漫」——两个选项的文案和出图风格都是对方的。
const STYLE_OPTIONS = [
  { key: 'anime', label: '漫画' },
  { key: 'portrait', label: '人物' },
  { key: 'landscape', label: '风景' },
  { key: 'cartoon', label: '卡通' }
]

// 图片比例（需求：竖向/横向/方形；API img_orientation 必传）。
// pad = 高/宽×100，直接当占位盒的 padding-bottom 百分比用（见 IMAGE_PAD_DEFAULT 上方注释）。
//
// ⚠️ 尺寸以 2026-08-06 后端给的**文生图实际出图尺寸**为准，是 16:9 / 1:1 / 9:16 ——
// 与 API 文档 v1.0.4 §四写的 1472×1104(4:3) / 1328×1328 / 1104×1472(3:4) **不一致**，
// 文档那组已作废。别再按文档改回去，先找后端对齐。
const ORIENTATION_OPTIONS = [
  {
    key: 'vertical',
    label: '竖向',
    size: '1440×2560',
    pad: 177.78, // 2560/1440，9:16
    icon: '/assets/images/ai-orientation-vertical-default.png',
    activeIcon: '/assets/images/ai-orientation-vertical-active.png'
  },
  {
    key: 'horizontal',
    label: '横向',
    size: '2560×1440',
    pad: 56.25, // 1440/2560，16:9
    icon: '/assets/images/ai-orientation-horizontal.png',
    activeIcon: '/assets/images/ai-orientation-horizontal-active.png'
  },
  {
    key: 'square',
    label: '方形',
    size: '1920×1920',
    pad: 100, // 1:1
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
// ⚠️ 比例来源：2026-08-06 后端确认的**文生图实际出图尺寸**（见 ORIENTATION_OPTIONS）——
//    vertical 1440×2560(9:16) / horizontal 2560×1440(16:9) / square 1920×1920(1:1)。
//    此前按文档 v1.0.4 的 3:4 / 4:3 取值，那组已作废。
//    这里取错也不会一直错 —— 图片 bindload 回来会用**真实尺寸**改写（见 onImageLoad），
//    pad 只决定「图加载完之前占多高」；尺寸再变只需改 ORIENTATION_OPTIONS 的三个 pad。
//
//    图生图/融合图**不走这三档**：后端规则是「像素 ≥ 3,686,400 保持原尺寸，不足则等比放大到
//    3,686,400」——等比放大不改变宽高比，所以出图比例跟着**用户原图**走，与 img_orientation 无关。
//    因此带图发送时占位比例取用户原图的（见 sendChat → _dispatchChat 的 replyPad）。
const IMAGE_PAD_DEFAULT = 177.78 // 历史消息取不到方向时按默认的竖向(9:16)占位
const IMAGE_PAD_MIN = 40 // 过于扁/长的图钳一下，免得占位盒把整屏撑没了
const IMAGE_PAD_MAX = 240

// AI 页顶栏要与微信原生胶囊同高同轴：把原生胶囊的实际 top/height 换成页面变量，
// 导航行高取「胶囊上下留白 + 胶囊高」；取不到 API 时回退到普通自定义导航尺寸。
// （2026-08-10 Token 胶囊移到会话列表页后，这里不再需要算它的右偏移。）
function getAiLayoutMetrics() {
  const metrics = system.getLayoutMetrics()
  const fallback = Object.assign({}, metrics, {
    menuButtonOffsetTop: 6,
    menuButtonHeight: 32,
    navigationHeight: 44
  })
  if (!wx.getMenuButtonBoundingClientRect) {
    return fallback
  }
  try {
    const rect = wx.getMenuButtonBoundingClientRect()
    if (!rect || !(rect.left >= 0) || !(rect.height > 0)) {
      return fallback
    }
    const offsetTop = Math.max(0, rect.top - metrics.statusBarHeight)
    return Object.assign({}, metrics, {
      menuButtonOffsetTop: offsetTop,
      menuButtonHeight: rect.height,
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

// 本页自己的路由（不带前导斜杠，与 getCurrentPages() 里的 page.route 同形）：
// 判断栈里还有没有别的聊天页时用，见 hasOtherChatPageInStack。
const CHAT_ROUTE = 'subpackages/ai/chat/chat'

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

// 折叠屏/分屏适配：Page 配置外面包一层 fold.adapt（方案见 utils/fold-adapt.js 与
// styles/fold-adapt.wxss）。只叠加「形态变化后重测状态栏/安全区」等钩子，页面原有配置一字不改。
Page(fold.adapt({
  data: {
    statusBarHeight: 20,
    safeBottom: 0,
    menuButtonOffsetTop: 6,
    menuButtonHeight: 32,
    navigationHeight: 44,

    sessionId: '',
    // 顶栏只在**有会话时**显示标题（wxml 里按 sessionId 判），默认页留空不写「新对话」。
    // 这里仍保留默认值：会话建出来之前若已从列表带了标题，切过去就是它。
    sessionTitle: '新对话',
    // 真实账户余额（见 utils/ai-token.js）。本页顶栏已不展示它（2026-08-10 让位给居中标题），
    // 留着是给「余额不足拦截」用；展示位在「历史会话」页顶部。
    tokenBalance: aiToken.UNKNOWN_BALANCE,
    consentDialogVisible: false,
    consentDialogTitle: aiServiceConsent.CONSENT_TITLE,
    consentServiceDescription: aiServiceConsent.CONSENT_SERVICE_DESCRIPTION,
    consentDataNotice: aiServiceConsent.CONSENT_DATA_NOTICE,
    consentCrossBorderNotice: aiServiceConsent.CONSENT_CROSS_BORDER_NOTICE,

    // 消息模型：{ id, serverId, role: 'user'|'assistant',
    //            kind: 'text'(纯文字) | 'image'(纯图，仅用户侧) | 'rich'(AI 回复：文字+图同一个气泡),
    //            content(文本), images([{ url, serverId, pad }]), loading(三点动画), typing(打字机进行中),
    //            timestampMs/timeLabel(时间分隔), failed/failureTitle/failureDesc(可重试失败卡片),
    //            preText(SSE 预描述「正在为您绘制…」), streaming(生成中，显示进度条),
    //            progress(0-100，由 SSE progress 事件驱动)/progressLabel(进度文案) }
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

    // 长按气泡空白处弹出的删除确认框（2026-08-10 需求 2）：
    // { show, messageId(要删的消息本地 id), imageIndex(>=0 只删该张图，-1 删整条), title, desc }
    deleteDialog: { show: false, messageId: 0, imageIndex: -1, title: '', desc: '' },

    // 星币不足确认框（2026-08-12 需求 1，改自 wx.showModal）：与 deleteDialog 同一套版式，
    // desc 由 showTokenShortModal 现拼（数字来自后端 chkAiDialogue 的 retMsg）
    tokenDialog: { show: false, desc: '' },

    // 未绑定设备提示（2026-08-12 需求 2，同样改自 wx.showModal）：进页面时 checkDeviceBound 决定弹不弹
    bindDialog: { show: false },

    // 投屏设备选择弹窗（未连接时弹出已绑定设备列表，需求「投屏流程」）。
    // 选中态在 device-picker-sheet 组件内部持有：它是那一屏的临时状态，页面只关心
    // 「用户最后按按钮时选的是哪台」（2026-08-13 需求 2 起不再默认选中）。
    devicePicker: { show: false, loading: false, devices: [] },

    // 贴底滚动（2026-07-27 需求 2.2/5.1 重做）：原先用 scroll-into-view + 「先清空再设锚点」
    // 两次 setData 触发，打字期间跟不上、首屏还会当着用户的面从头滚到尾。现在改 scroll-top
    // 交替大值，一次 setData 直接夹到底（见 SCROLL_BOTTOM_A 注释与 stickToBottom）。
    scrollTop: 0,
    scrollAnimate: false // 只有首屏定位那一下关动画（见 stickToBottom 的 animate 默认值），其余都开着滑
  },

  onLoad(options) {
    this.setData(Object.assign({ tokenBalance: aiToken.cachedBalance() }, getAiLayoutMetrics()))
    this.refreshTokenBalance()
    this._uid = 0 // 本地消息自增 id
    this._pid = 0 // 待发送图片自增 id
    this._typeTimer = null
    this._progressTimer = null // 进度补间的定时器（见 pumpProgress）
    this._stream = null // 在途流式回复的状态（见 beginStream）
    this._stick = true // 视图是否还贴着底（用户上翻看历史时置 false，见 onChatScroll）
    this._touching = false // 手指是否正按在聊天区上（区分「用户滑的」与「我们贴底滑的」）
    this._touchEndAt = 0 // 上次松手时间，惯性滑行期内的滚动仍算用户的
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
      // 2026-08-12 需求 2：由 wx.showModal 改成页面自绘（chat.wxml 的 .confirm-mask/.confirm-dialog，
      // 与删除确认框、星币不足弹窗同一套版式）—— 原生弹框的圆角/字号/按钮排布与全站对不上。
      // 遮罩**不做点外面关闭**：这是个二选一的决定（去绑定 / 返回），点空白处溜走会把用户留在
      // 一个用不了投屏的页面上，还以为是自己点错了。
      this.setData({ bindDialog: { show: true } })
    } catch (error) {
      // 查询失败（未登录/网络异常）不拦截，发送阶段的接口错误会如实提示
    }
  },

  // 「去绑定」：先收弹窗再跳，绑完返回本页时不会还盖着一层
  goBindDevice() {
    this.setData({ 'bindDialog.show': false })
    wx.navigateTo({ url: '/subpackages/device/bind/bind' })
  },

  // 「返回」：与原生弹窗的取消键同义 —— 退回进入 AI 之前的那一页
  onBindDialogBack() {
    this.setData({ 'bindDialog.show': false })
    this.goBack()
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
    // 底栏 AI 图标「再次点击回到刚才那条会话」的记录点之一（2026-08-13 需求 5，见 utils/ai-last-session.js）。
    // 为什么 onShow 也要记、不只在 onUnload 记：页面栈里可能叠着好几个聊天页（每从会话列表点开
    // 一条会话就多一页）。上面那页返回时它的 onUnload 会记下**它**那条会话，可用户此刻看的是
    // 下面这页——所以谁变可见谁就把记录抢回来，最后一条记录才对得上用户眼前的那一页。
    this.rememberAsLastAiPage()
  },

  // 把「本页此刻停在哪」记成「上次离开 AI 时的位置」。
  // sessionId 为空＝停在 AI 默认页，这同样是要记的有效状态（需求 5 的第 2 条：
  // 从默认页返回后再点 AI 图标，还得是默认页）。
  rememberAsLastAiPage() {
    aiLastSession.remember(this.data.sessionId, this.data.sessionTitle)
  },

  // 页面栈里除本页外还有没有别的聊天页（从会话列表点开一条会话就会多叠一页，见 sessions.goChat）
  hasOtherChatPageInStack() {
    const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : []
    return pages.some(page => page && page !== this && page.route === CHAT_ROUTE)
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
    // 离开 AI 时记下停在哪：底栏 AI 图标下次据此决定是回到这条会话还是进默认页（需求 5）。
    // ⚠️ 只有「栈里再没有别的聊天页」时才在这里记 —— 否则本页是被退回**下层聊天页**的那一页，
    // 用户眼前的是下面那一页，该由它的 onShow 记自己。两页的 onShow/onUnload 谁先谁后在不同
    // 基础库版本上并不一致，所以按「谁还留在栈里」判，不按触发顺序赌。
    if (!this.hasOtherChatPageInStack()) {
      this.rememberAsLastAiPage()
    }
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
      deleteDialog: { show: false, messageId: 0, imageIndex: -1, title: '', desc: '' },
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
      deleteDialog: { show: false, messageId: 0, imageIndex: -1, title: '', desc: '' }
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
      const serverTitle = session.title || '新对话'
      const patch = { sessionId: session.session_id }
      // 刚建出来的会话，后端给的标题一律是占位的「新对话」（要等首条用户消息入库才自动填）。
      // 而这一刻页面上的标题**可能已经**同步成首条用户消息了 —— sendChat 现在是「气泡先上屏、
      // 再建会话」（见其内注释），顺序与 2026-08-07 前相反。别让这个占位把它盖回去。
      if (serverTitle !== '新对话' || this.data.sessionTitle === '新对话') {
        patch.sessionTitle = serverTitle
      }
      this.setData(patch)
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
        // 用户图片消息：**message 与 images[0] 都记上同一个 serverId**。
        //
        // ⚠️ 2026-08-28 修「用户自己发的照片删不掉」（两端同款 bug）：原来这里只把 id 记在
        // 消息本身上、images[0] 留空串，理由是「免得删整条时对同一个 message_id 打两次 DELETE」。
        // 但用户图片气泡下面那条常驻操作条走的是 deleteBubbleImage，它只认 image.serverId ——
        // 拿到空串就**只删本地、不调接口**，重进会话照旧躺在那儿。
        //（AI 回复的图 id 记在 image 上，所以那边一直是好的，正是用户观察到的差别。）
        // 现在两处都记，重复由 deleteMessage 去重收口 —— 数据模型如实反映
        // 「这条用户图片消息就是这一个 message_id」，比靠约定记在哪一处稳。
        images: isImage ? [{ url: row.content, serverId: row.id, pad: IMAGE_PAD_DEFAULT }] : [],
        loading: false,
        typing: false,
        failed: false,
        timestampMs: timeMeta.timestampMs,
        timeLabel: timeMeta.timeLabel
      })
    })
    return messages
  },

  // 顶栏返回键（2026-08-10 需求 5：AI 页去掉底部 tabbar 后，返回上一个 tab 只剩这一个出口）。
  // 与 components/page-nav 的 handleBack 同口径：能退就退，本页是栈底（从 tabbar navigateTo 进来
  // 且中途被重定向过等情况）就切回首页 tab —— navigateBack 在栈底是静默失败，点了没反应。
  goBack() {
    const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : []
    if (pages.length > 1) {
      wx.navigateBack()
      return
    }
    wx.switchTab({ url: '/pages/home/home' })
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
      // 星币校验排在**建会话之前**（2026-08-12 需求 2）：确定发得出去，才值得去占一条会话。
      // 反过来的话，余额见底的用户每点一次发送就在服务端多留一条空的「新对话」——
      // 每个用户上限 20 条，几次就占满了，还得自己去列表里删。
      // 拦下时草稿与待发图原样保留（这里还没清），下面 sendChat 就不必再查一遍。
      if (!(await this.guardAiDialogue())) {
        return
      }
      // 先把会话建出来，**再清输入框**。顺序不能反：建会话可能失败（网络异常 / 20013 会话已达上限），
      // 先清的话用户打的字和选的图就白没了——而「首次发送才建会话」之后，每轮新对话的第一条都会走到这。
      // sendChat 自己也会兜底建（一键生图那条路走的就是它，见其内注释），这里多这一趟纯粹是为了
      // 护住草稿：它有输入框要清，而 sendChat 的回滚只撤得掉气泡、撤不回已经清掉的草稿。
      if (!this.data.sessionId) {
        await this.createSession()
        if (!this.data.sessionId) {
          return // 错误提示已由 createSession 弹出；草稿原样留着，用户可直接重发
        }
      }
      this.setData({ inputValue: '', pendingImages: [] })
      // await：让 submitting 一直持有到请求真正发出（sendChat 内 sending 接棒），中间不留空窗
      const sent = await this.sendChat(text, undefined, sendImages, { dialogueChecked: true })
      // 没发出去（星币不足最常见，见 guardAiDialogue）就把草稿放回输入框：这时清空动作已经
      // 做了，不还回去用户就得照着记忆重打一遍——而「不够星币」恰恰是他每次发都会撞上的。
      if (!sent) {
        this.setData({ inputValue: text, pendingImages: images })
      }
    })
  },

  // 发送对话 / 一键生图 / 图文多模态。styleKey 仅一键生图传（cartoon/landscape/portrait/anime）；
  // imageUrls 为随文字一起发送的图片（≤MAX_IMAGES），可传 URL 字符串数组，也可传
  // { url, pad } 数组（带上占位比例，图片气泡就不会在加载完时把内容顶飞）。
  // 先把用户消息（图片气泡+文字气泡）上屏，再交给 _dispatchChat 发请求
  // ——这样 30xxx 重试只重发请求、不重复堆用户气泡。
  //
  // 返回是否真的发出去了：false = 被某道闸拦下（星币不足 / 未同意协议 / 建会话失败），
  // 调用方据此把草稿还回输入框（见 onSendTap）。**所有发送入口都汇到这里**，
  // 星币校验就放在这一处，别再往各入口散着加。
  //
  // options.dialogueChecked：调用方已经查过星币了（onSendTap 要先查再建会话，见需求 2），
  // 这里就别重复打一次接口 —— 一次用户动作只该产生一次校验请求。
  async sendChat(message, styleKey, imageUrls, options) {
    if (this.data.sending || this.data.banned) {
      return false
    }
    if (!(await this.requestAiServiceConsent(true))) {
      return false
    }
    // 服务端裁决「星币够不够发这一轮」。放在任何 setData **之前**：不够时用户气泡一条都不该上屏，
    // 否则界面上会闪出一句发不出去的话再被撤掉——而余额见底的用户**每次**发送都会走到这一步。
    if (!(options && options.dialogueChecked) && !(await this.guardAiDialogue())) {
      return false
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
    const prevTitle = this.data.sessionTitle
    this.setData({
      messages: this.data.messages.concat(userMsgs),
      // 首条消息后标题自动变为首条内容（与后端 session.title 行为一致，本地同步免重拉）。
      // v1.0.4 §二明确后端只取**前 20 字**，这里同样截断，免得列表页重拉后标题突然变短对不上。
      sessionTitle: this.data.sessionTitle === '新对话'
        ? message.slice(0, SESSION_TITLE_MAX)
        : this.data.sessionTitle
    })
    this.stickToBottom({ force: true, animate: true })

    // 空态下发出第一条消息，这时才真正建会话——**全项目唯一的建会话时机**（见 createSession 注释）。
    // onSendTap 走到这之前已经建过了（它要先建再清输入框），这里主要给「一键生图」等其它入口兜底；
    // createSession 自带在途去重，重复调不会多建。
    //
    // ⚠️ 顺序：用户气泡**先上屏，再** await 建会话。反过来（2026-08-07 前的写法）时，
    // 「一键生图」点完要干等一整趟 POST /session/new（真机上约 1s）文案才出现在对话框里，
    // 点下去像没反应。建会话失败时把刚上屏的这几条撤掉、标题也还原，界面回到点击前的样子
    // ——错误提示由 createSession 内部弹，用户重点一次即可。
    if (!this.data.sessionId) {
      await this.createSession()
      if (!this.data.sessionId) {
        const rolledBack = userMsgs.map(item => item.id)
        this.setData({
          messages: this.data.messages.filter(item => rolledBack.indexOf(item.id) < 0),
          sessionTitle: prevTitle
        })
        return false
      }
    }
    // 带图发送 = 图生图/融合图，出图比例跟用户原图走（后端只等比放大，不改宽高比），
    // 与 img_orientation 无关；多张时按第一张（融合结果的比例后端未约定，bindload 回来会校正）。
    const replyPad = picked.length ? clampPad(picked[0].pad) : 0
    // 图片气泡与文字气泡的本地 id 分开带下去：SSE init 事件会回来 image_msg_ids
    //（与图片顺序一一对应）+ user_msg_id，要按各自的位置贴回去（见 applyUserMessageIds）。
    this._dispatchChat(message, styleKey, urls, replyPad, {
      imageBubbleIds: userMsgs.slice(0, picked.length).map(item => item.id),
      textBubbleId: userMsgs[userMsgs.length - 1].id
    })
    return true
  },

  // 发一次 /chat 请求并渲染回复（可被「重试」重复调用，不再追加用户气泡）。
  //
  // 2026-08-06 起主链路是**流式**（SSE，见 utils/ai-api.chatStream 与
  // assets/BoltStar-SSE-前端接入文档 -改.md）：预描述先到、进度条 0→100、图先上屏、文字边收边打，
  // 不再是「干等 15~30s 然后整段刷出来」。老基础库收不了流时按 supportsStream() 回退到
  // 非流式 chat()（renderReply 那条老路原样保留）。
  // replyPad：回复图片的占位比例。图生图/融合图传用户原图的比例（见 sendChat），
  // 文生图传 0 → 回落到当前 img_orientation 那一档（orientationPad）。
  // userBubbles: { imageBubbleIds, textBubbleId } —— 本轮用户气泡的本地 id，交给 beginStream
  // 保管，等 init 事件把服务端 message_id 贴回去。重试路径不重建用户气泡，不传即可。
  async _dispatchChat(message, styleKey, urls, replyPad, userBubbles) {
    this._replyPad = replyPad > 0 ? replyPad : 0 // 见 replyImagePad
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
      preText: '',
      streaming: false,
      progress: 0,
      progressLabel: '',
      // 渐变占位盒的比例：与这轮回复图将来的占位比例取同一个值，100% 换真图时高度不跳
      genPad: this.replyImagePad(),
      timestampMs: Date.now(),
      timeLabel: ''
    }
    this.setData({ messages: this.data.messages.concat([holder]), sending: true })
    this.stickToBottom({ force: true, animate: true })

    const params = {
      sessionId: this.data.sessionId,
      message,
      imgOrientation: this.normalizedOrientation(),
      imgStyle: styleKey,
      imageUrls: urls
    }
    // 真正发给 /chat 的 image_urls：应与「待发图上传完成」逐条一致（前端全程不改写这些地址）
    if (urls.length) {
      console.log('[AI] /chat image_urls=', urls)
    }
    const streaming = aiApi.supportsStream()
    // 局部持有这次的流状态：this._stream 会被停止生成/切会话清空，catch 里靠它分辨
    // 「这条流是不是还归我管」，以及「断线前已经吐出内容了没有」。
    const stream = streaming ? this.beginStream(holder.id, userBubbles) : null
    // 失败时一起打出来：前端超时（GENERATE_TIMEOUT）是 600s，如果 elapsed 稳定卡在明显更短的
    // 数字上（60s/180s 之类），那就是上游 FC/网关先掐的，调前端超时没用 —— 见 ai-api.js 文件头。
    const startedAt = Date.now()

    try {
      this._chatReq = streaming
        ? aiApi.chatStream(params, { onEvent: event => this.onStreamEvent(holder.id, event) })
        : aiApi.chat(params)
      const reply = await this._chatReq
      this._chatReq = null
      this.spendToken()
      if (streaming) {
        this.finishStream(holder.id, reply)
      } else {
        this.renderReply(holder.id, reply.text, reply.images)
      }
    } catch (error) {
      this._chatReq = null
      if (error && error.code === 'ABORTED') {
        // 用户主动停止：界面已由 stopGenerate 收拾好（有内容的留着、空气泡去掉），这里只清状态。
        // 兜底 removeMessageById 只针对「一个字都还没出来」的占位气泡。
        const holderIndex = this.data.messages.findIndex(item => item.id === holder.id)
        if (holderIndex >= 0 && this.data.messages[holderIndex].loading) {
          this.removeMessageById(holder.id)
        }
        if (this._stream === stream) {
          this._stream = null
        }
        this.setData({ sending: false })
        return
      }
      // 流中途断了、但预描述/图/文字已经上屏：保留已生成的部分（用户明明已经看到图了，
      // 这时候把整条换成失败卡片更像 bug）。错误照常按码分发提示，但**不给重试入口**
      // —— 这一轮服务端已经算过、也可能已扣过费，重试等于再来一遍。
      if (stream && stream.hasContent && this._stream === stream) {
        console.warn(
          `[BoltStar] 流式回复中途中断，保留已生成内容 code=${(error && error.code) ||
            '?'} elapsed=${Date.now() - startedAt}ms`,
          (error && error.detail) || ''
        )
        stream.ended = true
        this.pumpTyping() // 把已收到的文字打完再收尾
        aiI18n.handleAiError(error, { onBanned: () => this.setData({ banned: true }) })
        return
      }
      if (this._stream === stream) {
        this._stream = null
      }
      const code = Number(error && error.code) || 31001
      const showInlineFailure =
        !(error && error.userMessage) &&
        ((code >= 30000 && code < 31000) || code === 31001)
      if (showInlineFailure) {
        const index = this.data.messages.findIndex(item => item.id === holder.id)
        if (index >= 0) {
          this._retryByMessage[holder.id] = { message, styleKey, urls, replyPad }
          // elapsed 是分辨「前端超时」和「上游先掐」的唯一线索，失败时无条件打
          console.warn(
            `[BoltStar] code=${code} elapsed=${Date.now() - startedAt}ms`,
            (error && error.detail) || ''
          )
          this.setData({
            [`messages[${index}].loading`]: false,
            // 只收到进度就断了的情况：进度条要一起收掉，否则失败卡片下面还挂着半条进度
            [`messages[${index}].streaming`]: false,
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
        onRetry: () => this._dispatchChat(message, styleKey, urls, replyPad),
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
      // 重试也是一次真实调用，同样要过服务端校验（上一轮失败到现在，余额可能已经不够了）。
      // 失败卡片原样留着：这里什么都还没删，用户买完星币回来还能接着点重试。
      if (!(await this.guardAiDialogue())) {
        return
      }
      delete this._retryByMessage[id]
      this.removeMessageById(id)
      await this._dispatchChat(retry.message, retry.styleKey, retry.urls, retry.replyPad)
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
    const pad = this.replyImagePad()
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

  // ==================== 流式回复（SSE） ====================
  //
  // 事件顺序（2026-08-07 服务端新增 init / heartbeat / **mode**）：
  //   生图：  init → pre_text「星宝努力思考中」→ heartbeat → mode:"image" → pre_text(替换成真文案)
  //          → progress(5/15/30/45/50/80/85/90) → image → text（逐条）→ progress(100) → done
  //   纯文字：init → pre_text「星宝努力思考中」→ heartbeat → mode:"text" → pre_text:""
  //          → text（逐条）→ done
  //
  // ⚠️ **占位盒的显形时机由 mode 决定，不是 pre_text**。这是这批改动的要点：
  //    两条路开头一模一样（都有那句「星宝努力思考中」），服务端要到 mode 事件才知道这轮走哪条。
  //    改造前是 pre_text 一到就把渐变占位盒亮出来 —— 放到新流程里，纯文字回复也会先闪一个
  //    生图占位盒再收掉。所以 pre_text 只管写文案，mode:"image" 才唤出占位盒 + 起进度。
  //    mode:"text" 那条紧跟着的 pre_text:"" 是服务端来擦「思考中」的，擦完气泡若空了要把
  //    三点动画放回去，别晾出一个空白气泡。
  // ⚠️ image 排在 progress 90(uploaded) **之后**，不是 50%——50 那级只是「初稿完成」，
  //    图还没下载上传完，URL 拿不到。占位盒因此几乎会挂满整个生成过程。
  //
  // 兼容没有 mode 的老部署：progress 事件照旧能把占位盒唤出来（见 case 'progress'），
  // 只是显形时机从 pre_text 推迟到第一条 progress —— 两者本来就前后脚，观感无差。
  //
  // this._stream 只跟着「当前这一条在途回复」走，一次只可能有一条（sending 期间不许再发）：
  //   holderId   —— 内容写进哪个气泡；
  //   chars      —— 已收到的全部文字（按码点拆好，emoji 不会被劈成两半）；
  //   shown      —— 已经打上屏的字数，chars 与 shown 的差就是「积压」；
  //   ended      —— 流已结束（resolve 或中断），打字机排空后才收尾；
  //   mode       —— 服务端 mode 事件定的这一轮走向：'image'=生图（出占位盒）/'text'=纯文字/
  //                 ''=还没收到（老部署不发这个事件，一直是空串，各处按「未知」兜底）；
  //   hasContent —— 已经吐出过预描述/图/文字（决定中断时是保留还是换失败卡片）；
  //   target     —— 服务端最新推到的里程碑，只增不减（重复/乱序推也不会让进度倒退）；
  //   progress   —— 当前**上屏**的进度，由 pumpProgress 一步步爬向 target；
  //   stage/message —— target 那一级的 stage 与服务端文案，用来出文案（见 progressLabel）。
  beginStream(holderId, userBubbles) {
    this._stream = {
      holderId,
      chars: [],
      shown: 0,
      ended: false,
      mode: '',
      hasContent: false,
      target: 0,
      progress: 0,
      stage: '',
      message: '',
      // 本轮用户气泡的**本地** id：图片按发送顺序一一对应 init 的 image_msg_ids，
      // 文字那条对应 user_msg_id（见 applyUserMessageIds）。
      imageBubbleIds: (userBubbles && userBubbles.imageBubbleIds) || [],
      textBubbleId: (userBubbles && userBubbles.textBubbleId) || 0
    }
    return this._stream
  },

  // 把 SSE init 事件带回的服务端 message_id 贴到刚上屏的用户气泡上。
  //
  // 事件形状（后端 2026-08-28 新增）：
  //   { "type": "init", "user_msg_id": "文字消息id", "image_msg_ids": ["图1id", "图2id"] }
  // image_msg_ids 与请求里的 image_urls **顺序一一对应**（一张图 = 一条消息 = 一个 id）。
  //
  // ⚠️ 这一步解决的是「发一张照片 → 立刻删 → 退出重进又回来」：在此之前 /chat 全程不回消息 id，
  // 本轮新发的气泡 serverId 是空串，删除只能删本地（deleteBubbleImage 里那个 if 过不去）。
  // 贴上之后，刚发的照片点删除就会真的打 DELETE /chat/history，不必再等一次历史刷新。
  //
  // 图片气泡**两处都贴**（消息本身 + images[0]），与历史消息的模型保持一致：
  // 删单图走 images[0].serverId、删整条走消息上的那个，重复由 deleteMessage 去重收口。
  // 老部署不推这两个字段 → 取到空，行为与改动前完全一致。
  applyUserMessageIds(stream, event) {
    const patch = {}
    const indexOfBubble = localId => {
      if (!localId) {
        return -1
      }
      return this.data.messages.findIndex(item => item.id === localId)
    }

    const textId = String((event && event.user_msg_id) || '')
    if (textId) {
      const index = indexOfBubble(stream.textBubbleId)
      if (index >= 0) {
        patch[`messages[${index}].serverId`] = textId
      }
    }

    const imageIds = Array.isArray(event && event.image_msg_ids) ? event.image_msg_ids : []
    // 按位取：后端给的条数理论上等于本轮发的图数，取两者的较小值，多/少都不越界。
    const count = Math.min(imageIds.length, (stream.imageBubbleIds || []).length)
    for (let i = 0; i < count; i++) {
      const id = String(imageIds[i] || '')
      const index = indexOfBubble(stream.imageBubbleIds[i])
      if (!id || index < 0) {
        continue // 气泡已被用户删掉：静默跳过
      }
      patch[`messages[${index}].serverId`] = id
      patch[`messages[${index}].images[0].serverId`] = id
    }

    if (Object.keys(patch).length) {
      this.setData(patch)
    }
  },

  onStreamEvent(holderId, event) {
    const stream = this._stream
    if (!stream || stream.holderId !== holderId || !event) {
      return // 已被停止生成/切会话清掉，这条流的后续事件一律丢弃
    }
    const index = this.data.messages.findIndex(item => item.id === holderId)
    if (index < 0) {
      return // 气泡被删了（用户长按删除），静默丢弃
    }

    switch (event.type) {
      // 开流握手。不带要渲染的内容（界面继续挂着三点动画），但 2026-08-28 起**带回本轮
      // 用户消息的 message_id** —— 刚发出去的图/文能不能删得掉全靠它，见 applyUserMessageIds。
      case 'init':
        this.applyUserMessageIds(stream, event)
        break

      // 心跳：长等待期间用来续命连接的空包，什么都不用做。
      // 显式列出来，免得以后有人以为漏处理了。
      case 'heartbeat':
        break

      // 这一轮走生图还是纯文字。**占位盒只认这个事件**（理由见 beginStream 上方大段注释）。
      // 字段名按 { "type": "mode", "mode": "image" } 取，同时兼容塞在 content 里的写法。
      case 'mode': {
        const mode = String(event.mode || event.content || '').trim().toLowerCase()
        if (mode !== 'image' && mode !== 'text') {
          break // 未知取值：当没收到，让 progress 那条兜底路照旧生效
        }
        stream.mode = mode
        if (mode === 'image') {
          // 渐变占位盒显形并起步到 5%：原先这两件事挂在 pre_text 上，现在挪到这儿。
          this.markStreamStarted(index, true)
          this.applyProgress(index, stream.target || 5, 'starting')
          this.stickToBottom({ force: true, animate: true })
        }
        break
      }

      // 预描述。服务端会推**两条**：先秒回一句占位的「星宝努力思考中」顶掉空等，
      // 之后按 mode 分两种走向 —— 生图是替换成真正的「正在为您绘制…」，纯文字是推一条**空串**
      // 把它擦掉。前端不用分辨是哪一条，直接覆盖即可 —— 所以这里没有「只写第一次」的判断，别加。
      case 'pre_text': {
        const content = String(event.content || '').trim()
        const message = this.data.messages[index]
        if (!content) {
          // 空串 = 擦掉预描述（mode:"text" 之后紧跟的那条）。擦完气泡里可能什么都不剩，
          // 正文还在路上，这时候要把三点动画放回去，别晾出一个空白气泡。
          if (!message.preText) {
            break
          }
          const patch = { [`messages[${index}].preText`]: '' }
          if (!message.content && !message.streaming && !(message.images || []).length) {
            patch[`messages[${index}].loading`] = true
            // 屏上又什么都不剩了：这时候断线该走「失败卡片 + 可重试」，而不是
            // 「保留已生成内容」那条（那条不给重试入口，见 _dispatchChat 的 catch）
            stream.hasContent = false
          }
          this.setData(patch)
          break
        }
        // 第一条是「凭空多出一块内容」，必须强制贴底；后一条只是就地换字，
        // 这时候还硬拽用户回底部，正在上翻看历史的人会被打断。
        const first = !message.preText
        stream.hasContent = true
        this.markStreamStarted(index, false) // 只收三点动画；占位盒交给 mode:"image"
        this.setData({ [`messages[${index}].preText`]: content })
        this.stickToBottom({ force: first, animate: true })
        break
      }

      case 'progress':
        // mode 已经定了走纯文字：迟到/多余的 progress 不能把占位盒翻出来。
        if (stream.mode === 'text') {
          break
        }
        // ⚠️ stream.target < 100 这个闸不能省：读数走到 100 时占位盒已经收起、真图已经上屏，
        // 这时候服务端再补推一条 progress（重复/迟到的都可能），不挡就会把占位盒重新翻出来
        // 盖在真图上。applyProgress 那边只挡了「进度倒退」，挡不住这里的显形。
        //
        // 这一行同时是**没有 mode 的老部署**的兜底：进度一来照样把占位盒唤出来。
        this.markStreamStarted(index, stream.target < 100)
        this.applyProgress(index, event.progress, event.stage, event.message)
        break

      // 图在 90%(uploaded) 之后才推过来（见 beginStream 上方的事件顺序）。
      // 先收进 images，但要等进度真的走到 100% 才换掉占位盒（见 showProgress）。
      case 'image': {
        const url = String(event.content || '').trim()
        if (!url) {
          return
        }
        // 服务端回的生成图地址，前端不做任何改写（下载/投屏时才 toHttpsUrl 升协议）。
        // 这条打出来若不是 OSS 域名，就是后端把上游模型的临时图直出了，不是前端传错 image_urls。
        console.log('[AI] 回复图 url=', url)
        stream.hasContent = true
        this.markStreamStarted(index, false)
        this.setData({
          [`messages[${index}].images`]: (this.data.messages[index].images || []).concat([
            { url, serverId: '', pad: this.replyImagePad() }
          ])
        })
        this.stickToBottom({ force: true, animate: true })
        break
      }

      // 文字逐条推送：只往队列里追加，真正上屏交给 pumpTyping（边收边打）
      case 'text': {
        const content = String(event.content || '')
        if (!content) {
          return
        }
        stream.hasContent = true
        stream.chars = stream.chars.concat(Array.from(content))
        this.markStreamStarted(index, false)
        if (!this.data.messages[index].typing) {
          this.setData({ [`messages[${index}].typing`]: true })
        }
        this.pumpTyping()
        break
      }

      case 'done':
        // 只有走过生图那条路才需要把进度补到 100（收占位盒、换真图）。纯文字这一路压根没有
        // 占位盒，还去补间就是白跑三十来次 setData（0→100 每 80ms 走 3 步，全程没人看得见）。
        // 用 target>0 而不是 mode 判：老部署不发 mode，但只要出过图就一定推过 progress。
        if (stream.target > 0) {
          this.applyProgress(index, 100, 'done')
        }
        break

      default:
        break // 文档未列出的事件类型：忽略，别让未知事件把这一轮搞挂
    }
  },

  // 收起三点动画 / 让进度条显形。只在真的要改时才 setData —— 一次生图有十来条 progress 事件，
  // 每条都无脑把 loading/streaming 再写一遍纯属白刷渲染。
  markStreamStarted(index, showProgress) {
    const message = this.data.messages[index]
    const patch = {}
    if (message.loading) {
      patch[`messages[${index}].loading`] = false
    }
    if (showProgress && !message.streaming) {
      patch[`messages[${index}].streaming`] = true
    }
    if (Object.keys(patch).length) {
      this.setData(patch)
    }
  },

  // 收到服务端的里程碑：只记成**目标值**，不直接上屏 —— 上屏交给 pumpProgress 一步步爬过去
  // （接入文档 §三，理由见 PROGRESS_TICK_MS 上方注释）。目标只增不减，迟到/乱序的小值直接丢。
  //
  // stage/message 只在目标值真的往前走时才更新。服务端在同一级上换 stage 的两处
  //（5: starting→request_sent、90 之后仍是 uploaded）在 STAGE_LABELS 里文案本来就相同，
  // 不跟这一步没有可见差别。
  applyProgress(index, value, stage, message) {
    const stream = this._stream
    const next = Math.max(0, Math.min(100, Math.round(Number(value) || 0)))
    if (!stream || next <= stream.target) {
      return
    }
    stream.target = next
    stream.stage = stage || ''
    stream.message = message || ''
    this.pumpProgress()
  },

  // 进度补间：每 PROGRESS_TICK_MS 往 target 走一步，到了就停表（下一条里程碑再把它叫醒）。
  // 与打字机分开用一支定时器：文字和进度是两条互不等待的流，共用一支会互相拖节奏。
  pumpProgress() {
    if (this._progressTimer) {
      return // 已经在爬了，新的 target 自然会被追上
    }
    const step = () => {
      this._progressTimer = null
      const stream = this._stream
      if (!stream) {
        return // 已被停止生成 / 切会话清掉
      }
      const index = this.data.messages.findIndex(item => item.id === stream.holderId)
      const gap = stream.target - stream.progress
      if (index < 0 || gap <= 0) {
        return
      }
      const stride = gap > PROGRESS_NEAR_GAP ? PROGRESS_STEP_FAR : PROGRESS_STEP_NEAR
      this.showProgress(index, Math.min(stream.progress + stride, stream.target))
      if (stream.progress < stream.target) {
        this._progressTimer = setTimeout(step, PROGRESS_TICK_MS)
      }
    }
    step() // 首步立即走，别让占位盒先亮一下 0%
  },

  // 把补间出来的值写上屏。文案按**已上屏**的值出，爬到目标那一刻才用目标的 stage
  // —— 否则会出现「52% + 正在优化细节…」这种数字与文案对不上的组合。
  //
  // 到 100% 就把 streaming 落下：渐变占位盒收起、真图原地顶上（需求 2026-08-07 「达到 100%
  // 渲染生成的图片」）。**不能等 settleStream**——那要等打字机把几十个 text 事件全打完才收，
  // 图会被压到文字之后好几秒才出来。服务端漏推 100 时仍由 settleStream 兜底置 false。
  showProgress(index, value) {
    const stream = this._stream
    stream.progress = value
    const reached = value >= stream.target
    const label = progressLabel(
      value,
      reached ? stream.stage : '',
      reached ? stream.message : ''
    )
    const patch = { [`messages[${index}].progress`]: value }
    if (this.data.messages[index].progressLabel !== label) {
      patch[`messages[${index}].progressLabel`] = label
    }
    if (value >= 100) {
      patch[`messages[${index}].streaming`] = false
    }
    this.setData(patch)
    if (value >= 100) {
      this.stickToBottom() // 占位盒换成真图，高度一般会变，跟着贴一下底
    }
  },

  // 流式打字机：一路追着积压的字打，队列空了就等下一段（每帧字数见 STREAM_TYPE_TICKS）。
  // 与 startTyping 共用 this._typeTimer，所以 stopGenerate 那套清理原样有效。
  pumpTyping() {
    if (this._typeTimer) {
      return // 已经在打了，新来的字自然会被追上
    }
    const step = () => {
      this._typeTimer = null
      const stream = this._stream
      if (!stream) {
        return
      }
      const index = this.data.messages.findIndex(item => item.id === stream.holderId)
      if (index < 0) {
        this._stream = null
        this.setData({ sending: false })
        return
      }
      const backlog = stream.chars.length - stream.shown
      if (backlog <= 0) {
        if (stream.ended) {
          this.settleStream(index)
          return
        }
        this._typeTimer = setTimeout(step, STREAM_IDLE_TICK_MS) // 等服务端推下一段
        return
      }
      stream.shown += Math.max(1, Math.ceil(backlog / STREAM_TYPE_TICKS))
      this.setData({
        [`messages[${index}].content`]: stream.chars.slice(0, stream.shown).join('')
      })
      this.stickToBottom() // 内部按 SCROLL_STICK_MS 节流，并尊重「用户已上翻」
      this._typeTimer = setTimeout(step, TYPE_TICK_MS)
    }
    step()
  },

  // 流结束（resolve）：标记 ended 并按汇总结果兜底补齐，剩下的交给打字机排空后 settleStream 收尾。
  // 兜底是必要的 —— 事件流里漏推、或者服务端某次只在最终结果里给全文时，界面不能少内容。
  finishStream(holderId, reply) {
    const stream = this._stream
    if (!stream || stream.holderId !== holderId) {
      return // 期间被停止生成/切会话清掉了
    }
    stream.ended = true
    const index = this.data.messages.findIndex(item => item.id === holderId)
    if (index < 0) {
      this._stream = null
      this.setData({ sending: false })
      return
    }
    if (reply) {
      const shown = (this.data.messages[index].images || []).map(img => img.url)
      const missing = (reply.images || []).filter(url => url && shown.indexOf(url) < 0)
      if (missing.length) {
        const pad = this.replyImagePad()
        this.setData({
          [`messages[${index}].images`]: this.data.messages[index].images.concat(
            missing.map(url => ({ url, serverId: '', pad }))
          )
        })
      }
      // 一个 text 事件都没收到、但汇总里有文字：按最终文本补上，照样走打字机
      if (!stream.chars.length && reply.text) {
        stream.chars = Array.from(reply.text)
        this.setData({ [`messages[${index}].typing`]: true })
      }
    }
    this.pumpTyping()
  },

  // 收尾：隐藏进度条、结束打字机、放行发送。
  // 流都结束了就没什么可等的了，补间没爬完也直接落到 100（服务端漏推 100 时也靠这一手兜底）。
  settleStream(index) {
    this._stream = null
    if (this._progressTimer) {
      clearTimeout(this._progressTimer)
      this._progressTimer = null
    }
    const message = this.data.messages[index]
    // 一句话、一张图都没有（服务端只推了进度就结束）：留个空气泡纯属让人以为坏了
    if (message && !message.content && !message.preText && !(message.images || []).length) {
      this.removeMessageById(message.id)
      this.setData({ sending: false })
      toast.show({ title: '本次没有生成内容，请重试', icon: 'none' })
      return
    }
    this.setData({
      [`messages[${index}].typing`]: false,
      [`messages[${index}].streaming`]: false,
      [`messages[${index}].progress`]: 100,
      sending: false
    })
    this.stickToBottom({ force: true, animate: true })
  },

  // 停止生成：中断请求 + 结束打字机（已打出的内容保留）。silent=true 用于切会话/卸载时清理
  stopGenerate(silent) {
    if (this._chatReq && this._chatReq.abort) {
      this._chatReq.abort()
      this._chatReq = null
    }
    if (this._typeTimer) {
      clearTimeout(this._typeTimer) // 打字机现在是递归 setTimeout（见 startTyping / pumpTyping）
      this._typeTimer = null
    }
    if (this._progressTimer) {
      clearTimeout(this._progressTimer) // 进度补间同理（见 pumpProgress）
      this._progressTimer = null
    }
    this._stream = null // 之后 abort 的 reject 与迟到的 SSE 事件都会认出「这条流已经不归我管」
    if (!silent) {
      const messages = this.data.messages
        // 还什么都没渲染出来的气泡直接去掉：三点动画的占位气泡，以及只收到进度、
        // 连预描述都还没来的流式气泡（留着就是一条空白气泡）
        .filter(
          item =>
            !item.loading &&
            !(item.streaming && !item.content && !item.preText && !(item.images || []).length)
        )
        .map(item =>
          item.typing || item.streaming
            ? Object.assign({}, item, { typing: false, streaming: false })
            : item
        )
      this.setData({ messages, sending: false })
    }
  },

  onStopTap() {
    this.stopGenerate(false)
  },

  // 从后端取权威余额（扣费在服务端发生，端上只能重取）。静默失败：读不到就保持当前值。
  async refreshTokenBalance() {
    const balance = await aiToken.refreshBalance()
    if (balance !== this.data.tokenBalance) {
      this.setData({ tokenBalance: balance })
    }
  },

  // 星币权限控制（文档 §5.5）：发起对话前的**服务端**校验
  //（2026-08-12 GET /Client/Order/chkAiDialogue，见 utils/ai-token.canDialogue）。
  //
  // 这是**唯一**的闸。此前那道 `guardToken()`（端上按余额数字比大小 + LIMIT_ENABLED=false）
  // 已随 aiToken.hasBalance 一并删除：它既不知道一轮对话扣多少星币，开关又一直关着，
  // 余额为 0 也照发 —— 留着只会和服务端口径打架。
  //
  // 校验接口本身失败一律放行（见 aiToken.canDialogue），所以这里只处理「明确不允许」。
  // 顺带刷一次余额：会话列表页那颗胶囊的数字要与「不够了」这个结论对得上。
  async guardAiDialogue() {
    const verdict = await aiToken.canDialogue()
    if (verdict.allowed) {
      return true
    }
    this.refreshTokenBalance()
    this.showTokenShortModal(verdict)
    return false
  },

  // 星币不足的统一弹窗：只有「个人中心-星币管理」一条出路，直接把人送过去，
  // 别让用户自己在页面里找（原文案只说「请前往」，用户还得退三层）。
  //
  // 2026-08-12 需求 1：由 wx.showModal 改成页面自绘（chat.wxml 的 .confirm-mask/.confirm-dialog，
  // 与删除确认框、「我的相册」删除弹窗同一套版式）—— 原生弹框的圆角/字号/按钮排布与全站对不上。
  //
  // 文案来源（2026-08-12 真机）：后端原话是
  //   「token余额不足，需要最低余额：30.0 token」
  // ——「token」是内部叫法（对外一律「星币」）、「30.0」是浮点、整句还带着接口味，
  // 直接甩给用户不合适。所以：**数字用后端的，话是我们自己说的**。
  // 抠不到数字时才退回后端原话（把 token 换成星币），至少还能说清原因——
  // 403 也可能是余额之外的别的理由，那时硬套「星币不足」反而是错的。
  showTokenShortModal(verdict) {
    const required = (verdict && verdict.required) || 0
    const fallback = String((verdict && verdict.message) || '').replace(/token/gi, '星币')
    const desc = required
      ? `发起一次 AI 对话至少需要 ${formatTokenAmount(required)} 星币，当前余额不足。购买后即可继续和星宝聊天。`
      : fallback || '当前星币余额不足，无法发起 AI 对话。购买后即可继续和星宝聊天。'
    this.setData({ tokenDialog: { show: true, desc } })
  },

  closeTokenDialog() {
    if (this.data.tokenDialog.show) {
      this.setData({ 'tokenDialog.show': false })
    }
  },

  // 「去购买」：先收弹窗再跳，否则从星币管理页返回时它还盖在聊天上
  goBuyTokens() {
    this.setData({ 'tokenDialog.show': false })
    wx.navigateTo({ url: '/subpackages/token/index/index' })
  },

  // 一次 AI 调用完成后对齐余额。
  // ⚠️ **端上不扣数**：swagger 里没有「消费 Token」的 Client 端点，扣费在服务端发生
  // （消费记录见 getUserAccountTrade inOutType=2）。端上自减就是双重记账。
  spendToken() {
    this.refreshTokenBalance()
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
      this.data.showStylePicker
    ) {
      this.setData({
        showTools: false,
        showOrientationPicker: false,
        showStylePicker: false
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

  // 本轮回复图的占位比例。图生图/融合图由 _dispatchChat 存下用户原图的比例（后端等比放大、
  // 不改宽高比，所以出图比例跟原图走）；文生图没有原图，回落到当前方向那一档。
  // 一次只可能有一轮在途（sending 期间不许再发），所以存在页面上不会串。
  replyImagePad() {
    return this._replyPad > 0 ? clampPad(this._replyPad) : this.orientationPad()
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
      toast.show({ title: `当前AI只允许上传${MAX_IMAGES}张图`, icon: 'none' })
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
      toast.show({ title: `当前AI只允许上传${MAX_IMAGES}张图`, icon: 'none' })
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
      // 排查「聊天里的图不是我们 OSS 的地址」先看这条：打出的就是 setFileUpload 原样回的地址，
      // 它会原封不动进 pendingImages[].url → image_urls（见 _dispatchChat 里的 image_urls 日志）。
      console.log('[AI] 待发图上传完成 url=', url, ' 接口原始返回=', uploaded)
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
      toast.warn({ title: '当前手机不支持录音', icon: 'none' })
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

  // ==================== 消息长按 / 图片操作 ====================

  // 长按气泡的**空白处**（内边距、边缘）→ 删除确认框。
  //
  // 2026-08-10 需求 2 重做：原先长按整个气泡弹 wx.showActionSheet，而气泡里的正文又开着
  // user-select —— 同一次长按同时触发「系统选字菜单」和「原生操作面板」，两种交互叠在一起。
  // 现在按**区域**分工，互不重叠：
  //   · 正文 <text> 自己 catchlongpress 吃掉长按 → 只走系统选字/复制（wxml 里那两处 catchlongpress="noop"）；
  //   · 气泡空白处冒泡到这里 → 弹本页自绘的删除确认框（版式与「我的相册」删除弹窗一致）。
  // 图片的下载/投屏/删除不再靠长按，改成常驻在图下方的操作条（需求 7，见 onImageActionTap）。
  onBubbleLongPress(event) {
    const id = event.currentTarget.dataset.id
    const message = this.data.messages.find(item => item.id === id)
    // 生成中的气泡不给删：请求还在途，删了本地这条也停不下服务端那边（要停用「停止生成」）
    if (!message || message.loading || message.typing || message.streaming) {
      return
    }
    this.openDeleteDialog(id, -1, '删除消息', (message.images && message.images.length)
      ? '删除后这条消息和其中的图片都会从对话中移除，且无法恢复'
      : '删除后这条消息会从对话中移除，且无法恢复')
  },

  // imageIndex >= 0 = 只删气泡里的那一张图；-1 = 删整条消息
  openDeleteDialog(messageId, imageIndex, title, desc) {
    this.setData({
      showOrientationPicker: false,
      showStylePicker: false,
      deleteDialog: { show: true, messageId, imageIndex, title, desc }
    })
  },

  closeDeleteDialog() {
    if (this.data.deleteDialog.show) {
      this.setData({ deleteDialog: { show: false, messageId: 0, imageIndex: -1, title: '', desc: '' } })
    }
  },

  // 确认删除。删除是一次真实往返（历史消息要逐个 message_id 打接口），
  // 期间加 loading 遮罩挡住重复点击，与会话列表页删除同款。
  async confirmDeleteMessage() {
    const { messageId, imageIndex } = this.data.deleteDialog
    const message = this.data.messages.find(item => item.id === messageId)
    this.closeDeleteDialog()
    if (!message) {
      return
    }
    wx.showLoading({ title: '删除中', mask: true })
    try {
      if (imageIndex >= 0) {
        await this.deleteBubbleImage(message, imageIndex)
      } else {
        await this.deleteMessage(message)
      }
    } finally {
      wx.hideLoading()
    }
  },

  // 图下方常驻操作条（需求 7）。AI 回复里的每张图、用户自己发的图气泡共用这一个入口。
  // 删除仍要过一次确认框：按钮从「长按才出现」变成常驻后，误触一下就少一张图，代价太大。
  onImageActionTap(event) {
    const { action, url } = event.currentTarget.dataset
    const id = Number(event.currentTarget.dataset.id)
    const index = Number(event.currentTarget.dataset.index)
    const message = this.data.messages.find(item => item.id === id)
    if (!message || !message.images[index]) {
      return
    }
    if (action === 'download') {
      this.downloadImage(url)
    } else if (action === 'project') {
      this.projectImage(url)
    } else if (action === 'delete') {
      this.openDeleteDialog(id, index, '删除图片', '删除后这张图片会从对话中移除，且无法恢复')
    }
  },

  // 删整条消息。图文合并进一个气泡后一条消息可能对应**多个** message_id
  //（文字行 + 每张图各一行），逐个删掉，漏一个就会重进会话时诡异地只剩半条。
  async deleteMessage(message) {
    // 历史消息带服务端 id 走接口删除；本轮新产生的消息接口未回 id，仅本地移除
    //（重进会话会重新出现，待后端在 /chat 响应中带回 message_id 后可彻底删除）
    // ⚠️ **去重**（2026-08-28）：用户图片消息的 id 在 message 与 images[0] 上各记了一份
    // （见 buildHistoryMessages 的说明），不去重就会对同一个 message_id 打两次 DELETE，
    // 第二次多半回「消息不存在」，把一次成功的删除报成失败。
    // Set 保持插入顺序，文字行仍排在图片行前面。
    const serverIds = Array.from(
      new Set(
        [message.serverId]
          .concat((message.images || []).map(img => img.serverId))
          .filter(Boolean)
      )
    )
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
    this.setData({ messages: this.data.messages.filter(item => item.id !== id) })
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

    // 未连接：弹已绑定设备列表。
    // ⚠️ 不预置选中项（2026-08-13 需求 2）：此前进来就把当前设备选上，用户以为是自己选的，
    // 实际是端上替他选的——投屏是往设备写图，选错了就得再投一次。改为一律从「未选中」开始，
    // 选完还要再按一次「连接并投屏」才真的动设备。
    this._pendingProjectImage = url
    this.setData({
      devicePicker: {
        show: true,
        loading: true,
        devices: []
      }
    })
    try {
      const devices = await api.getDevices()
      if (!devices.length) {
        this.setData({ 'devicePicker.show': false })
        toast.show({ title: '暂无已绑定电子纸设备，请先绑定电子纸设备', icon: 'none' })
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
          devices: pickerDevices
        }
      })
    } catch (error) {
      this.setData({ 'devicePicker.show': false })
    }
  },

  // 弹层里按下「连接并投屏」才真正开投（选中只是选中，见 device-picker-sheet）
  onDevicePickerConfirm(event) {
    const device = event.detail && event.detail.device
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
    // 主动点「投屏 / 连接并投屏」：这台设备此刻已连接（电量读得到）且 ≤10% 就先提醒一次（2026-08-21）。
    // 未连接那一支读不到电量、真正的连接又发生在预览/结果页（自动连接不弹），所以这里天然只对已连接的情形生效。
    await lowBattery.warnIfLow(activeDevice.findConnectedDeviceId(device), { device })
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
  //   animate —— 是否带滚动动画。**不传时按 force 取默认值**：
  //             · 跟随类（非 force：打字出字、占位盒换真图、图片 bindload 校正高度）→ 默认**开**动画，
  //               让视图平滑滑下去。2026-08-07 前这里是瞬移，一秒十几下，就是用户说的「一闪、卡顿」；
  //             · force 且没显式指定 → 默认**关**动画，留给首屏定位（openSession）：那一下要是带动画，
  //               用户会眼睁睁看着列表从最老一条滚到最新。发消息那几处都显式传了 animate: true。
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
    const animate = opts.animate === undefined ? !opts.force : !!opts.animate
    const next = this.data.scrollTop === SCROLL_BOTTOM_A ? SCROLL_BOTTOM_B : SCROLL_BOTTOM_A
    this.setData({ scrollAnimate: animate, scrollTop: next }, opts.done)
  },

  // 手指在聊天区上**滑动**（不是点一下）时才算用户在自己滚，见 onChatScroll。
  // 用 touchmove 而不是 touchstart：点一下（关工具栏/收键盘）不该被当成滚动，
  // 否则正好撞上我们的贴底动画中途，就会把「用户上翻」误判出来。
  onChatTouchMove() {
    this._touching = true
  },

  onChatTouchEnd() {
    if (!this._touching) {
      return // 只是点了一下，没滑
    }
    this._touching = false
    this._touchEndAt = Date.now() // 松手后还有一段惯性滑行，那段也算用户滑的
  },

  // 记录「用户是不是自己翻上去了」。量不到聊天区高度时保持自动贴底（＝改造前的行为），
  // 宁可多贴一次底，也别出现「AI 在回复、视图却纹丝不动」。
  //
  // ⚠️ 只认用户手势滑出来的滚动。贴底改成带动画之后（2026-08-07），我们自己发起的滚动
  // 也会一路推 scroll 事件，而动画**中途**的距底距离可能远大于 SCROLL_STICK_PX——照单全收
  // 就会在自己滑向底部的路上把自己判成「用户上翻」，接着整条回复都不再跟着滚了。
  onChatScroll(event) {
    if (!this._chatViewH) {
      return
    }
    if (!this._touching && Date.now() - (this._touchEndAt || 0) > SCROLL_FLING_MS) {
      return // 不是用户滑的（我们自己的贴底动画）：不改贴底状态
    }
    const detail = event.detail || {}
    const distance = (detail.scrollHeight || 0) - (detail.scrollTop || 0) - this._chatViewH
    this._stick = distance <= SCROLL_STICK_PX
  }
}))
