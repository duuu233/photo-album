const toast = require('../../utils/toast')
const api = require('../../utils/api')
const app = getApp()

Page({
  data: {
    agreed: false,
    submitting: false,
    leaving: false,
    loggingIn: false, // 登录成功过渡层：授权回调开始到 switchTab 落地期间全屏 loading
    loginTip: '正在登录…'
  },

  onShow() {
    // 已登录则无需停留在登录页，直接进入首页
    const token = app.globalData.token || wx.getStorageSync('token')
    const jwtToken =
      app.globalData.jwtToken || wx.getStorageSync('jwtToken')
    if (token && jwtToken) {
      wx.switchTab({
        url: '/pages/home/home'
      })
    }
  },

  // 协议勾选改为图片单选按钮，点击切换勾选状态
  onAgreementChange() {
    this.setData({
      agreed: !this.data.agreed
    })
  },

  // 未勾选协议时按钮无 getPhoneNumber 能力，仅触发 bindtap：提示先同意协议（避免提前弹授权框）
  onLoginTap() {
    if (!this.data.agreed) {
      this.showToast('请先同意用户协议和隐私政策')
    }
  },

  // open-type="getPhoneNumber" 的回调：detail 含手机号授权结果（code 或 encryptedData+iv）
  async onWechatLogin(event) {
    if (this.data.submitting) {
      return // 防重复点击
    }

    // 双重保险：勾选协议后才会触发该回调，这里再校验一次
    if (!this.data.agreed) {
      this.showToast('请先同意用户协议和隐私政策')
      return
    }

    const detail = (event && event.detail) || {}

    // 用户拒绝/取消授权：静默返回，不弹错误；其余失败给出提示
    if (!detail.code && !detail.encryptedData) {
      const errMsg = detail.errMsg || ''
      if (
        errMsg &&
        errMsg.indexOf('deny') === -1 &&
        errMsg.indexOf('cancel') === -1
      ) {
        this.showToast('获取手机号失败，请重试')
      }
      return
    }

    // 全屏过渡层立即出现：既是登录中的 loading 反馈，也盖住按钮防止重复点击
    this.setData({
      submitting: true,
      loggingIn: true,
      loginTip: '正在登录…'
    })

    try {
      await app.loginWithWechatPhone(detail)
      // 成功提示用原生 wx.showToast：它挂在原生层，switchTab 后仍会继续显示
      wx.showToast({
        title: '登录成功',
        icon: 'none',
        duration: 1500
      })
      // 过渡层背后预取首页设备列表（存 globalData，首页 loadHomeState 一次性消费）：
      // switchTab 落地时首页数据已就绪、整页直接渲染，不再出现首页自己的「加载中」
      this.setData({ loginTip: '正在进入首页…' })
      try {
        app.globalData.prefetchedDevices = await api.getDevices()
      } catch (error) {
        // 预取失败不阻塞进入首页：首页会自行重新拉取
      }
      wx.switchTab({
        url: '/pages/home/home',
        // switchTab 基本不会失败；兜底收起过渡层，避免卡死在 loading
        fail: () => this.setData({ submitting: false, loggingIn: false })
      })
      // 成功路径不收起过渡层：本页随 switchTab 销毁，提前收起会闪现登录按钮
    } catch (error) {
      // 登录失败（具体错误由请求层统一 toast）：收起过渡层，恢复可重试
      this.setData({
        submitting: false,
        loggingIn: false
      })
    }
  },

  // 过渡层 catchtouchmove 占位：阻止滚动穿透
  noop() {},

  // 首页是 tabBar 页只能 switchTab，而 switchTab 没有过渡动画（硬切）。
  // 先让整页淡出（css transition 0.24s，露出与首页同色的窗口底色 #f2f5fc），
  // 淡出完成后再 switchTab，视觉上近似「交叉渐隐」，掩盖硬切。
  leaveTo(url) {
    if (this.data.leaving) {
      return // 防止淡出期间重复触发
    }
    this.setData({
      leaving: true
    })
    setTimeout(() => {
      wx.switchTab({
        url
      })
    }, 240)
  },

  // 登录页返回固定回首页：无论从哪个页面进入登录页，点返回都直达首页
  goBack() {
    this.leaveTo('/pages/home/home')
  },

  openUserAgreement() {
    wx.navigateTo({
      url: '/subpackages/settings/agreement/agreement'
    })
  },

  openPrivacyPolicy() {
    wx.navigateTo({
      url: '/subpackages/settings/privacy/privacy'
    })
  },

  showToast(title) {
    // 本页 showToast 仅用于本地校验/错误提示（协议未勾选、获取手机号失败等），统一走 warn 加「小程序-」前缀。
    toast.warn({
      title,
      icon: 'none'
    })
  }
})
