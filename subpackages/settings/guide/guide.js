Page({
  data: {
    statusBarHeight: 20,
    safeBottom: 0,
    guides: [
      {
        id: 'bind',
        title: '如何绑定设备?',
        open: true,
        lines: [
          '1.确保相册设备已开机，并打开手机蓝牙。',
          '2.进入首页点击绑定设备，或「我的设备」。',
          '3.在设备列表中选择要连接的相册设备。',
          '4.点击「立即绑定」完成连接。',
          '若未搜索到设备，请确认设备在附近并重新搜索。'
        ]
      },
      { id: 'project', title: '如何进行照片投屏?', open: false, lines: ['进入首页，选择拍照或相册，确认照片后发送到已连接设备。'] },
      { id: 'album', title: '如何管理我的相册?', open: false, lines: ['进入我的图库，可查看、删除和重新投屏已上传的照片。'] },
      { id: 'empty', title: '设备照片被清空怎么办?', open: false, lines: ['请在我的图库中重新选择照片投屏，或检查设备存储状态。'] },
      {
        id: 'storage',
        title: '相框空间已满怎么办?',
        open: true,
        lines: [
          '设备空间已满时，新的照片将无法继续投屏。你可以前往「我的相册」删除部分照片，或执行一键清空。清理完成后，再重新选择照片进行投屏即可。'
        ]
      }
    ]
  },

  onLoad() {
    this.setSystemMetrics()
  },

  setSystemMetrics() {
    try {
      const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
      this.setData({
        statusBarHeight: info.statusBarHeight || 20
      })
    } catch (error) {
      this.setData({ statusBarHeight: 20 })
    }
  },

  toggleGuide(event) {
    const id = event.currentTarget.dataset.id
    this.setData({
      guides: this.data.guides.map(item => ({
        ...item,
        open: item.id === id ? !item.open : item.open
      }))
    })
  },

  goBack() {
    wx.navigateBack()
  }
})
