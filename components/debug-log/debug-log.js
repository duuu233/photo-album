// 联调日志浮窗（2026-10-27）：开发版 / 体验版每个页面左下角一颗「日志 N」小药丸，点开展开日志框，
// 可「复制」全部、「清空」、「关闭」。正式版不渲染（utils/debug-log.enabled()）。
// 日志是全局一份（utils/debug-log），跨页面累积；只有当前显示的页面订阅刷新，后台页面不跟着 setData。
// 每个页面的 wxml 末尾放一个 <debug-log></debug-log>（app.json 全局注册）。
const debugLog = require('../../utils/debug-log')

const REFRESH_MS = 300

Component({
  data: {
    enabled: false,
    open: false,
    count: 0,
    lines: [],
    anchor: ''
  },

  lifetimes: {
    attached() {
      this.setData({ enabled: debugLog.enabled() })
    },
    detached() {
      this.unwatch()
    }
  },

  pageLifetimes: {
    show() {
      if (!this.data.enabled) {
        return
      }
      const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : []
      const page = pages[pages.length - 1]
      if (page && page.route) {
        debugLog.add(`页面 → ${page.route}`)
      }
      this.watch()
      this.refresh()
    },
    hide() {
      this.unwatch()
    }
  },

  methods: {
    noop() {},

    watch() {
      if (!this._off) {
        this._off = debugLog.subscribe(() => this.scheduleRefresh())
      }
    },

    unwatch() {
      if (this._off) {
        this._off()
        this._off = null
      }
      if (this._timer) {
        clearTimeout(this._timer)
        this._timer = null
      }
    },

    // 日志可能一秒很多行：合并到 REFRESH_MS 刷一次
    scheduleRefresh() {
      if (this._timer) {
        return
      }
      this._timer = setTimeout(() => {
        this._timer = null
        this.refresh()
      }, REFRESH_MS)
    },

    // 收起时只更新条数；展开时才把全部行给到模板
    refresh() {
      if (!this.data.open) {
        this.setData({ count: debugLog.count() })
        return
      }
      const lines = debugLog.getLines()
      this.setData({
        count: lines.length,
        lines,
        anchor: lines.length ? lines[lines.length - 1].id : ''
      })
    },

    toggle() {
      this.setData({ open: !this.data.open })
      this.refresh()
    },

    copy() {
      const text = debugLog.text()
      if (!text) {
        wx.showToast({ title: '暂无日志', icon: 'none' })
        return
      }
      wx.setClipboardData({ data: text })
    },

    clear() {
      debugLog.clear()
    }
  }
})
