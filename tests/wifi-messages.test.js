// WiFi 版消息中心（2026-10-27，docs/wifi/V1.4对接实现报告反馈.md 第三节）utils/wifi-messages + 页面：
//   ① 文案：按 type 翻译，payload 关键参数一行展示，未知 type 通用文案；
//   ② 分页：第一页整页替换，加载更多按 id 去重；hasMore 按 total；
//   ③ 单条已读：原样回传 id、角标减 1；失败回滚；全部已读 ids=[]；
//   ④ 只看未读切换带 unreadOnly=true；收到本设备 notification.new 刷新第一页；自己订阅的退出时退订；
//   ⑤ WiFi 详情：进页查未读数，收到 notification.new 再查。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const root = path.join(__dirname, '..')
const m = require('../utils/wifi-messages')

let checks = 0
function checked(name) { checks++; console.log('PASS ' + name) }
const plain = value => JSON.parse(JSON.stringify(value))

{
  const ok = m.toItem({ id: 7, category: 'BUSINESS', type: 'PLAY_SUCCESS', payload: { msgid: '1', result: 113, reason: '投屏成功', corrected: true }, read: false, createdAt: '2026-10-27 21:00:00' })
  assert.equal(ok.title, '投屏成功')
  assert.equal(ok.categoryText, '业务')
  assert.equal(ok.detail, '投屏成功，设备返回码 113，设备超时后才返回成功')
  assert.equal(ok.rawId, 7, '原始 id 保留')
  assert.equal(m.toItem({ id: '8', type: 'PLAY_DOWNLOAD_FAILED', payload: '{"result":205}' }).detail, '设备返回码 205', 'payload 是字符串也能解析')
  assert.equal(m.toItem({ id: 9, type: 'LOW_BATTERY', payload: { level: 2 } }).detail, '电量等级 2')
  assert.equal(m.toItem({ id: 10, type: 'NEW_THING' }).title, '设备消息（NEW_THING）', '未知 type 通用文案')
  const merged = m.mergePage(m.mergePage([], [{ id: 1 }, { id: 2 }]), [{ id: 2 }, { id: 3 }])
  assert.deepEqual(merged.map(item => item.id), ['1', '2', '3'], '翻页按 id 去重')
  checked('文案与分页合并')
}

function loadPage() {
  let definition
  const state = { calls: [], reads: [], subs: [], unsubs: [], handlers: {}, timers: [], toasts: [], pages: {} }
  const emit = (type, payload) => (state.handlers[type] || []).slice().forEach(fn => fn(payload))
  const api = {
    getNotifications: async params => {
      state.calls.push(plain(params))
      const reply = state.pages[`${params.page}:${!!params.unreadOnly}`]
      if (reply instanceof Error) throw reply
      return reply || { total: 0, unreadCount: 0, list: [] }
    },
    markNotificationsRead: async (deviceNo, ids) => {
      state.reads.push([deviceNo, ids])
      if (state.readError) throw state.readError
      return null
    }
  }
  const ws = {
    on(type, fn) { (state.handlers[type] = state.handlers[type] || []).push(fn); return () => { state.handlers[type] = state.handlers[type].filter(item => item !== fn) } },
    subscribe(id) { state.subs.push(id) },
    unsubscribe(id) { state.unsubs.push(id) },
    getSubscriptions: () => []
  }
  const modules = {
    'iot-api': api, 'iot-ws': ws,
    toast: { show: value => state.toasts.push(value.title) },
    system: { getLayoutMetrics: () => ({}) },
    'fold-adapt': { adapt: value => value },
    'wifi-messages': m
  }
  vm.runInNewContext(fs.readFileSync(path.join(root, 'subpackages/device/wifi-messages/wifi-messages.js'), 'utf8'), {
    require: target => modules[target.split('/').at(-1)],
    Page: value => { definition = value },
    wx: { stopPullDownRefresh() {} },
    setTimeout: (fn, ms) => { state.timers.push(fn); return state.timers.length },
    clearTimeout() {},
    console: { log() {}, warn() {} }
  }, { filename: 'wifi-messages.js' })
  const page = { ...definition, data: plain(definition.data), setData(values) {
    Object.keys(values).forEach(key => {
      const hit = /^items\[(\d+)\]\.read$/.exec(key)
      if (hit) this.data.items[Number(hit[1])] = Object.assign({}, this.data.items[Number(hit[1])], { read: values[key] })
      else this.data[key] = values[key]
    })
  } }
  return { page, state, emit }
}

const flush = () => new Promise(resolve => setImmediate(resolve))
const rows = (from, to) => Array.from({ length: to - from + 1 }, (v, i) => ({ id: from + i, type: 'DEVICE_ONLINE', category: 'DEVICE', read: false }))

async function main() {
  {
    const { page, state, emit } = loadPage()
    state.pages['1:false'] = { total: 25, unreadCount: 25, list: rows(1, 20) }
    state.pages['2:false'] = { total: 25, unreadCount: 25, list: rows(19, 25) }
    page.onLoad({ deviceNo: 'D0:CF:13:F0:2F:F8' })
    await flush()
    assert.deepEqual(state.subs, ['D0CF13F02FF8'], '没订阅就自己订阅（去冒号）')
    assert.deepEqual(state.calls[0], { deviceNo: 'D0CF13F02FF8', page: 1, size: 20, unreadOnly: false })
    assert.equal(page.data.items.length, 20)
    assert.equal(page.data.hasMore, true)
    await page.loadMore()
    assert.equal(page.data.items.length, 25, '第二页与第一页重叠的两条去重')
    assert.equal(page.data.hasMore, false)
    checked('分页：第一页 + 加载更多去重')

    await page.tapItem({ currentTarget: { dataset: { index: 0 } } })
    assert.deepEqual(plain(state.reads[0]), ['D0CF13F02FF8', [1]], '单条已读回传原始 id')
    assert.equal(page.data.items[0].read, true)
    assert.equal(page.data.unreadCount, 24, '角标减 1')
    state.readError = Object.assign(new Error('接口(IoT)-服务异常'), { code: 5000 })
    await page.tapItem({ currentTarget: { dataset: { index: 1 } } })
    assert.equal(page.data.items[1].read, false, '失败回滚')
    assert.equal(page.data.unreadCount, 24)
    state.readError = null
    await page.readAll()
    assert.deepEqual(plain(state.reads.at(-1)), ['D0CF13F02FF8', []], '全部已读 ids 传空数组')
    assert.equal(page.data.unreadCount, 0)
    assert.ok(page.data.items.every(item => item.read))
    checked('单条已读 / 失败回滚 / 全部已读')

    state.calls.length = 0
    emit('notification.new', { type: 'notification.new', deviceNo: 'OTHER', messageType: 'LOW_BATTERY' })
    assert.equal(state.timers.length, 0, '别的设备的推送不理')
    emit('notification.new', { type: 'notification.new', deviceNo: 'D0CF13F02FF8', messageType: 'LOW_BATTERY' })
    state.timers.at(-1)()
    await flush()
    assert.equal(state.calls[0].page, 1, '收到本设备推送刷新第一页')
    page.toggleUnreadOnly({ detail: { value: true } })
    await flush()
    assert.equal(state.calls.at(-1).unreadOnly, true, '只看未读带 unreadOnly')
    page.onUnload()
    assert.deepEqual(state.unsubs, ['D0CF13F02FF8'], '自己订阅的退出时退订')
    checked('推送刷新 / 只看未读 / 退订')
  }
  {
    const { page, state } = loadPage()
    state.pages['1:false'] = Object.assign(new Error('接口(IoT)-无权限'), { code: 403 })
    page.onLoad({ deviceNo: 'X' })
    await flush()
    assert.equal(page.data.loadError, '没有查看该设备消息的权限', '403 有对应提示')
    checked('错误态')
  }
  {
    const detail = fs.readFileSync(path.join(root, 'subpackages/device/wifi-detail/wifi-detail.js'), 'utf8')
    assert.ok(/iotApi\.getUnreadCount/.test(detail), '详情查未读数')
    assert.ok(/iotWs\.on\('notification\.new'[\s\S]*?this\.refreshUnread\(\)/.test(detail), '收到新消息推送重查角标')
    const json = JSON.parse(fs.readFileSync(path.join(root, 'subpackages/device/wifi-messages/wifi-messages.json'), 'utf8'))
    assert.equal(json.enablePullDownRefresh, true, '支持下拉刷新')
    checked('详情角标与下拉刷新')
  }
  console.log(`wifi-messages: ${checks} groups passed`)
}
main().catch(error => { console.error(error); process.exitCode = 1 })
