const api = require('../../../utils/api')
const permission = require('../../../utils/permission')
const bluetooth = require('../../../utils/bluetooth')
const deviceBle = require('../../../utils/device-ble')
const system = require('../../../utils/system')

const app = getApp()

Page({
  data: {
    statusBarHeight: 20,
    safeBottom: 0,
    scanning: false,
    devices: [],
    location: null,
    showHelp: false
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

    this.setData({
      scanning: true,
      devices: [],
      showHelp: false
    })

    try {
      // 微信要求搜索蓝牙前需有定位权限
      const location = await permission.getCurrentLocation()
      if (!location) {
        wx.showToast({
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

      this.setData({
        devices
      })
    } catch (error) {
      wx.showToast({
        title: error.message || '设备搜索失败',
        icon: 'none'
      })
    } finally {
      this.setData({
        scanning: false
      })
    }
  },

  // 打开硬件联调调试台：开发对接阶段在这里逐个点按钮试每条 BLE 指令、看收发的 16 进制数据。
  // 可从某个已扫描到的设备直接带 deviceId 进去（免去再扫一次）；不带则在调试台里自行搜索连接。
  openDebug(e) {
    const id = e && e.currentTarget && e.currentTarget.dataset.id
    const device = id ? this.data.devices.find(item => item.id === id || item.deviceId === id) : null
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

  closeHelp() {
    this.setData({
      showHelp: false
    })
  },

  // 绑定所选设备：真机设备先连接读取真实信息（电量/播放/屏幕/固件），再保存并设为当前选中设备
  async bindDevice(e) {
    const id = e.currentTarget.dataset.id
    const scanDevice = this.data.devices.find(item => item.id === id || item.deviceId === id)

    if (!scanDevice) {
      return
    }

    let info = null
    // 真实蓝牙设备：连接并读取设备信息；连接失败则中止绑定（不再有模拟兜底）
    if (scanDevice.realBluetooth && scanDevice.deviceId) {
      wx.showLoading({ title: '连接设备中', mask: true })
      try {
        info = await deviceBle.readDeviceInfo(scanDevice.deviceId)
        try {
          const conn = await deviceBle.getConnectionInterval(scanDevice.deviceId)
          info.connectionIntervalUnits = conn.units
          info.connectionIntervalMs = conn.ms
        } catch (error) {
          // 连接间隔是 v1.4 新增能力，读取失败不影响基础绑定。
        }
      } catch (error) {
        wx.showToast({
          title: error.message || '设备连接失败',
          icon: 'none'
        })
        return
      } finally {
        deviceBle.disconnect(scanDevice.deviceId)
        wx.hideLoading()
      }
    }

    // 合并：扫描得到的蓝牙标识 + 连接后读到的真实设备信息（保留蓝牙 deviceId 供后续重连）
    const payload = Object.assign({}, scanDevice, info || {}, {
      deviceId: scanDevice.deviceId,
      deviceNo: (info && info.deviceId) || scanDevice.deviceNo,
      name: scanDevice.name
    })

    const device = await api.bindDevice(payload)
    app.setSelectedDevice(device)

    wx.showToast({
      title: '绑定成功',
      icon: 'success'
    })
    setTimeout(() => {
      wx.navigateBack()
    }, 500)
  }
})
