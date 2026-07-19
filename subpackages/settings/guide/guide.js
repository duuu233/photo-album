const api = require('../../../utils/api')
const language = require('../../../utils/language')
const richHtml = require('../../../utils/rich-html')

// 单页条数：后端 pageSize 上限未知（默认才 10），取 50 并配合翻页兜住全量。
const PAGE_SIZE = 50
// 安全上限：后端分页字段异常时不至于把请求打成死循环。
const MAX_PAGES = 20

function faqToGuide(item, index) {
  const content = item.faqContent || ''
  return {
    id: String(item.faqId || item.id || `faq_${index}`),
    faqId: item.faqId,
    title: item.faqTitle || item.title || `问题 ${index + 1}`,
    // 默认全部收起（2026-07-19 产品要求），不再默认展开首项。
    open: false,
    loaded: !!content,
    // 后端富文本可能是 HTML / 转义 HTML / 纯文本，统一归一后交给 rich-text 渲染，
    // 否则 <p> 之类的标签要么被当纯文字显示、要么整段不换行（详见 utils/rich-html.js）。
    content: richHtml.toRichHtml(content),
    lines: content ? content.split(/\r?\n/).filter(Boolean) : []
  }
}

Page({
  data: {
    statusBarHeight: 20,
    safeBottom: 0,
    loading: true,
    // 接口失败时的本地兜底文案，同样默认收起。
    guides: [
      {
        id: 'bind',
        title: '如何绑定设备?',
        open: false,
        lines: [
          '1.确保相册设备已开机，并打开手机蓝牙。',
          '2.进入首页点击绑定设备，或「我的设备」。',
          '3.在设备列表中选择要连接的相册设备。',
          '4.点击「立即绑定」完成连接。',
          '若未搜索到设备，请确认设备在附近并重新搜索。'
        ]
      },
      { id: 'project', title: '如何进行照片投屏?', open: false, lines: ['进入首页，选择拍照或相册，确认照片后发送到已连接设备。'] },
      { id: 'album', title: '如何管理我的相册?', open: false, lines: ['进入我的图库，可查看、删除和重新投屏已上传的照片。'] },
      { id: 'empty', title: '设备照片被清空怎么办?', open: false, lines: ['请在我的图库中重新选择照片投屏，或检查设备存储状态。'] },
      {
        id: 'storage',
        title: '相框空间已满怎么办?',
        open: false,
        lines: [
          '设备空间已满时，新的照片将无法继续投屏。你可以前往「我的相册」删除部分照片，或执行一键清空。清理完成后，再重新选择照片进行投屏即可。'
        ]
      }
    ]
  },

  onLoad() {
    this.setSystemMetrics()
  },

  onShow() {
    // 语种可能在「语种设置」页被改过：回到本页就按新语种重新取数，
    // 否则会一直显示上一个语种的列表。
    // loadedLanguage 由 loadGuides 在成功后写入（失败置空以便下次重试）。
    if (this.loadedLanguage !== language.getSelectedLanguage()) {
      this.loadGuides()
    }
  },

  // 全量读取常见问题（翻完所有分页）：
  // - 按 pageCount / recordCount 一直翻到取完，不是只取第一页；
  // - 不带任何设备/产品过滤参数（Client 侧接口本就没有 productId），取全局问题；
  // - 不做客户端排序：权重 grade 只在后台 DTO 里，顺序以后端返回为准。
  async fetchAllFaq() {
    const collected = []
    const seen = {}
    let pageIndex = 1

    while (pageIndex <= MAX_PAGES) {
      const data = await api.getProductFaqList({
        pageIndex,
        pageSize: PAGE_SIZE
      })
      const list = Array.isArray(data) ? data : (data && data.pageData) || []

      list.forEach((item, index) => {
        const guide = faqToGuide(item, collected.length + index)
        // 翻页之间后端顺序可能有变动，按 id 去重，避免同一条重复出现。
        if (!seen[guide.id]) {
          seen[guide.id] = true
          collected.push(guide)
        }
      })

      // 空页 = 没有更多了。
      if (!list.length) {
        break
      }

      // 停止条件**优先用后端的分页元数据**，不能拿「返回条数 < 请求的 pageSize」当依据：
      // 后端可能无视 pageSize、按自己的默认值（swagger 写的是 10）分页，
      // 那样第一页就 10 < 50 直接停了，只能拿到 10 条 —— 正是「只显示几条」的成因。
      const pageCount = Number(data && data.pageCount) || 0
      const recordCount = Number(data && data.recordCount) || 0
      if (recordCount && collected.length >= recordCount) {
        break
      }
      if (pageCount && pageIndex >= pageCount) {
        break
      }
      // 两个元数据都没有时，才退回按「不满一页即最后一页」判断。
      if (!recordCount && !pageCount && list.length < PAGE_SIZE) {
        break
      }
      pageIndex += 1
    }

    return collected
  },

  async loadGuides() {
    // 注意：this.fetching 是实例上的并发锁，this.data.loading 是渲染用的标记，两回事。
    if (this.fetching) {
      return
    }
    this.fetching = true
    this.setData({ loading: true })

    try {
      // 翻页要花好几个 RTT，期间语种可能又被改过：拉完对一下，
      // 不一致就按最新语种再拉一遍，避免停在中间那个语种上。
      let requested = language.getSelectedLanguage()
      let collected = []
      while (true) {
        collected = await this.fetchAllFaq()
        const current = language.getSelectedLanguage()
        if (current === requested) {
          break
        }
        requested = current
      }
      this.loadedLanguage = requested

      // 成功即以后端为准：哪怕返回空也要清掉上一个语种的残留，
      // 否则切到日文后会继续显示上次拉的中文列表。
      this.setData({ guides: collected, loading: false })
    } catch (error) {
      // 接口失败保留当前文案（首次为本地兜底）；语种标记回退，下次进页面会重试。
      this.loadedLanguage = null
      this.setData({ loading: false })
    } finally {
      this.fetching = false
    }
  },

  setSystemMetrics() {
    try {
      const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
      const safeBottom = Math.max(0, (info.screenHeight || 0) - (info.safeArea ? info.safeArea.bottom : info.windowHeight || 0))
      this.setData({
        statusBarHeight: info.statusBarHeight || 20,
        safeBottom
      })
    } catch (error) {
      this.setData({ statusBarHeight: 20, safeBottom: 0 })
    }
  },

  // 折叠面板：点击的项切换展开/收起，其余保持不变（可多个同时展开）
  async toggleGuide(event) {
    const id = event.currentTarget.dataset.id
    const guide = this.data.guides.find(item => item.id === id)
    const willOpen = guide && !guide.open

    if (willOpen && guide.faqId && !guide.loaded) {
      try {
        const detail = await api.getProductFaqDetail(guide.faqId)
        const content = detail && detail.faqContent ? detail.faqContent : ''
        this.setData({
          guides: this.data.guides.map(item => item.id === id ? Object.assign({}, item, {
            loaded: true,
            content: richHtml.toRichHtml(content),
            lines: content ? content.split(/\r?\n/).filter(Boolean) : item.lines
          }) : item)
        })
      } catch (error) {
        // 详情加载失败不阻断展开。
      }
    }

    this.setData({
      guides: this.data.guides.map(item =>
        Object.assign({}, item, {
          open: item.id === id ? !item.open : item.open
        })
      )
    })
  },

  goBack() {
    wx.navigateBack()
  }
})
