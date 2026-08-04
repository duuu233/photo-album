const api = require('../../../utils/api')
const media = require('../../../utils/media')
const system = require('../../../utils/system')
const deviceBle = require('../../../utils/device-ble')
const deviceInfo = require('../../../utils/device-info')
const protocol = require('../../../utils/frame-protocol')
const activeDevice = require('../../../utils/active-device')
const toast = require('../../../utils/toast')

const app = getApp()

const TOTAL_PLACEHOLDER_COUNT = 0
// 筛选项完全按设备接口动态生成、以后端设备ID为值（见 buildDeviceFiltersFromDevices），不再有「全部」
const DEFAULT_FILTERS = []
const DEVICE_NAMES = ['房间相册', '客厅相框', '书房相框']
const THUMB_TYPES = [
  'tree',
  'kite',
  'dogs',
  'portrait',
  'flower',
  'mountain',
  'field',
  'beach',
  'meadow',
  'cat',
  'puppy',
  'paw',
  'daisy',
  'sea',
  'sunset'
]

// 统一设备名（修正历史命名差异），缺省时按下标循环取占位名
function normalizeDeviceName(name, index) {
  if (name === '客厅相册') return '客厅相框'
  if (name === '书房厅相册') return '书房相框'
  return name || DEVICE_NAMES[index % DEVICE_NAMES.length]
}

// 取有照片（已用内存 > 0）的设备名列表，用于给占位照片分配归属设备
function getActiveDeviceNames(devices) {
  return (devices || [])
    .filter(device => Number(device.usedMemory || 0) > 0)
    .map((device, index) => normalizeDeviceName(device.name, index))
}

// 后端记录的设备槽位索引(imgIndex, String) → 数字；无索引/非法值统一返回 -1。
// ⚠️ 0 是合法槽位（相框第一个位置），所以只能判 undefined/null/''，绝不能写 if (!imgIndex)——
// 否则第一个位置上的照片永远删不掉、刷不到。见 docs/decisions/image-slot-index.md 的问题 E。
function parseImgIndex(value) {
  if (value === undefined || value === null || value === '') {
    return -1
  }
  const index = Number(value)
  return Number.isInteger(index) && index >= 0 ? index : -1
}

// 补全单张照片的展示字段（标题、缩略图类型、大小等）
function normalizePhoto(photo, index) {
  return Object.assign({}, photo, {
    id: photo.id || `photo_${index}`,
    title: photo.title || `照片 ${index + 1}`,
    deviceName: normalizeDeviceName(photo.deviceName, index),
    thumbType: photo.thumbType || THUMB_TYPES[index % THUMB_TYPES.length],
    size: photo.size || 2.5
  })
}

function buildDisplayPhotos(sourcePhotos, devices) {
  // 只保留仍在设备上的真实照片并补全展示字段。
  return sourcePhotos
    .filter(photo => photo.onDevice !== false)
    .map(normalizePhoto)
}

// 默认选中偏好：按图库照片出现顺序，取第一台「有照片且仍在筛选项里」的设备ID，没有则返回 ''。
// 筛选项只来自设备接口（见 buildDeviceFiltersFromDevices），已解绑设备的老照片不再单独成筛选项，
// 所以必须限定「仍在筛选项里」——否则默认值会落到下拉里根本不存在的设备上。
function firstFilterValueWithPhotos(filters, photos) {
  const hit = (photos || []).find(photo => {
    const value = String(photo.deviceId || '')
    return value && filters.some(item => item.value === value)
  })
  return hit ? String(hit.deviceId) : ''
}

// 由设备接口(getDevices)列表生成筛选项(按后端设备ID userProductId 去重)。图库为空但用户有设备时用它——
// 导航栏设备下拉是设备展示载体，只要设备接口有数据就该显示设备并默认选中第一台。
// value=userProductId(兜底 id)即后端查询参数本身(见 checkDeviceClearStatus)；label 仅作展示。
function buildDeviceFiltersFromDevices(devices) {
  const filters = []

  ;(devices || []).forEach((device, index) => {
    const value = String(device.userProductId || device.id || '')
    if (value && !filters.some(item => item.value === value)) {
      filters.push({
        label: normalizeDeviceName(device.name, index),
        serialTail: serialTail(device),
        value
      })
    }
  })

  return filters
}

// 设备序列号(deviceNo/productDeviceId, AA:BB:…:FF)去分隔符后的尾 4 位(如 D428)，供同名设备下拉消歧
function serialTail(device) {
  const serial = String((device && (device.deviceNo || device.productDeviceId)) || '')
    .replace(/[:\-\s]/g, '')
  return serial ? serial.slice(-4) : ''
}

// 同名设备消歧：筛选值已按设备ID区分，但下拉里两个一样的名字用户无法分辨，
// 重名时给 label 补序列号尾 4 位(取不到序列号则按出现次序补 (2)/(3))。
// 设备名只用于展示，不参与任何匹配/合并——照片归属一律按设备ID。
function disambiguateFilterLabels(filters) {
  const counts = {}
  filters.forEach(item => {
    counts[item.label] = (counts[item.label] || 0) + 1
  })
  const seen = {}
  return filters.map(item => {
    const label = item.label
    seen[label] = (seen[label] || 0) + 1
    if (counts[label] < 2) {
      return { label, value: item.value }
    }
    const suffix = item.serialTail || String(seen[label])
    return { label: `${label}(${suffix})`, value: item.value }
  })
}

// 已选照片 id 列表 / 计数：selectedMap 用数据路径更新后（toggleSelect），取消选中的键
// 值为 false 而非被删除，所以取值与计数都必须按「值为真」过滤，不能直接 Object.keys().length
function selectedIds(map) {
  const source = map || {}
  return Object.keys(source).filter(id => source[id])
}

function countSelected(map) {
  return selectedIds(map).length
}

// 「设备上本来就没有这张图 / 槽位对不上」这一类错误：删记录必须放行，否则异常记录会永久卡在图库。
// 2026-08-01 扩充：0x07「掩码不一致(该位置已有图/索引越界)」以及各种「索引越界 / out of range」
// 也归到这里——产品明确要求，凡是不影响真正删掉设备与图片的异常都不要抛给用户中断流程。
// ⚠️ 只放行这一类；连接中断、设备繁忙(0x0B)、Flash 写失败等真实链路/硬件错误仍按原规则中止。
function isMissingDevicePhotoError(error) {
  const message = String((error && error.message) || error || '').toLowerCase()
  return /照片.*(不存在|异常)|图片.*(不存在|异常)|not[\s_-]*(found|exist)|无此图片|索引.*(无效|不存在|越界)|越界|掩码不一致|out[\s_-]*of[\s_-]*(range|bounds|index)/i.test(
    message
  )
}

Page({
  data: {
    statusBarHeight: 20,
    safeBottom: 0,
    filters: DEFAULT_FILTERS,
    // currentFilter 存后端设备ID(筛选/查询用)，currentFilterLabel 存展示名(筛选按钮文案用)
    currentFilter: '',
    currentFilterLabel: '',
    showFilterMenu: false,
    filterLoading: false,
    // sourcePhotos/photos 不进 data：模板只渲染 filteredPhotos，这两份全量列表纯 JS 使用
    // （见 this.sourcePhotos/this.photos）。100 张时三份全字段照片一起 setData 序列化可达上百 KB，
    // 已逼近 setData 性能红线，移出后传输量降到 1/3。
    filteredPhotos: [],
    selectedMap: {},
    selectedCount: 0,
    totalCount: TOTAL_PLACEHOLDER_COUNT,
    showDeleteConfirm: false,
    deleteClosing: false, // 删除确认弹窗是否正在播放退场动画
    loading: true, // 首屏接口返回前为 true，避免空态先闪一下
    loadError: false // 接口失败标记：走「加载失败+重新加载」空态，不再伪装成「暂无照片」
  },

  onLoad() {
    this.setSystemMetrics()
  },

  onShow() {
    this.loadPhotos()
  },

  // 失败态「重新加载」：先回到 loading 转圈（即时反馈），再走一遍正常加载
  retryLoad() {
    this.setData({ loading: true, loadError: false })
    this.loadPhotos()
  },

  setSystemMetrics() {
    this.setData(system.getLayoutMetrics())
  },

  // 加载图库：合并真实+占位照片，并过滤掉本地已软删除的项
  async loadPhotos() {
    // 首屏渲染即 loading=true，等接口返回再决定展示照片网格还是空态，避免空态先闪一下
    let result
    try {
      result = await Promise.all([
        api.getAlbumPhotos(),
        api.getDevices()
      ])
    } catch (error) {
      // 接口失败时 api 层已 toast 提示；标记 loadError 展示「加载失败+重新加载」——
      // 落到「暂无照片」空态会让用户误以为数据被清空了，且除退出重进外没有任何重试手段
      this.setData({ loading: false, loadError: true })
      return
    }
    const sourcePhotos = result[0]
    const devices = result[1]
    // 设备列表存实例上（不参与渲染）：图库为空时取第一台的 userProductId 查一键清除状态(firstDeviceUserProductId)
    this.devices = devices
    // 列表以后端返回为准：删除已实际删掉设备(0x12)+后端记录，不再叠加本地软隐藏
    //（旧的软隐藏是永久的，会把后端仍返回的图一直藏起来，导致「接口有 N 条却只显示 1 条」）
    const photos = buildDisplayPhotos(sourcePhotos, devices)

    // 筛选项(导航栏设备下拉是设备展示载体)：完全以「设备接口全量绑定设备」为准，返回几台展示几台——
    // 含刚绑定、还没有照片的设备；按设备ID(userProductId)去重，设备改名后老照片按 ID 仍归到改名后的设备项下。
    // (2026-07-30)已删「照片里带的设备ID、但设备列表里没有的(已解绑设备老照片)并入下拉」的兜底：
    // 这类照片不再单独成筛选项，也不会出现在任何设备的筛选结果里。
    const filters = this.buildLatestDeviceFilters(devices)
    // 默认选中：保留原选中(仍在列表) → 否则优先第一台「有照片」的设备(避免默认打开空设备，维持原有观感) → 再否则第一台
    const currentFilter = filters.some(item => item.value === this.data.currentFilter)
      ? this.data.currentFilter
      : (firstFilterValueWithPhotos(filters, photos) || (filters[0] ? filters[0].value : ''))

    // 全量照片列表存实例字段（不参与渲染，模板只用 filteredPhotos），省 setData 序列化开销
    this.sourcePhotos = sourcePhotos
    this.photos = photos

    this.setData({
      filters,
      // totalCount 不在这里算：它要跟着「当前设备」走，由 applyFilter 统一维护（见其注释）
      currentFilter,
      selectedMap: {},
      selectedCount: 0,
      showDeleteConfirm: false,
      filterLoading: false,
      loading: false,
      loadError: false
    })
    this.applyFilter(currentFilter, photos)
  },

  // 按设备ID(userProductId)筛选照片（无「全部」选项）；filter 为空（无设备）时回退展示全部，切换筛选时清空已选。
  // (2026-07-30)只按设备ID匹配，不再有设备名兜底：设备名可重复，按名匹配会把同名设备的照片混进来。
  // 代价是「后端没回 deviceId 的老照片」筛不出来——这类照片本就无法可靠归属到某台设备。
  applyFilter(filter, photos = this.photos || [], keepFilterMenuOpen = false) {
    const active = (this.data.filters || []).find(item => item.value === filter)
    const filteredPhotos = filter
      ? photos.filter(item => String(item.deviceId || '') === filter)
      : photos

    this.setData({
      currentFilter: filter,
      currentFilterLabel: active ? active.label : '',
      filteredPhotos,
      // 左上角「共 N 张」取**当前设备**的张数，不是全部设备的合计。
      // 这里是唯一维护点：首次加载与每次切换设备都经过 applyFilter，算一处即处处对。
      // 原来在 loadPhotos 里写死 photos.length（全部设备合计），切设备时也不会变——
      // 用户看到的是「筛到了 3 张，却写着共 12 张」。
      totalCount: filteredPhotos.length,
      showFilterMenu: keepFilterMenuOpen,
      selectedMap: {},
      selectedCount: 0
    })

    // 进入图库/每次切换设备都查一次该设备的一键清除状态（applyFilter 是两条路径的公共汇合点）
    this.checkDeviceClearStatus(filter)
  },

  // 查询所选设备的一键清除状态（getUserProductClearImg，retData: 0=未清除, 1=已清除）。
  // 设备在别处被执行过清空时（图库照片已不在设备上），弹确认框提醒重新上传；
  // 确认后调 editUserProduct 把 isClearImg 复位为 0，后端不再返回「已清除」，避免每次进来都弹。
  async checkDeviceClearStatus(filterValue) {
    // 筛选值本身就是后端设备ID(userProductId，见 buildDeviceFiltersFromDevices)，直接用，无需再按设备名反查。
    // 图库为空(无照片故无筛选项、filterValue 为空)：只要用户设备接口有数据，
    // 就默认用设备列表第一项的设备ID 去查一键清除状态——设备被清空后图库自然为空，正需靠它弹「重新上传」提醒。
    // 图库与设备接口都空 → userProductId 为空 → 直接 return 不查。
    const userProductId = filterValue || this.firstDeviceUserProductId()
    if (!userProductId) {
      return
    }

    // 自增序号标记「最新一次查询」：查询期间用户又切了设备，旧结果直接丢弃，避免弹错设备
    const seq = (this.clearCheckSeq = (this.clearCheckSeq || 0) + 1)

    let result
    try {
      result = await api.getUserProductClearImg(userProductId)
    } catch (error) {
      return // 后台查询失败静默忽略（接口层 showError:false），下次进入/切换设备会再查
    }

    if (seq !== this.clearCheckSeq || this.clearImgModalShowing) {
      return
    }

    // retData 通常就是 0/1，兼容后端包一层对象返回 { isClearImg } 的情况
    const cleared = Number(
      result && typeof result === 'object' ? result.isClearImg : result
    )
    if (cleared !== 1) {
      return
    }

    this.clearImgModalShowing = true
    wx.showModal({
      title: '提示',
      content: '照片在此电子纸设备异常，请删除重新上传',
      showCancel: false,
      confirmText: '确认',
      success: res => {
        if (res.confirm) {
          // 确认关闭后复位清除标记；失败时接口层会 toast（接口- 前缀），下次进入会再次提醒
          api.editUserProduct({ userProductId, isClearImg: 0 }).catch(() => {})
        }
      },
      complete: () => {
        this.clearImgModalShowing = false
      }
    })
  },

  // 用户设备接口(getDevices)返回列表第一项的后端设备ID(userProductId，兜底 id)。
  // 图库为空但用户有设备时，默认拿它去查一键清除状态；设备列表为空则返回 ''（连同空图库一起 → 不查）。
  firstDeviceUserProductId() {
    const first = (this.devices || [])[0]
    return (first && (first.userProductId || first.id)) || ''
  },

  // 设备下拉每次展开都重新调用 getDevices：不把上次进页时的 state/data 当设备列表缓存。
  // 菜单先打开并只显示局部 loading，接口返回后再用最新设备列表重建选项；图库照片无需重复请求。
  async toggleFilterMenu() {
    if (this.data.showFilterMenu) {
      this.filterRefreshSeq = (this.filterRefreshSeq || 0) + 1
      this.setData({ showFilterMenu: false, filterLoading: false })
      return
    }

    const seq = (this.filterRefreshSeq || 0) + 1
    this.filterRefreshSeq = seq
    this.setData({ showFilterMenu: true, filterLoading: true })

    let devices
    try {
      devices = await api.getDevices()
    } catch (error) {
      if (seq === this.filterRefreshSeq && this.data.showFilterMenu) {
        // 接口层已提示错误；保留现有选项作为失败兜底，但本次确实发起了真实请求。
        this.setData({ filterLoading: false })
      }
      return
    }
    if (seq !== this.filterRefreshSeq || !this.data.showFilterMenu) {
      return
    }

    this.devices = devices
    const photos = this.photos || []
    const filters = this.buildLatestDeviceFilters(devices)
    const currentFilter = filters.some(item => item.value === this.data.currentFilter)
      ? this.data.currentFilter
      : (firstFilterValueWithPhotos(filters, photos) || (filters[0] ? filters[0].value : ''))

    this.setData({ filters, currentFilter, filterLoading: false })
    // 刷新后仍保持菜单展开；只有用户真正选项时才关闭。
    this.applyFilter(currentFilter, photos, true)
  },

  // 完全以设备接口返回的设备为准（返回几台就几项），按后端设备ID去重后做同名消歧。
  buildLatestDeviceFilters(devices) {
    return disambiguateFilterLabels(buildDeviceFiltersFromDevices(devices))
  },

  selectFilter(e) {
    this.applyFilter(e.currentTarget.dataset.value)
  },

  toggleSelect(e) {
    const id = e.currentTarget.dataset.id
    const next = !this.data.selectedMap[id]
    // 数据路径更新：只 diff 这一格。此前整个 map 重传会让全部网格 tile 的绑定重算，
    // 100 张时点选有可感知延迟。取消项置 false 而非删键，计数/取已选统一按「值为真」过滤
    //（见 selectedIds/countSelected；cancelSelect/applyFilter 整体清空时会把 false 键一并清掉）。
    this.setData({
      ['selectedMap.' + id]: next,
      selectedCount: countSelected(
        Object.assign({}, this.data.selectedMap, { [id]: next })
      )
    })
  },

  // 取消选择：清空所有已选，底部操作栏随之收起
  cancelSelect() {
    this.setData({
      selectedMap: {},
      selectedCount: 0
    })
  },

  // 全选/取消全选：仅作用于当前筛选结果。已全选则取消，否则全选
  toggleSelectAll() {
    if (!this.data.filteredPhotos.length) {
      return
    }

    const selectedMap = Object.assign({}, this.data.selectedMap)
    const allSelected = this.data.filteredPhotos.every(item => selectedMap[item.id])

    if (allSelected) {
      this.data.filteredPhotos.forEach(item => {
        delete selectedMap[item.id]
      })
    } else {
      this.data.filteredPhotos.forEach(item => {
        selectedMap[item.id] = true
      })
    }

    this.setData({
      selectedMap,
      selectedCount: countSelected(selectedMap)
    })
  },

  // 删除前的连接校验：删除要同时删设备(0x12)与后端，二者必须一致，所以必须先连上设备。
  // 已连接返回 device；未连接则提示「无法删除」并返回 null。
  // 取「选中照片所属设备」并确保已连接（删除 0x12 / 刷新屏幕 0x24 共用）。
  //
  // ⚠️ 2026-08-03：必须按照片自己的 deviceId(=后端 userProductId) 找设备，不能一律用首页选中的
  //    那台（旧行为）。图库按设备筛选后，选中的是 B 设备的照片，却对 A 设备下 0x12/0x24 ——
  //    等于拿 B 的槽位号去删 / 刷 A 上的图，删错刷错。Flutter 侧（state.dart deleteAlbumPhotos /
  //    refreshGalleryPhotoOnScreen）一直是连「照片所属设备」的，本次两端对齐：同一张照片不管在
  //    哪端操作，都指向同一台设备的同一个物理槽位。
  //  · 选中照片跨设备 → 直接拦下（同一份掩码解析出的槽位只对一台设备成立）；
  //  · 照片没有 deviceId（后端未回的老照片）→ 退回当前选中设备，保持旧行为。
  async ensureConnectedDevice(photoIds) {
    const owners = []
    ;(photoIds || []).forEach(id => {
      const photo = (this.photos || []).filter(item => item.id === id)[0]
      const owner = String((photo && photo.deviceId) || '')
      if (owners.indexOf(owner) === -1) {
        owners.push(owner)
      }
    })
    if (owners.length > 1) {
      toast.warn({
        title: '只能操作同一台电子纸设备的照片',
        icon: 'none'
      })
      return null
    }

    const ownerId = owners[0] || ''
    let device = ownerId
      ? (this.devices || []).filter(
          item => String(item.userProductId || item.id || '') === ownerId
        )[0]
      : null
    if (ownerId && !device) {
      toast.warn({
        title: '未找到照片所属电子纸设备，请刷新后重试',
        icon: 'none'
      })
      return null
    }
    if (!device) {
      device = activeDevice.getActiveDevice()
    }
    if (!device || !(device.deviceId || device.bleDeviceId || device.deviceNo || device.name)) {
      toast.warn({
        title: '电子纸设备未连接，请先连接电子纸设备',
        icon: 'none'
      })
      return null
    }
    // 断联则自动重连(扫描+连接)，连不上再提示；连上返回带当下有效 deviceId 的设备。
    const deviceId = await activeDevice.ensureConnectedForAction(device)
    if (!deviceId) {
      return null // 提示已由 ensureConnectedForAction 弹出（请先连接设备 / 权限引导）
    }
    return Object.assign({}, device, { deviceId, bleDeviceId: deviceId, connected: true })
  },

  showDeleteDialog() {
    if (!this.data.selectedCount) {
      toast.warn({
        title: '请选择照片',
        icon: 'none'
      })
      return
    }

    // 连接判断/自动重连移到「确认删除」时(confirmDeleteSelected)，避免弹确认框前先干等数秒扫描重连。
    this.setData({
      showDeleteConfirm: true
    })
  },

  // 先播放退场动画再卸载，避免弹窗瞬间消失
  hideDeleteDialog() {
    if (this.data.deleteClosing) {
      return
    }
    this.setData({ deleteClosing: true })
    setTimeout(() => {
      this.setData({ showDeleteConfirm: false, deleteClosing: false })
    }, 220)
  },

  // 删除选中照片：先把设备固件上对应槽位删掉(CMD 0x12)，设备删成功后再删后端记录，
  // 保证「列表 / 后端 / 设备」三处一致。设备删除失败则整体中止，避免列表删了但相框里还在。
  async confirmDeleteSelected() {
    const ids = selectedIds(this.data.selectedMap)

    if (!ids.length) {
      this.hideDeleteDialog()
      return
    }

    // 1) 删除前确保已连接：断联则自动重连，连不上才提示（防止弹确认框期间设备断开导致设备/后端不一致）。
    //    连的是「这些照片所属的设备」，不是首页选中的那台（见 ensureConnectedDevice）。
    const device = await this.ensureConnectedDevice(ids)
    if (!device) {
      this.hideDeleteDialog()
      return
    }

    wx.showLoading({ title: '删除中', mask: true })
    let refreshWarn = '' // 「设备已删成功但刷屏失败」的提示文案，成功删除后带给用户
    let devicePhotoAbnormal = false
    try {
      // 读固件已占用槽位（升序），用同一份快照把每张选中照片解析成对应槽位；
      // 不在本设备上的（解析为 -1）跳过，只删能对上的。curImgIndex 用于判断是否删到屏显图。
      // 槽位掩码是删除操作的依据，必须真实读取；deviceInfo 已取消 15s 节流。
      const info = await deviceInfo.read(device.deviceId, { force: true })
      const occupied = protocol.maskToIndexes(info.imgMask)
      const slotIndexes = ids
        .map(id => this.resolveDeviceImageIndex(id, device, occupied))
        .filter(index => index >= 0)
      devicePhotoAbnormal = slotIndexes.length < ids.length

      // 2) 一条 0x12 批量删这些槽位（deleteImage 内部把索引数组转成掩码）
      if (slotIndexes.length) {
        const deleted = await deviceBle.deleteImage(device.deviceId, slotIndexes)
        // 2.1) 被删槽位若包含「屏幕当前正显示的图片」，需要接着刷屏，
        //      否则相框会一直挂着已删除的图（见 refreshAfterDeleteIfNeeded）
        refreshWarn = await this.refreshAfterDeleteIfNeeded(
          device.deviceId,
          info,
          deleted,
          slotIndexes
        )
      }
    } catch (error) {
      // 设备已经没有这张照片/槽位时，后端记录仍必须允许删除，否则异常记录会永久卡在图库。
      // 仅放行明确的“照片不存在”类结果；连接中断、设备繁忙等真实链路错误仍按原规则中止。
      if (isMissingDevicePhotoError(error)) {
        devicePhotoAbnormal = true
      } else {
        wx.hideLoading()
        toast.warn({
          // 超时统一走中文可操作文案（2026-08-01），不把微信/固件的英文原文抛给用户
          title: activeDevice.friendlyConnectMessage(
            (error && error.message) || '电子纸设备删除失败'
          ),
          icon: 'none'
        })
        return
      }
    }
    wx.hideLoading()

    // 3) 设备删除成功后，再删后端记录；删完 loadPhotos 以后端为准刷新（不再做本地软隐藏）
    try {
      await api.deleteAlbumPhotos(ids)
    } catch (error) {
      toast.warn({
        title: (error && error.message) || '删除照片记录失败',
        icon: 'none'
      })
      return
    }

    if (devicePhotoAbnormal) {
      toast.warn({ title: '照片在此电子纸设备异常，请删除重新上传', icon: 'none' })
    } else if (refreshWarn) {
      toast.warn({ title: refreshWarn, icon: 'none' })
    } else {
      toast.show({ title: '已删除', icon: 'none' })
    }
    this.loadPhotos()
  },

  // 删除后的屏幕处理（只在删到「屏幕当前显示的图片」时才动屏幕）：
  //   · 被删槽位不含当前屏显图（0x01 读到的 curImgIndex）→ 按索引删完即可，不刷屏；
  //   · 含当前屏显图 → 用 0x12 应答里删除后的最新掩码，从索引 0 开始找最近的有图槽位，0x24 刷过去；
  //   · 删完设备上已无图片 → 不主动刷屏：固件在图片全部清空后会自动（约 5 秒）刷成空屏
  //     （以固件群结论为准），且当前协议没有单独的「清屏」指令；若后续固件提供清屏指令，在此补调用。
  // 返回 ''=无需额外提示；非空=「已删除但刷屏失败」的提示文案。刷屏失败不抛出——设备侧已删成功，
  // 抛出会中止后端记录删除，造成设备与图库两边不一致。
  async refreshAfterDeleteIfNeeded(deviceId, info, deleted, slotIndexes) {
    if (slotIndexes.indexOf(info.curImgIndex) === -1) {
      return ''
    }

    const remaining = protocol.maskToIndexes((deleted && deleted.imgMask) || [])
    if (!remaining.length) {
      return '' // 设备已无图片：交给固件自动刷空屏
    }

    try {
      // maskToIndexes 返回升序槽位，第 0 个即「从 0 开始检索」到的最近有图位置
      await deviceBle.refreshScreen(deviceId, remaining[0])
      return ''
    } catch (error) {
      return '已删除，但屏幕刷新失败，请稍后手动刷新屏幕'
    }
  },

  // 刷新屏幕：图库照片大多已存在于固件，只需找到其在设备上的槽位索引，让相框切到这张图。
  // 仅支持单选——多选/全选是为了批量删除，单选才走刷新屏幕逻辑。
  async refreshScreen() {
    const ids = selectedIds(this.data.selectedMap)

    if (!ids.length) {
      toast.warn({
        title: '请选择图片',
        icon: 'none'
      })
      return
    }

    if (ids.length > 1) {
      toast.warn({
        title: '刷新屏幕只能选中一张图片',
        icon: 'none'
      })
      return
    }

    const photoId = ids[0]

    // 与「这张照片所属设备」建立蓝牙连接（2026-08-03 由「首页轮播选中的那台」改过来，
    // 与删除、与 Flutter 同一口径：槽位号只在它自己的设备上成立，连错设备就是刷错图）
    const device = await this.ensureConnectedDevice([photoId])
    if (!device) {
      return // 提示已由 ensureConnectedDevice / ensureConnectedForAction 弹出
    }

    wx.showLoading({ title: '刷新中', mask: true })
    try {
      // 读固件当前已占用的图片槽位（升序），按所选照片在本设备照片中的位置取对应槽位
      // force：槽位掩码是刷屏指定目标的依据，吃到旧掩码会刷错图
      const info = await deviceInfo.read(device.deviceId, { force: true })
      const occupied = protocol.maskToIndexes(info.imgMask)
      const index = this.resolveDeviceImageIndex(photoId, device, occupied)

      if (index < 0) {
        wx.hideLoading()
        toast.warn({
          title: '未找到该图片在电子纸设备上的位置',
          icon: 'none'
        })
        return
      }

      // CMD=0x24：让固件切换/刷新到指定索引的图片
      await deviceBle.refreshScreen(device.deviceId, index)
      wx.hideLoading()
      toast.show({
        title: '已刷新屏幕',
        icon: 'none'
      })
    } catch (error) {
      wx.hideLoading()
      toast.warn({
        // 刷新屏幕要先扫描/连上设备，超时是这里最常见的失败；统一中文提示（2026-08-01）
        title: activeDevice.friendlyConnectMessage(
          (error && error.message) || '刷新失败'
        ),
        icon: 'none'
      })
    }
  },

  // 选中照片 → 固件图片槽位索引。删除图片(0x12)与刷新屏幕(0x24)共用这一处解析。
  //
  // ① 首选后端记录的真实槽位 imgIndex：投屏成功时由 result.js 上报的设备物理位置，是准确值。
  // ② 没有 imgIndex 时才回退推算（投屏成功但记账失败会产生这种记录，见 docs/decisions/image-slot-index.md
  //    的问题 B）：固件已占用槽位(occupied)按索引升序，上传时用 firstFreeIndex 从最小空闲槽位起填，
  //    即最早上传的图落在最小槽位；所以把本设备照片按「上传先后」排好，第 N 张对应升序槽位里的第 N 个。
  //    直接用后端列表顺序(常见最新在前)去对 occupied[pos] 会刷错图 —— 这是「指定刷新图片不对」的旧根因。
  //    ⚠️ 推算前必须剔除「已被其它照片的 imgIndex 钉住」的槽位，否则推算结果会撞上别人的位置。
  //
  // 2026-08-03 与 Flutter（state.dart _resolveDeviceImageIndex）逐条对齐——两端各自算槽位，
  // 规则不一致时同一张照片在两端会解析到不同的物理位置（「小程序和 App 各投几张后索引就乱了」）：
  //   · 真实 imgIndex 必须在固件掩码里确实有图才采用（下方 ①），否则返回 -1；
  //   · claimed 只统计同一台设备的照片（跨设备槽位号互不相干，混进来会误剔除本机候选）；
  //   · candidates 为空且设备上确实有图时返回 -1，不再硬套位置号去删/刷别人的图。
  resolveDeviceImageIndex(photoId, device, occupied) {
    const onDevicePhotos = (this.photos || []).filter(item => item.onDevice !== false)
    const occupiedSlots = occupied || []

    // ① 有真实索引直接用，但要求该槽位在固件掩码里确实有图：记录指向空位说明设备侧这张早被删掉
    //    （在另一端删过 / 一键清空过 / 删除半成功），此时跳过而不是回退推算——推算只会撞上别人的图。
    //    顺带避免把空槽位塞进 0x12，被固件按「图片不存在」整批拒掉。
    const target = onDevicePhotos.filter(item => item.id === photoId)[0]
    const known = parseImgIndex(target && target.imgIndex)
    if (known >= 0) {
      return occupiedSlots.indexOf(known) > -1 ? known : -1
    }

    const deviceKey = String((device && (device.userProductId || device.id)) || '')
    const deviceName = device ? normalizeDeviceName(device.name, 0) : ''

    // 选中设备的照片：按后端 userProductId 匹配；都匹配不到则退化为全部（多为单设备）。
    // 设备名只在两种情况下参与匹配（与 applyFilter 同一套降级规则）：
    //   ① 设备没有后端ID(deviceKey 为空) → 整体退回按名匹配；
    //   ② 有ID但照片没有 deviceId（后端未回的老照片）→ 这些照片按名兜底。
    // ⚠️ 不能写成「ID 匹配 || 名字匹配」：两台设备可能同名，带ID的照片必须按ID归属，
    //    否则同名设备的照片会一起参与下面的「上传先后」排队，推算出的槽位错位 → 刷错图。
    let devicePhotos = onDevicePhotos.filter(item => {
      if (deviceKey && String(item.deviceId || '') === deviceKey) {
        return true
      }
      if (!deviceName) {
        return false
      }
      return (!deviceKey || !item.deviceId) && item.deviceName === deviceName
    })
    if (!devicePhotos.length) {
      devicePhotos = onDevicePhotos
    }

    // ② 回退推算：候选槽位 = 固件已占用槽位 − 已被真实索引占用的槽位；
    //    参与排队的也只剩「同样没有索引」的照片，两边一一对应才不会错位。
    //    claimed 只看**同一台设备**的照片：槽位号是每台设备自己的物理位置，
    //    把别的设备的 imgIndex 算进来会白白剔掉本机的候选槽位 → 推算错位（对齐 Flutter）。
    const claimed = devicePhotos
      .map(item => parseImgIndex(item.imgIndex))
      .filter(index => index >= 0)
    const candidates = occupiedSlots.filter(index => claimed.indexOf(index) === -1)

    // 按上传先后升序排列，使「第 N 张」与升序候选槽位 candidates[N] 对齐：
    // 主键 uProductImgId 自增，越小越早上传；取不到时退回按上传时间(createdAt)升序。
    //
    // 最后一道兜底 = 「后端列表顺序的倒序」：图库列表接口目前**不下发任何时间字段**
    //（createdAt 恒为空串），主键也取不到时两条记录就分不出先后，而 Array.sort 稳定排序会原样
    // 保留后端顺序（最新在前）→ 最新那张排到第 0 位、对上最小槽位，正好反了。
    // Flutter 侧用「固定基准 − 下标秒」的合成时间达到同一效果（state.dart `uploadedAt`），
    // 两端必须同向，否则同一张照片在两端排到不同位次 → 解析到不同槽位。
    const backendOrder = {}
    onDevicePhotos.forEach((item, index) => {
      backendOrder[item.id] = index
    })
    const orderOf = id => (backendOrder[id] === undefined ? 0 : backendOrder[id])
    const orderedPhotos = devicePhotos
      .filter(item => parseImgIndex(item.imgIndex) < 0)
      .sort((a, b) => {
        const ai = Number(a.uProductImgId)
        const bi = Number(b.uProductImgId)
        if (Number.isFinite(ai) && Number.isFinite(bi) && ai !== bi) {
          return ai - bi
        }
        const byTime = String(a.createdAt || '').localeCompare(String(b.createdAt || ''))
        if (byTime !== 0) {
          return byTime
        }
        return orderOf(b.id) - orderOf(a.id)
      })

    const pos = orderedPhotos.findIndex(item => item.id === photoId)
    if (pos < 0) {
      return -1
    }

    if (candidates.length) {
      return pos < candidates.length ? candidates[pos] : -1
    }
    // 候选为空：设备真无图(occupied 空)时回退到位置本身（保持旧行为，多为空设备的兜底路径）；
    // 有图但全被真实索引钉住，说明本张在设备上没有立足之处 —— 返回 -1，绝不硬套一个别人的槽位
    // 去删/去刷（对齐 Flutter state.dart：`occupied.isEmpty ? pos : -1`）。
    return occupiedSlots.length ? -1 : pos
  },

  async chooseForProjection() {
    let images = []

    try {
      images = await media.chooseFromAlbum()
    } catch (error) {
      if (error.errMsg && error.errMsg.indexOf('cancel') > -1) {
        return
      }
      toast.warn({
        title: '选择照片失败',
        icon: 'none'
      })
      return
    }

    if (!images.length) {
      return
    }

    const device = app.globalData.selectedDevice

    if (!device) {
      toast.warn({
        title: '请先选择电子纸设备',
        icon: 'none'
      })
      return
    }

    wx.setStorageSync('pendingProjection', {
      device,
      images
    })
    wx.navigateTo({
      url: '/subpackages/projection/preview/preview'
    })
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

  noop() {
  }
})
