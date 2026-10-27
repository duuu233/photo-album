// WiFi 版设备状态推送订阅（2026-10-27，首页设备卡 / 我的设备列表共用；WiFi 设备详情页沿用自己的订阅）。
// 结论见 docs/wifi/WiFi版状态刷新分析.md：用订阅长连接 + 补查，不做定时轮询。
//
// 页面用法：create(onChange) 得到一个订阅器；
//   · update(devices)：页面显示 / 设备列表刷新后传当前的 WiFi 设备，按 deviceNo（去冒号）订阅，多余的退订；
//   · stop()：页面隐藏 / 卸载时退订、摘掉监听（隐藏的页面不跟着刷新，也不占着订阅）；
//   · onChange(deviceNos, reason)：页面据此调 IoT 设备信息接口重查这些设备：
//       - 'push'：收到 WS device.status（上下线 / 关机 / 对账离线，只推信号不带电量，文档 1.6）→ 只重查这一台；
//       - 'reconnect'：长连接断线后重连成功（如熄屏回前台，iot-ws 会在 onAppShow 立刻重连）→ 断线期间的推送会丢，
//         全部重查一次；此时网络已通，这一次能拿到最新值。
// 订阅归属：只退订自己订阅的；某台设备已被别处（如 WiFi 详情页）订阅时不重复订阅，也不替它退订。
// 电量只在设备心跳（600 秒）时更新、推送不带电量：停留在页面期间电量不会自己变，需后端心跳时也推送（见分析文档）。
const iotWs = require('./iot-ws')

function plainDeviceNo(value) {
  return String(value == null ? '' : value).replace(/[:\-\s]/g, '').toUpperCase()
}

function deviceNoOf(device) {
  return plainDeviceNo(device && (device.productDeviceId || device.deviceNo))
}

function create(onChange) {
  let watching = [] // 页面关心的设备
  let owned = [] // 其中由本订阅器订阅的（退订只退这些）
  let offs = []

  const notify = (deviceNos, reason) => {
    console.log('[WiFi订阅]', reason === 'push' ? '收到状态推送，重查' : '长连接重连，全部重查', deviceNos.join(','))
    try {
      onChange(deviceNos, reason)
    } catch (error) {
      console.warn('[WiFi订阅] 刷新回调出错', error)
    }
  }

  function listen() {
    if (offs.length) {
      return
    }
    offs = [
      iotWs.on('device.status', event => {
        const deviceNo = plainDeviceNo(event && event.deviceNo)
        if (deviceNo && watching.indexOf(deviceNo) > -1) {
          notify([deviceNo], 'push')
        }
      }),
      iotWs.on('state', event => {
        if (event && event.state === 'open' && event.reconnect && watching.length) {
          notify(watching.slice(), 'reconnect')
        }
      })
    ]
  }

  function unlisten() {
    offs.forEach(off => off())
    offs = []
  }

  function update(devices) {
    const next = []
    ;(devices || []).forEach(device => {
      const deviceNo = deviceNoOf(device)
      if (deviceNo && next.indexOf(deviceNo) === -1) {
        next.push(deviceNo)
      }
    })
    owned.filter(deviceNo => next.indexOf(deviceNo) === -1).forEach(deviceNo => iotWs.unsubscribe(deviceNo))
    owned = owned.filter(deviceNo => next.indexOf(deviceNo) > -1)
    watching = next
    if (!next.length) {
      // 没有 WiFi 设备（纯蓝牙版用户）：不订阅、不建长连接
      unlisten()
      return
    }
    listen()
    const subscribed = iotWs.getSubscriptions()
    next.forEach(deviceNo => {
      if (owned.indexOf(deviceNo) === -1 && subscribed.indexOf(deviceNo) === -1) {
        iotWs.subscribe(deviceNo) // 未连接时会顺带建连
        owned.push(deviceNo)
      }
    })
  }

  function stop() {
    owned.forEach(deviceNo => iotWs.unsubscribe(deviceNo))
    owned = []
    watching = []
    unlisten()
  }

  return {
    update,
    stop,
    deviceNos: () => watching.slice()
  }
}

module.exports = {
  plainDeviceNo,
  deviceNoOf,
  create
}
