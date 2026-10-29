const api = require('../../../utils/api')
const iotApi = require('../../../utils/iot-api')
const system = require('../../../utils/system')
const fold = require('../../../utils/fold-adapt')
const signal = require('../../../utils/signal')
const wifiStatus = require('../../../utils/wifi-status')

// WiFi 版「设备信息」二级页（2026-10-29，原详情页的信息行挪到这里）：WiFi信号、WiFi名称、最后上线、最后心跳、固件版本；
// 不再显示国家码。数据：老服务 getDeviceDetail 取设备号 → IoT GET /api/device/info。非在线时信号不显示（本地模式影子冻结）。
function infoRows(info) {
  const i = info || {}
  const shadow = i.shadow || {}
  const online = !!info && wifiStatus.deviceState(info) === 'online'
  const rssi = Number(shadow.wifiRssi)
  return [
    { key: 'signal', label: 'WiFi信号', value: online && rssi < 0 ? `${rssi}dBm` : '', level: online ? signal.rssiToLevel(rssi) : 0 },
    { key: 'wifiName', label: 'WiFi名称', value: shadow.wifiName || '' },
    { key: 'lastOnline', label: '最后上线', value: i.lastOnlineAt || '' },
    { key: 'lastHeart', label: '最后心跳', value: shadow.lastHeartAt || '' },
    { key: 'version', label: '固件版本', value: i.firmwareVersion || shadow.espVersion || shadow.version || '' }
  ].map(row => Object.assign(row, { value: row.value || '--' }))
}

Page(fold.adapt({
  data: {
    statusBarHeight: 20,
    safeBottom: 0,
    id: '',
    loading: true,
    loadError: false,
    rows: []
  },

  onLoad(options) {
    this.setData(Object.assign(system.getLayoutMetrics(), { id: (options && options.id) || '' }))
    this.load()
  },

  onUnload() {
    this.unloaded = true
  },

  async load() {
    let device
    try {
      device = await api.getDeviceDetail(this.data.id)
    } catch (error) {
      this.setData({ loading: false, loadError: true })
      return
    }
    let info = null
    try {
      info = await iotApi.getDeviceInfo(device.productDeviceId || device.deviceNo || '', { showError: false })
    } catch (error) {
      info = null
    }
    if (!this.unloaded) {
      this.setData({ loading: false, loadError: false, rows: infoRows(info) })
    }
  },

  retryLoad() {
    this.setData({ loading: true, loadError: false })
    this.load()
  }
}))
