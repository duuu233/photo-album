// BluFi 帧编解码（2026-10-26，WiFi 版配网 STEP 2）：以乐鑫 EspBlufi 为基线——
//   type = 子类型<<2 | 帧类型；序号逐帧递增；超出单帧长度时分片，分片帧带 0x10 标志、data 前 2 字节是剩余总长（小端）；
//   设备回的 WiFi 状态报告 / 自定义 JSON / 分片都能解出来。
const assert = require('node:assert/strict')
const blufi = require('../utils/blufi')

let checks = 0
function checked(name) { checks++; console.log('PASS ' + name) }
const arr = frame => Array.from(frame)

// ── 编码 ──
{
  const [opmode] = blufi.encodeFrames(false, blufi.CTRL.SET_OPMODE, [0x01], 0, 20)
  assert.deepEqual(arr(opmode), [0x08, 0x00, 0x00, 0x01, 0x01], '控制帧 SET_OPMODE：type=0x02<<2|0，seq 0，长 1，STA')
  const [ssid] = blufi.encodeFrames(true, blufi.DATA.STA_SSID, blufi.utf8Encode('Home'), 1, 20)
  assert.deepEqual(arr(ssid), [0x09, 0x00, 0x01, 0x04, 0x48, 0x6f, 0x6d, 0x65], '数据帧 STA_SSID：type=0x02<<2|1')
  const [connect] = blufi.encodeFrames(false, blufi.CTRL.CONNECT_WIFI, [], 255, 20)
  assert.deepEqual(arr(connect), [0x0c, 0x00, 0xff, 0x00], '无数据控制帧，序号按 255 写出')
  checked('控制帧 / 数据帧头部与序号')
}

{
  // 40 字节密码、单帧 20 字节 → data 上限 16：首片 2+14、次片 2+14、末片 12
  const payload = Array.from({ length: 40 }, (_, i) => i + 1)
  const frames = blufi.encodeFrames(true, blufi.DATA.STA_PASSWORD, payload, 5, 20).map(arr)
  assert.equal(frames.length, 3)
  assert.deepEqual(frames.map(f => f[2]), [5, 6, 7], '每片一个序号')
  assert.deepEqual(frames.map(f => f[1]), [0x10, 0x10, 0x00], '除末片外带分片标志')
  assert.deepEqual(frames[0].slice(4, 6), [40, 0], '首片前 2 字节是总长 40')
  assert.deepEqual(frames[1].slice(4, 6), [26, 0], '次片前 2 字节是剩余 26')
  assert.equal(frames[2][3], 12, '末片不带长度前缀')
  // 剩余正好装得下一帧时不再分片
  assert.equal(blufi.encodeFrames(true, blufi.DATA.STA_PASSWORD, payload.slice(0, 16), 0, 20).length, 1)
  assert.ok(frames.every(f => f.length <= 20), '每帧不超过单帧上限')
  const rebuilt = frames[0].slice(6).concat(frames[1].slice(6), frames[2].slice(4))
  assert.deepEqual(rebuilt, payload, '去掉长度前缀后拼回原文')
  checked('超长数据分片')
}

// ── 解码（设备 → 手机，方向位 0x04，可能带校验）──
{
  const decode = blufi.createDecoder()
  // WiFi 状态：STA 模式、已连上、0 个 softAP 连接，TLV SSID=Home
  const state = [0x01, 0x00, 0x00, 0x02, 0x04, 0x48, 0x6f, 0x6d, 0x65]
  const frame = [(0x0f << 2) | 1, 0x04 | 0x02, 0x00, state.length].concat(state, [0xaa, 0xbb])
  const message = decode(Uint8Array.from(frame))
  assert.equal(message.isData, true)
  assert.equal(message.subtype, blufi.DATA.WIFI_STATE)
  assert.deepEqual(message.data, state, '校验字节在 dataLen 之外，自然去掉')
  const parsed = blufi.parseWifiState(message.data)
  assert.equal(parsed.staState, blufi.STA_STATE.CONNECTED)
  assert.equal(parsed.ssid, 'Home')
  checked('WiFi 状态报告')

  const json = blufi.utf8Encode(JSON.stringify({ action: 'mqtt_config_ack', data: { result: 0, ack_msgid: '1756108400173' } }))
  const first = json.slice(0, 10)
  const rest = json.slice(10)
  assert.equal(decode(Uint8Array.from([(0x13 << 2) | 1, 0x04 | 0x10, 1, first.length + 2, json.length & 0xff, json.length >> 8].concat(first))), null, '分片中途不出消息')
  const done = decode(Uint8Array.from([(0x13 << 2) | 1, 0x04, 2, rest.length].concat(rest)))
  const custom = blufi.parseCustom(done.data)
  assert.equal(custom.action, 'mqtt_config_ack')
  assert.equal(custom.body.result, 0)
  assert.equal(custom.ackMsgid, '1756108400173')
  checked('分片的自定义 JSON 应答')

  const typo = blufi.parseCustom(blufi.utf8Encode('{"action":"mqtt_config_ack","date":{"result":3,"ack_msgid":"9"}}'))
  assert.equal(typo.body.result, 3, '协议表格里的 date 写法同样认')
  assert.equal(blufi.parseCustom(blufi.utf8Encode('not json')).action, '')
  checked('自定义数据兼容 date 写法与非 JSON')
}

{
  for (const text of ['Home_WiFi', '我家的WiFi', 'café', '🙂网络']) {
    assert.equal(blufi.utf8Decode(blufi.utf8Encode(text)), text)
  }
  assert.deepEqual(blufi.utf8Encode('家'), [0xe5, 0xae, 0xb6])
  checked('中文 / emoji WiFi 名称 UTF-8 编解码')
}

{
  // 设备扫描附近 WiFi：手机发控制帧 0x09，设备回数据帧 0x11（len | rssi | ssid）
  const [scan] = blufi.encodeFrames(false, blufi.CTRL.GET_WIFI_LIST, [], 3, 20)
  assert.deepEqual(arr(scan), [0x24, 0x00, 0x03, 0x00], '获取 WiFi 列表：type=0x09<<2|0、无数据')
  const entry = (ssid, rssi) => {
    const name = blufi.utf8Encode(ssid)
    return [name.length + 1, rssi & 0xff].concat(name)
  }
  const payload = entry('Home', -45).concat(entry('我家', -80), [9, 0xc0])
  const list = blufi.parseWifiList(payload)
  assert.deepEqual(list.map(item => [item.ssid, item.rssi, item.len]), [['Home', -45, 5], ['我家', -80, 7]], 'RSSI 按有符号解析，长度不足的残尾丢弃')
  assert.equal(list[0].raw, '05 D3 48 6F 6D 65', '每条带原始字节，联调核对固件回了哪些字段')
  assert.equal(list.tailHex, '09 C0', '解析不了的残尾单独给出')
  assert.equal(list.rawHex.split(' ').length, payload.length)
  assert.ok(list.every(item => item.channel === undefined && item.frequency === undefined), '乐鑫标准格式没有信道 / 频率')
  const decode = blufi.createDecoder()
  const message = decode(Uint8Array.from([(0x11 << 2) | 1, 0x04, 0, payload.length].concat(payload)))
  assert.equal(message.subtype, blufi.DATA.WIFI_LIST)
  checked('设备扫描 WiFi：0x09 指令与 0x11 列表解析')
}

{
  // 本设备实测（2026-10-26 真机日志）：WiFi 列表走自定义数据 0x13，每行 ssid:<名称>,rssi:<dBm>,ch:<信道>
  const text = [
    'ssid:starhc520,rssi:-27,ch:1',
    'ssid:,rssi:-28,ch:1',
    'ssid:starhc520_5G,rssi:-29,ch:48',
    'ssid:Zheng房间,rssi:-79,ch:1',
    'ssid:a,b,rssi:-50,ch:6',
    'ssid:1308_5G,rssi:-60,ch:157',
    'ssid:EricRachel,rssi:-84,ch:13',
    'garbage line'
  ].join('\n')
  const list = blufi.parseCustomWifiList(text)
  assert.deepEqual(list.map(item => [item.ssid, item.rssi, item.channel]), [
    ['starhc520', -27, 1], ['', -28, 1], ['starhc520_5G', -29, 48], ['Zheng房间', -79, 1],
    ['a,b', -50, 6], ['1308_5G', -60, 157], ['EricRachel', -84, 13]
  ], '名称可为空、可带中文和逗号；认不出的行忽略')
  assert.equal(blufi.parseCustomWifiList('ssid:x,rssi:-1,ch:1\r\nssid:y,rssi:-2,ch:6').length, 2, '兼容 CRLF 换行')
  assert.equal(blufi.channelFrequency(1), 2412)
  assert.equal(blufi.channelFrequency(13), 2472)
  assert.equal(blufi.channelFrequency(14), 2484)
  assert.equal(blufi.channelFrequency(36), 5180)
  assert.equal(blufi.channelFrequency(157), 5785)
  assert.deepEqual([1, 6, 13, 14, 36, 48, 157].map(ch => blufi.is24GChannel(ch)), [true, true, true, true, false, false, false], '信道 1~14 为 2.4G')
  assert.equal(blufi.is24GChannel(undefined), null, '没回信道（乐鑫标准格式）时判不了')
  checked('本设备自定义文本格式的 WiFi 列表与信道→频段')
}

{
  assert.equal(blufi.errorText(11), 'WiFi 扫描失败', '设备报错码按乐鑫定义翻译')
  assert.equal(blufi.errorText(99), '未知错误')
  checked('设备错误码文案')
}

console.log(`blufi: ${checks} groups passed`)
