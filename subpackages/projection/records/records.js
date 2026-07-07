const api = require('../../../utils/api')
const system = require('../../../utils/system')
const toast = require('../../../utils/toast')
const activeDevice = require('../../../utils/active-device')

Page({
  data: {
    statusBarHeight: 20,
    safeBottom: 0,
    records: [],
    filteredRecords: [],
    filter: 'success',
    loading: true
  },

  onLoad() {
    this.setSystemMetrics()
  },

  onShow() {
    this.loadRecords()
  },

  setSystemMetrics() {
    this.setData(system.getLayoutMetrics())
  },

  goBack() {
    const pages = getCurrentPages()

    if (pages.length > 1) {
      wx.navigateBack()
      return
    }

    wx.switchTab({
      url: '/pages/mine/mine'
    })
  },

  // 成功/失败标签 → 设备上传状态参数：成功=1，失败=0
  filterToUploadState(filter) {
    return filter === 'success' ? 1 : 0
  },

  // 按当前标签向后端请求对应状态的投屏记录（成功 deviceUploadState=1 / 失败=0），
  // 不再一次性拉全部再本地筛。数据已在 api 层归一化。
  async loadRecords(filter = this.data.filter) {
    // 首屏渲染即 loading=true，等接口返回再决定展示列表还是空态，避免空态先闪一下。
    // 切换标签/二次进入时已有内容，不再回到 loading，沿用旧内容直到新数据到位。
    try {
      const records = await api.getProjectionRecords({
        deviceUploadState: this.filterToUploadState(filter)
      })
      this.setData({
        filter,
        records,
        // 后端已按状态过滤；再按 status 兜底过滤一层，兼容后端忽略该参数的情况
        filteredRecords: records.filter(item => item.status === filter),
        loading: false
      })
    } catch (error) {
      // 接口失败时 api 层已 toast 提示，这里仅结束 loading，落到空态
      this.setData({ loading: false })
    }
  },

  switchFilter(e) {
    const filter = e.currentTarget.dataset.filter
    if (filter === this.data.filter) {
      return
    }
    this.loadRecords(filter)
  },

  // 再次/重新投屏：用记录里的服务器图片地址重新走一遍正常投屏链路。
  // 就算当前没连接设备，也先扫描+连接设备，连上后再跳投屏预览页，由结果页从服务器拉取文件并 BLE 图传。
  async retryProjection(e) {
    const id = e.currentTarget.dataset.id
    const record =
      this.data.filteredRecords.find(item => item.id === id) ||
      this.data.records.find(item => item.id === id)
    if (!record) {
      return
    }

    // 记录归一化时 thumbUrl 已按 img → thumbUrl → url 兜底取到服务器图片地址
    const imageUrl = record.thumbUrl || record.img || record.url
    if (!imageUrl) {
      toast.warn({ title: '该记录没有可投屏的图片', icon: 'none' })
      return
    }

    // 产品要求：再次/重新投屏一律直接用记录里的设备帧 .bin(imgBle) 图传，
    // 不再走后端上传/转码接口；没有 imgBle 的记录无法直接投屏，明确提示
    if (!record.imgBle) {
      toast.warn({ title: '该记录缺少设备帧文件，无法再次投屏', icon: 'none' })
      return
    }

    // 自动寻找并连接「该记录对应的设备」（而非全局选中设备）：先按记录定位到这台设备，
    // 再自动扫描+连接它（未连接会按序列号扫描匹配再连；连不上/无权限有 toast 提示）。
    // 满足「点再次/重新投屏就自动找到并连上该记录的设备」，无需先去首页选设备。
    const targetDevice = await this.resolveRecordDevice(record)
    if (
      !targetDevice ||
      !(
        targetDevice.deviceId ||
        targetDevice.bleDeviceId ||
        targetDevice.deviceNo ||
        targetDevice.productDeviceId ||
        targetDevice.name
      )
    ) {
      toast.warn({ title: '未找到该记录对应的设备，请前往首页确认设备', icon: 'none' })
      return
    }
    const connectedId = await activeDevice.ensureConnectedForAction(targetDevice)
    if (!connectedId) {
      return // 连不上，提示已由 ensureConnectedForAction 弹出（请先连接设备 / 权限引导）
    }
    const device = Object.assign({}, targetDevice, {
      deviceId: connectedId,
      bleDeviceId: connectedId,
      connected: true
    })

    // 预览/重转码用图优先取「图库里同一张照片的原图」（按 uProductImgId 关联）：
    // 记录里的 img 是后端按设备尺寸转换/压缩后的图，比例可能与原图不一致（预览会显得被拉伸），
    // 而图库 img 与首次投屏同源，能保证「投屏」与「再次投屏」进预览页显示一致；
    // 记录缺 uProductImgId / 照片已从图库删除 / 图库拉取失败时，退回记录里的图（保持可用）。
    const originalUrl = await this.resolveAlbumOriginalUrl(record)
    console.log(
      `[再次投屏] 预览图源：${originalUrl ? '图库原图' : '记录img(未匹配到图库原图)'} ${originalUrl || imageUrl}`
    )

    // 复用正常投屏链路：把该图片(服务器地址)与设备写入 Storage，跳投屏预览页。
    // 记录里已有后端转换好的设备帧地址 imgBle：带上它与 upirId/userProductId，
    // 结果页直接下载 imgBle 帧数据 BLE 图传（不调后端上传/转码、不调 editUserProductImgRecord），
    // 设备图传成功/失败后都调 addUserProductImgRecord 新增一条投屏记录。
    wx.setStorageSync('pendingProjection', {
      device,
      images: [
        {
          url: originalUrl || imageUrl,
          imgBle: record.imgBle,
          upirId: record.upirId,
          // 记账必填字段：记录缺 userProductId 时兜底用当前设备的用户产品ID
          userProductId:
            record.userProductId ||
            (device && (device.userProductId || device.id))
        }
      ]
    })
    wx.navigateTo({
      url: '/subpackages/projection/preview/preview'
    })
  },

  // 定位「该条记录对应的设备」：优先按 userProductId 从用户设备列表精确匹配，其次按设备序列号
  // (productDeviceId/deviceNo) 容错匹配；都匹配不到时退回当前全局选中设备（保证单设备场景仍可用）。
  // 返回带序列号的设备对象(供 ensureConnectedForAction 扫描匹配连接)或 null。
  async resolveRecordDevice(record) {
    let devices = []
    try {
      devices = await api.getDevices()
    } catch (error) {
      devices = []
    }

    const upid = record && record.userProductId
    if (upid) {
      const byId = devices.find(
        item =>
          String(item.userProductId) === String(upid) ||
          String(item.id) === String(upid)
      )
      if (byId) {
        return byId
      }
    }

    const serial = record && (record.productDeviceId || record.deviceNo)
    if (serial) {
      const bySerial = devices.find(item =>
        activeDevice.serialsMatch(item.deviceNo || item.productDeviceId, serial)
      )
      if (bySerial) {
        return bySerial
      }
    }

    // 兜底：记录未带可匹配的设备标识时，退回全局选中设备（沿用旧行为，单设备场景不受影响）
    return activeDevice.getActiveDevice()
  },

  // 按记录的 uProductImgId 到图库找同一张照片的原图地址；找不到/失败返回 ''，调用方回退记录图。
  // 不抛错：这只是「显示一致性」的增强，不能因图库接口失败挡住再次投屏。
  async resolveAlbumOriginalUrl(record) {
    const imgId = record && (record.uProductImgId || record.uproductImgId)
    if (!imgId) {
      return ''
    }
    try {
      const photos = await api.getAlbumPhotos()
      const matched = photos.find(
        item => String(item.uProductImgId) === String(imgId)
      )
      return (matched && matched.url) || ''
    } catch (error) {
      return ''
    }
  },

  deleteRecord(e) {
    const id = e.currentTarget.dataset.id

    wx.showModal({
      title: '删除记录',
      content: '仅删除投屏记录，不影响相册照片。',
      confirmText: '删除',
      confirmColor: '#c7372f',
      success: async res => {
        if (!res.confirm) {
          return
        }

        await api.deleteProjectionRecord(id)
        this.loadRecords()
      }
    })
  }
})
