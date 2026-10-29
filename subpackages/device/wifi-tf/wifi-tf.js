const api = require('../../../utils/api')
const iotApi = require('../../../utils/iot-api')
const iotWs = require('../../../utils/iot-ws')
const toast = require('../../../utils/toast')
const system = require('../../../utils/system')
const fold = require('../../../utils/fold-adapt')
const wifiStatus = require('../../../utils/wifi-status')
const wifiTf = require('../../../utils/wifi-tf')

// WiFi 版 TF 卡设置（2026-10-29，docs/wifi/前端对接20261029.md）。入口：WiFi 详情「TF卡」行（有卡才能点）。
//   · 开关「TF卡播放」：开 = 设备当前是本地模式（LOCAL_TF）；不存本地，设备重新入网后自然回到关闭。
//   · 开启：先查 /api/device/info，只有在线且 tfStatus=present 才弹二次确认，否则不让开并提示；
//     确认后 POST /api/device/play-tf → 等 WS command.result（按 msgid，30 秒），期间 loading 防重复点击。
//     success=true：提示即将进入本地模式；false：设备拒绝，状态不变；超时：补查一次，已是本地模式按成功，否则提示未响应。
//   · 关闭：协议没有远程切回指令，只能在设备端重新入网，点了只提示。
//   · 本期不做 TF 卡清除。
Page(fold.adapt({
  data: {
    statusBarHeight: 20,
    safeBottom: 0,
    id: '',
    loading: true,
    loadError: false,
    device: null,
    status: 'loading',
    tfText: '--',
    tfOn: false,
    switching: false
  },

  onLoad(options) {
    this.setData(Object.assign(system.getLayoutMetrics(), { id: (options && options.id) || '' }))
    this._offStatus = iotWs.on('device.status', event => {
      if (this.data.device && event && String(event.deviceNo || '').replace(/[:\-\s]/g, '').toUpperCase() === this.deviceNo()) {
        this.refresh()
      }
    })
    this.load()
  },

  onUnload() {
    this.unloaded = true
    if (this._offStatus) {
      this._offStatus()
    }
    if (this._waiter) {
      this._waiter.dispose()
    }
    if (this._subscribed) {
      iotWs.unsubscribe(this._subscribed)
    }
  },

  deviceNo() {
    const device = this.data.device || {}
    return String(device.productDeviceId || device.deviceNo || '').replace(/[:\-\s]/g, '').toUpperCase()
  },

  async load() {
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
    this.setData({ device, loading: false, loadError: false })
    // command.result / device.status 需先订阅；详情页通常已订阅，没订才订
    const deviceNo = this.deviceNo()
    if (deviceNo && iotWs.getSubscriptions().indexOf(deviceNo) === -1) {
      iotWs.subscribe(deviceNo)
      this._subscribed = deviceNo
    }
    await this.refresh()
  },

  retryLoad() {
    this.setData({ loading: true, loadError: false })
    this.load()
  },

  // 查状态与影子；返回 info（查不到为 null）
  async refresh() {
    let info = null
    try {
      info = await iotApi.getDeviceInfo(this.deviceNo(), { showError: false })
    } catch (error) {
      info = null
    }
    if (this.unloaded) {
      return info
    }
    const status = info ? wifiStatus.deviceState(info) : 'unknown'
    const tf = wifiTf.tfState(info && info.shadow)
    if (status === 'local') {
      this._acceptedAt = 0 // 已进入本地模式，此后开关只看状态：设备重新入网即回到关闭
    }
    this.setData({ status, tfText: tf.text, tfOn: this.isOn(status) })
    return info
  },

  // 开关显示：本地模式为开；设备刚接受切换、还没断开的那一小段（60 秒内）也显示开
  isOn(status) {
    return status === 'local' || this.data.switching || (!!this._acceptedAt && Date.now() - this._acceptedAt < 60000)
  },

  async toggleTf(e) {
    const turningOn = !!(e && e.detail && e.detail.value)
    if (!turningOn) {
      // 本地模式下才会是开；协议没有切回指令
      this.setData({ tfOn: this.isOn(this.data.status) })
      toast.show({ title: '如需恢复联网，请在设备上重新入网', icon: 'none' })
      return
    }
    this.setData({ tfOn: false }) // 先还原，确认并成功后再由状态驱动
    if (this.data.switching) {
      return
    }
    wx.showLoading({ title: '检查设备', mask: true })
    const info = await this.refresh()
    wx.hideLoading()
    if (this.unloaded) {
      return
    }
    const status = this.data.status
    if (status !== 'online') {
      toast.show({ title: wifiStatus.blockedTip(status) || wifiStatus.NOT_ONLINE_TIP, icon: 'none' })
      return
    }
    const tf = wifiTf.tfState(info && info.shadow)
    if (tf.state !== 'present') {
      toast.show({ title: tf.state === 'absent' ? '设备未插TF卡，无法开启' : '未检测到TF卡，请稍后重试', icon: 'none' })
      return
    }
    wx.showModal({
      title: '开启TF卡播放',
      content: '开启后设备将断开网络进入本地模式，无法进行APP投屏，也无法在APP取消本地模式；如需恢复，请在设备上重新入网。确认开启？',
      confirmText: '开启',
      confirmColor: '#ff6a20',
      success: res => {
        if (res.confirm) {
          this.startPlayTf()
        }
      }
    })
  },

  async startPlayTf() {
    if (this.data.switching) {
      return
    }
    const deviceNo = this.deviceNo()
    this.setData({ switching: true })
    wx.showLoading({ title: '切换中', mask: true })
    const waiter = wifiTf.createResultWaiter(iotWs, deviceNo, 'play_tf')
    this._waiter = waiter
    let outcome
    try {
      const res = await iotApi.playTf(deviceNo, { showError: false })
      outcome = await waiter.wait(res && res.msgid, wifiTf.RESULT_TIMEOUT_MS)
    } catch (error) {
      console.warn('[WiFi TF] play-tf 失败', error && error.code, error && error.message)
      outcome = { error }
    } finally {
      waiter.dispose()
      this._waiter = null
    }
    if (this.unloaded) {
      wx.hideLoading()
      return
    }
    // 超时：WS 可能断过，补查一次在线状态，已是本地模式就算成功
    if (outcome.timeout) {
      try {
        const online = await iotApi.getDeviceOnline(deviceNo, undefined, { showError: false })
        if (wifiStatus.deviceState(online) === 'local') {
          outcome = { success: true }
        }
      } catch (error) {
        // 保持超时
      }
    }
    wx.hideLoading()
    if (this.unloaded) {
      return
    }
    let tip
    if (outcome.error) {
      tip = wifiTf.playTfErrorText(outcome.error)
    } else if (outcome.timeout) {
      tip = '设备未响应，请稍后重试'
    } else if (outcome.success) {
      tip = '设备已切换，即将进入本地模式'
    } else {
      tip = `设备拒绝切换（result=${outcome.result}）`
    }
    // 成功后设备数秒内断开，device.status=LOCAL_TF 推送到了再由状态驱动；这之前按已接受显示为开
    if (outcome.success) {
      this._acceptedAt = Date.now()
    }
    this.setData({ switching: false })
    this.setData({ tfOn: this.isOn(this.data.status) })
    toast.show({ title: tip, icon: 'none' })
    this.refresh()
  }
}))
