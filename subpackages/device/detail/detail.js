const api = require('../../../utils/api')
const toast = require('../../../utils/toast')
const system = require('../../../utils/system')
const batteryUtil = require('../../../utils/battery')
const deviceBle = require('../../../utils/device-ble')
const deviceInfo = require('../../../utils/device-info')
const protocol = require('../../../utils/frame-protocol')
const media = require('../../../utils/media')
const activeDevice = require('../../../utils/active-device')
const deviceName = require('../../../utils/device-name')
const deviceIdUtil = require('../../../utils/device-id')
const deviceIdentity = require('../../../utils/device-identity')
const fold = require('../../../utils/fold-adapt')

const app = getApp()

// 从没读到过间隔时的兜底（秒）。后端 carouselInterval 单位是分钟、固件 0x10 收的是秒，
// 页面内一律按秒传递，只有这里才允许出现「小时」。
const DEFAULT_INTERVAL_SECONDS = 2 * 3600

// 屏幕物理分辨率文案（展示在「设备ID」下方），如 `680*960`。
// 取值优先级：0x01 读到的 screenType 查表 → 后端记录的 width/height → '--'。
// 与设备ID/内存不同，分辨率是**产品静态属性**而非实时数据，所以**不跟随连接状态置 --**：
// 未连接时后端记录里的宽高一样准，硬要置 -- 只会让常态未连接的设备永远看不到分辨率。
function resolutionText(device) {
  if (!device) {
    return '--'
  }
  const screen = protocol.SCREEN_TYPES[device.screenType] || {}
  const width = Number(screen.width || device.width) || 0
  const height = Number(screen.height || device.height) || 0
  return width && height ? `${width}*${height}` : '--'
}

// 「最大照片数量」行的展示值（2026-08-01 起显示已用，2026-08-02 产品改为 `已用/上限` 分数式）。
// 形如 `8/51`：分子是当前已占用的槽位数(0x01 imgCount)，分母是固件回报的容量(0x01 capacity)。
// 容量未知（未连接/未读到 0x01）时整行回落 '--'，与设备ID/内存同口径——绝不用 0 冒充真实值。
// 已用数拿不到时按 0 计：容量已经读到了，只是这次 imgCount 缺省，显示 `0/51` 比整行变 '--' 更有信息量。
function memoryText(device) {
  const total = Number(device && device.totalMemory) || 0
  if (!total) {
    return '--'
  }
  const used = Number(device && device.usedMemory) || 0
  return `${used}/${total}`
}

// 计算设备存储使用百分比（已用/总量），上限 100，用于进度条展示
function memoryPercent(device) {
  if (!device || !device.totalMemory) {
    return 0
  }
  return Math.min(
    100,
    Math.round((device.usedMemory / device.totalMemory) * 100)
  )
}

function getPlaybackLabel(device) {
  if (
    !device ||
    device.playbackMode === 'manual' ||
    device.carouselEnabled === false
  ) {
    return '未启用'
  }
  return device.playbackMode === 'random' ? '随机轮播' : '顺序轮播'
}

function hexStringToBytes(hex) {
  return String(hex || '')
    .split(/\s+/)
    .filter(Boolean)
    .map(part => parseInt(part, 16))
    .filter(value => Number.isFinite(value))
}

function formatHexByte(value) {
  return Number(value || 0)
    .toString(16)
    .padStart(2, '0')
    .toUpperCase()
}

function logClearDeviceFrame(traceId, record) {
  if (!record) {
    return
  }
  const cmdHex = formatHexByte(record.cmd)
  const dirText = record.dir === 'TX' ? '发送给设备' : '设备返回'
  const note = record.note ? ' ' + record.note : ''
  let ackText = ''

  if (record.dir === 'RX' && Number(record.cmd) === protocol.ACK) {
    const parsed = protocol.tryParseFrame(hexStringToBytes(record.hex))
    if (parsed && parsed.frame) {
      const ack = protocol.parseAck(parsed.frame.payload)
      ackText =
        ' ACK_CMD=0x' +
        formatHexByte(ack.ackCmd) +
        ' RESULT=0x' +
        formatHexByte(ack.result) +
        '(' +
        protocol.resultText(ack.result) +
        ')'
    }
  }

  console.log(
    '[一键清空][' +
      traceId +
      '] ' +
      dirText +
      ' CMD=0x' +
      cmdHex +
      ackText +
      note +
      ': ' +
      record.hex
  )
}

function logClearDeviceData(traceId, label, data) {
  console.log('[一键清空][' + traceId + '] ' + label + ':', data)
}

function textValue(value) {
  return String(value || '').trim()
}

// 给「设备返回 / 蓝牙链路」类错误统一加「设备-」前缀（与 toast 来源前缀约定一致：
// 设备-/小程序-/接口-）。幂等：已带任一来源前缀时原样返回，避免重复叠加。
function prefixDeviceError(error) {
  const e =
    error instanceof Error ? error : new Error((error && error.message) || '电子纸设备操作失败')
  const msg = e.message || '电子纸设备操作失败'
  if (!/^(?:接口-|设备-|电子纸设备-|小程序-)/.test(msg)) {
    e.message = '电子纸设备-' + msg
  }
  return e
}

// 「不影响删除结果」的设备结果码（2026-08-01 产品要求）：
//   0x05 图片不存在、0x07 掩码不一致(该位置已有图/索引越界)，以及各种「索引越界 / out of range」。
// 这几类的共同点是——要删的那张图设备上本来就没有，对「把图删掉」这个目标而言已经达成，
// 抛出来只会让用户在一个其实成功了的操作上看到红字。
// ⚠️ 只放行这一类：设备忙(0x0B)、Flash 写入失败(0x04)、传输中断(0x09)、连接断开/应答超时
//    仍必须如实中止，它们代表设备可能真的没删干净。
// 判定本身 2026-08-10 收归 utils/frame-protocol.js（「我的相册」删除也要同一套口径，
// 见 list.js confirmDeleteSelected 第 4 步）：优先认结果码，拿不到再退回文案匹配。
function isBenignDeleteError(error) {
  return protocol.isSkippableDeleteError(error)
}

function isUpdateFlag(device) {
  return Number(device && device.isUpdate) === 1
}

function isBinFirmwareUrl(url) {
  return /\.bin(?:[?#]|$)/i.test(textValue(url))
}

// OTA 逐帧日志助手（describeOtaFrame / decodeFinalResultFrame / OTA_OP）随 2026-08-11 删除的
// 「OTA测试升级」一并移除：真实升级在 subpackages/device/ota 页里跑，日志由 utils/ota-ble.js 自己打。

// 「固件升级」行右侧读不到设备当前版本时的占位（未连接 / 0x03 读失败）。
// 2026-08-20 起右侧只展示版本号，「有版本可更新/已是最新版本」两句文案随之下线——
// 有无新版本改由箭头旁的红点表达，弹窗里的结论文案在 goOtaUpgrade 内就地写。
const OTA_TEXT_UNKNOWN = '--'

// 版本号比较：去空格 + 不区分大小写（与 ota.js sameVersion 同口径）。
// 任一为空一律**不算相同**，由调用方按「未知」处理——绝不把「没读到」当成「一样」。
function sameVersion(a, b) {
  const na = textValue(a).toUpperCase()
  const nb = textValue(b).toUpperCase()
  return !!na && !!nb && na === nb
}

// 升级包本身是否可用：新版本号 + 有效 .bin 下载地址。缺一不可，否则进了升级页也下不动。
function firmwarePackageError(device) {
  const version = textValue(device && device.newVersionNo)
  const url = textValue(device && device.downloadPath)

  if (!version || !url) {
    return '检测到电子纸设备可更新，但缺少新版本号或固件下载地址，请稍后重试。'
  }

  if (!isBinFirmwareUrl(url)) {
    return '固件下载地址不是有效的 .bin 文件，请稍后重试。'
  }

  return ''
}

// 固件更新判定（2026-08-12 产品规则）：以**设备实际在跑的固件版本**与详情接口下发的
// newVersionNo 比较为准，而不是后端 isUpdate 标志。
// 当前版本只认调试台那条路读回来的值——0x03 GET_SW_VER，详情页由 deviceInfo.read 一并读回、
// 落在 device.firmwareVersion（见 utils/device-ble.js readDeviceInfo 与 debug.js cmdGetVersion）。
// 后端不下发设备真正在跑的版本，所以未连接时它必然为空：那种情况只能返回 unknown，
// 不能拿「空 ≠ 新版本号」当成有更新，也不能反过来说「已是最新」。
//
// state：
//   'unknown' 读不到设备当前固件版本（未连接 / 0x03 读失败）→ 无从比较
//   'update'  版本号不同且下载地址有效 → 有版本可更新
//   'invalid' 版本号不同但缺号/缺地址/不是 .bin → 后台数据有问题，点击时如实说明原因
//   'latest'  其余（版本号相同，或接口压根没给新版本号）→ 已是最新
//
// 右侧红点与点击流程必须共用这一个判定，否则会出现「红点亮着、点进去弹已是最新」。
function evaluateFirmwareUpdate(device, currentVersion) {
  const current = textValue(currentVersion)
  if (!current) {
    return { state: 'unknown', reason: '' }
  }

  const version = textValue(device && device.newVersionNo)
  if (!version || sameVersion(current, version)) {
    return { state: 'latest', reason: '' }
  }

  const packageError = firmwarePackageError(device)
  return packageError
    ? { state: 'invalid', reason: packageError }
    : { state: 'update', reason: '' }
}

// 「固件升级」行右侧文案（2026-08-20 产品规则）：只展示**设备当前在跑的固件版本号**，
// 有没有新版本改用箭头旁的红点表达（见 hasFirmwareUpdate），不再写「有版本可更新/已是最新版本」。
// 版本号只认 0x03 GET_SW_VER 读回的值（deviceInfo.read → device.firmwareVersion），
// 未连接/读不到时回落 '--'，与本页设备ID、最大照片数量、轮播设置同一套占位约定：
// 不知道就说不知道，接口不下发设备实际在跑的版本，拿 newVersionNo 顶上等于显示了一个假版本。
function firmwareVersionText(device) {
  if (!device || !device.connected) {
    return OTA_TEXT_UNKNOWN
  }
  return textValue(device.firmwareVersion) || OTA_TEXT_UNKNOWN
}

// 「固件升级」行箭头旁的红点：**已连接**且检测到有新版本才亮。
//
// 未连接一律不亮（2026-08-20 产品规则）：这一行整行回落 '--'，与设备ID/内存/轮播设置同一套
// 占位约定——「不知道就说不知道」；未连接时右边写着 '--' 却挂个红色角标，是在没有版本依据的
// 情况下报警，与本页其它 '--' 行自相矛盾。用户想查版本，点进这一行照样能查
//（goOtaUpgrade 未连接时仍走接口 + isUpdate 回落，2026-08-11 定的能力没丢），只是不再由红点催。
//
// 已连接后判定与点击流程 goOtaUpgrade 同源——包括「0x03 读不到当前版本时退回后端 isUpdate
// 标志」这一分支，否则会出现红点亮着、点进去却弹「当前固件已是最新版本」的自相矛盾。
// 只有 'update'（版本不同 + 下载地址是有效 .bin）才算数：'invalid' 是后台数据有问题，
// 点进去只会弹原因说明、升不了级，亮红点等于催用户去撞墙。
function hasFirmwareUpdate(device) {
  if (!device || !device.connected) {
    return false
  }

  const result = evaluateFirmwareUpdate(device, device.firmwareVersion)
  if (result.state !== 'unknown') {
    return result.state === 'update'
  }
  return isUpdateFlag(device) && !firmwarePackageError(device)
}

// 折叠屏/分屏适配：Page 配置外面包一层 fold.adapt（方案见 utils/fold-adapt.js 与
// styles/fold-adapt.wxss）。只叠加「形态变化后重测状态栏/安全区」等钩子，页面原有配置一字不改。
Page(fold.adapt({
  data: {
    statusBarHeight: 20,
    safeBottom: 0,
    id: '',
    device: null,
    memoryPercent: 0,
    // 首帧未知电量：传 null 取未知档图标（旧写法取 DEFAULT_BATTERY=100 会先闪一下满电）
    batteryIcon: batteryUtil.getBatteryIcon(null),
    deviceCode: '',
    resolutionText: '--',
    memoryText: '',
    macAddress: '',
    // 「固件升级」行右侧：设备当前固件版本号（0x03 读回），未连接/读不到为 '--'
    firmwareVersionText: '--',
    // 「固件升级」行箭头旁的红点：已连接且检测到有新版本时亮（未连接一律不亮）
    firmwareHasUpdate: false,
    batteryText: '--',
    playbackLabel: '',
    intervalOptions: [1, 2, 4, 8, 24],
    intervalIndex: 1,
    showClearConfirm: false,
    showClearConfirm2: false, // 一键清空二级确认弹窗
    showDeleteConfirm: false, // 仅解除绑定确认
    showPermanentDeleteConfirm: false, // 清空照片并解除绑定一级确认
    showPermanentDeleteConfirm2: false, // 清空照片并解除绑定二级确认
    clearClosing: false, // 清空确认弹窗是否正在播放退场动画
    clearClosing2: false, // 二级清空确认弹窗是否正在播放退场动画
    deleteClosing: false, // 解除绑定确认弹窗是否正在播放退场动画
    permanentDeleteClosing: false,
    permanentDeleteClosing2: false,
    renameVisible: false,
    renameValue: '',
    renameSaving: false,
    showMediaSheet: false, // 「拍照/相册」选择弹层是否展示
    mediaSheetClosing: false, // 选择弹层是否正在播放退场动画
    loading: true,
    loadError: false
  },

  onLoad(options) {
    this.setSystemMetrics()
    this.setData({
      id: options.id || ''
    })
  },

  onShow() {
    this.loadDetail()
  },

  noop() {},

  // 0x01 最近结果登记已收归 utils/device-info.js；读取本身不再做 15s 节流。
  cacheBleInfo(deviceId, info) {
    deviceInfo.put(deviceId, info)
  },

  invalidateBleInfo() {
    deviceInfo.invalidate()
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

    wx.navigateTo({
      url: '/subpackages/device/list/list'
    })
  },

  // 在途去重：onShow 与「重新加载」/操作后刷新可能并发触发 loadDetail，并发的 0x01 读还会
  // 撞上 device-ble 的同指令限制(CMD_PENDING)，让用户此刻点「连接」时被误判——见 connectBoundDevice。
  async loadDetail() {
    if (this._loadingDetail) {
      return
    }
    if (this.data.device) {
      const cleared = Object.assign(
        {},
        this.data.device,
        batteryUtil.stampBattery(null)
      )
      this.setData({
        device: cleared,
        batteryIcon: batteryUtil.batteryIconOf(cleared),
        batteryText: batteryUtil.batteryText(cleared)
      })
    }
    this._loadingDetail = true
    try {
      await this.doLoadDetail()
    } finally {
      this._loadingDetail = false
    }
  },

  // 拉取设备详情并派生出页面展示字段（含轮播间隔下标、设备编号、内存文案等）
  // 接口失败时不再让 device 悬空：标记 loadError 走统一空态，提供「重新加载」入口
  async doLoadDetail() {
    if (!this.data.device) {
      this.setData({ loading: true, loadError: false })
    }

    let device
    try {
      device = await api.getDeviceDetail(this.data.id)
    } catch (error) {
      this.setData({
        loading: false,
        loadError: true
      })
      return
    }

    const selected = app.globalData.selectedDevice

    // 选中设备的 BLE deviceId（连接用、后端不存）要回填到详情记录，连接状态才显示得对。
    // 选中设备与详情记录可能「不同源」（绑定返回的 id 可能落到序列号，详情记录是 userProductId，
    // 或同一台设备的重复绑定记录），只按 id 匹配会漏配、错显示成「未连接」——
    // 与 list.js 一致：id 匹配不上时按硬件序列号兜底。
    const isSelected =
      !!selected &&
      !!device &&
      // 后端记录主键/完整设备 ID 优先，避免同尺寸设备因广播短 ID 相同而串用选中状态。
      activeDevice.devicesMatch(device, selected)

    if (isSelected) {
      device = Object.assign({}, device, {
        deviceId: device.deviceId || selected.deviceId,
        bleDeviceId:
          device.bleDeviceId || selected.bleDeviceId || selected.deviceId,
        battery:
          batteryUtil.normalizeBattery(device.battery) === null
            ? selected.battery
            : device.battery,
        batteryAt: device.batteryAt || selected.batteryAt || null
      })
    }
    // 完整 6 字节身份的继承与「当前选中的是不是这台」解耦：详情接口不返回设备 ID，
    // 只在 isSelected 时继承的话，用户先连了别的设备（selectedDevice 被改写）再进这台详情，
    // 记录就没有完整 ID，点「连接/投屏」会被身份闸误报「记录缺少完整设备ID，请删除后重新绑定」。
    // inheritStableIdentity 在 fallback 之外还会查身份登记表（device-identity），照样认得这台。
    device = activeDevice.inheritStableIdentity(device, isSelected ? selected : null)

    // 判连接用「deviceId 直连 + 设备ID×广播ID 序列号交叉匹配」：详情记录从接口重拉后常不带 BLE deviceId，
    // 只按 deviceId 判断会把还连着的设备错显示成「未连接」（假断联）；命中后把当下有效 deviceId 回填给记录，
    // 顶部「断开」、投屏、轮播设置等操作才有正确的 deviceId 可用。
    const liveId = activeDevice.findConnectedDeviceId(device)
    if (liveId) {
      // 连接态以 BLE 会话为准，先行置位；0x01 只用于补充内存/播放模式等信息，
      // 读失败不影响「已连接」显示（此前读失败会被静默吞掉，明明连着却显示成未连接）。
      device = activeDevice.applyConnectedIdentity(device, liveId)
      // 0x01 读取其它设备信息；电量先显示缓存，15 秒过期后再读 0x04。
      let info = null
      try {
        info = await deviceInfo.read(liveId)
      } catch (error) {
        // 其它设备信息读取失败不影响连接态；电量仍按缓存策略处理。
      }
      const batteryState = await batteryUtil.readLatestBattery(liveId, {
        fallback: device
      })
      if (info) {
        device = Object.assign(
          {},
          device,
          {
            usedMemory: info.imgCount,
            totalMemory: info.capacity,
            playbackMode: info.playMode,
            intervalSeconds: info.intervalSeconds,
            // 真机回的是秒，换算不取整：300s(5 分钟) 取整会变成 1 小时，保存时再写回就把设备改了。
            intervalHours: info.intervalSeconds
              ? info.intervalSeconds / 3600
              : device.intervalHours,
            firmwareVersion: info.firmwareVersion || device.firmwareVersion,
            // 固件真实 Device_ID（0x01 返回，与调试台一致）：设备ID行优先展示它
            firmwareDeviceId: info.deviceId || device.firmwareDeviceId
          },
          batteryState
        )
      } else {
        device = Object.assign({}, device, batteryState)
      }
      // 无论 0x01 其它信息是否成功，最近一次有效电量都回写 selectedDevice/Storage。
      // 只有「选中的就是这台」才允许在旧选中对象上合并——否则是把本设备的字段盖到另一台的记录上，
      // 本设备没有的字段会留着上一台的值（宽高/屏型/版本…），拼出一台并不存在的设备。
      const current = app.globalData.selectedDevice
      app.setSelectedDevice(
        current && activeDevice.devicesMatch(device, current)
          ? Object.assign({}, current, device)
          : device
      )
    }
    // 把当前间隔小时数映射到选择器下标，缺省落到第 1 项（2 小时）
    const intervalIndex = this.data.intervalOptions.indexOf(
      device ? device.intervalHours : 2
    )
    // 电量优先走最近缓存，超窗后台刷新；只有从未读到有效值时才显示未知。
    // 轮播设置/固件升级的右侧值只在已连接时展示，未连接一律 -- 占位（点击时提示先连接设备）
    const connected = !!(device && device.connected)
    // 设备ID只展示完整 6 字节值：优先本次 0x01 结果，读取失败可回退后端保存的完整 ID；
    // 广播 4 字节短 ID、末 6 位截断值和微信 BLE deviceId 一律不展示。
    const deviceCode = connected
      ? deviceIdUtil.canonical(device && device.firmwareDeviceId) ||
        deviceIdUtil.canonical(device && device.deviceNo) ||
        '--'
      : '--'

    this.setData({
      device,
      memoryPercent: memoryPercent(device),
      batteryIcon: batteryUtil.batteryIconOf(device),
      batteryText: batteryUtil.batteryText(device),
      deviceCode,
      resolutionText: resolutionText(device),
      memoryText: memoryText(device),
      macAddress: device && device.macAddress ? device.macAddress : '--',
      // 固件升级行右侧展示设备当前固件版本；有无新版本由箭头旁的红点表达
      firmwareVersionText: firmwareVersionText(device),
      firmwareHasUpdate: hasFirmwareUpdate(device),
      playbackLabel: connected ? getPlaybackLabel(device) : '--',
      intervalIndex: intervalIndex > -1 ? intervalIndex : 1,
      loading: false,
      loadError: false
    })
  },

  renameDevice() {
    if (!this.data.device) {
      return
    }
    this.setData({
      renameVisible: true,
      renameValue: this.data.device.name || '',
      renameSaving: false
    })
  },

  cancelRename() {
    if (!this.data.renameSaving) {
      this.setData({ renameVisible: false })
    }
  },

  async confirmRename(e) {
    const checked = deviceName.validateDeviceName(e.detail.value)
    if (!checked.ok) {
      toast.warn(checked.message)
      return
    }
    this.setData({ renameSaving: true })
    try {
      await api.renameDevice(this.data.id, checked.name)
      const updated = Object.assign({}, this.data.device, {
        name: checked.name,
        productName: checked.name
      })
      const selected = app.globalData.selectedDevice
      if (selected && String(selected.id) === String(updated.id)) {
        app.setSelectedDevice(
          Object.assign({}, selected, {
            name: checked.name,
            productName: checked.name
          })
        )
      }
      this.setData({
        device: updated,
        renameVisible: false
      })
      toast.show({ title: '名称已保存', icon: 'none' })
    } finally {
      this.setData({ renameSaving: false })
    }
  },

  async toggleCarousel(e) {
    if (!this.data.device) {
      return
    }

    const currentMode =
      this.data.device.playbackMode === 'manual'
        ? 'order'
        : this.data.device.playbackMode
    // 只改模式；间隔以后端 carouselInterval（分钟→秒）为准，后端缺字段才回退设备读回值。
    await this.applyPlayback(
      e.detail.value ? currentMode || 'order' : 'manual',
      api.resolveCarouselIntervalSeconds(
        this.data.device,
        this.data.device.intervalSeconds
      ),
      e.detail.value
    )
  },

  // 切换播放模式：单选值 '0' 为顺序，其余为随机
  async changePlayback(e) {
    if (!this.data.device) {
      return
    }

    const mode = e.detail.value === '0' ? 'order' : 'random'
    await this.applyPlayback(
      mode,
      api.resolveCarouselIntervalSeconds(
        this.data.device,
        this.data.device.intervalSeconds
      ),
      true
    )
  },

  // 切换轮播间隔：picker 返回的是 intervalOptions 的下标，intervalOptions 是小时，需转换成秒
  async changeInterval(e) {
    if (!this.data.device) {
      return
    }

    const intervalHours = this.data.intervalOptions[Number(e.detail.value)]
    await this.applyPlayback(
      this.data.device.playbackMode || 'order',
      Math.round(Number(intervalHours) * 3600),
      this.data.device.carouselEnabled !== false
    )
  },

  // intervalSeconds 单位为秒（后端 carouselInterval 的分钟已在 api.js 换算），传空才回落默认 2 小时。
  async applyPlayback(mode, intervalSeconds, carouselEnabled) {
    const device = this.data.device
    if (!device) {
      return
    }
    // 操作前先确保已连接：断联则自动重连(扫描+连接)，连不上再提示「请先连接设备」。
    const deviceId = await activeDevice.ensureConnectedForAction(device)
    if (!deviceId) {
      return
    }

    const seconds = Math.max(
      1,
      Math.round(Number(intervalSeconds) || DEFAULT_INTERVAL_SECONDS)
    )

    wx.showLoading({ title: '保存中', mask: true })
    try {
      await deviceBle.setPlayback(deviceId, mode, seconds)
      this.invalidateBleInfo() // 播放配置已变，清掉最近结果；下次 loadDetail 仍会真实重读
      const updated = Object.assign({}, device, {
        deviceId,
        bleDeviceId: deviceId,
        connected: true,
        playbackMode: mode,
        intervalSeconds: seconds,
        intervalHours: seconds / 3600,
        carouselEnabled
      })
      const intervalIndex = this.data.intervalOptions.indexOf(seconds / 3600)

      if (
        app.globalData.selectedDevice &&
        app.globalData.selectedDevice.id === updated.id
      ) {
        app.setSelectedDevice(updated)
      }

      this.setData({
        device: updated,
        playbackLabel: getPlaybackLabel(updated),
        intervalIndex:
          intervalIndex > -1 ? intervalIndex : this.data.intervalIndex
      })
      // 轮播设置保存成功不再弹提示（右侧值已刷新即为反馈）；仅保存失败时提示。
    } catch (error) {
      toast.warn({
        title: error.message || '保存失败',
        icon: 'none'
      })
    } finally {
      wx.hideLoading()
    }
  },

  // 顶部「投屏」：先确保设备已连接（未连接则自动扫描匹配并连接，连不上按标准规则提示），
  // 再弹出「拍照/相册」二选一，由用户选择投屏方式（与首页一致）。
  async startProjection() {
    let device = this.data.device
    if (!device) {
      return
    }
    // deviceId 直连 + 序列号交叉匹配：记录丢了 deviceId 但会话还活着也算已连接（connectDevice 内部会复用）
    if (!activeDevice.isDeviceConnected(device)) {
      device = await this.connectDevice()
      if (!device) {
        return // 连接失败，提示已由 connectDevice 弹出
      }
    }

    // 设为当前选中设备，预览/结果页据此连接并图传
    app.setSelectedDevice(device)
    this.setData({ showMediaSheet: true, mediaSheetClosing: false })
  },

  // 关闭「拍照/相册」选择弹层（带退场动画，与删除/清空确认弹窗一致）
  hideMediaSheet() {
    if (this.data.mediaSheetClosing) {
      return
    }
    this.setData({ mediaSheetClosing: true })
    setTimeout(() => {
      this.setData({ showMediaSheet: false, mediaSheetClosing: false })
    }, 220)
  },

  // 选「拍照」：调起相机拍一张后进入投屏
  chooseCamera() {
    this.pickAndProject(() => media.chooseFromCamera())
  },

  // 选「相册」：从相册选图后进入投屏
  chooseAlbum() {
    this.pickAndProject(() => media.chooseFromAlbum())
  },

  // 选图（拍照/相册）后跳投屏预览：用户取消选择不报错；选到图先关弹层再带数据跳转，
  // 避免弹层 flag 残留导致从预览返回详情页时弹层又冒出来。
  async pickAndProject(pickImages) {
    const device = this.data.device
    if (!device) {
      return
    }

    let images
    try {
      images = await pickImages()
    } catch (error) {
      if (error && error.errMsg && error.errMsg.indexOf('cancel') > -1) {
        return // 用户取消选择不算错误，保留弹层让其重新选择
      }
      toast.warn({ title: '选择照片失败', icon: 'none' })
      return
    }
    if (!images || !images.length) {
      return
    }

    this.setData({ showMediaSheet: false, mediaSheetClosing: false })
    wx.setStorageSync('pendingProjection', { device, images })
    wx.navigateTo({
      url: '/subpackages/projection/preview/preview'
    })
  },

  // 断开当前设备：断 BLE + 连接态回落（顶部「断开」与删除前置弹窗的「断开」共用）
  performDisconnect() {
    const device = this.data.device
    if (!device || !device.connected) {
      return
    }
    // 断的是「这台设备当下真实的那条会话」：页面记录里的 deviceId 可能是上一轮扫描的旧句柄
    // （接口刷新后被回填/继承进来），拿它去 disconnect 等于没断，会话继续占着设备（单连接、不再广播）。
    const liveId = activeDevice.findConnectedDeviceId(device) || device.deviceId
    if (liveId) {
      deviceBle.disconnect(liveId)
    }
    // 断开后这些「连接才可信」的实时数据不再有效：清掉固件读到的设备ID(0x01)与内存占用，
    // 让 device 与显示一致回落。注意保留 deviceNo(后端序列号)——重连时 matchScannedDevice 靠它匹配本机。
    // BLE 句柄一并清空：它的含义是「当前已核实属于本记录的活动会话」，会话都断了还留着，
    // 下游只按 isConnected(句柄) 判断的代码会被这条死记录骗过去（与 reconcileConnectionFlags 同口径）。
    const updated = Object.assign({}, device, {
      connected: false,
      deviceId: '',
      bleDeviceId: '',
      firmwareDeviceId: '',
      usedMemory: 0,
      totalMemory: 0
    })
    if (
      app.globalData.selectedDevice &&
      String(app.globalData.selectedDevice.id) === String(updated.id)
    ) {
      app.setSelectedDevice(updated)
    }
    // 断开后轮播设置/固件版本/设备ID/内存都不再可信，与未连接态一致回落到 --（内存进度条一并归零）。
    // 分辨率是产品静态属性、断开后依然成立，故照常刷新而不置 --（见 resolutionText 注释）
    this.setData({
      device: updated,
      deviceCode: '--',
      resolutionText: resolutionText(updated),
      memoryText: '--',
      memoryPercent: 0,
      playbackLabel: '--',
      // 断开后读不到 0x03 当前固件版本：整行回落 '--' 且红点熄灭（2026-08-20 产品规则）——
      // 与本行版本号、设备ID/内存/轮播设置一致：没有版本依据就不报警。
      // hasFirmwareUpdate 已按 connected 回落 false，这里照常调用保持单一出口。
      firmwareVersionText: '--',
      firmwareHasUpdate: hasFirmwareUpdate(updated)
    })
    // 断开成功不再弹提示（顶部按钮已切「未连接」态即为反馈）；仅失败时提示。
  },

  // 顶部「连接 / 断开」：已连接则断开；未连接则重扫匹配本设备并连接（BLE deviceId 每次扫描会话才有效）。
  async toggleConnection() {
    const device = this.data.device
    if (!device) {
      return
    }

    if (device.connected) {
      this.performDisconnect()
      return
    }

    await this.connectDevice()
  },

  // 扫描匹配并连接当前设备（「连接」按钮与「投屏」按钮共用）：
  // 成功返回带有效 deviceId/实时信息的设备对象并刷新页面 UI；失败按标准规则提示后返回 null。
  async connectDevice() {
    const device = this.data.device
    if (!device) {
      return null
    }
    try {
      // 扫描+匹配+连接主链已收敛到 active-device.connectBoundDevice（首页/列表/详情共用一份）。
      // 只用完整 6 字节 ID 筛选/复核，不再按名称连接；复用活动会话前先读设备信息做活性校验。
      const res = await activeDevice.connectBoundDevice(device, {
        verifyReuse: true
      })
      const updated = this.applyConnectedDevice(device, res.deviceId, res.info)
      // 连接成功不再弹提示（顶部切「已连接」态即为反馈，投屏流程也直接继续）；仅连接失败时提示。
      return updated
    } catch (error) {
      // 系统级「附近设备」权限被拒：弹引导去系统设置，而非笼统的「连接失败」
      activeDevice.showConnectError(error)
      return null
    }
  },

  // 连接成功后的统一收尾（新连接与复用活动会话共用）：合并设备实时信息 → 设为全局选中设备 → 刷新页面 UI。
  // info 的电量来自 15 秒缓存或本次 0x04；失败时保留详情已有有效值。
  applyConnectedDevice(device, deviceId, info) {
    if (info) {
      this.cacheBleInfo(deviceId, info) // 登记最近一次真实 0x01；紧随的 loadDetail 仍会重新读取
    }
    const updatedBase = Object.assign(
      {},
      device,
      {
        deviceId,
        bleDeviceId: deviceId,
        connected: true
      },
      info
        ? Object.assign(
            {
              usedMemory:
                info.imgCount === undefined ? device.usedMemory : info.imgCount,
              totalMemory:
                info.capacity === undefined ? device.totalMemory : info.capacity,
              playbackMode:
                info.playMode === undefined ? device.playbackMode : info.playMode,
              intervalSeconds:
                info.intervalSeconds === undefined
                  ? device.intervalSeconds
                  : info.intervalSeconds,
              // 同上：真机秒数换算不取整，保住分钟级间隔
              intervalHours: info.intervalSeconds
                ? info.intervalSeconds / 3600
                : device.intervalHours,
              firmwareVersion: info.firmwareVersion || device.firmwareVersion,
              // 固件真实 Device_ID（0x01 返回，与调试台一致）：设备ID行优先展示它
              firmwareDeviceId: info.deviceId || device.firmwareDeviceId
            },
            batteryUtil.normalizeBattery(info.battery) === null
              ? null
              : batteryUtil.stampBattery(info.battery)
          )
        : null
    )
    const updated = activeDevice.applyConnectedIdentity(
      updatedBase,
      deviceId,
      info
    )
    app.setSelectedDevice(updated)

    this.setData({
      device: updated,
      memoryPercent: memoryPercent(updated),
      batteryIcon: batteryUtil.batteryIconOf(updated),
      batteryText: batteryUtil.batteryText(updated),
      memoryText: memoryText(updated),
      // 连上后 0x01 的 screenType 才到手，分辨率这时才可能从「后端宽高/--」升级为权威值
      resolutionText: resolutionText(updated),
      playbackLabel: getPlaybackLabel(updated),
      firmwareVersionText: firmwareVersionText(updated),
      firmwareHasUpdate: hasFirmwareUpdate(updated),
      // 在详情页内点「连接」成功后只展示完整 6 字节 Device_ID。
      deviceCode:
        deviceIdUtil.canonical(updated.firmwareDeviceId) ||
        deviceIdUtil.canonical(updated.deviceNo) ||
        '--'
    })
    return updated
  },

  // 点「轮播设置」：未连接设备时不进入，提示先连接（与 startProjection 同一实时判连方式）
  goSlideshow() {
    const device = this.data.device
    if (!device) {
      return
    }
    // deviceId 直连 + 序列号交叉匹配，避免记录丢 deviceId 时误判「未连接」拦住入口
    if (!activeDevice.isDeviceConnected(device)) {
      toast.warn({ title: '请先连接电子纸设备', icon: 'none' })
      return
    }
    wx.navigateTo({
      url: `/subpackages/device/slideshow/slideshow?id=${this.data.id}`
    })
  },

  // 点「固件升级」：调接口重拉详情 → 与设备当前固件版本(0x03)比对 → 有新版本弹二次确认
  //（稍后/立刻更新），无则提示已是最新、不进升级页。判定与右侧文案共用 evaluateFirmwareUpdate。
  //
  // ⚠️ 2026-08-11 去掉了这里的「未连接直接拦住」：版本检测走后端接口、根本不需要蓝牙，
  //    先拦一道只会让用户在「没连设备」时连版本都看不到。真正需要连接的是「立刻更新」那一步，
  //    由 enterOtaUpgrade 的 ensureConnectedForAction 负责（断联自动扫连）。
  async goOtaUpgrade() {
    const device = this.data.device
    if (!device) {
      return
    }

    // 先调接口检测版本（不依赖详情页可能已过期的数据）
    wx.showLoading({ title: '检测版本中', mask: true })
    let latest
    try {
      latest = await api.getDeviceDetail(this.data.id)
    } catch (error) {
      wx.hideLoading()
      toast.warn({ title: (error && error.message) || '版本检测失败', icon: 'none' })
      return
    }
    wx.hideLoading()

    // 接口成功但没给记录：不能拿空对象去比对（会一路推导成「已是最新」），如实报检测失败。
    if (!latest) {
      toast.warn({ title: '版本检测失败', icon: 'none' })
      return
    }

    // 刚拉到的接口数据顺手回写并刷新红点：本行可能还是进页面时拉的，已经过期。
    const refreshed = Object.assign({}, device, {
      newVersionNo: latest.newVersionNo,
      downloadPath: latest.downloadPath,
      isUpdate: latest.isUpdate
    })
    this.setData({
      device: refreshed,
      firmwareVersionText: firmwareVersionText(refreshed),
      firmwareHasUpdate: hasFirmwareUpdate(refreshed)
    })

    // 与右侧红点同一套判定：设备实际固件版本(0x03) vs 接口 newVersionNo + 下载地址有效性。
    const result = evaluateFirmwareUpdate(latest, device.firmwareVersion)
    let state = result.state
    let reason = result.reason

    // 读不到设备当前版本（未连接 / 0x03 读失败）时无从比较，退回后端 isUpdate 标志：
    // 保住 2026-08-11 定下的「版本检测走接口、不连蓝牙也能查」，别把用户拦在门外。
    // 这一分支下右侧文案是 '--'，不会和这里的结论互相打架。
    if (state === 'unknown') {
      if (!isUpdateFlag(latest)) {
        state = 'latest'
      } else {
        reason = firmwarePackageError(latest)
        state = reason ? 'invalid' : 'update'
      }
    }

    // 已是最新：弹提示框，不进入固件升级详情页
    if (state === 'latest') {
      wx.showModal({
        title: '固件升级',
        content: '当前固件已是最新版本',
        showCancel: false,
        confirmText: '知道了'
      })
      return
    }

    // 版本确实不同，但包信息无效（缺版本号/下载地址/非 .bin）：如实提示，不进入
    if (state === 'invalid') {
      wx.showModal({
        title: '固件升级',
        content: reason,
        showCancel: false,
        confirmText: '知道了'
      })
      return
    }

    // 有新版本：二次确认；「立刻更新」→ 确保已连接后进入升级页自动开始下载
    wx.showModal({
      title: '固件升级',
      content: `检测到新版本：${textValue(latest.newVersionNo)}，是否升级`,
      cancelText: '稍后',
      confirmText: '立刻更新',
      success: res => {
        if (res.confirm) {
          this.enterOtaUpgrade()
        }
      }
    })
  },

  // 「立刻更新」：确保设备已连接(断联自动重连)，把当下有效连接写回选中设备，再进入固件升级页自动开始下载。
  async enterOtaUpgrade() {
    const device = this.data.device
    if (!device) {
      return
    }
    const deviceId = await activeDevice.ensureConnectedForAction(device)
    if (!deviceId) {
      return // 连不上，提示已弹（请先连接设备 / 权限引导）
    }
    app.setSelectedDevice(
      Object.assign({}, device, { deviceId, bleDeviceId: deviceId, connected: true })
    )
    wx.navigateTo({
      url: `/subpackages/device/ota/ota?id=${this.data.id}&auto=1`
    })
  },

  showClearConfirm() {
    this.setData({
      showClearConfirm: true
    })
  },

  // 先播放退场动画再卸载，避免弹窗瞬间消失
  hideClearConfirm() {
    if (this.data.clearClosing) {
      return
    }
    this.setData({ clearClosing: true })
    setTimeout(() => {
      this.setData({ showClearConfirm: false, clearClosing: false })
    }, 220)
  },

  // 一级确认点「继续」：关一级、开二级，进入二次确认（我已阅读并了解结果）
  openClearStep2() {
    this.setData({
      showClearConfirm: false,
      clearClosing: false,
      showClearConfirm2: true,
      clearClosing2: false
    })
  },

  // 二级确认弹窗关闭（带退场动画）
  hideClearConfirm2() {
    if (this.data.clearClosing2) {
      return
    }
    this.setData({ clearClosing2: true })
    setTimeout(() => {
      this.setData({ showClearConfirm2: false, clearClosing2: false })
    }, 220)
  },

  clearCopies() {
    // 一键清空需与固件交互：未连接不自动重连，直接提示「请先连接设备」
    if (!activeDevice.isDeviceConnected(this.data.device)) {
      toast.warn({ title: '请先连接电子纸设备', icon: 'none' })
      return
    }
    this.showClearConfirm()
  },

  async confirmClearCopies(options) {
    const forPermanentDelete = !!(options && options.forPermanentDelete)
    if (!this.data.device) {
      return false
    }

    // 一键清空需已连接：未连接不自动重连(点击时已拦一次，这里作二次保护)，直接提示「请先连接设备」。
    const deviceId = activeDevice.findConnectedDeviceId(this.data.device)
    if (!deviceId) {
      toast.warn({ title: '请先连接电子纸设备', icon: 'none' })
      return false
    }

    const traceId = Date.now().toString(36)
    logClearDeviceData(traceId, '点击确认，开始清空设备图片', {
      pageDeviceId: this.data.id,
      bleDeviceId: deviceId
    })
    deviceBle.setMonitor(record => logClearDeviceFrame(traceId, record))
    let clearSucceeded = false

    wx.showLoading({ title: '清空中', mask: true })
    try {
      await deviceBle.ensureConnection(deviceId)
      logClearDeviceData(traceId, 'BLE 连接已就绪', { deviceId })

      // 要删哪些槽位取决于这份 imgMask，必须真实回读 0x01；deviceInfo 已取消 15s 节流。
      const info = await deviceInfo.read(deviceId, { force: true })
      const indexes = protocol.maskToIndexes(info.imgMask)
      logClearDeviceData(traceId, '设备信息(0x01/0x03解析结果)', Object.assign({}, info, {
        imgMaskHex: protocol.bytesToHex(info.imgMask),
        existingIndexes: indexes
      }))

      // 带标签：catch 里判定为「越界/不存在」这类良性结果码时 break 出整段删图逻辑，
      // 直接进入下面的「清后端记录」，不再做回读核对（见 isBenignDeleteError）。
      deleteImages: if (indexes.length) {
        const deleteMask = protocol.indexesToMask(indexes)
        logClearDeviceData(traceId, '准备发送删除全部图片指令(0x12)', {
          indexes,
          imgIndexMask: deleteMask,
          imgIndexMaskHex: protocol.bytesToHex(deleteMask)
        })
        try {
          const deleteResult = await deviceBle.deleteImage(deviceId, indexes)
          logClearDeviceData(traceId, '删除图片应答(0x12解析结果)', Object.assign({}, deleteResult, {
            imgMaskHex: protocol.bytesToHex(deleteResult.imgMask)
          }))
        } catch (deleteError) {
          // 「槽位越界 / 图片不存在 / 掩码不一致」这类结果码：要删的图设备上本来就没有，
          // 对「清空」这个目标而言等价于已完成，不该中断流程（2026-08-01 产品要求：
          // 凡是不影响真正删掉设备与图片的异常都别抛出来）。直接按成功继续，连回读核对都免了。
          if (isBenignDeleteError(deleteError)) {
            logClearDeviceData(traceId, '删除指令(0x12)回了「越界/不存在」类结果码，按已清空继续', {
              deviceError: (deleteError && deleteError.message) || String(deleteError)
            })
            break deleteImages
          }
          // 设备对 0x12 回了非 0 结果码或应答超时——但不少固件其实已经把图删干净了，
          // 只是应答异常/迟到。这里回读一次设备状态核对：真清空了就按成功继续（记一条日志说明），
          // 只有确实还留着图才把这个「设备-」错误抛给用户，避免「已清空却报错误码」误导。
          logClearDeviceData(traceId, '删除指令(0x12)报错，回读设备状态核对是否已实际清空', {
            deviceError: (deleteError && deleteError.message) || String(deleteError)
          })
          // 设备可能还在擦除、此刻回不了 0x01：重读几次(每次间隔 4s、共 3 次)给它删完的时间，
          // 别因一次回读失败就误报「设备暂时无法连接」。任一次读到就用，全部失败才沿用原始设备错误抛出。
          let after
          let reReadError
          for (let attempt = 1; attempt <= 3 && !after; attempt++) {
            if (attempt > 1) {
              await new Promise(resolve => setTimeout(resolve, 4000))
            }
            try {
              // 这次回读用来核对「是否真的清空了」；deviceInfo 已取消 15s 结果复用。
              after = await deviceInfo.read(deviceId, { force: true })
            } catch (error) {
              reReadError = error
              logClearDeviceData(traceId, '回读设备状态失败，稍后重试', {
                attempt,
                reReadError: (error && error.message) || String(error)
              })
            }
          }
          if (!after) {
            // 多次回读都失败：无法确认设备是否已清空，沿用原始设备错误如实抛出（带来源前缀）
            logClearDeviceData(traceId, '多次回读设备状态均失败，无法确认清空结果，沿用原始设备错误', {
              reReadError: (reReadError && reReadError.message) || String(reReadError)
            })
            throw prefixDeviceError(deleteError)
          }
          const remaining = protocol.maskToIndexes(after.imgMask)
          logClearDeviceData(traceId, '回读设备状态结果', {
            imgMaskHex: protocol.bytesToHex(after.imgMask),
            remainingIndexes: remaining,
            imgCount: after.imgCount
          })
          if (remaining.length) {
            // 确实没删干净：把设备结果码如实抛出，让用户看到真实失败原因（带「设备-」前缀）
            throw prefixDeviceError(
              new Error(
                ((deleteError && deleteError.message) || '清空失败') +
                  `（电子纸设备仍剩 ${remaining.length} 张未删除）`
              )
            )
          }
          // 设备已实际清空，只是 0x12 应答异常：记录后按成功继续，不打断清空流程
          logClearDeviceData(traceId, '设备已实际清空（0x12 应答曾报错，回读确认无残留，按成功处理）', {
            deviceReportedError: (deleteError && deleteError.message) || String(deleteError)
          })
        }
      } else {
        logClearDeviceData(traceId, '设备本地没有图片，不发送删除指令(0x12)', { indexes })
      }

      // 后端文档里这个接口叫「一键删除我的图库」，端上保持只调它一个，不额外补删投屏记录：
      // 后端会在同一次调用里同步删掉该设备的投屏记录（2026-08-10 确认）。
      // 注意名实之差——「我的相册」渲染的是投屏成功记录，所以真正让相册变空的是这层级联。
      await api.clearUserProductImg(this.data.id)
      logClearDeviceData(traceId, '后端清空记录完成（含级联删投屏记录）', { id: this.data.id })
      clearSucceeded = true
    } catch (error) {
      const rawMsg = (error && error.message) || String(error)
      console.error('[一键清空][' + traceId + '] 清空失败:', error)
      // 设备忙(0x0B)：设备答得上话、只是暂时在忙，别被下方「设备-」前缀误判成「设备暂时无法连接」，
      // 原样提示「当前设备繁忙，请稍后重试」，引导用户稍后再清空。
      const isBusy = rawMsg.indexOf(protocol.BUSY_MESSAGE) !== -1
      // 清空中途设备断联 / 连不上 / 应答超时等蓝牙链路问题：会话已断，或错误带「设备-」来源前缀
      // （device-ble 的 ensureConnection/readDeviceInfo/deleteImage 失败都会被前缀成「设备-」）。
      // 这类一律统一提示「设备暂时无法连接」，不把底层设备错误码抛给用户；
      // 后端接口类错误（「接口-」前缀）仍如实提示，避免把接口问题误报成设备连不上。
      const deviceLinkFailed =
        !isBusy && (!deviceBle.isConnected(deviceId) || /^(?:设备|电子纸设备)-/.test(rawMsg))
      logClearDeviceData(traceId, '清空失败', { deviceLinkFailed, busy: isBusy, error: rawMsg })
      toast.warn({
        title: isBusy
          ? protocol.BUSY_MESSAGE
          : deviceLinkFailed
          ? '电子纸设备暂时无法连接'
          : rawMsg || '清空失败',
        icon: 'none'
      })
      return false
    } finally {
      wx.hideLoading()
      if (!clearSucceeded) {
        deviceBle.setMonitor(null)
      }
    }

    if (forPermanentDelete) {
      deviceBle.setMonitor(null)
      return true
    }

    this.hideClearConfirm2() // 带退场动画关闭二级确认弹窗
    toast.show({
      title: '已清空',
      icon: 'none'
    })
    // 一键清空后马上回读设备信息和 0x04 电量，不等下面 loadDetail 的接口往返。
    await this.refreshDeviceMemoryFromBle(deviceId)
    try {
      await this.loadDetail()
    } finally {
      logClearDeviceData(traceId, '一键清空设备指令打印结束')
      deviceBle.setMonitor(null)
    }
    return true
  },

  // 一键清空成功后立刻回读设备信息(0x01)及电量(0x04)，不等 loadDetail 的接口往返，
  // 让「已清空」后内存数马上归零。读失败(设备刚擦完可能短暂无响应)不影响清空结果，随后 loadDetail 仍会再同步一次。
  async refreshDeviceMemoryFromBle(deviceId) {
    if (!deviceId) {
      return
    }
    let info
    try {
      info = await deviceInfo.read(deviceId, { force: true })
    } catch (error) {
      return
    }
    const prev = this.data.device || {}
    const batteryState = await batteryUtil.readLatestBattery(deviceId, {
      force: true,
      fallback: prev
    })
    const device = Object.assign(
      {},
      prev,
      {
        usedMemory: info.imgCount,
        totalMemory: info.capacity
      },
      batteryState
    )
    // 回写设备连接/容量及最近一次有效电量，供跨页无闪烁展示。
    app.setSelectedDevice(
      Object.assign({}, app.globalData.selectedDevice || {}, device)
    )
    this.setData({
      device,
      memoryPercent: memoryPercent(device),
      memoryText: memoryText(device),
      resolutionText: resolutionText(device),
      batteryIcon: batteryUtil.batteryIconOf(device),
      batteryText: batteryUtil.batteryText(device)
    })
  },

  showDeleteConfirm() {
    this.setData({ showDeleteConfirm: true })
  },

  hideDeleteConfirm() {
    if (this.data.deleteClosing) {
      return
    }
    this.setData({ deleteClosing: true })
    setTimeout(() => {
      this.setData({ showDeleteConfirm: false, deleteClosing: false })
    }, 220)
  },

  // 解除绑定：只解除账号关系并断开当前会话，不清空设备或图库照片。
  async confirmDeleteDevice() {
    // _deleting 锁防连点：成功后到 navigateBack 有 500ms 窗口，期间再点会对已删设备重复请求、
    // 弹一条误导性的报错；成功路径不释放锁（页面马上销毁），仅失败释放供重试
    if (!this.data.device || this._deleting) {
      return
    }
    this._deleting = true
    try {
      await api.deleteDevice(this.data.id)
    } catch (error) {
      this._deleting = false
      return // 失败已由接口层统一提示，确认弹窗保留供重试
    }
    deviceIdentity.forget(this.data.id) // 解绑后清掉身份登记，避免主键复用时把旧设备的完整 ID 带回来
    const liveId = activeDevice.findConnectedDeviceId(this.data.device)
    if (liveId) {
      deviceBle.disconnect(liveId)
    }
    if (
      app.globalData.selectedDevice &&
      app.globalData.selectedDevice.id === this.data.id
    ) {
      app.setSelectedDevice(null)
    }
    // 删除成功立即收起确认弹窗（否则 500ms 窗口内弹窗还停在屏上），再返回上一页（列表刷新即为反馈）
    this.hideDeleteConfirm()
    setTimeout(() => wx.navigateBack(), 500)
  },

  // 「删除设备」= 一键清空设备与图库 + 断开连接 + 解除绑定。该动作必须在连接态发起。
  showPermanentDeleteConfirm() {
    if (!activeDevice.findConnectedDeviceId(this.data.device)) {
      toast.warn({ title: '请先连接电子纸设备', icon: 'none' })
      return
    }
    this.setData({
      showPermanentDeleteConfirm: true,
      permanentDeleteClosing: false
    })
  },

  hidePermanentDeleteConfirm() {
    if (this.data.permanentDeleteClosing) {
      return
    }
    this.setData({ permanentDeleteClosing: true })
    setTimeout(() => {
      this.setData({
        showPermanentDeleteConfirm: false,
        permanentDeleteClosing: false
      })
    }, 220)
  },

  openPermanentDeleteStep2() {
    this.setData({
      showPermanentDeleteConfirm: false,
      permanentDeleteClosing: false,
      showPermanentDeleteConfirm2: true,
      permanentDeleteClosing2: false
    })
  },

  hidePermanentDeleteConfirm2() {
    if (this.data.permanentDeleteClosing2) {
      return
    }
    this.setData({ permanentDeleteClosing2: true })
    setTimeout(() => {
      this.setData({
        showPermanentDeleteConfirm2: false,
        permanentDeleteClosing2: false
      })
    }, 220)
  },

  async confirmPermanentDeleteDevice() {
    if (!this.data.device || this._permanentDeleting) {
      return
    }
    const deviceId = activeDevice.findConnectedDeviceId(this.data.device)
    if (!deviceId) {
      toast.warn({ title: '请先连接电子纸设备', icon: 'none' })
      return
    }
    this._permanentDeleting = true
    const cleared = await this.confirmClearCopies({ forPermanentDelete: true })
    if (!cleared) {
      this._permanentDeleting = false
      return
    }

    wx.showLoading({ title: '删除电子纸设备中', mask: true })
    try {
      deviceBle.disconnect(deviceId)
      await api.deleteDevice(this.data.id)
      deviceIdentity.forget(this.data.id)
      if (
        app.globalData.selectedDevice &&
        String(app.globalData.selectedDevice.id) === String(this.data.id)
      ) {
        app.setSelectedDevice(null)
      }
    } catch (error) {
      this._permanentDeleting = false
      return
    } finally {
      wx.hideLoading()
    }
    this.setData({ showPermanentDeleteConfirm2: false })
    toast.show({ title: '电子纸设备已删除', icon: 'none' })
    setTimeout(() => wx.navigateBack(), 500)
  },

  formatDevice() {
    if (!this.data.device) {
      return
    }

    wx.showModal({
      title: '格式化设备',
      content: '格式化会删除电子纸设备上的照片数据，请确认是否继续。',
      confirmText: '格式化',
      confirmColor: '#c7372f',
      success: async res => {
        if (!res.confirm) {
          return
        }

        try {
          await api.formatDevice(this.data.id)
        } catch (error) {
          return // 失败已由接口层统一提示
        }
        toast.show({
          title: '格式化完成',
          icon: 'none'
        })
        this.invalidateBleInfo() // 设备照片已被清，清掉最近结果并让 loadDetail 重读内存占用
        this.loadDetail()
      }
    })
  }
}))
