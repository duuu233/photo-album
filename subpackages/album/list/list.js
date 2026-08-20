// 「我的相册」（2026-08-04 由原「设备照片」+「投屏管理」两个模块合并而来）。
//
// 口径：
//   · 列表 = **投屏成功**的记录（getProjectionRecords + deviceUploadState=1），按电子纸设备分类
//     （设备下拉即分类器），展示的缩略图就是当次投屏的那张，与设备上的画面一致；
//   · 沿用原「设备照片」页的整套 UI（网格 + 全选 + 底部三枚圆钮）；
//   · 底部第一枚由原「刷新屏幕」改为投屏记录页的「再次投屏」：单选=再投这一张（可在预览页重新构图），
//     多选/全选=按批量传输走同一条链路（一次最多 utils/upload-limit 张）；
//   · 底部第二枚是删除：先删设备槽位(0x12)，再删来源投屏记录，删完不会「还在列表里」。
//     两半**互不阻断**（2026-08-20）：设备指令失败照样删记录，记录接口失败也不回滚设备，
//     最后把两边结果合并成一条提示。
//
// ⚠️ 本页**不再调用任何「我的图库」接口**（2026-08-17 清理）：数据来源只剩两个——
//    设备列表 getDevices（铺设备下拉）与投屏成功记录 getProjectionRecords（铺网格）。
//    · 删除索引的唯一来源是**这条投屏记录自己的 imgIndex**（2026-08-10 改；原先绕一层
//      uProductImgId 关联图库照片、只认图库列表的 imgIndex，图库列表不回该字段时整批删不掉）。
//      列表本就是投屏记录铺的，记录里的 imgIndex 正是投屏成功时 editUserProductImgRecord 写进去的那份。
//      取到后直接交给 deviceBle.deleteImage 转成协议规定的 12 字节 IMG_INDEX_MASK 并发送 0x12。
//      不按列表顺序推算，也不在设备报错后改走其它槽位。
//    · 再次投屏的图直接用记录自己的 img：2026-07-22 起 setUserProductUpload 传的就是**原图**
//      （只按设备长边等比缩、不改比例），记录图与图库图本就是同一次上传的同一张，
//      绕图库那一跳（旧 findPhotoOfRecord）没有任何收益，只多一个会拖垮首屏的请求。
//    · 唯一保留的「清空」相关行为是提醒：进页面/切设备时查 getUserProductClearImg，
//      设备在别处被一键清空过就弹框提示重新上传（见 checkDeviceClearStatus）——它是
//      UserProduct 侧的状态查询，不属于图库列表链路。
//
// ⚠️ 多手机共用一台设备（2026-08-10 下午补）：另一部手机删过图后，本机列表里那条记录还在，
//    它的槽位在设备上已经空了。此时**删除必须照样能删掉**——设备侧按真实 IMG_MASK 过滤后再发
//    0x12，空槽位跳过、槽位上换了别的图也照删，后端记录一律删掉。详见 confirmDeleteSelected 第 3 步。
const api = require('../../../utils/api')
const media = require('../../../utils/media')
const system = require('../../../utils/system')
const deviceBle = require('../../../utils/device-ble')
const deviceInfo = require('../../../utils/device-info')
const protocol = require('../../../utils/frame-protocol')
const activeDevice = require('../../../utils/active-device')
const uploadLimit = require('../../../utils/upload-limit')
const toast = require('../../../utils/toast')
const fold = require('../../../utils/fold-adapt')

const app = getApp()

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

// 后端记录的设备槽位索引(imgIndex, String) → 0~95 的 bit 位；无索引/非法值统一返回 -1。
// ⚠️ 0 是合法槽位（相框第一个位置），所以只能判 undefined/null/''，绝不能写 if (!imgIndex)——
// 否则第一个位置上的照片永远删不掉、刷不到。见 docs/decisions/image-slot-index.md 的问题 E。
function parseImgIndex(value) {
  if (value === undefined || value === null || value === '') {
    return -1
  }
  if (typeof value !== 'string' && typeof value !== 'number') {
    return -1
  }
  const normalized = typeof value === 'string' ? value.trim() : value
  if (normalized === '') {
    return -1
  }
  const index = Number(normalized)
  return Number.isInteger(index) && index >= 0 && index < 96 ? index : -1
}

// 投屏成功记录 → 网格瓦片。id 取记录 id(upirId)：选中/删除/再次投屏都按它走。
function buildRecordTile(record, index) {
  return {
    id: String(record.id),
    // 缩略图与投屏画面同源：优先后端缩略图字段，旧数据回退整图（api 层已归一化）
    imgThumb: record.imgThumb || record.thumbUrl || '',
    deviceName: record.deviceName || '',
    createdAt: record.createdAt || '',
    thumbType: THUMB_TYPES[index % THUMB_TYPES.length]
  }
}

// 默认选中偏好：当下**连接中**的那台设备。
// 用户在首页/设备列表/设备详情连过设备、BLE 会话还活着时，进「我的相册」就该直接落在那台上——
// 本页的再次投屏/删除都要连设备，默认分类到已连接的那台，用户不必先在下拉里找一遍。
// 与投屏管理页 records.js 的 `filters.find(item => item.connected)` 完全同口径
//（2026-08-04 合并「设备照片」+「投屏管理」时只搬过来了设备照片页的默认规则，这条跟着丢了）。
//
// 连接态一律**现算**：设备接口不返回它，只能按当下真实 BLE 会话判定（deviceId 直连 +
// 设备ID×广播ID 序列号交叉匹配，见 utils/active-device.findConnectedDeviceId）。
// 单连接下最多只有一台命中；真出现多台就取设备接口顺序里第一台。
function firstConnectedFilterValue(filters, devices) {
  const hit = (devices || []).find(device => activeDevice.findConnectedDeviceId(device))
  // 筛选项按 userProductId(兜底 id) 建，取值口径必须与 buildDeviceFiltersFromDevices 一致；
  // 再限定「仍在筛选项里」——取不到设备ID 的设备根本不成项，默认值不能落到下拉里没有的设备上。
  const value = hit ? String(hit.userProductId || hit.id || '') : ''
  return value && filters.some(item => item.value === value) ? value : ''
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

// 折叠屏/分屏适配：Page 配置外面包一层 fold.adapt（方案见 utils/fold-adapt.js 与
// styles/fold-adapt.wxss）。只叠加「形态变化后重测状态栏/安全区」等钩子，页面原有配置一字不改。
Page(fold.adapt({
  data: {
    statusBarHeight: 20,
    safeBottom: 0,
    filters: DEFAULT_FILTERS,
    // currentFilter 存后端设备ID(筛选/查询用)，currentFilterLabel 存展示名(筛选按钮文案用)
    currentFilter: '',
    currentFilterLabel: '',
    showFilterMenu: false,
    filterLoading: false,
    // records 不进 data：模板只渲染 filteredPhotos，全量记录列表纯 JS 使用（见 this.records）。
    // 100 条时全字段列表一起 setData 序列化可达上百 KB，已逼近 setData 性能红线。
    // filteredPhotos = 当前设备的「投屏成功记录」瓦片（见 buildRecordTile）。
    filteredPhotos: [],
    selectedMap: {},
    selectedCount: 0,
    totalCount: 0,
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

  onUnload() {
    // 页面销毁后作废在途请求，避免慢接口回包继续向已卸载页面 setData
    this.recordSeq = (this.recordSeq || 0) + 1
  },

  // 失败态「重新加载」：先回到 loading 转圈（即时反馈），再走一遍正常加载
  retryLoad() {
    this.setData({ loading: true, loadError: false })
    this.loadPhotos()
  },

  setSystemMetrics() {
    this.setData(system.getLayoutMetrics())
  },

  // 加载页面基础数据：只有设备列表（铺下拉分类 + 供删除/再次投屏定位目标设备）。
  // 网格本身的数据是「当前设备的投屏成功记录」，由 applyFilter → loadRecords 取。
  // 2026-08-17 起这里不再并行拉图库列表：它只喂过「默认设备③」和「再次投屏取原图」两处，
  // 两处都已改掉，留着等于让一个用不上的接口有权把整页打成「加载失败」。
  async loadPhotos() {
    // 首屏渲染即 loading=true，等接口返回再决定展示照片网格还是空态，避免空态先闪一下
    let devices
    try {
      devices = await api.getDevices()
    } catch (error) {
      // 接口失败时 api 层已 toast 提示；标记 loadError 展示「加载失败+重新加载」——
      // 落到「暂无照片」空态会让用户误以为数据被清空了，且除退出重进外没有任何重试手段
      this.setData({ loading: false, loadError: true })
      return
    }
    // 设备列表存实例上（不参与渲染）：删除/再次投屏按记录的 userProductId 回它找目标设备，
    // 没有筛选值时也靠它取第一台的 userProductId 查一键清除状态(firstDeviceUserProductId)
    this.devices = devices

    // 筛选项(导航栏设备下拉是设备展示载体)：完全以「设备接口全量绑定设备」为准，返回几台展示几台——
    // 含刚绑定、还没有照片的设备；按设备ID(userProductId)去重，设备改名后老记录按 ID 仍归到改名后的设备项下。
    // (2026-07-30)已删「照片里带的设备ID、但设备列表里没有的(已解绑设备老照片)并入下拉」的兜底：
    // 这类照片不再单独成筛选项，也不会出现在任何设备的筛选结果里。
    const filters = this.buildLatestDeviceFilters(devices)
    const currentFilter = this.pickDefaultFilter(filters, devices)

    this.setData({
      filters,
      // totalCount 不在这里算：它要跟着「当前设备」走，由 loadRecords 统一维护（见其注释）
      currentFilter,
      selectedMap: {},
      selectedCount: 0,
      showDeleteConfirm: false,
      filterLoading: false,
      loadError: false
      // loading 保持 true 到记录回包（loadRecords）：先出空态再补数据会闪一下
    })
    this.applyFilter(currentFilter)
  },

  // 切换设备分类：清空已选 → 查一键清除状态 → 重新拉这台设备的投屏成功记录。
  // filter 就是后端设备ID(userProductId)，直接作为记录接口的查询参数，由后端按设备过滤——
  // 与投屏管理页同一口径，不在端上按记录字段猜归属（记录不一定回 userProductId）。
  applyFilter(filter, keepFilterMenuOpen = false) {
    const active = (this.data.filters || []).find(item => item.value === filter)

    this.setData({
      currentFilter: filter,
      currentFilterLabel: active ? active.label : '',
      showFilterMenu: keepFilterMenuOpen,
      selectedMap: {},
      selectedCount: 0
    })

    // 进入页面/每次切换设备都查一次该设备的一键清除状态（applyFilter 是两条路径的公共汇合点）
    this.checkDeviceClearStatus(filter)
    this.loadRecords(filter)
  },

  // 拉「当前设备的投屏成功记录」并铺成网格。
  // · deviceUploadState=1 由后端过滤成功记录，端上再按 status 兜一层，兼容后端忽略该参数；
  // · 无设备（filters 为空）时不带 userProductId，展示全部成功记录，保持原页面「没有设备也有内容」的行为；
  // · seq 作废在途请求：切设备切得快时，旧回包不得倒灌覆盖新设备的列表。
  async loadRecords(userProductId = this.data.currentFilter) {
    const seq = (this.recordSeq || 0) + 1
    this.recordSeq = seq
    this.records = []
    this.setData({
      filteredPhotos: [],
      totalCount: 0,
      loading: true,
      loadError: false
    })

    let records
    try {
      records = await api.getProjectionRecords({
        deviceUploadState: 1,
        userProductId: userProductId || undefined
      })
    } catch (error) {
      if (seq !== this.recordSeq) {
        return
      }
      // 接口失败时 api 层已 toast；标记 loadError 展示「加载失败 + 重新加载」——
      // 落到「暂无照片」空态会让用户误以为照片被清空，且除退出重进外没有重试手段
      this.setData({ loading: false, loadError: true })
      return
    }

    if (seq !== this.recordSeq) {
      return
    }

    const success = (records || []).filter(item => item.status === 'success')
    this.records = success

    this.setData({
      filteredPhotos: success.map(buildRecordTile),
      // 左上角「共 N 张」取**当前设备**的张数，不是全部设备的合计
      totalCount: success.length,
      selectedMap: {},
      selectedCount: 0,
      loading: false,
      loadError: false
    })
  },

  // 记录 id(upirId) → 记录对象
  findRecord(id) {
    return (this.records || []).filter(item => item.id === String(id))[0] || null
  },

  // 已选记录 id，按**网格展示顺序**返回（不是 Object.keys 顺序）：
  // 批量再次投屏时预览页的图片顺序要与用户在网格里看到的一致。
  selectedIdsInOrder() {
    const map = this.data.selectedMap || {}
    return (this.data.filteredPhotos || [])
      .filter(item => map[item.id])
      .map(item => item.id)
  },

  // 【务必保留】查询所选设备的一键清除状态（getUserProductClearImg，retData: 0=未清除, 1=已清除）。
  // 设备在别处执行过「一键清空」时，进入本页/切换设备就弹框告诉用户，提醒删掉残留记录重新上传；
  // 确认后调 editUserProduct 把 isClearImg 复位为 0，后端不再返回「已清除」，避免每次进来都弹。
  // ⚠️ 2026-08-17 清掉图库列表调用时这条**有意留下**：它查的是 UserProduct 侧的设备状态，
  //    不属于「我的图库」列表链路，是用户能感知到「设备被清空过」的唯一入口。
  async checkDeviceClearStatus(filterValue) {
    // 筛选值本身就是后端设备ID(userProductId，见 buildDeviceFiltersFromDevices)，直接用，无需再按设备名反查。
    // filterValue 为空(用户还没有设备 / 设备接口没回可用ID)时退到设备列表第一项的设备ID：
    // 设备被清空后本页记录也随之为空(后端同步删投屏记录)，正需靠它弹「重新上传」提醒。
    // 两者都取不到 → userProductId 为空 → 直接 return 不查。
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
  // 没有筛选值但用户有设备时，默认拿它去查一键清除状态；设备列表为空则返回 ''（→ 不查）。
  firstDeviceUserProductId() {
    const first = (this.devices || [])[0]
    return (first && (first.userProductId || first.id)) || ''
  },

  // 设备下拉每次展开都重新调用 getDevices：不把上次进页时的 state/data 当设备列表缓存。
  // 菜单先打开并只显示局部 loading，接口返回后再用最新设备列表重建选项。
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
    const filters = this.buildLatestDeviceFilters(devices)
    const currentFilter = this.pickDefaultFilter(filters, devices)

    this.setData({ filters, filterLoading: false })
    // 刷新后仍保持菜单展开；只有用户真正选项时才关闭。
    // 选中设备没变就只更新选项：applyFilter 会重新拉记录，仅仅展开一下下拉不该把列表清成转圈。
    if (currentFilter === this.data.currentFilter) {
      this.setData({ currentFilter })
      return
    }
    this.applyFilter(currentFilter, true)
  },

  // 完全以设备接口返回的设备为准（返回几台就几项），按后端设备ID去重后做同名消歧。
  buildLatestDeviceFilters(devices) {
    return disambiguateFilterLabels(buildDeviceFiltersFromDevices(devices))
  },

  // 默认选中哪台设备（loadPhotos 首屏与下拉刷新共用，两处必须同一套规则）：
  //   ① 保留用户当前选中的那台（仍在列表里）——本页 onShow 每次都会重跑 loadPhotos，
  //      不保留的话「点进照片再返回」就会把用户手动切过的设备冲掉；
  //   ② 否则优先**连接中**的设备：外面（首页/设备列表/设备详情）连了哪台，进来就看哪台的照片；
  //   ③ 再否则第一台。
  //
  // 2026-08-17 删掉了原来夹在 ②③ 之间的「第一台有照片的设备」：它的判据是图库列表里照片的
  // 归属设备，而本页数据源是投屏记录、图库列表已不再拉。要按「哪台有照片」排就得先把全部设备的
  // 记录都拉一遍（一台一个请求），代价远大于收益——且 ② 已经覆盖了最常见的场景（刚连过的那台）。
  pickDefaultFilter(filters, devices) {
    if (filters.some(item => item.value === this.data.currentFilter)) {
      return this.data.currentFilter
    }
    return (
      firstConnectedFilterValue(filters, devices) ||
      (filters[0] ? filters[0].value : '')
    )
  },

  selectFilter(e) {
    const value = String(e.currentTarget.dataset.value || '')
    // 选中的还是当前这台：只收起菜单，不重新拉一遍记录
    if (value === this.data.currentFilter) {
      this.setData({ showFilterMenu: false })
      return
    }
    this.applyFilter(value)
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

  // 操作前的连接校验：删除要同时删设备(0x12)与后端、再次投屏要走 BLE 图传，都必须先连上设备。
  // 已连接返回带当下有效 deviceId 的 device；连不上返回 null（提示已在内部弹出）。
  //
  // ⚠️ 2026-08-03 起的口径不变：必须按**这些照片自己所属的设备**找，不能一律用首页选中的那台。
  //    选中的是 B 设备的照片却对 A 设备下 0x12/0x24，等于拿 B 的槽位号去删 / 刷 A 上的图。
  //    Flutter 侧（state.dart deleteAlbumPhotos / refreshGalleryPhotoOnScreen）同口径。
  //  · 记录带 userProductId → 按它找设备；跨设备直接拦下（同一份掩码解析出的槽位只对一台设备成立）；
  //  · 记录没带 userProductId（后端未回）→ 退回当前设备下拉选中的那台——本页列表本就是
  //    按该设备ID向后端筛出来的，归属一致。
  async ensureConnectedDevice(recordIds) {
    const owners = []
    ;(recordIds || []).forEach(id => {
      const record = this.findRecord(id)
      const owner = String((record && record.userProductId) || '')
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

    const ownerId = owners[0] || String(this.data.currentFilter || '')
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

  // 选中的记录 id → 待删目标 { id, slot }。slot 只认这条投屏记录自己的 imgIndex
  // （0 是合法槽位；缺失/非法一律 -1，由调用方整批终止，绝不推算）。
  resolveDeleteTargets(ids) {
    return (ids || []).map(id => {
      const record = this.findRecord(id)
      return {
        id: String(id),
        slot: parseImgIndex(record && record.imgIndex)
      }
    })
  },

  // 把待删槽位按设备真实 IMG_MASK 分成两拨（见 confirmDeleteSelected 第 3 步）：
  //   onDevice = 掩码里有这一位 → 设备上确实还有图，照常发 0x12 删掉
  //              （哪怕现在躺在这个位置的是另一端后传的另一张图，也按索引删，产品口径）；
  //   gone     = 掩码里没有这一位 → 另一端已经删过，设备侧跳过，只删后端记录。
  // ⚠️ 掩码缺失（读不到 / 不是字节数组）时**一张都不能判 gone**，否则会变成「记录全删了、图还留在
  //    设备上」。这种情况整体按 onDevice 返回，交给 0x12 的良性结果码兜底。
  //    注意与「设备真的一张图都没有」区分：那时 imgMask 是 12 个 0 的合法掩码，全判 gone 才是对的。
  splitSlotsByDeviceMask(slots, imgMask) {
    const list = (slots || []).slice()
    const mask = protocol.toBytes(imgMask)
    if (!mask.length) {
      return { onDevice: list, gone: [] }
    }
    const existing = protocol.maskToIndexes(mask)
    return {
      onDevice: list.filter(slot => existing.indexOf(slot) !== -1),
      gone: list.filter(slot => existing.indexOf(slot) === -1)
    }
  },

  // 删除选中照片：直接读这条投屏记录自己的 imgIndex（网格就是按投屏成功记录铺的）；
  // deviceBle.deleteImage 会把这些索引按 bit 位转换成固定 12 字节、低字节在前的 IMG_INDEX_MASK，
  // 然后发送 CMD=0x12。协议示例：[0, 2] → 05 00 00 00 00 00 00 00 00 00 00 00。
  //
  // 这里刻意不推算缺失索引，也不在 0x12 报错后改删别的槽位：记录没给有效 imgIndex 就直接终止。
  // 但 0x01 的 IMG_MASK 会读一次，只用来判断「这个槽位设备上还有没有图」——见第 3 步。
  async confirmDeleteSelected() {
    const ids = this.selectedIdsInOrder()

    if (!ids.length) {
      this.hideDeleteDialog()
      return
    }

    // 1) 只认投屏记录里的 imgIndex。任意一张缺索引就整批终止，绝不按设备掩码/列表顺序猜位置。
    const targets = this.resolveDeleteTargets(ids)
    if (targets.some(item => item.slot < 0)) {
      this.hideDeleteDialog()
      toast.warn({
        title: '投屏记录未返回有效的图片索引，无法删除',
        icon: 'none'
      })
      return
    }

    const slotIndexes = []
    targets.forEach(item => {
      if (slotIndexes.indexOf(item.slot) === -1) {
        slotIndexes.push(item.slot)
      }
    })

    // 2) 删除前确保已连接；连的是这些照片所属的设备，不使用首页当前选中的其它设备。
    const device = await this.ensureConnectedDevice(ids)
    if (!device) {
      this.hideDeleteDialog()
      return
    }
    // 用户已确认且设备已就绪 → 关掉确认弹窗，后面交给「删除中」loading
    //（原先只在提前 return 的分支关，成功路径上弹窗会一直挂着）
    this.hideDeleteDialog()

    // 3) 先读一次设备当前 IMG_MASK(0x01)，把选中的槽位分成「设备上还在的」和「已经不在的」两拨。
    //
    //    为什么要读：同一台设备可能被两部手机连过。另一部手机删掉了 A，设备上只剩 B、C，
    //    而本机列表是按后端投屏记录铺的，A 那条记录还在 → 网格里仍是 A/B/C 三张。
    //    这时把 A 的空槽位一起塞进 0x12 的掩码，固件回 0x07，**整批**删除被打回，
    //    用户看到的就是「电子纸设备-掩码不一致(该位置已有图/索引越界)」——B、C 也跟着删不掉。
    //
    //    口径（2026-08-10 产品确认）：删除以「从我的相册里消失」为准，设备侧尽力而为——
    //      · 槽位在设备上已空 → 跳过设备侧，后端记录照删；
    //      · 槽位上现在躺着另一端后传的别的图 → 仍按索引删掉，不做内容比对（产品明确接受）；
    //      · 掩码读不到（刚断连/回读失败）→ 不拦，按选中槽位原样下发，仍由第 4 步的良性结果码兜底。
    wx.showLoading({ title: '删除中', mask: true })
    let slotsOnDevice = slotIndexes
    let slotsGone = []
    try {
      const info = await deviceInfo.read(device.deviceId, { force: true })
      const split = this.splitSlotsByDeviceMask(slotIndexes, info && info.imgMask)
      slotsOnDevice = split.onDevice
      slotsGone = split.gone
      console.log(
        '[相册删除] 设备 IMG_MASK=',
        protocol.bytesToHex(info && info.imgMask),
        '待删槽位',
        slotIndexes,
        '→ 设备上仍在',
        slotsOnDevice,
        '设备上已无(跳过)',
        slotsGone
      )
    } catch (error) {
      console.warn(
        '[相册删除] 回读设备掩码(0x01)失败，按选中槽位原样下发：',
        (error && error.message) || error
      )
    }

    // 4) 剩下的槽位交给 deviceBle.deleteImage，内部转成 12 字节 IMG_INDEX_MASK 后发送 0x12。
    //
    // ⚠️ 2026-08-20 口径变更：**设备侧与记录侧互不阻断**——先发设备删除指令(0x12)，无论它成功、
    // 失败还是设备根本没应答，都继续往下调投屏记录删除接口；反过来记录接口失败也不回滚设备。
    // 两半各自的结果最后合并成一条提示（见第 6 步），失败的那半让用户重试即可。
    // 改前是「非良性结果码直接 return」：设备忙(0x0B)/Flash 写失败(0x04)/断连超时时整批中止，
    // 记录一条都不删，用户回到相册看见照片还在、再点一次还是同样的报错。
    // 代价（产品已确认接受）：设备真的没删掉时，记录先没了 → 相框上那张图成了「相册里看不到」的
    // 幽灵图，端上不再有它的 imgIndex，只能靠「一键清空」清理。
    let deviceError = ''
    if (slotsOnDevice.length) {
      try {
        console.log(
          '[相册删除] 投屏记录 imgIndex=',
          slotsOnDevice,
          '按 12 字节 IMG_INDEX_MASK 发送 0x12'
        )
        await deviceBle.deleteImage(device.deviceId, slotsOnDevice)
      } catch (error) {
        // 「图片不存在(0x05) / 掩码不一致(0x07)」：要删的图设备上本来就没有——上一步的掩码回读
        // 与真正下发之间，另一端仍可能再删一张，所以这里还要兜一次。这类结果码本就算已删。
        if (protocol.isSkippableDeleteError(error)) {
          console.log(
            '[相册删除] 0x12 回了「图片不存在/掩码不一致」，按设备侧已无此图继续删记录：',
            (error && error.message) || error
          )
        } else {
          // 设备忙(0x0B)、Flash 写入失败(0x04)、传输中断(0x09)、断连/应答超时：设备侧「可能真的
          // 没删掉」。只记下来，不再中止——记录侧照删（见上方口径）。
          deviceError = activeDevice.friendlyConnectMessage(
            (error && error.message) || '电子纸设备删除失败'
          )
          console.warn(
            '[相册删除] 设备删除(0x12)失败，不影响后续记录删除：',
            (error && error.message) || error
          )
        }
      }
    } else {
      console.log('[相册删除] 选中照片在设备上都已不存在，跳过 0x12，直接删后端记录')
    }
    wx.hideLoading()

    // 5) 最后删掉本页列表的来源——投屏成功记录。不删的话照片虽已从设备消失，
    //    「我的相册」下次进来仍会把它列出来（列表就是按成功记录铺的）。
    //    这一步对「设备上已经没有的那几张」同样要执行：它们本就是另一端删过、只剩记录的幽灵条目，
    //    删掉记录正是用户点这个按钮想要的结果。
    //    允许部分失败：设备侧结果与这一步互不影响，不能因为记录没删干净就回滚设备、
    //    也不会因为设备没删掉就跳过这一步（2026-08-20 口径）。
    //    ⚠️ 端上到此为止，**不再调 delUserProductImg 删图库照片**（2026-08-10 屏蔽、2026-08-17 删除）：
    //       图库记录的清理归后端，端上删设备槽位 + 删投屏记录就是「从我的相册里消失」的完整定义。
    let recordResult = { total: ids.length, failed: 0 }
    wx.showLoading({ title: '删除中', mask: true })
    try {
      recordResult = await api.deleteProjectionRecords(ids)
    } catch (error) {
      recordResult = { total: ids.length, failed: ids.length }
    }
    wx.hideLoading()

    // 6) 两半的结果合并成一条提示：谁失败就说谁，都失败就都说，都成功才是「已删除」。
    //    （不再有「设备失败就整批中止」那条路径，所以这里必须把设备侧的失败也报出来，
    //     否则用户只会看到「已删除」，而相框上那张图其实还在。）
    if (deviceError && recordResult.failed) {
      toast.warn({ title: `电子纸设备与投屏记录都未删除成功：${deviceError}`, icon: 'none' })
    } else if (deviceError) {
      toast.warn({ title: `投屏记录已删除，${deviceError}`, icon: 'none' })
    } else if (recordResult.failed) {
      toast.warn({ title: '照片已删除，投屏记录未全部删除，请稍后重试', icon: 'none' })
    } else {
      toast.show({ title: '已删除', icon: 'none' })
    }
    this.loadPhotos()
  },

  // 再次投屏（2026-08-04 取代原「刷新屏幕」按钮）：与投屏管理页的「再次投屏」完全同链路——
  // 把图片地址 + 目标设备写进 pendingProjection，跳投屏预览页；用户可在预览页重新构图，
  // 点「开始投屏」后照常走 seekink 出帧 + BLE 图传 + setUserProductUpload 建**新记录**。
  // 所以再次投屏产生的是一张新照片、一条新记录，不会改动被选中的那条。
  //
  // 多选/全选按「批量传输」走同一条链路：预览页本就支持多张（左右切图逐张构图），
  // 结果页按张串行图传。张数上限与首页相册选图一致（utils/upload-limit，常规 10 张）。
  //
  // 在途锁：前置要跑设备查找 + 扫描连接，弱网下点了没反应会诱发连点，
  // 并发两条「查设备→连接→跳转」会双跳转报错（records.js 记过同类崩点）。
  async retryProjection() {
    if (this._retrying) {
      return
    }
    this._retrying = true
    try {
      await this.doRetryProjection()
    } finally {
      this._retrying = false
    }
  },

  async doRetryProjection() {
    const ids = this.selectedIdsInOrder()

    if (!ids.length) {
      toast.warn({
        title: '请选择照片',
        icon: 'none'
      })
      return
    }

    const limit = uploadLimit.albumPickLimit()
    if (ids.length > limit) {
      toast.warn({
        title: `一次最多投屏 ${limit} 张照片`,
        icon: 'none'
      })
      return
    }

    // 预览/重转码用图直接取记录自己的 img（2026-08-17：不再按 uProductImgId 回图库找原图）。
    // 2026-07-22 起 setUserProductUpload 传的就是**原图**（进预览页前那张，只按设备长边等比缩、
    // 不改比例），图库那条照片与这条记录是同一次上传的同一张图——绕图库只多一个请求，换不到
    // 任何画质/比例上的差别。api 层归一化时 thumbUrl 已按 img→thumbUrl→url 兜过底，这里再兜一层。
    const images = ids
      .map(id => {
        const record = this.findRecord(id)
        if (!record) {
          return null
        }
        // 排查用：把选中的记录对象**整个**打出来（含它的 imgIndex——注意这是这条记录当年
        // 写入设备的旧槽位，再次投屏会走完整链路选**新的**空闲槽位建**新**记录，旧值不参与本次投屏；
        // 本次真正写入/刷新的槽位看结果页 `[BLE] 0x20 图传帧头` 与 `[BLE] 0x24 刷新显示` 两行）。
        console.log('[相册再投] 选中记录 item=', JSON.stringify(record))
        const url = record.img || record.thumbUrl || record.url || ''
        return url ? { url } : null
      })
      .filter(Boolean)

    if (!images.length) {
      toast.warn({
        title: '所选照片没有可投屏的图片',
        icon: 'none'
      })
      return
    }

    // 与「这些照片所属设备」建立蓝牙连接（口径同删除：槽位/图传只在它自己的设备上成立）。
    // 放在取图之后：没有可投屏的图时不该先干等几秒扫描重连。
    const device = await this.ensureConnectedDevice(ids)
    if (!device) {
      return // 提示已由 ensureConnectedDevice / ensureConnectedForAction 弹出
    }

    if (images.length < ids.length) {
      toast.warn({
        title: `${ids.length - images.length} 张照片缺少图片地址，已跳过`,
        icon: 'none'
      })
    }

    // payload 形态与首页手选图片完全一致（只有 url），结果页会照常出帧 + 建记录 + 记账
    wx.setStorageSync('pendingProjection', {
      device,
      images
    })
    wx.navigateTo({
      url: '/subpackages/projection/preview/preview'
    })
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
}))
