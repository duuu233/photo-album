const api = require('../../../utils/api')
const system = require('../../../utils/system')
const fold = require('../../../utils/fold-adapt')
const toast = require('../../../utils/toast')
const fpgaFirmware = require('../../../utils/fpga-firmware')

// WiFi 版「优雅刷新升级」（2026-11-13，原名渲染固件管理；逻辑说明见 utils/fpga-firmware.js 文件头）：
// 设备信息页进来（只有渲染模式 = fpga16 的设备才有入口）；列出后台启用的版本：版本号、简介、安装。
// 设备不上报 FPGA 版本（ota/status 的 baseVersion 为 null），不显示设备当前版本。
// 点「安装」→ 固件升级页的 fpga 模式（wifi-ota?mode=fpga），安装目标经本地存储带过去。
// 列表接口后端还没提供时显示「版本列表暂未开放」。
Page(fold.adapt({
  data: {
    statusBarHeight: 20,
    safeBottom: 0,
    id: '',
    loading: true,
    loadError: false,
    pending: false, // 列表接口未开放
    notFpga: false,
    versions: []
  },

  onLoad(options) {
    this.setData(Object.assign(system.getLayoutMetrics(), { id: (options && options.id) || '' }))
    this.load()
  },

  onUnload() {
    this.unloaded = true
  },

  async load() {
    this.setData({ loading: true, loadError: false })
    let device
    try {
      device = await api.getDeviceDetail(this.data.id)
    } catch (error) {
      this.setData({ loading: false, loadError: true })
      return
    }
    if (this.unloaded) {
      return
    }
    this.device = device
    const renderMode = await api.resolveRenderMode(device).catch(() => '')
    if (!fpgaFirmware.isFpgaRender(renderMode)) {
      this.setData({ loading: false, notFpga: true })
      return
    }
    let result
    try {
      result = await fpgaFirmware.fetchVersions(device.productId)
    } catch (error) {
      console.warn('[优雅刷新] 版本列表查询失败', error && error.message)
      if (!this.unloaded) {
        this.setData({ loading: false, loadError: true })
      }
      return
    }
    if (!this.unloaded) {
      this.setData({ loading: false, pending: result.pending, versions: result.list })
    }
  },

  install(event) {
    const index = Number(event.currentTarget.dataset.index)
    const target = this.data.versions[index]
    if (!target) {
      return
    }
    if (!fpgaFirmware.isHttpUrl(target.url)) {
      toast.show({ title: '该版本固件地址无效，暂时无法安装', icon: 'none' })
      return
    }
    fpgaFirmware.saveTarget(this.data.id, target)
    wx.navigateTo({ url: `/subpackages/device/wifi-ota/wifi-ota?id=${this.data.id}&mode=fpga` })
  },

  retryLoad() {
    this.load()
  }
}))
