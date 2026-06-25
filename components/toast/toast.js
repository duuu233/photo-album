// 全局 Toast 组件。不直接在页面里调用，由 utils/toast.js 通过 selectComponent 拿到实例后调 show()/hide()。
// 设计成「方法驱动 + 自带定时器」，用法贴近原生 wx.showToast。
Component({
  options: {
    // 允许外部（页面 wxss）覆盖样式时再开 addGlobalClass；当前样式自包含，无需开启
    multipleSlots: false
  },

  data: {
    visible: false,
    leaving: false, // 是否正在播放退场动画
    title: '',
    iconType: '', // '' 纯文字 / 'success' / 'error' / 'loading'
    mask: false
  },

  methods: {
    noop() {},

    // options 兼容两种写法：
    //   show('文案')                       —— 纯文字（最常用，解决长文案换行）
    //   show({ title, icon, duration, mask }) —— 同 wx.showToast 字段
    // 注意：icon 默认 'none'（与原生默认 success 不同），因为本组件主要就是为「纯文字长提示」服务。
    show(options) {
      const opts = typeof options === 'string' ? { title: options } : (options || {})
      const title = opts.title == null ? '' : String(opts.title)
      const icon = opts.icon || 'none'
      const iconType = ['success', 'error', 'loading'].indexOf(icon) > -1 ? icon : ''
      const duration = opts.duration === undefined ? 2000 : Number(opts.duration)
      const mask = !!opts.mask

      this.clearTimers()
      this.setData({ visible: true, leaving: false, title, iconType, mask })

      // duration<=0（如 loading）则常驻，等调用方手动 hide()
      if (duration > 0) {
        this._hideTimer = setTimeout(() => this.hide(), duration)
      }
    },

    hide() {
      this.clearTimers()
      if (!this.data.visible) {
        return
      }
      // 先播放退场动画再真正卸载，避免瞬间消失
      this.setData({ leaving: true })
      this._leaveTimer = setTimeout(() => {
        this.setData({ visible: false, leaving: false })
      }, 180)
    },

    clearTimers() {
      if (this._hideTimer) {
        clearTimeout(this._hideTimer)
        this._hideTimer = null
      }
      if (this._leaveTimer) {
        clearTimeout(this._leaveTimer)
        this._leaveTimer = null
      }
    }
  },

  lifetimes: {
    detached() {
      this.clearTimers()
    }
  }
})
