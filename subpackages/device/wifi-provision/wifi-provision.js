const system = require('../../../utils/system')
const fold = require('../../../utils/fold-adapt')
const wifiProvision = require('../../../utils/wifi-provision')

const app = getApp()

// WiFi 版设备配网第二步：配网状态（2026-10-26，STEP 2 接入真实流程，流程本体见 utils/wifi-provision.js）。
//
// 四个状态依次执行：执行中的状态圈转圈，通过打勾；全部通过标题改「设备入网成功」并出「立即体验」（选中该设备回首页）；
// 任一步失败打叉、标题改成具体错误，出「重新配网」「取消」。重新配网从第 1 步整套重来
// （已绑定过的设备第 3 步会复用原绑定记录，不会重复绑定）。离开页面即取消，蓝牙连接随之释放。
// 配网日志面板（10-26 联调用）已于 2026-10-27 按产品要求删除。

const RUNNING_TITLE = '设备正在进行配网'
const SUCCESS_TITLE = '设备入网成功'

function freshSteps() {
  return wifiProvision.STEP_TEXTS.map((text, index) => ({ key: index, text, status: 'pending' }))
}

Page(fold.adapt({
  data: {
    statusBarHeight: 20,
    safeBottom: 0,
    deviceNo: '',
    deviceName: '',
    phase: 'running', // running / success / failed
    title: RUNNING_TITLE,
    steps: freshSteps()
  },

  onLoad(options) {
    this.setData(system.getLayoutMetrics())
    const decode = value => {
      try {
        return decodeURIComponent(value || '')
      } catch (error) {
        return value || ''
      }
    }
    this.setData({
      deviceNo: decode(options && options.deviceNo),
      deviceName: decode(options && options.name)
    })
    this.start()
  },

  onUnload() {
    this.unloaded = true
    if (wx.setKeepScreenOn) {
      wx.setKeepScreenOn({ keepScreenOn: false })
    }
  },

  setStep(index, status) {
    if (this.unloaded) {
      return
    }
    this.setData({ [`steps[${index}].status`]: status })
  },

  async start() {
    const job = wifiProvision.getJob()
    this.runId = (this.runId || 0) + 1
    const runId = this.runId
    this.device = null
    this.setData({ phase: 'running', title: RUNNING_TITLE, steps: freshSteps() })
    if (!job) {
      // 交接信息丢了（如小程序被回收后重进本页）：没有 WiFi 密码与设备句柄，只能回去重填
      this.setStep(0, 'fail')
      this.setData({ phase: 'failed', title: '配网信息已失效，请返回重新配网' })
      return
    }
    // 配网全程约 1 分钟，期间息屏会让蓝牙被挂起
    if (wx.setKeepScreenOn) {
      wx.setKeepScreenOn({ keepScreenOn: true })
    }
    try {
      const result = await wifiProvision.run(job, {
        onStep: (index, status) => {
          if (runId === this.runId) {
            this.setStep(index, status)
          }
        },
        isCancelled: () => this.unloaded || runId !== this.runId
      })
      if (this.unloaded || runId !== this.runId) {
        return
      }
      this.device = result.device
      this.setData({ phase: 'success', title: SUCCESS_TITLE })
    } catch (error) {
      if (this.unloaded || runId !== this.runId) {
        return
      }
      const step = typeof error.step === 'number' ? error.step : 0
      this.setStep(step, 'fail')
      this.setData({ phase: 'failed', title: error.message || '配网失败，请重试' })
    } finally {
      if (!this.unloaded && runId === this.runId && wx.setKeepScreenOn) {
        wx.setKeepScreenOn({ keepScreenOn: false })
      }
    }
  },

  // 立即体验：选中刚配好的设备，回到首页（首页即该设备的主页）
  goExperience() {
    if (this.device) {
      app.setSelectedDevice(this.device)
    }
    wx.switchTab({ url: '/pages/home/home' })
  },

  retry() {
    this.start()
  },

  // 取消：回到 WiFi 填写页
  cancel() {
    wx.navigateBack({
      fail() {
        wx.switchTab({ url: '/pages/home/home' })
      }
    })
  }
}))
