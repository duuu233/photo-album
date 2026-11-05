// WiFi 版消息中心的纯逻辑（2026-10-27，docs/wifi/V1.4对接实现报告反馈.md 第三节、对接文档第八节、V1.4 更新说明 2.2）。
// 服务端只给短码 type + payload，文案由 App 维护；未知 type 显示通用文案。

const TYPE_TEXT = {
  DEVICE_ONLINE: '设备已上线',
  DEVICE_OFFLINE: '设备已离线',
  LOW_BATTERY: '设备电量低',
  WIFI_WEAK: '设备 WiFi 信号弱',
  TF_FULL: 'TF 卡容量将满',
  TF_LOCAL_MODE: '设备已进入本地模式', // 2026-10-29：切到 TF 卡本地播放，payload 为空；此时不再发 DEVICE_OFFLINE
  PLAY_SUCCESS: '投屏成功',
  PLAY_DOWNLOAD_FAILED: '投屏失败：设备下载图片失败',
  PLAY_STORAGE_ERROR: '投屏失败：设备存储异常',
  PLAY_FAILED: '投屏失败',
  // 2026-11-02（docs/前端对接文档20261031.md 第四节）：只在设备重启后服务端确认版本时发；payload { version, baseVersion, reason? }
  OTA_SUCCESS: '固件升级成功',
  OTA_FAILED: '固件升级失败',
  // 2026-11-05（docs/wifi/前端对接文档20261105.md 10.2）：到点该推轮播但设备不在线 / 下发失败；category BUSINESS
  CAROUSEL_NOT_SENT: '轮播未发送成功',
  EXCEPTION_UP_PARSE: '设备上报数据解析失败',
  EXCEPTION_UNKNOWN_ACTION: '设备上报了未知指令',
  EXCEPTION_COMMAND_BUILD: '平台下发指令构造失败'
}

const CATEGORY_TEXT = { DEVICE: '设备', ALARM: '告警', EXCEPTION: '异常', BUSINESS: '业务' }

function parsePayload(payload) {
  if (payload && typeof payload === 'object') {
    return payload
  }
  try {
    const value = JSON.parse(payload)
    return value && typeof value === 'object' ? value : {}
  } catch (error) {
    return {}
  }
}

// 轮播未发送的那个时刻（HH:mm）：time / triggerTime / scheduledAt / planTime，带日期的只取时分
function carouselTime(p) {
  const raw = p.time || p.triggerTime || p.scheduledAt || p.planTime || p.triggerAt || ''
  const m = /(\d{1,2}:\d{2})(:\d{2})?\s*$/.exec(String(raw).trim()) || /(\d{1,2}:\d{2})/.exec(String(raw))
  return m ? m[1] : ''
}

// payload 里值得给用户看的参数，拼成一行；看不懂的字段不展示
function detailText(type, payload) {
  const p = parsePayload(payload)
  const parts = []
  if (p.level !== undefined && p.level !== null && p.level !== '') {
    parts.push(type === 'WIFI_WEAK' ? `信号等级 ${p.level}` : `电量等级 ${p.level}`)
  }
  if (p.battery !== undefined && p.battery !== null && p.battery !== '') {
    parts.push(`电量 ${p.battery}%`)
  }
  if (p.rssi !== undefined && p.rssi !== null && p.rssi !== '') {
    parts.push(`信号 ${p.rssi}dBm`)
  }
  if (/^OTA_/.test(String(type))) {
    // 升级通知：版本变化一行；reason 是短码（timeout 超时 / corrected 超时后由版本号确认成功），翻成中文
    if (p.baseVersion && p.version) {
      parts.push(`${p.baseVersion} → ${p.version}`)
    } else if (p.version) {
      parts.push(`目标版本 ${p.version}`)
    }
    if (p.reason === 'timeout') {
      parts.push('升级超时')
    }
    return parts.join('，')
  }
  if (type === 'CAROUSEL_NOT_SENT') {
    // 内容「18:00 的轮播图片未发送成功，请检查设备网络状态」；payload 字段对接文档未列，几种常见写法都认，取不到时刻只给后半句
    const at = carouselTime(p)
    return at ? `${at} 的轮播图片未发送成功，请检查设备网络状态` : '轮播图片未发送成功，请检查设备网络状态'
  }
  if (p.reason) {
    parts.push(String(p.reason))
  }
  if (p.result !== undefined && p.result !== null && p.result !== '' && /^PLAY_/.test(String(type))) {
    parts.push(`设备返回码 ${p.result}`)
  }
  if (p.corrected === true) {
    parts.push('设备超时后才返回成功')
  }
  return parts.join('，')
}

// 列表项 → 页面行
function toItem(raw) {
  const r = raw || {}
  const type = String(r.type || '')
  return {
    id: String(r.id),
    rawId: r.id, // 标记已读原样回传（Long 型 ID 可能按字符串返回，不转数字）
    type,
    category: String(r.category || ''),
    categoryText: CATEGORY_TEXT[r.category] || '消息',
    title: TYPE_TEXT[type] || `设备消息${type ? `（${type}）` : ''}`,
    detail: detailText(type, r.payload),
    read: !!r.read,
    createdAt: r.createdAt || ''
  }
}

// 分页合并：按 id 去重，保持先来后到（服务端按时间倒序），翻页时新增的消息把旧页往后挤也不会重复
function mergePage(existing, rawList) {
  const list = (existing || []).slice()
  const seen = {}
  list.forEach(item => {
    seen[item.id] = true
  })
  ;(rawList || []).forEach(raw => {
    const item = toItem(raw)
    if (!seen[item.id]) {
      seen[item.id] = true
      list.push(item)
    }
  })
  return list
}

module.exports = {
  TYPE_TEXT,
  CATEGORY_TEXT,
  detailText,
  toItem,
  mergePage
}
