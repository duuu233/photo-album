const system = require('../../../utils/system')

Page({
  data: {
    statusBarHeight: 20,
    safeBottom: 0,
    device: null,
    images: [],
    activeImage: null,
    activeIndex: 0,
    imageCount: 0,
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

  // 统一刷新图片相关状态：当前预览图与张数（设备空间是否够由结果页按真实容量/掩码判断）
  updateImageState(images, device, activeIndex) {
    const safeIndex = Math.max(0, Math.min(activeIndex, images.length - 1)) // 防止下标越界

    this.setData({
      device,
      images,
      activeIndex: safeIndex,
      activeImage: images[safeIndex] || null,
      imageCount: images.length
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
      icon: 'none'
    })
  },

  // 确认投屏：基础校验后跳到结果页，由结果页真实连接设备并走 BLE 图传（带真实进度）。
  // 设备空间是否够、能否连接，都在结果页用真实读到的容量/掩码与连接结果判断，这里不再用假数据预判。
  confirmProjection() {
    // 编辑态下按钮置灰不可投屏，需先保存或还原退出编辑
    if (this.data.editing) {
      return
    }

    if (!this.data.device) {
      wx.showToast({ title: '请选择设备', icon: 'none' })
      return
    }

    if (!this.data.images.length) {
      wx.showToast({ title: '请至少保留一张照片', icon: 'none' })
      return
    }

    // 必须有真实蓝牙 deviceId 才能连接图传（绑定时由蓝牙读取写入）
    if (!this.data.device.deviceId) {
      wx.showToast({ title: '设备未连接，请重新绑定后再投屏', icon: 'none' })
      return
    }

    // 待投屏的设备与图片已在 Storage(pendingProjection)，结果页读取后真实图传
    wx.redirectTo({
      url: '/subpackages/projection/result/result?status=progress'
    })
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
