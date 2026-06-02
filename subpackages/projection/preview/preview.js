const api = require('../../../utils/api')
const system = require('../../../utils/system')

// 累加所有待投屏图片大小（MB，保留两位），用于判断设备内存是否够用
function calcTotalSize(images) {
  return Number(images.reduce((sum, image) => sum + Number(image.sizeMb || image.size || 0), 0).toFixed(2))
}

Page({
  data: {
    statusBarHeight: 20,
    safeBottom: 0,
    device: null,
    images: [],
    activeImage: null,
    activeIndex: 0,
    imageCount: 0,
    totalSize: 0,
    enoughMemory: true,
    activeTool: 'origin',
    editing: false,
    rotation: 0,
    projecting: false
  },

  onLoad() {
    this.setData(system.getLayoutMetrics())
    // 待投屏的设备与图片由上个页面通过 Storage 传入（见首页/相册的 openPreview）
    const pending = wx.getStorageSync('pendingProjection') || {}
    const images = pending.images || []
    const device = pending.device || null
    this.updateImageState(images, device, 0)
  },

  // 统一刷新图片相关状态：当前预览图、总大小，并据此判断设备内存是否足够
  updateImageState(images, device, activeIndex) {
    const safeIndex = Math.max(0, Math.min(activeIndex, images.length - 1)) // 防止下标越界
    const totalSize = calcTotalSize(images)

    this.setData({
      device,
      images,
      activeIndex: safeIndex,
      activeImage: images[safeIndex] || null,
      imageCount: images.length,
      totalSize,
      enoughMemory: device ? device.usedMemory + totalSize <= device.totalMemory : false
    })
  },

  onSwiperChange(e) {
    const index = e.detail.current
    // 切换图片即视为换了一张，退出编辑态并重置旋转
    this.setData({
      activeIndex: index,
      activeImage: this.data.images[index] || null,
      activeTool: 'origin',
      editing: false,
      rotation: 0
    })
  },

  // 底部工具切换：裁剪/旋转进入编辑态，旋转每次 +90° 循环；原图弹二次确认后还原
  selectTool(e) {
    const tool = e.currentTarget.dataset.tool

    if (tool === 'crop') {
      this.setData({
        activeTool: 'crop',
        editing: true
      })
      return
    }

    if (tool === 'rotate') {
      this.setData({
        activeTool: 'rotate',
        editing: true,
        rotation: (this.data.rotation + 90) % 360
      })
      return
    }

    if (tool === 'origin') {
      this.restoreOrigin()
    }
  },

  // 原图：二次确认后还原到最原始的图片（重置旋转/裁剪并退出编辑态）
  restoreOrigin() {
    wx.showModal({
      title: '还原原图',
      content: '确定要还原到最原始的图片吗？当前的编辑将不会保存。',
      confirmText: '还原',
      confirmColor: '#ff5f1f',
      success: (res) => {
        if (!res.confirm) {
          return
        }
        this.setData({
          activeTool: 'origin',
          editing: false,
          rotation: 0
        })
      }
    })
  },

  // 保存编辑：保留当前调整并退出编辑态
  savePhoto() {
    this.setData({
      activeTool: '',
      editing: false
    })
    wx.showToast({
      title: '已保存',
      icon: 'success'
    })
  },

  // 确认投屏：依次校验设备/图片/连接/内存，上传成功或失败都跳转结果页（通过 Storage 传递结果）
  async confirmProjection() {
    // 编辑态下按钮置灰不可投屏，需先保存或还原退出编辑
    if (this.data.editing) {
      return
    }

    // 逐项前置校验，任一不满足即提示并中断
    if (!this.data.device) {
      wx.showToast({
        title: '请选择设备',
        icon: 'none'
      })
      return
    }

    if (!this.data.images.length) {
      wx.showToast({
        title: '请至少保留一张照片',
        icon: 'none'
      })
      return
    }

    if (!this.data.device.connected) {
      wx.showToast({
        title: '设备未连接',
        icon: 'none'
      })
      return
    }

    if (!this.data.enoughMemory) {
      wx.showToast({
        title: '设备内存不足',
        icon: 'none'
      })
      return
    }

    this.setData({
      projecting: true // 投屏中，禁用按钮防重复提交
    })

    try {
      await api.uploadProjection({
        deviceId: this.data.device.id,
        images: this.data.images
      })
      // 成功：清除待投屏数据，写入结果供结果页读取，并 redirect（不可返回本页）
      wx.removeStorageSync('pendingProjection')
      wx.setStorageSync('lastProjectionResult', {
        status: 'success',
        deviceName: this.data.device.name,
        imageCount: this.data.images.length
      })
      wx.redirectTo({
        url: '/subpackages/projection/result/result?status=progress'
      })
    } catch (error) {
      // 失败：同样写入结果（含错误信息）并跳转失败结果页
      wx.setStorageSync('lastProjectionResult', {
        status: 'fail',
        deviceName: this.data.device ? this.data.device.name : '',
        imageCount: this.data.images.length,
        message: error.message || '投屏失败'
      })
      wx.redirectTo({
        url: '/subpackages/projection/result/result?status=fail'
      })
    } finally {
      this.setData({
        projecting: false
      })
    }
  },

  goBack() {
    const pages = getCurrentPages()

    if (pages.length > 1) {
      wx.navigateBack()
      return
    }

    wx.switchTab({
      url: '/pages/home/home'
    })
  }
})
