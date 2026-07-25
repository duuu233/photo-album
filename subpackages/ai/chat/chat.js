// AI 对话（星宝）主界面 —— 需求见 assets/ai/支付&ai&官方图库.docx「一、AI对话模块」，
// 接口见 assets/ai/BoltStar-API-Doc-v2-1.0.4.md（当前对接版本；小程序只能走非流式 + 客户端打字机）。
// UI 未出图，图标一律用色块占位（icon-block），后续换图只动 wxml/wxss。
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

function readTokenBalance() {
  const value = wx.getStorageSync(TOKEN_STORAGE_KEY)
  return typeof value === 'number' ? value : TOKEN_DEFAULT
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

    voiceMode: false, // 键盘/按住说话切换
    recording: false,

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
    this._pendingProjectImage = '' // 设备弹窗确认前暂存的待投屏图片 URL
    this.initRecorder()

    if (options && options.sessionId) {
      this.openSession(options.sessionId, options.title ? decodeURIComponent(options.title) : '')
    } else {
      this.createSession()
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

  // 会话列表页选中某条会话/点新建后，经 Storage 传回（避免跨页 eventChannel 的兼容问题）
  onShow() {
    const pending = wx.getStorageSync('aiOpenSession')
    if (!pending) {
      return
    }
    wx.removeStorageSync('aiOpenSession')
    this.stopGenerate(true)
    if (pending.newSession) {
      this.setData({ messages: [], sessionTitle: '新对话', sessionId: '', banned: false, pendingImages: [], inputValue: '' })
      this.createSession()
    } else if (pending.sessionId && pending.sessionId !== this.data.sessionId) {
      this.setData({ messages: [], banned: false, pendingImages: [], inputValue: '' })
      this.openSession(pending.sessionId, pending.title)
    }
  },

  onUnload() {
    this.stopGenerate(true)
  },

  // ==================== 会话 ====================

  async createSession() {
    try {
      const session = await aiApi.newSession()
      this.setData({ sessionId: session.session_id, sessionTitle: session.title || '新对话' })
    } catch (error) {
      // 建会话失败不阻塞界面（招呼语照常显示），发送时会再兜底重建
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
    wx.navigateTo({ url: `/subpackages/ai/sessions/sessions?current=${this.data.sessionId}` })
  },

  startNewSession() {
    if (this.data.sending) {
      return
    }
    this.stopGenerate(true)
    this.setData({ messages: [], sessionTitle: '新对话', sessionId: '', banned: false, pendingImages: [], inputValue: '' })
    this.createSession()
  },

  // ==================== 发送 ====================

  onInput(event) {
    this.setData({ inputValue: event.detail.value })
  },

  onSendTap() {
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

  toggleVoice() {
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

  // ==================== 语音（按住说话） ====================

  initRecorder() {
    this._recorder = wx.getRecorderManager ? wx.getRecorderManager() : null
    if (!this._recorder) {
      return
    }
    this._recorder.onStop(() => {
      if (!this.data.recording) {
        return
      }
      this.setData({ recording: false })
      // TODO 接入微信「同声传译」插件(WechatSI)转文字后直接 sendChat（文档 §5.1.2：
      // 按住说话，松手直接发送）。插件需在小程序后台开通，demo 先占位提示。
      toast.show({ title: '录音完成。语音转文字需开通「同声传译」插件（待接入）', icon: 'none' })
    })
    this._recorder.onError(() => {
      this.setData({ recording: false })
      toast.warn({ title: '录音失败，请重试', icon: 'none' })
    })
  },

  onVoiceStart() {
    if (!this._recorder || this.data.sending || this.data.banned) {
      return
    }
    this.setData({ recording: true })
    this._recorder.start({ duration: 60000, format: 'mp3' }) // 最长 60s（文档建议）
  },

  onVoiceEnd() {
    if (this._recorder && this.data.recording) {
      this._recorder.stop()
    }
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

  // 下载：保存到系统相册（拒权时引导去设置开启）
  downloadImage(url) {
    wx.downloadFile({
      url,
      success: res => {
        wx.saveImageToPhotosAlbum({
          filePath: res.tempFilePath,
          success: () => toast.show({ title: '已保存到相册', icon: 'success' }),
          fail: err => {
            if (err && err.errMsg && err.errMsg.indexOf('auth') > -1) {
              wx.showModal({
                title: '需要相册权限',
                content: '请在设置中允许保存图片到相册',
                confirmText: '去设置',
                success: r => r.confirm && wx.openSetting()
              })
            } else {
              toast.warn({ title: '保存失败', icon: 'none' })
            }
          }
        })
      },
      fail: () => toast.warn({ title: '图片下载失败（生成图 24 小时后过期）', icon: 'none' })
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

  startProjection(device, url) {
    wx.showLoading({ title: '准备投屏', mask: true })
    wx.downloadFile({
      url,
      success: res => {
        wx.hideLoading()
        wx.setStorageSync('pendingProjection', {
          device,
          images: [
            {
              tempFilePath: res.tempFilePath,
              name: 'AI 生成图',
              sizeMb: 2.5
            }
          ]
        })
        wx.navigateTo({ url: '/subpackages/projection/preview/preview' })
      },
      fail: () => {
        wx.hideLoading()
        toast.warn({ title: '图片下载失败（生成图 24 小时后过期）', icon: 'none' })
      }
    })
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
