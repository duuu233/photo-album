// AI 对话（星宝）主界面 —— 需求见 assets/ai/支付&ai&官方图库.docx「一、AI对话模块」，
// 接口见 assets/ai/BoltStar-API-Doc-v2-1.0.4.md（当前对接版本；小程序只能走非流式 + 客户端打字机）。
// UI 未出图，图标一律用色块占位（icon-block），后续换图只动 wxml/wxss。
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
const aiApi = require('../../../utils/ai-api')
const aiI18n = require('../../../utils/ai-i18n')
const api = require('../../../utils/api')
const media = require('../../../utils/media')
const system = require('../../../utils/system')
const toast = require('../../../utils/toast')
const activeDevice = require('../../../utils/active-device')
const language = require('../../../utils/language')

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

const TYPE_INTERVAL_MS = 30 // 打字机 30ms/字（文档 §6.4）

// 图文多模态一次最多带 4 张图（文档 v1.0.3 §二 image_urls 上限；超出服务端回 20012）
const MAX_IMAGES = 4

// 会话标题截断长度：v1.0.4 §二「首条用户消息前 20 字自动填充，默认'新对话'」。
// 前端本地同步标题时按同一规则截，避免列表页重拉后标题突然变短。
const SESSION_TITLE_MAX = 20

// 一键生图风格（需求文案：漫画/风景/肖像/动漫；API 值：cartoon/landscape/portrait/anime）
const STYLE_OPTIONS = [
  { key: 'cartoon', label: '漫画' },
  { key: 'landscape', label: '风景' },
  { key: 'portrait', label: '肖像' },
  { key: 'anime', label: '动漫' }
]

// 图片比例（需求：竖向/横向/方形；API img_orientation 必传）
const ORIENTATION_OPTIONS = [
  { key: 'vertical', label: '竖向', size: '1104×1472' },
  { key: 'horizontal', label: '横向', size: '1472×1104' },
  { key: 'square', label: '方形', size: '1328×1328' }
]

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

Page({
  data: {
    statusBarHeight: 20,
    safeBottom: 0,

    sessionId: '',
    sessionTitle: '新对话',
    tokenBalance: TOKEN_DEFAULT,

    // 消息模型：{ id, serverId, role: 'user'|'assistant', kind: 'text'|'image',
    //            content(文本), url(图片), loading(三点动画), typing(打字机进行中) }
    messages: [],
    historyLoading: false,

    inputValue: '',
    // 待发送图片（v1.0.3 图文多模态）：{ id, url, tempFilePath, uploading }，缩略图停在输入框内，
    // 每张可删、最多 MAX_IMAGES 张；发送时随文字一起以 image_urls 提交（纯图片不可发）。
    pendingImages: [],
    maxImages: MAX_IMAGES,
    sending: false, // 等待 AI 回复中（含打字机渲染期），期间禁止再次发送
    banned: false, // 22002/22003 封禁后禁用输入（文档 §八）

    voiceMode: false, // 键盘/按住说话切换（🎤 专属语音按钮）
    recording: false, // 录音中：显示仿微信的浮层
    voiceCancel: false, // 已上滑到取消区：浮层转红、松手丢弃
    voiceText: '', // 实时识别到的文字（WechatSI onRecognize 的中间结果），浮层里滚动显示
    speechReady: false, // 同声传译插件可用（后台已开通）。false 时只能录音、转不了文字

    showTools: false, // + 工具面板（相册/拍照/一键生图/比例）
    showStylePicker: false, // 一键生图风格弹层
    styleOptions: STYLE_OPTIONS,
    orientationOptions: ORIENTATION_OPTIONS,
    orientation: 'vertical', // 默认竖向（电子相框主流为竖屏）

    // 投屏设备选择弹窗（未连接时弹出已绑定设备列表，需求「投屏流程」）
    devicePicker: { show: false, loading: false, devices: [] },

    scrollInto: '' // scroll-view 锚点
  },

  onLoad(options) {
    this.setData(Object.assign({ tokenBalance: readTokenBalance() }, system.getLayoutMetrics()))
    this._uid = 0 // 本地消息自增 id
    this._pid = 0 // 待发送图片自增 id
    this._typeTimer = null
    this._chatReq = null // 进行中的 chat/enhance 请求，供「停止生成」abort
    this._createReq = null // 在途的建会话请求，连点发送时去重（见 createSession）
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

    // 权限规则（API 文档 §5.5）：无绑定设备时拦截 AI 入口，提示先绑定
    this.checkDeviceBound()
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

  onUnload() {
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
    this.setData({
      messages: [],
      sessionTitle: '新对话',
      sessionId: '',
      banned: false,
      sending: false,
      pendingImages: [],
      inputValue: ''
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
    // sending: false 同 resetToNewSession —— 刚掐掉的在途回复不能把这一页锁在「正在回复中」
    this.setData({ messages: [], banned: false, sending: false, pendingImages: [], inputValue: '' })
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
      historyLoading: true
    })
    try {
      const history = await aiApi.getHistory(sessionId, 1, 100)
      if (history.expired) {
        toast.show({ title: aiI18n.t('info.10001'), icon: 'none' })
      }
      // 接口时间倒序，倒回正序渲染；assistant 且 content 以 http 开头 = 图片（文档 §6.5）
      const messages = history.list
        .slice()
        .reverse()
        .map(item => ({
          id: ++this._uid,
          serverId: item.id,
          role: item.role,
          kind: /^https?:\/\//.test(item.content) ? 'image' : 'text',
          content: item.content,
          url: item.content,
          loading: false,
          typing: false
        }))
      this.setData({ messages, historyLoading: false })
      this.scrollToBottom()
    } catch (error) {
      this.setData({ historyLoading: false })
      aiI18n.handleAiError(error, { onRetry: () => this.openSession(sessionId, title) })
    }
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
    if (this.data.sending) {
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

  async onSendTap() {
    if (this.data.sending || this.data.banned) {
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
    // 还有图片在上传：等 OSS URL 就绪再发，否则 image_urls 会缺图
    if (images.some(img => img.uploading)) {
      toast.show({ title: '图片上传中，请稍候…', icon: 'none' })
      return
    }
    const imageUrls = images.map(img => img.url).filter(Boolean)
    // 先把会话建出来，**再清输入框**。顺序不能反：建会话可能失败（网络异常 / 20013 会话已达上限），
    // 先清的话用户打的字和选的图就白没了——而「首次发送才建会话」之后，每轮新对话的第一条都会走到这。
    if (!this.data.sessionId) {
      await this.createSession()
      if (!this.data.sessionId) {
        return // 错误提示已由 createSession 弹出；草稿原样留着，用户可直接重发
      }
    }
    this.setData({ inputValue: '', pendingImages: [] })
    this.sendChat(text, undefined, imageUrls)
  },

  // 发送对话 / 一键生图 / 图文多模态。styleKey 仅一键生图传（cartoon/landscape/portrait/anime）；
  // imageUrls 为随文字一起发送的图片 URL（≤4，v1.0.3）。先把用户消息（图片气泡+文字气泡）上屏，
  // 再交给 _dispatchChat 发请求——这样 30xxx 重试只重发请求、不重复堆用户气泡。
  async sendChat(message, styleKey, imageUrls) {
    if (this.data.sending || this.data.banned) {
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

    const urls = Array.isArray(imageUrls) ? imageUrls.filter(Boolean) : []
    // 用户消息：先按张追加图片气泡（用户上传的原图 URL），再追加文字气泡
    const userMsgs = urls.map(url => ({ id: ++this._uid, role: 'user', kind: 'image', url, content: url }))
    userMsgs.push({ id: ++this._uid, role: 'user', kind: 'text', content: message })
    this.setData({
      messages: this.data.messages.concat(userMsgs),
      // 首条消息后标题自动变为首条内容（与后端 session.title 行为一致，本地同步免重拉）。
      // v1.0.4 §二明确后端只取**前 20 字**，这里同样截断，免得列表页重拉后标题突然变短对不上。
      sessionTitle: this.data.sessionTitle === '新对话'
        ? message.slice(0, SESSION_TITLE_MAX)
        : this.data.sessionTitle
    })
    this.scrollToBottom()
    this._dispatchChat(message, styleKey, urls)
  },

  // 发一次 /chat 请求并渲染回复（可被「重试」重复调用，不再追加用户气泡）
  async _dispatchChat(message, styleKey, urls) {
    const holder = { id: ++this._uid, role: 'assistant', kind: 'text', content: '', loading: true }
    this.setData({ messages: this.data.messages.concat([holder]), sending: true })
    this.scrollToBottom()

    try {
      this._chatReq = aiApi.chat({
        sessionId: this.data.sessionId,
        message,
        imgOrientation: this.data.orientation,
        imgStyle: styleKey,
        imageUrls: urls
      })
      const reply = await this._chatReq
      this._chatReq = null
      this.spendToken()
      this.renderReply(holder.id, reply.text, reply.images)
    } catch (error) {
      this._chatReq = null
      this.removeMessageById(holder.id)
      this.setData({ sending: false })
      if (error && error.code === 'ABORTED') {
        return // 用户主动停止，静默
      }
      aiI18n.handleAiError(error, {
        onRetry: () => this._dispatchChat(message, styleKey, urls),
        onBanned: () => this.setData({ banned: true })
      })
    }
  },

  // 回复渲染：文字走打字机（30ms/字），图片按气泡追加（文档 §6.3/6.4）
  renderReply(holderId, text, images) {
    const imageMsgs = (images || []).map(url => ({
      id: ++this._uid,
      role: 'assistant',
      kind: 'image',
      url,
      content: url
    }))

    if (!text) {
      // 只有图没有文字：占位气泡直接替换成图片
      const messages = this.data.messages.filter(item => item.id !== holderId).concat(imageMsgs)
      this.setData({ messages, sending: false })
      this.scrollToBottom()
      return
    }

    const startIndex = this.data.messages.findIndex(item => item.id === holderId)
    if (startIndex < 0) {
      this.setData({ sending: false })
      return
    }
    this.setData({
      [`messages[${startIndex}].loading`]: false,
      [`messages[${startIndex}].typing`]: true
    })

    const chars = text.split('')
    let pos = 0
    this._typeTimer = setInterval(() => {
      // 打字期间用户可能删除了前面的消息导致数组下标变化，每帧按 id 重新定位
      const index = this.data.messages.findIndex(item => item.id === holderId)
      if (index < 0) {
        clearInterval(this._typeTimer)
        this._typeTimer = null
        this.setData({ sending: false })
        return
      }
      if (pos >= chars.length) {
        clearInterval(this._typeTimer)
        this._typeTimer = null
        let finalMessages = this.data.messages.map(item =>
          item.id === holderId ? Object.assign({}, item, { typing: false }) : item
        )
        if (imageMsgs.length) {
          finalMessages = finalMessages.concat(imageMsgs)
        }
        this.setData({ messages: finalMessages, sending: false })
        this.scrollToBottom()
        return
      }
      // 每帧追 3 字减少 setData 频率（视觉上仍是连续打字）
      const next = chars.slice(pos, pos + 3).join('')
      pos += 3
      this.setData({
        [`messages[${index}].content`]: this.data.messages[index].content + next
      })
      if (pos % 30 < 3) {
        this.scrollToBottom()
      }
    }, TYPE_INTERVAL_MS)
  },

  // 停止生成：中断请求 + 结束打字机（已打出的内容保留）。silent=true 用于切会话/卸载时清理
  stopGenerate(silent) {
    if (this._chatReq && this._chatReq.abort) {
      this._chatReq.abort()
      this._chatReq = null
    }
    if (this._typeTimer) {
      clearInterval(this._typeTimer)
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
    this.setData({ showTools: !this.data.showTools, showStylePicker: false })
  },

  // 🎤 / ⌨ 切换。切走时若还在录音，按取消处理——不然录音会挂在后台，界面却已经换成输入框了。
  toggleVoice() {
    if (this.data.recording) {
      this.endVoice(true)
    }
    this.clearHoldTimer()
    this.setData({ voiceMode: !this.data.voiceMode, showTools: false })
  },

  onOrientationTap(event) {
    this.setData({ orientation: event.currentTarget.dataset.key })
  },

  openStylePicker() {
    this.setData({ showStylePicker: true })
  },

  closeStylePicker() {
    this.setData({ showStylePicker: false })
  },

  // 一键生图：按语种自动拼 message（如「生成图片-卡通」），img_style 触发生图（文档 §5.3.2）
  onStyleTap(event) {
    const key = event.currentTarget.dataset.key
    this.setData({ showStylePicker: false, showTools: false })
    this.sendChat(aiI18n.genMessage(key), key)
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
    this.setData({ showTools: false })
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
    // 先各插一张 uploading 缩略图占位，再逐张上传回填 URL（单张失败只移除该张）
    const items = files.map(file => ({ id: ++this._pid, tempFilePath: file.tempFilePath, url: '', uploading: true }))
    this.setData({ pendingImages: this.data.pendingImages.concat(items) })
    items.forEach(item => this.uploadPending(item))
  },

  // 单张上传到 OSS，成功回填 url、清 uploading；失败/无地址移除该缩略图
  async uploadPending(item) {
    try {
      const uploaded = await api.setFileUpload({ filePaths: [item.tempFilePath] })
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
    // 中间结果：边说边把文字滚在浮层里，主流 AI APP 都这么做，用户能确认「听到了」
    this._speech.onRecognize = res => {
      if (!this.isTopPage()) {
        return
      }
      this.setData({ voiceText: (res && res.result) || '' })
    }
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
    if (this.data.recording || this.data.sending || this.data.banned) {
      return false
    }
    if (!this._speech && !this._recorder) {
      toast.warn({ title: '当前设备不支持录音', icon: 'none' })
      return false
    }
    this._voiceCancelled = false
    this.setData({ recording: true, voiceCancel: false, voiceText: '' })
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
      this.setData({ recording: false, voiceCancel: false, voiceText: '' })
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
      this.setData({ recording: false, voiceCancel: false, voiceText: '' })
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
    if (this.data.sending || this.data.banned) {
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
    this.sendChat(text, undefined, imageUrls)
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

  onBubbleLongPress(event) {
    const id = event.currentTarget.dataset.id
    const message = this.data.messages.find(item => item.id === id)
    if (!message || message.loading || message.typing) {
      return
    }

    // 需求：文本消息→删除；图片消息→下载/投屏/删除
    const isImage = message.kind === 'image'
    const items = isImage ? ['下载', '投屏', '删除'] : ['删除']
    wx.showActionSheet({
      itemList: items,
      success: res => {
        const action = items[res.tapIndex]
        if (action === '删除') {
          this.deleteMessage(message)
        } else if (action === '下载') {
          this.downloadImage(message.url)
        } else if (action === '投屏') {
          this.projectImage(message.url)
        }
      }
    })
  },

  async deleteMessage(message) {
    try {
      // 历史消息带服务端 id 走接口删除；本轮新产生的消息接口未回 id，仅本地移除
      //（重进会话会重新出现，待后端在 /chat 响应中带回 message_id 后可彻底删除）
      if (message.serverId) {
        await aiApi.deleteMessage(this.data.sessionId, message.serverId)
      }
      this.removeMessageById(message.id)
      toast.show({ title: '已删除', icon: 'none' })
    } catch (error) {
      aiI18n.handleAiError(error)
    }
  },

  removeMessageById(id) {
    this.setData({ messages: this.data.messages.filter(item => item.id !== id) })
  },

  onImageTap(event) {
    const url = event.currentTarget.dataset.url
    wx.previewImage({ urls: [url], current: url })
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
    this.setData({ devicePicker: { show: true, loading: true, devices: [] } })
    try {
      const devices = await api.getDevices()
      if (!devices.length) {
        this.setData({ 'devicePicker.show': false })
        toast.show({ title: '暂无已绑定设备，请先绑定设备', icon: 'none' })
        return
      }
      this.setData({ devicePicker: { show: true, loading: false, devices } })
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

  scrollToBottom() {
    // 先清再设，保证连续两次滚到同一锚点也能触发
    this.setData({ scrollInto: '' }, () => {
      this.setData({ scrollInto: 'bottom-anchor' })
    })
  }
})
