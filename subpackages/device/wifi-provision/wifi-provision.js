const system = require('../../../utils/system')
const fold = require('../../../utils/fold-adapt')

// WiFi 版设备配网第二步：配网状态（2026-10-26，STEP 1 静态页）。
//
// 四个状态依次校验：前 3 个前端自己判断，第 4 个看服务端接口：
//   1 手机网络正常           —— 本地检测手机网络
//   2 设备网络配置已完成     —— BLE BluFi 下发 mqtt_config，设备回 result=0
//   3 设备正在连接Wi-Fi      —— 设备侧过程，无状态上报，第 2 步成功后直接展示
//   4 设备正在连接云端       —— 轮询 IoT GET /api/device/online?deviceNo=&since=，online=true 即成功
// 执行中的状态图标转圈，通过打勾；全部通过标题改「设备入网成功」并出「立即体验」；
// 任一步失败打叉、标题改成具体错误，出「重新配网」「取消」。
//
// 本阶段只做版式与状态流转的演示（runDemo 按固定节奏逐步通过，不碰网络 / 蓝牙），
// STEP 2 把每一步换成真实校验。开发调试可带 ?demo=fail 演示第 4 步失败的样子。
const STEP_TEXTS = ['手机网络正常', '设备网络配置已完成', '设备正在连接Wi-Fi', '设备正在连接云端']
const DEMO_STEP_MS = 900
const RUNNING_TITLE = '设备正在进行配网'
const SUCCESS_TITLE = '设备入网成功'
const DEMO_FAIL_MESSAGE = '设备联网超时，请检查WiFi密码或信号后重试'

function freshSteps() {
  return STEP_TEXTS.map((text, index) => ({ key: index, text, status: 'pending' }))
}

Page(fold.adapt({
  data: {
    statusBarHeight: 20,
    safeBottom: 0,
    deviceNo: '',
    deviceName: '',
    ssid: '',
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
    this.demoFail = !!(options && options.demo === 'fail')
    this.setData({
      deviceNo: decode(options && options.deviceNo),
      deviceName: decode(options && options.name),
      ssid: decode(options && options.ssid)
    })
    this.runDemo()
  },

  onUnload() {
    this.unloaded = true
    clearTimeout(this.demoTimer)
  },

  setStep(index, status) {
    this.setData({ [`steps[${index}].status`]: status })
  },

  // 演示流转：逐步 loading → done；demo=fail 时第 4 步失败
  runDemo() {
    clearTimeout(this.demoTimer)
    this.setData({ phase: 'running', title: RUNNING_TITLE, steps: freshSteps() })
    const next = index => {
      if (this.unloaded) {
        return
      }
      if (index >= STEP_TEXTS.length) {
        this.setData({ phase: 'success', title: SUCCESS_TITLE })
        return
      }
      this.setStep(index, 'loading')
      this.demoTimer = setTimeout(() => {
        if (this.unloaded) {
          return
        }
        if (this.demoFail && index === STEP_TEXTS.length - 1) {
          this.setStep(index, 'fail')
          this.setData({ phase: 'failed', title: DEMO_FAIL_MESSAGE })
          return
        }
        this.setStep(index, 'done')
        next(index + 1)
      }, DEMO_STEP_MS)
    }
    next(0)
  },

  // 立即体验：跳到该设备的首页。静态阶段还没有真正绑定，先回首页
  goExperience() {
    wx.switchTab({ url: '/pages/home/home' })
  },

  retry() {
    this.runDemo()
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
