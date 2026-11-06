// 「选择投屏设备」弹层的设备行（2026-11-06，utils/picker-devices.js，官方图库详情与 AI 对话共用）：
//   ① pickerId 兜底链：后端主键 → deviceId → 设备号 → 名称 → 序号；
//   ② WiFi 版带 isWifi，状态取云端（在线 → online，离线 / 本地模式 / 状态未知等 → off），所有 WiFi 版都列出；
//   ③ 蓝牙版：本机有活动会话「已连接」（connected），否则「未连接」（off）；判断抛错按未连接。
const assert = require('assert')
const path = require('path')

const stubModule = (request, exports) => {
  const filename = require.resolve(request)
  require.cache[filename] = { id: filename, filename, loaded: true, children: [], paths: [], exports }
}
const fields = {
  W1: { wifiStatus: 'online', wifiStatusText: '在线' },
  W2: { wifiStatus: 'offline', wifiStatusText: '离线' },
  W3: { wifiStatus: 'local', wifiStatusText: '本地模式' }
}
const queried = []
stubModule('../utils/wifi-status', {
  fetchFields: async device => {
    queried.push(device.id)
    return fields[device.id] || { wifiStatus: 'unknown', wifiStatusText: '状态未知' }
  }
})
const picker = require(path.join(__dirname, '..', 'utils/picker-devices.js'))

async function main() {
  assert.strictEqual(picker.pickerIdOf({ id: 0 }, 5), '0', '主键 0 也算')
  assert.strictEqual(picker.pickerIdOf({ deviceNo: 'AA' }, 1), 'AA')
  assert.strictEqual(picker.pickerIdOf({}, 3), '3', '都没有用序号')

  const bound = [
    { id: 'W1', wifi: true },
    { id: 'W2', wifi: true },
    { id: 'W3', wifi: true },
    { id: 'W4', wifi: true },
    { id: 'B1' },
    { id: 'B2' },
    { id: 'B3' }
  ]
  const rows = await picker.buildPickerDevices(bound, {
    isWifi: item => !!item.wifi,
    findConnectedDeviceId: item => {
      if (item.id === 'B3') throw new Error('ble')
      return item.id === 'B1' ? 'BLE-1' : ''
    }
  })
  assert.deepStrictEqual(rows.map(row => row.id), ['W1', 'W2', 'W3', 'W4', 'B1', 'B2', 'B3'], '全部列出、保持顺序，不过滤')
  assert.deepStrictEqual(rows.map(row => [row.isWifi, row.statusText, row.statusTone]), [
    [true, '在线', 'online'],
    [true, '离线', 'off'],
    [true, '本地模式', 'off'],
    [true, '状态未知', 'off'],
    [false, '已连接', 'connected'],
    [false, '未连接', 'off'],
    [false, '未连接', 'off']
  ])
  assert.deepStrictEqual(queried, ['W1', 'W2', 'W3', 'W4'], '只给 WiFi 版查云端状态')
  assert.strictEqual(bound[0].statusText, undefined, '不改原记录')
  assert.deepStrictEqual(await picker.buildPickerDevices(null), [])

  console.log('picker-devices.test.js: all passed')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
