const api = require('../../../utils/api')
const toast = require('../../../utils/toast')
const permission = require('../../../utils/permission')
const bluetooth = require('../../../utils/bluetooth')
const deviceBle = require('../../../utils/device-ble')
const system = require('../../../utils/system')

const app = getApp()

Page({
  data: {
    statusBarHeight: 20,
    safeBottom: 0,
    scanning: false, // 是否正在扫描附近设备
    devices: [],
    selectedId: '', // 当前选中待绑定设备的 id（单选）
    binding: false, // 是否正在绑定，避免重复点击「立即绑定」造成重复绑定
    location: null,
    showHelp: false,
    helpClosing: false // 「扫描帮助」弹层是否正在播放退场动画
  },

  onLoad() {
    this.setData(system.getLayoutMetrics())
    this.scan()
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
  },

  onUnload() {
    bluetooth.stopDiscovery() // 离开页面务必停止扫描，释放蓝牙资源
  },

  noop() {},

  // 搜索附近设备：定位授权 → 开蓝牙 → 扫描；开发者工具无真机蓝牙时降级到模拟数据
  async scan() {
    if (this.data.scanning) {
      return // 防止重复触发扫描
    }

    // 扫描序号：取消搜索时自增使在途的这次扫描结果失效，
    // 因为 discoverDevices 仍会在 8s 超时后 resolve，不能让它再回写界面
    this.scanSeq = (this.scanSeq || 0) + 1
    const seq = this.scanSeq

    this.setData({
      scanning: true,
      devices: [],
      showHelp: false
    })

    try {
      // 微信要求搜索蓝牙前需有定位权限
      const location = await permission.getCurrentLocation()
      if (!location) {
        toast.show({
          title: '请先授权定位',
          icon: 'none'
        })
        return
      }

      this.setData({
        location
      })

      await bluetooth.openAdapter()

      // 只扫真实相框（广播名以 EF6 开头或带合法厂商数据），不再用模拟设备兜底
      const devices = await bluetooth.discoverDevices({
        timeout: 8000
      })

      if (seq !== this.scanSeq) {
        return // 本次扫描已被取消，丢弃结果
      }

      // 默认选中第一台，符合设计稿「已搜索到设备」首项高亮
      this.setData({
        devices,
        selectedId: devices.length ? devices[0].id || devices[0].deviceId : ''
      })

      // 鸿蒙兼容兜底：一台没搜到时给鸿蒙用户单独排查引导(非鸿蒙保留原空态 UI)
      if (!devices.length) {
        bluetooth.showEmptyResultGuide()
      }
    } catch (error) {
      if (seq !== this.scanSeq) {
        return // 已取消，不再提示错误
      }
      // 系统级「附近设备」权限被拒：弹引导去系统设置，而非一句模糊的 toast
      if (error.code === 'PERMISSION_DENIED') {
        bluetooth.showPermissionGuide()
      } else {
        toast.show({
          title: error.message || '设备搜索失败',
          icon: 'none'
        })
      }
    } finally {
      if (seq === this.scanSeq) {
        this.setData({
          scanning: false
        })
      }
    }
  },

  // 取消正在进行的搜索：停止蓝牙扫描并让在途的 scan 结果失效，然后退出绑定流程
  cancelScan() {
    this.scanSeq = (this.scanSeq || 0) + 1 // 使在途扫描结果失效
    bluetooth.stopDiscovery()
    this.setData({
      scanning: false
    })
    this.goBack()
  },

  // 打开硬件联调调试台：开发对接阶段在这里逐个点按钮试每条 BLE 指令、看收发的 16 进制数据。
  // 可从某个已扫描到的设备直接带 deviceId 进去（免去再扫一次）；不带则在调试台里自行搜索连接。
  openDebug(e) {
    const id = e && e.currentTarget && e.currentTarget.dataset.id
    const device = id
      ? this.data.devices.find(item => item.id === id || item.deviceId === id)
      : null
    const query = device
      ? `?id=${device.deviceId}&name=${encodeURIComponent(device.name || '')}`
      : ''
    wx.navigateTo({
      url: `/subpackages/device/debug/debug${query}`
    })
  },

  openHelp() {
    this.setData({
      showHelp: true
    })
  },

  // 先播放退场动画再卸载，避免弹层瞬间消失
  closeHelp() {
    if (this.data.helpClosing) {
      return
    }
    this.setData({ helpClosing: true })
    setTimeout(() => {
      this.setData({ showHelp: false, helpClosing: false })
    }, 240)
  },

  // 点选某台设备：仅更新选中态，绑定动作交给底部「立即绑定」
  selectDevice(e) {
    this.setData({
      selectedId: e.currentTarget.dataset.id
    })
  },

  // 底部「立即绑定」：绑定当前选中的设备
  confirmBind() {
    if (this.data.binding) {
      return // 绑定进行中，忽略重复点击，避免重复绑定
    }
    if (!this.data.selectedId) {
      toast.show({
        title: '请选择要绑定的设备',
        icon: 'none'
      })
      return
    }
    this.bindById(this.data.selectedId)
  },

  // 绑定指定设备：真机设备先连接读取真实信息（电量/播放/屏幕/固件），再保存并设为当前选中设备
  async bindById(id) {
    const scanDevice = this.data.devices.find(
      item => item.id === id || item.deviceId === id
    )

    if (!scanDevice) {
      return
    }

    this.setData({ binding: true })

    let info = null
    // 绑定成功后是否保留这条 BLE 连接：保留则返回首页直接显示「已连接」，免去用户再手动点连接
    let bleConnected = false
    // 真实蓝牙设备：连接并读取设备信息；连接失败则中止绑定（不再有模拟兜底）
    if (scanDevice.realBluetooth && scanDevice.deviceId) {
      wx.showLoading({ title: '连接设备中', mask: true })
      try {
        info = await deviceBle.readDeviceInfo(scanDevice.deviceId)
        bleConnected = true // ensureConnection 已建立可复用会话，绑定成功后将沿用它
        try {
          const conn = await deviceBle.getConnectionInterval(
            scanDevice.deviceId
          )
          info.connectionIntervalUnits = conn.units
          info.connectionIntervalMs = conn.ms
        } catch (error) {
          console.warn('获取连接间隔失败', error)
          // 连接间隔是 v1.4 新增能力，读取失败不影响基础绑定。
        }
      } catch (error) {
        console.warn('连接设备/读取设备信息失败', error)
        // 连接/读取失败：断开以释放被占用的单连接、让设备能重新广播，再提示并中止绑定
        deviceBle.disconnect(scanDevice.deviceId)
        wx.hideLoading()
        toast.show({
          title: error.message || '设备连接失败',
          icon: 'none'
        })
        this.setData({ binding: false })
        return
      }
      wx.hideLoading()

      // 连接并读取设备信息成功：先提示「连接成功」，短暂停留让用户看到后，再调用绑定接口
      toast.show({ title: '连接成功', icon: 'none', duration: 800 })
      await new Promise(resolve => setTimeout(resolve, 800))
    }

    // 合并：扫描得到的蓝牙标识 + 连接后读到的真实设备信息（保留蓝牙 deviceId 供后续重连）
    const payload = Object.assign({}, scanDevice, info || {}, {
      deviceId: scanDevice.deviceId,
      deviceNo: (info && info.deviceId) || scanDevice.deviceNo,
      name: scanDevice.name
    })

    let device
    try {
      device = await api.bindDevice(payload)
    } catch (error) {
      // 绑定失败仍停留在本页：已连过就断开，避免占着设备的单连接妨碍重试
      if (bleConnected) {
        deviceBle.disconnect(scanDevice.deviceId)
      }
      // bindDevice 在 productId 解析不到时会抛错（后端必传），这里把原因提示给用户
      toast.show({
        title: error.message || '绑定失败',
        icon: 'none'
      })
      this.setData({ binding: false })
      return
    }
    app.setSelectedDevice(device)

    toast.show({
      title: '绑定成功',
      icon: 'none'
    })
    // 绑定成功后不再断开上面建立的连接：返回首页即显示「已连接」，无需用户手动点连接。
    // 同时保持 binding=true 直到返回上一页，避免 500ms 窗口内被重复点击触发二次绑定
    setTimeout(() => {
      wx.navigateBack()
    }, 500)
  }
})
