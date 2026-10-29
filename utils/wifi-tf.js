// WiFi 版 TF 卡（2026-10-29，docs/wifi/前端对接20261029.md）的纯逻辑：详情页 TF 卡行、TF 卡设置页共用。
// TF 卡播放与 App 投屏互斥：开启后设备切到本地模式（status=LOCAL_TF）并断开云端，恢复只能在设备端重新入网，
// 协议没有远程切回指令。开关不存本地：开 = 设备当前是本地模式，设备重新入网（ONLINE）后自然回到关闭。
// 本期不做 TF 卡清除（clean-tf）。

const RESULT_TIMEOUT_MS = 30000 // 等 command.result 的超时（文档 2.3 建议 30 秒）

function plainDeviceNo(value) {
  return String(value || '').replace(/[:\-\s]/g, '').toUpperCase()
}

// 影子里的 tfUsed / tfTotal 单位为 MB；满 1GB 换成 GB 显示
function sizeText(mb) {
  const value = Number(mb)
  if (!Number.isFinite(value) || value < 0) {
    return '0MB'
  }
  if (value >= 1024) {
    return `${(value / 1024).toFixed(1).replace(/\.0$/, '')}GB`
  }
  return `${Math.round(value)}MB`
}

// 影子 → TF 卡状态：absent 未插卡 / present 有卡（text 为「已用 / 总量」）/ unknown 没上报过
function tfState(shadow) {
  const s = shadow || {}
  if (s.tfStatus === 'absent') {
    return { state: 'absent', text: '未插卡' }
  }
  if (s.tfStatus !== 'present') {
    return { state: 'unknown', text: '--' }
  }
  const total = Number(s.tfTotal)
  return { state: 'present', text: total > 0 ? `${sizeText(s.tfUsed)}/${sizeText(total)}` : '已插卡' }
}

// POST /api/device/play-tf 的错误 → 提示
function playTfErrorText(error) {
  const code = Number(error && error.code)
  if (code === 4000) {
    return '设备未插TF卡，无法开启'
  }
  if (code === 4041) {
    return '设备不在线，无法开启'
  }
  if (code === 4045) {
    return '设备升级中，请稍后'
  }
  if (code === 403) {
    return '无该设备操作权限'
  }
  return String((error && error.message) || '开启失败，请稍后重试').replace(/^接口\(IoT\)-/, '')
}

// 等设备对某条指令的 command.result（文档 2.4）。须在发请求**之前**创建：推送可能早于 HTTP 响应到达，
// 先到的按 msgid 暂存。wait(msgid) 返回 { success, result } 或超时 { timeout: true }；用完调 dispose。
function createResultWaiter(ws, deviceNo, action) {
  const target = plainDeviceNo(deviceNo)
  const early = {}
  let pending = null
  let timer = null
  const finish = value => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (pending) {
      const resolve = pending.resolve
      pending = null
      resolve(value)
    }
  }
  const off = ws.on('command.result', event => {
    if (!event || event.action !== action || plainDeviceNo(event.deviceNo) !== target) {
      return
    }
    const outcome = { success: event.success === true, result: event.result }
    const key = String(event.msgid)
    if (pending && pending.msgid === key) {
      finish(outcome)
    } else {
      early[key] = outcome
    }
  })
  return {
    wait(msgid, timeoutMs) {
      const key = String(msgid)
      if (early[key]) {
        return Promise.resolve(early[key])
      }
      return new Promise(resolve => {
        pending = { msgid: key, resolve }
        timer = setTimeout(() => finish({ timeout: true }), timeoutMs || RESULT_TIMEOUT_MS)
      })
    },
    dispose() {
      off()
      finish({ timeout: true })
    }
  }
}

module.exports = {
  RESULT_TIMEOUT_MS,
  sizeText,
  tfState,
  playTfErrorText,
  createResultWaiter
}
