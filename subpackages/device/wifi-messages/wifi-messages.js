const iotApi = require('../../../utils/iot-api')
const iotWs = require('../../../utils/iot-ws')
const toast = require('../../../utils/toast')
const system = require('../../../utils/system')
const fold = require('../../../utils/fold-adapt')
const messages = require('../../../utils/wifi-messages')

// WiFi 版消息中心（2026-10-27，docs/wifi/V1.4对接实现报告反馈.md 第三节、对接文档第八节）。入口：WiFi 设备详情「消息中心」。
//   · 列表：IoT GET /api/notification/list，按时间倒序，每页 20 条；下拉刷新回第一页、触底加载下一页（按 id 去重）；
//   · 「只看未读」开关（unreadOnly=true）；文案按 type 翻译（utils/wifi-messages.js），未知 type 显示通用文案；
//   · 点单条：未读的标记已读（POST /api/notification/read ids=[id]），角标减 1；「全部已读」ids 传空数组；
//     只看未读时点过的那条不立刻移走，下拉刷新后才消失（免得列表跳）；
//   · 实时：订阅该设备，收到 WS notification.new（只推信号）或长连接重连成功后刷新第一页与未读数（合并 500ms）。
const PAGE_SIZE = 20

function plainDeviceNo(value) {
  return String(value || '').replace(/[:\-\s]/g, '').toUpperCase()
}

function errorText(error) {
  if (error && Number(error.code) === 403) {
    return '没有查看该设备消息的权限'
  }
  return String((error && error.message) || '加载失败，请稍后重试').replace(/^接口\(IoT\)-/, '')
}

Page(fold.adapt({
  data: {
    statusBarHeight: 20,
    safeBottom: 0,
    deviceNo: '',
    loading: true,
    loadError: '',
    items: [],
    unreadCount: 0,
    unreadOnly: false,
    hasMore: false,
    loadingMore: false,
    moreError: false
  },

  onLoad(options) {
    const deviceNo = plainDeviceNo(options && options.deviceNo)
    this.setData(Object.assign(system.getLayoutMetrics(), { deviceNo }))
    this.page = 0
    this.offs = [
      iotWs.on('notification.new', event => {
        if (event && plainDeviceNo(event.deviceNo) === deviceNo) {
          this.scheduleRefresh()
        }
      }),
      // 断线期间的推送会丢：重连成功补刷一次
      iotWs.on('state', event => {
        if (event && event.state === 'open' && event.reconnect) {
          this.scheduleRefresh()
        }
      })
    ]
    // 收推送要先订阅；详情页通常已订阅（它在栈下面），没订阅才自己订、退出时退
    if (deviceNo && iotWs.getSubscriptions().indexOf(deviceNo) === -1) {
      iotWs.subscribe(deviceNo)
      this.ownedSubscription = deviceNo
    }
    this.loadFirst()
  },

  onUnload() {
    this.unloaded = true
    clearTimeout(this.refreshTimer)
    ;(this.offs || []).forEach(off => off())
    if (this.ownedSubscription) {
      iotWs.unsubscribe(this.ownedSubscription)
    }
  },

  onPullDownRefresh() {
    this.loadFirst().then(() => wx.stopPullDownRefresh())
  },

  onReachBottom() {
    this.loadMore()
  },

  scheduleRefresh() {
    clearTimeout(this.refreshTimer)
    this.refreshTimer = setTimeout(() => {
      if (!this.unloaded) {
        console.log('[WiFi消息] 收到新消息推送，刷新列表')
        this.loadFirst()
      }
    }, 500)
  },

  // 第一页（进页、下拉、切「只看未读」、推送）：整页替换，带序号防旧请求覆盖
  async loadFirst() {
    const seq = (this.seq || 0) + 1
    this.seq = seq
    if (!this.data.items.length) {
      this.setData({ loading: true, loadError: '' })
    }
    let res
    try {
      res = await iotApi.getNotifications({ deviceNo: this.data.deviceNo, page: 1, size: PAGE_SIZE, unreadOnly: this.data.unreadOnly }, { showError: false })
    } catch (error) {
      if (this.unloaded || seq !== this.seq) {
        return
      }
      console.warn('[WiFi消息] 列表加载失败', error && error.code, error && error.message)
      if (this.data.items.length) {
        toast.show({ title: errorText(error), icon: 'none' })
        this.setData({ loading: false })
      } else {
        this.setData({ loading: false, loadError: errorText(error) })
      }
      return
    }
    if (this.unloaded || seq !== this.seq) {
      return
    }
    const list = (res && res.list) || []
    const items = messages.mergePage([], list)
    this.page = 1
    this.setData({
      loading: false,
      loadError: '',
      items,
      unreadCount: Number(res && res.unreadCount) || 0,
      hasMore: list.length >= PAGE_SIZE && items.length < (Number(res && res.total) || 0),
      moreError: false
    })
  },

  async loadMore() {
    if (this.data.loading || this.data.loadingMore || !this.data.hasMore) {
      return
    }
    const seq = this.seq
    this.setData({ loadingMore: true, moreError: false })
    let res
    try {
      res = await iotApi.getNotifications({ deviceNo: this.data.deviceNo, page: this.page + 1, size: PAGE_SIZE, unreadOnly: this.data.unreadOnly }, { showError: false })
    } catch (error) {
      if (!this.unloaded && seq === this.seq) {
        this.setData({ loadingMore: false, moreError: true })
      }
      return
    }
    if (this.unloaded || seq !== this.seq) {
      return
    }
    const list = (res && res.list) || []
    const items = messages.mergePage(this.data.items, list)
    this.page += 1
    this.setData({
      loadingMore: false,
      items,
      unreadCount: Number(res && res.unreadCount) || this.data.unreadCount,
      hasMore: list.length >= PAGE_SIZE && items.length < (Number(res && res.total) || 0)
    })
  },

  retryLoad() {
    this.loadFirst()
  },

  toggleUnreadOnly(e) {
    this.setData({ unreadOnly: !!e.detail.value, items: [] })
    this.loadFirst()
  },

  // 点单条：未读的标记已读
  async tapItem(e) {
    const index = Number(e.currentTarget.dataset.index)
    const item = this.data.items[index]
    if (!item || item.read) {
      return
    }
    this.setData({ [`items[${index}].read`]: true, unreadCount: Math.max(0, this.data.unreadCount - 1) })
    try {
      await iotApi.markNotificationsRead(this.data.deviceNo, [item.rawId], { showError: false })
    } catch (error) {
      console.warn('[WiFi消息] 标记已读失败', error && error.code, error && error.message)
      if (!this.unloaded) {
        this.setData({ [`items[${index}].read`]: false, unreadCount: this.data.unreadCount + 1 })
        toast.show({ title: errorText(error), icon: 'none' })
      }
    }
  },

  async readAll() {
    if (!this.data.unreadCount || this.readingAll) {
      return
    }
    this.readingAll = true
    try {
      await iotApi.markNotificationsRead(this.data.deviceNo, [], { showError: false })
      if (!this.unloaded) {
        this.setData({ items: this.data.items.map(item => Object.assign({}, item, { read: true })), unreadCount: 0 })
        toast.show({ title: '已全部标记为已读', icon: 'none' })
      }
    } catch (error) {
      if (!this.unloaded) {
        toast.show({ title: errorText(error), icon: 'none' })
      }
    } finally {
      this.readingAll = false
    }
  }
}))
