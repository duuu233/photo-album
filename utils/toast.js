// 全局 Toast 调用入口，替代 wx.showToast 解决「长文案被窄盒子挤到换行」。
// 用法：
//   const toast = require('../../../utils/toast')
//   toast.show('刷新屏幕只能选中一张图片')           // 纯文字
//   toast.show({ title: '已保存', icon: 'success' }) // 带图标，字段同 wx.showToast
//   toast.hide()
//
// 前提：页面 wxml 里放一个全局组件实例 <global-toast id="globalToast" />（组件已在 app.json 全局注册）。
// 若某页没放该组件，则自动退回原生 wx.showToast，保证「替换后任意页面都能正常提示」。

// 约定的组件实例 id，页面里必须用这个 id 才能被 selectComponent 命中
const TOAST_ID = '#globalToast'

// 取当前页面里的全局 toast 组件实例（没有则返回 null）
function getToastComponent() {
  const pages = getCurrentPages()
  const page = pages && pages.length ? pages[pages.length - 1] : null
  if (!page || typeof page.selectComponent !== 'function') {
    return null
  }
  return page.selectComponent(TOAST_ID)
}

function show(options) {
  const toast = getToastComponent()
  if (toast && typeof toast.show === 'function') {
    toast.show(options)
    return
  }
  // 兜底：当前页没放 <global-toast>，退回原生（字段对齐 wx.showToast）
  const opts = typeof options === 'string' ? { title: options } : (options || {})
  wx.showToast({
    title: opts.title == null ? '' : String(opts.title),
    icon: opts.icon || 'none',
    duration: opts.duration === undefined ? 2000 : opts.duration,
    mask: !!opts.mask
  })
}

// 报错/警告类提示：给「非接口、非设备」的本地错误统一加「小程序-」前缀，便于用户/客服一眼区分故障来源
// （设备/蓝牙错误已在 device-ble/ota-ble 加「设备-」，后端接口错误已在 request.js 加「接口-」）。
// 幂等：标题已带「接口-」「设备-」「小程序-」前缀时原样保留，避免二次拼接。
// ⚠️ 仅用于报错和警告；成功/中性提示（已保存、已连接等）请继续用 show()，不要加来源前缀。
function warn(options) {
  const opts = typeof options === 'string' ? { title: options } : Object.assign({}, options || {})
  const title = opts.title == null ? '' : String(opts.title)
  opts.title = title && !/^(接口-|设备-|小程序-)/.test(title) ? `小程序-${title}` : title
  if (!opts.icon) {
    opts.icon = 'none'
  }
  // 报错/警告类停留略久（默认 3s），既够看清故障来源与原因、又不至于长时间挡住操作；调用方显式传 duration 时以其为准。
  if (opts.duration === undefined) {
    opts.duration = 3000
  }
  show(opts)
}

function hide() {
  const toast = getToastComponent()
  if (toast && typeof toast.hide === 'function') {
    toast.hide()
    return
  }
  wx.hideToast()
}

module.exports = {
  show,
  warn,
  hide
}
