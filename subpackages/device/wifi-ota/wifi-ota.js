const api = require('../../../utils/api')
const iotApi = require('../../../utils/iot-api')
const iotWs = require('../../../utils/iot-ws')
const toast = require('../../../utils/toast')
const system = require('../../../utils/system')
const fold = require('../../../utils/fold-adapt')
const wifiStatus = require('../../../utils/wifi-status')
const wifiOta = require('../../../utils/wifi-ota')

// WiFi 版设备固件升级（2026-11-02，docs/前端对接文档20261031.md；纯逻辑见 utils/wifi-ota.js）。
//
// 页面形态与配网状态页相同（样式直接引用 wifi-provision.wxss）：插画 + 标题 + 说明 + 四步状态圈 + 底部按钮。
//   · 进页先看本地有没有这台设备进行中的升级记录（ota_inflight:{deviceNo}）：
//       有且 SENT / DOWNLOADING / FLASHING → 直接进步骤页接着展示；
//       VERIFYING → 不再进步骤页，显示「升级完成 · 等待设备重启」，不提示升级（对接文档 1.3 第 3 条、3.3）；
//       终态 / 4044 → 清记录，按正常检查走。
//   · 正常检查：老服务 getDeviceDetail 的 newVersionNo / downloadPath 对比 IoT 设备信息 firmwareVersion，
//     显示「发现新版本」（立即升级）/「已是最新版本」/「暂时无法判断」（当前版本未按新格式上报）/「升级包信息不完整」。
//   · 下发成功立即存 msgid（带 type: 'ota'），然后 3 秒轮询 GET /api/device/ota/status，WS ota.result 到了立即按它刷新
//     （WS 只是加速，断线丢事件由轮询兜底）。VERIFYING 第 4 步打勾即可离开；FAILED / TIMEOUT 在当前步打叉、给「重新升级」。
//   · 4000 / 4045（已有进行中的升级）：切到「设备正在升级」，不当普通失败。
//   · 最终结果（SUCCESS / FAILED）由服务端通过消息通知送达（OTA_SUCCESS / OTA_FAILED），本页不提供历史结果入口。
const POLL_MS = 3000

const OTA_ART = {
  progress: '/assets/images/upload-icon01.png',
  fail: '/assets/images/upload-icon02.png',
  success: '/assets/images/upload-icon03.png'
}

const RUNNING_TITLE = '设备正在升级'
const RUNNING_HINT = '升级期间请保持设备通电和网络连接，可离开本页，进度不受影响'

function elapsedText(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0))
  if (!value) {
    return ''
  }
  const minutes = Math.floor(value / 60)
  const rest = value % 60
  return minutes ? `已进行 ${minutes} 分 ${rest} 秒` : `已进行 ${rest} 秒`
}

Page(fold.adapt({
  data: {
    statusBarHeight: 20,
    safeBottom: 0,
    id: '',
    // checking / available / latest / unknown / invalid / error / running / verifying / failed / busy
    phase: 'checking',
    title: '检测版本中',
    hint: '正在检查固件版本，请稍候…',
    art: OTA_ART.progress,
    showSteps: false,
    steps: wifiOta.stepsFor('').steps,
    currentVersion: '',
    latestVersion: '',
    showVersions: false
  },

  onLoad(options) {
    this.setData(Object.assign(system.getLayoutMetrics(), { id: (options && options.id) || '' }))
    this._lastStep = -1
    // WS 只推状态信号：带了 status 就先按它画，再补查一次（3.9.2）
    this._offOta = iotWs.on('ota.result', event => {
      if (!event || !this._msgid || String(event.msgid) !== String(this._msgid)) {
        return
      }
      if (event.status) {
        this.applyStatus(event.status, null)
      }
      this.pollOnce()
    })
    // WS 重连期间的事件会丢，重连后补查
    this._offState = iotWs.on('state', event => {
      if (event && event.state === 'open' && event.reconnect && this._msgid) {
        this.pollOnce()
      }
    })
    this.load()
  },

  onShow() {
    if (this._hidden) {
      this._hidden = false
      if (this.data.phase === 'running') {
        this.startPolling()
      }
    }
  },

  onHide() {
    this._hidden = true
    this.stopPolling()
  },

  onUnload() {
    this.unloaded = true
    this.stopPolling()
    if (this._offOta) {
      this._offOta()
    }
    if (this._offState) {
      this._offState()
    }
    if (this._subscribed) {
      iotWs.unsubscribe(this._subscribed)
    }
  },

  setScreen(values) {
    if (!this.unloaded) {
      this.setData(values)
    }
  },

  deviceNo() {
    const device = this.device || {}
    return wifiOta.plainDeviceNo(device.productDeviceId || device.deviceNo)
  },

  async load() {
    this.stopPolling()
    this._msgid = ''
    this._lastStep = -1
    this.setScreen({
      phase: 'checking',
      title: '检测版本中',
      hint: '正在检查固件版本，请稍候…',
      art: OTA_ART.progress,
      showSteps: false,
      showVersions: false
    })
    let device
    try {
      device = await api.getDeviceDetail(this.data.id)
    } catch (error) {
      this.showError('设备信息加载失败，请稍后重试')
      return
    }
    if (this.unloaded) {
      return
    }
    this.device = device
    const deviceNo = this.deviceNo()
    if (!deviceNo) {
      this.showError('缺少设备编号，无法检查固件版本')
      return
    }
    if (this._subscribed !== deviceNo && iotWs.getSubscriptions().indexOf(deviceNo) === -1) {
      iotWs.subscribe(deviceNo)
      this._subscribed = deviceNo
    }

    // ① 先看本地进行中的升级（展示「有新版本」之前必须先查，对接文档 3.3）
    const inflight = await wifiOta.refreshInflight(deviceNo)
    if (this.unloaded) {
      return
    }
    if (inflight.record) {
      this.resumeInflight(inflight)
      return
    }

    // ② 没有进行中的任务：正常比对版本
    let info = null
    try {
      info = await iotApi.getDeviceInfo(deviceNo, { showError: false })
    } catch (error) {
      info = null
    }
    if (this.unloaded) {
      return
    }
    this.info = info
    this.deviceState = info ? wifiStatus.deviceState(info) : 'unknown'
    const current = (info && (info.firmwareVersion || (info.shadow || {}).version)) || ''
    const result = wifiOta.evaluate(current, device.newVersionNo, device.downloadPath)
    this.evaluation = result
    this.showEvaluation(result)
  },

  showError(message) {
    this.setScreen({
      phase: 'error',
      title: '检查失败',
      hint: message,
      art: OTA_ART.fail,
      showSteps: false,
      showVersions: false
    })
  },

  showEvaluation(result) {
    const versions = {
      currentVersion: result.current || '--',
      latestVersion: result.latest || '--',
      showVersions: true,
      showSteps: false
    }
    if (result.state === 'available') {
      this.setScreen(Object.assign(versions, {
        phase: 'available',
        title: `发现新版本 ${result.latest}`,
        hint: '升级期间设备会自动重启，请保持设备通电和网络连接',
        art: OTA_ART.progress
      }))
      return
    }
    if (result.state === 'unknown') {
      // 当前版本还是旧格式或没上报过：按「无法判断」处理，不报错（对接文档 2.3）
      this.setScreen(Object.assign(versions, {
        phase: 'unknown',
        title: '暂时无法判断是否有新版本',
        hint: '设备尚未上报当前固件版本，请确认设备在线后重新检查',
        art: OTA_ART.progress
      }))
      return
    }
    if (result.state === 'invalid') {
      this.setScreen(Object.assign(versions, {
        phase: 'invalid',
        title: `发现新版本 ${result.latest}`,
        hint: '升级包信息不完整，暂时无法升级，请稍后再试',
        art: OTA_ART.fail
      }))
      return
    }
    this.setScreen(Object.assign(versions, {
      phase: 'latest',
      title: '已是最新版本',
      hint: result.current ? `当前固件版本 ${result.current}` : '当前没有可用的固件更新',
      art: OTA_ART.success,
      latestVersion: result.latest || result.current || '--'
    }))
  },

  // 重进页面时接着展示本地记录的任务
  resumeInflight(inflight) {
    const record = inflight.record
    this._msgid = record.msgid
    this._lastStep = typeof record.lastStep === 'number' ? record.lastStep : -1
    const status = wifiOta.normalizeStatus(inflight.status || record.status || 'SENT')
    if (status === 'VERIFYING') {
      this.showWaitingReboot()
      return
    }
    this.applyStatus(status, inflight.data || null)
    if (this.data.phase === 'running') {
      this.startPolling()
    }
  },

  // VERIFYING 之后重进：不进步骤页、不提示升级，等设备重启后服务端确认
  showWaitingReboot() {
    this.stopPolling()
    this.setScreen({
      phase: 'busy',
      title: `升级完成 · ${wifiOta.WAIT_REBOOT_TEXT}`,
      hint: '设备重启后会确认升级结果，并通过消息中心通知您',
      art: OTA_ART.success,
      showSteps: false,
      showVersions: false
    })
  },

  // 已有进行中的升级（4000 / 4045，本地没有 msgid 可查）
  showBusy() {
    this.stopPolling()
    this.setScreen({
      phase: 'busy',
      title: wifiOta.IN_PROGRESS_TIP,
      hint: '设备已有进行中的升级任务，结果将通过消息中心通知您',
      art: OTA_ART.progress,
      showSteps: false,
      showVersions: false
    })
  },

  // 按服务端状态画步骤页；data 为状态查询结果（可为空）
  applyStatus(rawStatus, data) {
    if (this.unloaded) {
      return
    }
    const status = wifiOta.normalizeStatus(rawStatus)
    const index = wifiOta.stepIndex(status)
    if (index > this._lastStep) {
      this._lastStep = index
    }
    const deviceNo = this.deviceNo()
    if (wifiOta.isFinal(status)) {
      wifiOta.clearInflight(deviceNo)
    } else if (index > -1) {
      wifiOta.updateInflight(deviceNo, { status, lastStep: this._lastStep })
    }

    // SUCCESS 不在步骤页口径内；万一跳过 VERIFYING 直接到了，也按完成收尾，不让第 4 步一直转圈
    const view = wifiOta.stepsFor(status === 'SUCCESS' ? 'VERIFYING' : status, this._lastStep)
    if (view.phase === 'failed') {
      this.stopPolling()
      this.setScreen({
        phase: 'failed',
        title: wifiOta.failTitle(status),
        hint: '请确认设备在线、网络稳定后重新升级',
        art: OTA_ART.fail,
        showSteps: true,
        showVersions: false,
        steps: view.steps
      })
      return
    }
    if (view.phase === 'verifying') {
      this.stopPolling()
      this.setScreen({
        phase: 'verifying',
        title: '升级完成',
        hint: status === 'SUCCESS' ? '设备已重启，固件升级成功' : `${wifiOta.WAIT_REBOOT_TEXT}，结果将通过消息中心通知您`,
        art: OTA_ART.success,
        showSteps: true,
        showVersions: false,
        steps: view.steps
      })
      return
    }
    const elapsed = elapsedText(data && data.elapsedSeconds)
    this.setScreen({
      phase: 'running',
      title: RUNNING_TITLE,
      hint: elapsed ? `${elapsed}，${RUNNING_HINT}` : RUNNING_HINT,
      art: OTA_ART.progress,
      showSteps: true,
      showVersions: false,
      steps: view.steps
    })
  },

  startPolling() {
    this.stopPolling()
    if (this.unloaded || !this._msgid) {
      return
    }
    this._pollTimer = setInterval(() => this.pollOnce(), POLL_MS)
  },

  stopPolling() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer)
      this._pollTimer = null
    }
  },

  async pollOnce() {
    const msgid = this._msgid
    if (!msgid || this._polling || this.unloaded) {
      return
    }
    this._polling = true
    let data = null
    try {
      data = await iotApi.getOtaStatus(msgid, { showError: false })
    } catch (error) {
      this._polling = false
      if (error && Number(error.code) === 4044 && msgid === this._msgid) {
        // 任务过期（服务端只留 2 小时）：清记录，回到正常检查
        wifiOta.clearInflight(this.deviceNo())
        this._msgid = ''
        this.load()
      }
      return // 网络 / 503 等：保持当前画面，下一轮再查
    }
    this._polling = false
    if (msgid !== this._msgid || this.unloaded) {
      return
    }
    // 已经停在完成 / 失败上的，迟到的查询结果不再改画面
    if (this.data.phase !== 'running') {
      return
    }
    this.applyStatus(data && data.status, data)
  },

  // 「立即升级」/「重新升级」
  startUpgrade() {
    const result = this.evaluation
    if (this._starting || !result || !this.device) {
      return
    }
    const tip = wifiStatus.blockedTip(this.deviceState)
    if (tip) {
      toast.show({ title: tip, icon: 'none' })
      return
    }
    wx.showModal({
      title: '固件升级',
      content: `将升级到 ${result.latest}，升级期间设备会自动重启，请保持设备通电和网络连接`,
      confirmText: '立即升级',
      success: res => {
        if (res.confirm) {
          this.sendUpgrade()
        }
      }
    })
  },

  async sendUpgrade() {
    const result = this.evaluation
    const deviceNo = this.deviceNo()
    if (this._starting || !result || !deviceNo) {
      return
    }
    this._starting = true
    wx.showLoading({ title: '下发中', mask: true })
    let res
    try {
      res = await iotApi.startOta({
        deviceNo,
        url: result.url,
        type: wifiOta.OTA_TYPE_MAIN,
        version: result.latest
      }, { showError: false })
    } catch (error) {
      wx.hideLoading()
      this._starting = false
      if (wifiOta.isBusyError(error)) {
        toast.show({ title: wifiOta.IN_PROGRESS_TIP, icon: 'none' })
        this.showBusy()
        return
      }
      const message = String((error && error.message) || '升级指令下发失败').replace(/^接口\(IoT\)-/, '')
      toast.warn({ title: message, icon: 'none' })
      return
    }
    wx.hideLoading()
    this._starting = false
    const msgid = res && res.msgid
    if (!msgid) {
      toast.warn({ title: '升级指令下发失败，请重试', icon: 'none' })
      return
    }
    // 下发成功立即保存（带类型），一台设备只留一条（对接文档 3.1 / 3.2）
    wifiOta.saveInflight(deviceNo, msgid, {
      version: result.latest,
      baseVersion: result.current,
      status: 'SENT',
      lastStep: 0
    })
    this._msgid = String(msgid)
    this._lastStep = -1
    this.applyStatus('SENT', null)
    this.startPolling()
  },

  // 失败后的「重新升级」：本页走过版本比对的直接再下发；从本地记录恢复进来的没有比对结果，先重新检查
  retryUpgrade() {
    if (this.evaluation && this.evaluation.state === 'available') {
      this.startUpgrade()
      return
    }
    this.load()
  },

  retryCheck() {
    this.load()
  },

  finish() {
    wx.navigateBack({
      fail() {
        wx.switchTab({ url: '/pages/home/home' })
      }
    })
  }
}))
