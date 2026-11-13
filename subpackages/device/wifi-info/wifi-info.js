const api = require('../../../utils/api')
const iotApi = require('../../../utils/iot-api')
const system = require('../../../utils/system')
const fold = require('../../../utils/fold-adapt')
const signal = require('../../../utils/signal')
const wifiStatus = require('../../../utils/wifi-status')
const fpgaFirmware = require('../../../utils/fpga-firmware')

// WiFi 版「设备信息」二级页（2026-10-29，原详情页的信息行挪到这里）：WiFi信号、WiFi名称、最后上线、最后心跳、固件版本；
// 不再显示国家码。数据：老服务 getDeviceDetail 取设备号 → IoT GET /api/device/info。非在线时信号不显示（本地模式影子冻结）。
// 2026-11-13：产品渲染模式 = fpga16 的设备多一个「优雅刷新升级」入口，直接进安装步骤页（wifi-ota?mode=fpga，见 utils/fpga-firmware.js）；
// 2026-11-14 起不做红点。设备不上报 FPGA 版本，不显示版本号。
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
    rows: [],
    showFpga: false // 渲染模式 = fpga16 才显示「优雅刷新升级」
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
    let renderMode = ''
    ;[info, renderMode] = await Promise.all([
      iotApi.getDeviceInfo(device.productDeviceId || device.deviceNo || '', { showError: false }).catch(() => null),
      api.resolveRenderMode(device).catch(() => '')
    ])
    if (!this.unloaded) {
      this.setData({
        loading: false,
        loadError: false,
        rows: infoRows(info),
        showFpga: fpgaFirmware.isFpgaRender(renderMode)
      })
    }
  },

  // 「优雅刷新升级」：直接进安装步骤页（最新版本取设备详情）
  openFpga() {
    wx.navigateTo({ url: `/subpackages/device/wifi-ota/wifi-ota?id=${this.data.id}&mode=fpga` })
  },

  retryLoad() {
    this.setData({ loading: true, loadError: false })
    this.load()
  }
}))
