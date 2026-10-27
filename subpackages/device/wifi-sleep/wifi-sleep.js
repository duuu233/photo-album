const api = require('../../../utils/api')
const iotApi = require('../../../utils/iot-api')
const toast = require('../../../utils/toast')
const system = require('../../../utils/system')
const fold = require('../../../utils/fold-adapt')
const wifiStatus = require('../../../utils/wifi-status')
const sleep = require('../../../utils/wifi-sleep')

// WiFi 版休眠设置（2026-10-27，docs/wifi/V1.4对接实现报告反馈.md 第二节）。入口：WiFi 设备详情「休眠设置」。
//   · 回显：IoT GET /api/device/sleep（只要权限，离线也能查）；从未设置显示「未开启休眠」；
//   · 三种模式：关闭（确认后提交 mode=0）/ 周期（休眠、唤醒两个 HH:mm，不能相同，可跨午夜）/
//     一次性（开始、结束各一个日期 + 时间，开始早于结束、结束不能已过）；
//   · 保存：IoT POST /api/device/sleep，只传本地时间、不转 UTC；要求设备在线，4041 补查给休眠 / 关机 / 离线提示，
//     4000 显示服务端给的具体字段；保存成功后重新查询回显。
// 换算与校验见 utils/wifi-sleep.js。
function plainDeviceNo(value) {
  return String(value || '').replace(/[:\-\s]/g, '').toUpperCase()
}

// 表单 + 派生的「唤醒是否跨到次日」（不在 WXML 里比字符串）
function formPatch(form) {
  return { form, crossDay: form.wakeTime < form.sleepTime }
}

function errorText(error, fallback) {
  return String((error && error.message) || fallback).replace(/^接口\(IoT\)-/, '')
}

Page(fold.adapt({
  data: {
    statusBarHeight: 20,
    safeBottom: 0,
    id: '',
    loading: true,
    loadError: false,
    device: null,
    summary: '',
    updatedAt: '',
    queryFailed: false,
    form: sleep.formFromSleep(null),
    crossDay: true,
    today: sleep.dateText(new Date()),
    saving: false
  },

  onLoad(options) {
    this.setData(Object.assign(system.getLayoutMetrics(), { id: (options && options.id) || '' }))
    this.load()
  },

  onUnload() {
    this.unloaded = true
  },

  deviceNo() {
    const device = this.data.device || {}
    return plainDeviceNo(device.productDeviceId || device.deviceNo)
  },

  async load() {
    this.setData({ loading: true, loadError: false })
    let device
    try {
      device = await api.getDeviceDetail(this.data.id)
    } catch (error) {
      if (!this.unloaded) {
        this.setData({ loading: false, loadError: true })
      }
      return
    }
    if (this.unloaded) {
      return
    }
    this.setData({ device })
    await this.loadPlan(true)
    if (!this.unloaded) {
      this.setData({ loading: false })
    }
  },

  // 查当前休眠计划；fillForm=true 时按它回填表单（进页时），保存后只刷新顶部说明
  async loadPlan(fillForm) {
    let plan = null
    try {
      plan = await iotApi.getSleep(this.deviceNo(), { showError: false })
      console.log('[WiFi休眠] 当前计划', JSON.stringify(plan))
    } catch (error) {
      console.warn('[WiFi休眠] 查询失败', error && error.code, error && error.message)
    }
    if (this.unloaded) {
      return
    }
    const patch = {
      queryFailed: !plan,
      summary: plan ? sleep.summary(plan) : '当前设置查询失败',
      updatedAt: (plan && plan.updatedAt) || ''
    }
    if (fillForm) {
      Object.assign(patch, formPatch(sleep.formFromSleep(plan)))
    }
    this.setData(patch)
  },

  retryLoad() {
    this.load()
  },

  setForm(patch) {
    this.setData(formPatch(Object.assign({}, this.data.form, patch)))
  },

  chooseMode(e) {
    this.setForm({ mode: Number(e.currentTarget.dataset.value) })
  },

  changeField(e) {
    this.setForm({ [e.currentTarget.dataset.field]: e.detail.value })
  },

  // 4041：补查在线状态，休眠 / 关机 / 离线给对应提示
  async offlineTip(error) {
    if (!error || Number(error.code) !== 4041) {
      return ''
    }
    try {
      const res = await iotApi.getDeviceOnline(this.deviceNo(), undefined, { showError: false })
      return wifiStatus.blockedTip(wifiStatus.deviceState(res)) || wifiStatus.OFFLINE_TIP
    } catch (queryError) {
      return wifiStatus.OFFLINE_TIP
    }
  },

  save() {
    if (this.data.saving || !this.data.device) {
      return
    }
    const built = sleep.buildPayload(this.deviceNo(), this.data.form)
    if (built.error) {
      toast.show({ title: built.error, icon: 'none' })
      return
    }
    if (built.payload.mode === sleep.MODE_OFF) {
      wx.showModal({
        title: '关闭休眠',
        content: '关闭后设备将保持联网，不再按计划休眠，确认关闭吗？',
        success: res => {
          if (res.confirm) {
            this.submit(built.payload)
          }
        }
      })
      return
    }
    this.submit(built.payload)
  },

  async submit(payload) {
    console.log('[WiFi休眠] 保存', JSON.stringify(payload))
    this.setData({ saving: true })
    try {
      await iotApi.setSleep(payload, { showError: false })
    } catch (error) {
      console.warn('[WiFi休眠] 保存失败', error && error.code, error && error.message)
      const tip = (await this.offlineTip(error)) || errorText(error, '保存失败，请稍后重试')
      if (!this.unloaded) {
        this.setData({ saving: false })
        toast.show({ title: tip, icon: 'none' })
      }
      return
    }
    if (this.unloaded) {
      return
    }
    toast.show({ title: payload.mode === sleep.MODE_OFF ? '已关闭休眠' : '休眠设置已保存', icon: 'none' })
    await this.loadPlan(false)
    if (!this.unloaded) {
      this.setData({ saving: false })
    }
  }
}))
