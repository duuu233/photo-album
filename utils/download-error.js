// wx.downloadFile 失败 → 给用户看的中文提示（2026-09-21 产品：「下载超时提示修改，小程序尽量
// 不要用英文，改中文就行」）。
//
// 微信的失败回调只有一句 errMsg 原文（`downloadFile:fail timeout`、
// `downloadFile:fail url not in domain list` 之类），原来官方图库投屏、结果页取原图、固件包下载
// 三处都把它原样 toast 出去，用户看到的就是一串英文。统一在这里归类成人话；原文仍在调用方的
// console / error.rawErrMsg 里，排查不受影响。
//
// subject：下载的是什么（「图片」「原图」「固件包」），拼进提示里。

function errMsgOf(err) {
  if (!err) {
    return ''
  }
  if (typeof err === 'string') {
    return err
  }
  return String(err.errMsg || err.message || '')
}

function isTimeout(msg) {
  return /time\s*out|timeout|超时/i.test(msg)
}

// 合法域名没配：真机才会遇到（开发者工具勾了「不校验合法域名」时看不出来），是配置问题，
// 不能说成网络问题把排查带偏。
function isDomainNotAllowed(msg) {
  return /domain list|not in domain|域名/i.test(msg)
}

function describeDownloadFail(err, subject) {
  const what = subject || '图片'
  const msg = errMsgOf(err)
  if (isDomainNotAllowed(msg)) {
    return `${what}域名未配置（小程序后台 downloadFile 合法域名）`
  }
  if (isTimeout(msg)) {
    return `${what}下载超时，请检查网络后重试`
  }
  return `${what}下载失败，请检查网络后重试`
}

module.exports = {
  describeDownloadFail,
  isTimeout
}
