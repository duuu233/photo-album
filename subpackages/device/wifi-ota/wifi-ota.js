const api = require('../../../utils/api')
const iotApi = require('../../../utils/iot-api')
const iotWs = require('../../../utils/iot-ws')
const toast = require('../../../utils/toast')
const system = require('../../../utils/system')
const fold = require('../../../utils/fold-adapt')
const wifiStatus = require('../../../utils/wifi-status')
const wifiOta = require('../../../utils/wifi-ota')
const fpgaFirmware = require('../../../utils/fpga-firmware')

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
//   · 进度条（2026-11-12）：步骤上方一条，左边当前那一步的文案、右边百分比。服务端 progress（轮询与 WS 都带）只抬「上限」，
//     显示值由本页计时器匀速往上限走（规则见 utils/wifi-ota.js「升级进度条」）；失败停住，VERIFYING 走到 100。
//     收到过的最大进度存进本地记录，重进页面从那里接着走。
//   · 渲染固件安装（2026-11-13，mode=fpga，从「渲染固件管理」进来，见 utils/fpga-firmware.js）：不比对版本，安装目标
//     （版本号、简介、固件地址）由列表页经本地存储带来；下发同一个 POST /api/device/ota，type=fpga、version=目标版本；
//     进度条、四步、轮询 / WS、本地进行中记录与固件升级完全一致，只换文字（fpgaFirmware.TEXTS）并显示简介。
//     本地记录带 otaType，重进时（无论从哪个入口）按记录里的类型选文字。
const POLL_MS = 3000

const OTA_ART = {
  progress: '/assets/images/upload-icon01.png',
  fail: '/assets/images/upload-icon02.png',
  success: '/assets/images/upload-icon03.png'
}


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
    showVersions: false,
    progress: 0,
    progressText: '',
    // 文字随模式切换（固件升级 / 渲染固件安装）
    navTitle: fpgaFirmware.TEXTS.main.nav,
    confirmText: fpgaFirmware.TEXTS.main.confirmText,
    retryText: fpgaFirmware.TEXTS.main.retryText,
    targetLabel: fpgaFirmware.TEXTS.main.targetLabel,
    intro: '' // 渲染固件简介
  },

  onLoad(options) {
    this.setData(Object.assign(system.getLayoutMetrics(), { id: (options && options.id) || '' }))
    this._entryMode = options && options.mode === fpgaFirmware.OTA_TYPE_FPGA ? fpgaFirmware.OTA_TYPE_FPGA : wifiOta.OTA_TYPE_MAIN
    this.useType(this._entryMode)
    this._lastStep = -1
    this.resetProgress()
    // WS 只推状态信号：带了 status 就先按它画，再补查一次（3.9.2）；progress（2026-11-12）每条进度回执推一次，同样交给 applyStatus
    this._offOta = iotWs.on('ota.result', event => {
      if (!event || !this._msgid || String(event.msgid) !== String(this._msgid)) {
        return
      }
      if (event.status || wifiOta.parseProgress(event.progress) !== null) {
        this.applyStatus(event.status || this._status, event)
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
    this.stopProgress()
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

  // 按升级类型切文字：main 固件升级 / fpga 渲染固件安装
  useType(type) {
    this._otaType = type === fpgaFirmware.OTA_TYPE_FPGA ? fpgaFirmware.OTA_TYPE_FPGA : wifiOta.OTA_TYPE_MAIN
    this.texts = fpgaFirmware.textsFor(this._otaType)
    this.setScreen({ navTitle: this.texts.nav, confirmText: this.texts.confirmText, retryText: this.texts.retryText, targetLabel: this.texts.targetLabel })
  },

  // 四步里最后一步的文字跟着模式换（其余三步两种模式相同）
  stepText(index) {
    return index === wifiOta.STEP_TEXTS.length - 1 ? this.texts.doneStep : wifiOta.STEP_TEXTS[index]
  },

  withStepTexts(steps) {
    return (steps || []).map((step, index) => Object.assign({}, step, { text: this.stepText(index) }))
  },

  failTitleFor(status) {
    return wifiOta.normalizeStatus(status) === 'TIMEOUT' ? this.texts.timeoutTitle : this.texts.failTitle
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
    this.resetProgress()
    this.useType(this._entryMode)
    this.setScreen({
      phase: 'checking',
      title: this.texts.checkingTitle,
      hint: this.texts.checkingHint,
      art: OTA_ART.progress,
      showSteps: false,
      showVersions: false,
      intro: ''
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
    if (this._otaType === fpgaFirmware.OTA_TYPE_FPGA) {
      this.showFpgaTarget(info)
      return
    }
    const current = (info && (info.firmwareVersion || (info.shadow || {}).version)) || ''
    const result = wifiOta.evaluate(current, device.newVersionNo, device.downloadPath)
    this.evaluation = result
    this.showEvaluation(result)
  },

  // 渲染固件安装：不比对版本，直接展示列表页选中的目标（版本号 + 简介）
  showFpgaTarget(info) {
    const target = fpgaFirmware.readTarget(this.data.id)
    if (!target) {
      this.showError('没有选中要安装的版本，请返回「渲染固件管理」重新选择')
      return
    }
    const current = String(((info && info.shadow) || {}).fpgaVersion || '').trim()
    const result = {
      state: fpgaFirmware.isHttpUrl(target.url) ? 'available' : 'invalid',
      current,
      latest: target.version,
      url: target.url,
      intro: target.intro || ''
    }
    this.evaluation = result
    this.setScreen({
      phase: result.state,
      title: `安装渲染固件 ${result.latest}`,
      hint: result.state === 'available' ? '安装期间设备会自动重启，请保持设备通电和网络连接' : '该版本固件地址无效，暂时无法安装',
      art: result.state === 'available' ? OTA_ART.progress : OTA_ART.fail,
      currentVersion: current || '--',
      latestVersion: result.latest,
      showVersions: true,
      showSteps: false,
      intro: result.intro
    })
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
    this.useType(record.otaType)
    this.setScreen({ intro: record.intro || '' })
    this._msgid = record.msgid
    this._lastStep = typeof record.lastStep === 'number' ? record.lastStep : -1
    // 进度条从收到过的最大进度接着走（本地记录与这次查询取大的）
    this.resetProgress()
    const saved = wifiOta.parseProgress(record.progress)
    const fresh = wifiOta.parseProgress(inflight.data && inflight.data.progress)
    if (saved !== null || fresh !== null) {
      this._reported = Math.max(saved || 0, fresh || 0)
      this._shown = Math.min(this._reported, 99)
    }
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
      title: `${this.texts.doneTitle} · ${wifiOta.WAIT_REBOOT_TEXT}`,
      hint: this._otaType === fpgaFirmware.OTA_TYPE_FPGA ? '设备重启后会确认安装结果，并通过消息中心通知您' : '设备重启后会确认升级结果，并通过消息中心通知您',
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
    if (status) {
      this._status = status
    }
    const reported = wifiOta.parseProgress(data && data.progress)
    if (reported !== null && reported > (this._reported || 0)) {
      this._reported = reported
    }
    const deviceNo = this.deviceNo()
    if (wifiOta.isFinal(status)) {
      wifiOta.clearInflight(deviceNo)
    } else if (index > -1) {
      wifiOta.updateInflight(deviceNo, Object.assign({ status, lastStep: this._lastStep }, this._reported !== null ? { progress: this._reported } : {}))
    }

    // SUCCESS 不在步骤页口径内；万一跳过 VERIFYING 直接到了，也按完成收尾，不让第 4 步一直转圈
    const view = wifiOta.stepsFor(status === 'SUCCESS' ? 'VERIFYING' : status, this._lastStep)
    view.steps = this.withStepTexts(view.steps)
    const progressText = this.stepText(wifiOta.activeStep(view))
    if (view.phase === 'failed') {
      this.stopPolling()
      this.stopProgress() // 失败停在当时的位置
      this.setScreen({
        phase: 'failed',
        title: this.failTitleFor(status),
        hint: '请确认设备在线、网络稳定后重新升级',
        art: OTA_ART.fail,
        showSteps: true,
        showVersions: false,
        steps: view.steps,
        progress: this._shown,
        progressText
      })
      return
    }
    // 不认识的状态值不动上限；其余按状态与收到过的最大进度定上限，计时器匀速往上走
    if (index > -1 || status === 'SUCCESS') {
      this._cap = wifiOta.progressCap(status, this._reported)
    }
    this.runProgress()
    if (view.phase === 'verifying') {
      this.stopPolling()
      this.setScreen({
        phase: 'verifying',
        title: this.texts.doneTitle,
        hint: status === 'SUCCESS' ? (this._otaType === fpgaFirmware.OTA_TYPE_FPGA ? '设备已重启，渲染固件安装成功' : '设备已重启，固件升级成功') : `${wifiOta.WAIT_REBOOT_TEXT}，结果将通过消息中心通知您`,
        art: OTA_ART.success,
        showSteps: true,
        showVersions: false,
        steps: view.steps,
        progress: this._shown,
        progressText
      })
      return
    }
    const elapsed = elapsedText(data && data.elapsedSeconds)
    this.setScreen({
      phase: 'running',
      title: this.texts.runningTitle,
      hint: elapsed ? `${elapsed}，${this.texts.runningHint}` : this.texts.runningHint,
      art: OTA_ART.progress,
      showSteps: true,
      showVersions: false,
      steps: view.steps,
      progress: this._shown,
      progressText
    })
  },

  // ── 进度条（2026-11-12，规则见 utils/wifi-ota.js「升级进度条」）──
  resetProgress() {
    this.stopProgress()
    this._reported = null // 本次升级收到过的最大 progress
    this._shown = 0 // 进度条显示值，只增不减
    this._cap = 0 // 显示值能走到的上限
    this._status = ''
  },

  // 显示值没到上限就每 PROGRESS_TICK_MS 走 1%，到了就停表，上限抬高后再开
  runProgress() {
    if (this._progressTimer || this.unloaded || this._shown >= this._cap) {
      return
    }
    this._progressTimer = setInterval(() => {
      if (this.unloaded || this._shown >= this._cap) {
        this.stopProgress()
        return
      }
      this._shown += 1
      this.setScreen({ progress: this._shown })
    }, wifiOta.PROGRESS_TICK_MS)
  },

  stopProgress() {
    if (this._progressTimer) {
      clearInterval(this._progressTimer)
      this._progressTimer = null
    }
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
    const fpga = this._otaType === fpgaFirmware.OTA_TYPE_FPGA
    wx.showModal({
      title: this.texts.confirmTitle,
      content: fpga
        ? `将安装渲染固件 ${result.latest}，安装期间设备会自动重启，请保持设备通电和网络连接`
        : `将升级到 ${result.latest}，升级期间设备会自动重启，请保持设备通电和网络连接`,
      confirmText: this.texts.confirmText,
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
    wx.showLoading({ title: this.texts.sending, mask: true })
    const type = this._otaType // main 固件升级 / fpga 渲染固件（version 为 FPGA 目标版本）
    let res
    try {
      res = await iotApi.startOta({
        deviceNo,
        url: result.url,
        type,
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
    wifiOta.saveInflight(deviceNo, msgid, Object.assign({
      version: result.latest,
      baseVersion: result.current,
      status: 'SENT',
      lastStep: 0
    }, type === fpgaFirmware.OTA_TYPE_FPGA ? { otaType: type, intro: result.intro || '' } : {}))
    this._msgid = String(msgid)
    this._lastStep = -1
    this.resetProgress()
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
