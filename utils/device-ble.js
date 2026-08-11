// 相框设备的 BLE 会话层：在 utils/bluetooth.js（底层扫描/适配器）与 frame-protocol.js（编解码）之上，
// 提供「连接 → 发指令 → 收应答」的请求-应答能力，并封装出读设备信息、设电量等业务方法。
//
// 用法（绑定/详情页）：
//   const info = await deviceBle.readDeviceInfo(deviceId)   // 一次拿到电量/播放/屏幕/张数/固件
//   await deviceBle.setPlayback(deviceId, 'random', 60)
//   await deviceBle.disconnect(deviceId)

const protocol = require('./frame-protocol')
const imageCodec = require('./image-codec')

// 每台设备一个会话：缓存已发现的服务/特征、接收缓冲区与未完成的请求
const sessions = {}
// 每台设备「正在建立」的连接 Promise：用于把并发的 ensureConnection 合并成同一次连接，
// 避免预览页「预热连接」与结果页「正式连接」同时触发各自 createBLEConnection 造成竞态/重复初始化。
const connecting = {}
let globalListenerBound = false

// 收发监听器：联调调试台用它把每一帧的 16 进制原始字节打印出来，方便和硬件侧日志对照。
// 业务页面不需要可不设置；setMonitor(null) 取消。
let monitor = null
// 图传帧（0x21 数据 / 0x23 累计应答）是否也上报给监听器，默认**不报**。
// 为什么默认关：一张 5.89 寸图有 600~1400 个 0x21 包，每包都要 bytesToHex 一遍整帧（约 500 字节
// → 上千字符的字符串），这笔开销正好压在「写一包 → 等 0x23」的热路径上，既拖慢发包又推迟
// ACK 通知的处理——而调试台的 onMonitorFrame 本来就把这两类帧直接丢掉，纯属白烧。
// 真要看图传原始字节时：setMonitor(fn, { includeImageFrames: true })。
let monitorImageFrames = false

function setMonitor(fn, options) {
  monitor = typeof fn === 'function' ? fn : null
  monitorImageFrames = !!(options && options.includeImageFrames)
}

// 向监听器上报一帧收发记录。dir: 'TX' 发送 / 'RX' 接收；cmd: 命令字；bytes: 整帧原始字节。
function reportFrame(dir, deviceId, cmd, bytes, note) {
  if (!monitor) {
    return
  }
  if (
    !monitorImageFrames &&
    (cmd === protocol.CMD.IMG_DATA || cmd === protocol.CMD.IMG_ACK)
  ) {
    return
  }
  try {
    monitor({
      dir,
      deviceId,
      cmd,
      hex: protocol.bytesToHex(bytes),
      note: note || '',
      time: Date.now()
    })
  } catch (error) {
    // 监听器自身异常不能影响蓝牙收发
  }
}

// 微信返回的 UUID 是 128 位全大写串（如 0000FF01-0000-...），只取其中的 16 位短码做匹配。
// 兼容短形态入参（"FF02" / "0000FF02"）：取末 4 位——旧实现对 4 字符入参 slice(4,8) 返回空串，
// 而 matchUuid(任意短UUID, '') 恒真，短 UUID 机型上 FF11(OTA) 的通知会穿过特征过滤
// 灌进 FF00 解帧缓冲（首字节非 0xAA 堵缓冲 → 此后指令全部「应答超时」）。
function short16(uuid) {
  const norm = String(uuid || '')
    .toUpperCase()
    .replace(/-/g, '')
  if (norm.length <= 8) {
    return norm.slice(-4)
  }
  return norm.slice(4, 8)
}

// 兼容设备上报的多种 UUID 形态：
//   - 标准 128 位（0000FF00-0000-1000-8000-00805F9B34FB）：取去横杠后第 5-8 个字符的 16 位短码；
//   - 直接上报的 16 位短 UUID（"FF00" / "0000FF00"）：整体比对。
function matchUuid(uuid, shortCode) {
  const code = String(shortCode || '').toUpperCase()
  const norm = String(uuid || '')
    .toUpperCase()
    .replace(/-/g, '')
  return norm.slice(4, 8) === code || norm === code
}

function wxp(fn, options) {
  return new Promise((resolve, reject) => {
    fn(
      Object.assign({}, options, {
        success: resolve,
        fail: error =>
          reject(new Error((error && error.errMsg) || '蓝牙操作失败'))
      })
    )
  })
}

// 全局只注册一次：特征值变化 + 连接状态变化，均按 deviceId 分发到对应会话
function ensureGlobalListener() {
  if (globalListenerBound) {
    return
  }
  globalListenerBound = true

  if (wx.onBLECharacteristicValueChange) {
    wx.onBLECharacteristicValueChange(res => {
      const session = sessions[res.deviceId]
      if (!session) {
        return
      }
      // 只收本会话通知特征(FF02)的数据：同一连接上 OTA 特征(FF11)的通知（0xFC/0xF1/0xF3 应答）
      // 若灌进来，首字节不是 0xAA 会堵住解帧缓冲头部，此后 FF00 全部指令一律「应答超时」，
      // 直到断开重连（OTA 测试跑完后详情页/投屏全挂的根因之一）。
      if (
        res.characteristicId &&
        !matchUuid(res.characteristicId, short16(session.notifyCharId))
      ) {
        return
      }
      handleNotify(session, res.value)
    })
  }

  // 监听连接状态：设备主动断开（息屏/休眠/距离过远/被别的手机抢连）时，微信回调 connected=false。
  // 必须据此清掉本地会话，否则会出现两类「连接不稳定」的假象：
  //   1) isConnected() 一直谎报「已连接」（首页、调试页 requireDevice 都被骗）；
  //   2) ensureConnection 见 ready=true 会复用这条已死的会话、不再重连，后续指令全部写失败/超时。
  // 清掉会话后，下次 ensureConnection 会重新 createBLEConnection，自动恢复可用。
  if (wx.onBLEConnectionStateChange) {
    wx.onBLEConnectionStateChange(res => {
      if (!res.connected) {
        cleanupSession(res.deviceId, '电子纸设备连接已断开')
      }
    })
  }
}

// 清理某设备的会话：置为未就绪、让所有在等应答的请求立刻失败、并移除会话缓存。
// 只动内存状态，不调用 closeBLEConnection（断开回调场景下底层连接其实已经没了）。
function cleanupSession(deviceId, reason) {
  const session = sessions[deviceId]
  if (!session) {
    return
  }
  session.ready = false
  Object.keys(session.pending).forEach(key => {
    const pending = session.pending[key]
    clearTimeout(pending.timer)
    pending.reject(new Error(reason || '连接已断开'))
  })
  session.pending = {}
  delete sessions[deviceId]
}

// 单会话接收缓冲上限：设备侧应答帧都很小（几十字节）。超过说明头部 SOF 是错位数据里的假帧头、
// LEN 字段被污染成超大值在傻等「收齐」——此时必须丢头重同步，否则缓冲无界增长且解帧永久停摆。
const RX_BUFFER_MAX = 2048

// 处理一次通知数据：追加到接收缓冲，循环解出完整帧并派发给等待中的请求
function handleNotify(session, value) {
  session.rxBuffer = session.rxBuffer.concat(protocol.toBytes(value))

  // 可能粘包/分包：从头不断尝试解帧，解出一帧就消费掉对应字节
  while (session.rxBuffer.length) {
    const parsed = protocol.tryParseFrame(session.rxBuffer)
    if (!parsed) {
      // 头字节不是 SOF(0xAA)：丢包错位/串道垃圾堵在头部。丢弃到下一个 0xAA 重新同步，
      // 否则此后所有合法帧永远解不出来（表象为该设备所有指令一律「应答超时」，只能断开重连）。
      // 头部是 SOF 但缓冲异常膨胀：假帧头 + 被污染的 LEN 在傻等收齐，同样丢头重同步。
      if (
        session.rxBuffer[0] !== protocol.SOF ||
        session.rxBuffer.length > RX_BUFFER_MAX
      ) {
        const next = session.rxBuffer.indexOf(protocol.SOF, 1)
        session.rxBuffer = next === -1 ? [] : session.rxBuffer.slice(next)
        continue
      }
      break // 头部是 SOF 且长度合理：整帧未收齐，等下一次通知续上
    }
    const rawBytes = session.rxBuffer.slice(0, parsed.consumed) // 整帧原始字节，给监听器打日志
    session.rxBuffer = session.rxBuffer.slice(parsed.consumed)

    const frame = parsed.frame
    reportFrame(
      'RX',
      session.deviceId,
      frame.cmd,
      rawBytes,
      frame.crcOk ? '' : 'CRC校验失败'
    )

    // 先把帧广播给临时监听者（图传的 0x23 应答靠它接收）。复制一份再遍历，避免回调里增删数组出错。
    session.frameListeners.slice().forEach(listener => {
      try {
        listener(frame)
      } catch (error) {
        // 单个监听者异常不影响其它人
      }
    })

    if (frame.cmd !== protocol.ACK) {
      continue // 非通用应答（如 0x23 图传应答）已交给上面的监听者处理
    }
    const ack = protocol.parseAck(frame.payload)
    const pending = session.pending[ack.ackCmd]
    if (!pending) {
      continue // 没有对应的等待者（可能是主动上报），忽略
    }
    delete session.pending[ack.ackCmd]
    clearTimeout(pending.timer)
    if (!frame.crcOk) {
      pending.reject(new Error('应答 CRC 校验失败'))
    } else {
      pending.resolve(ack)
    }
  }
}

// 连接时请求的 MTU（协议设计值）与每个 0x21 数据包的数据字节上限（6.8.2）。
// 这两个值决定真实投屏的分包大小，**不要为了调试而改**——调试台要试更大的包时走
// negotiateMtu(deviceId, mtu) / uploadImage 的 options.chunkSize 显式传参，不碰这里的默认值。
const MTU_REQUEST_DEFAULT = 247
const IMG_DATA_CHUNK_MAX = 236

// 协商 MTU（一次能传多少字节）。这是图传能否成功的关键：
//   数据包整帧 = SOF+CMD+LEN(2)+PKT_SEQ(2)+DATA+CRC(2) = DATA + 8 字节固定开销，
//   而蓝牙单次可写 = MTU - 3（ATT 头），整帧必须塞得下，否则会被静默丢弃 → 图传卡死。
// 安卓默认 MTU 常只有 23，必须主动调大；iOS 由系统自动协商（setBLEMTU 会失败，忽略即可）。
// requestMtu：想协商到的值，缺省 247。调试台会传更大的值（设备侧 2026-08-07 起支持 MTU 500 +
// 0x21 数据 489 字节）；真实投屏建连时不传，仍按 247 走。
async function negotiateMtu(deviceId, requestMtu) {
  let mtu = 0
  const target =
    Number.isFinite(requestMtu) && requestMtu > 23
      ? Math.round(requestMtu)
      : MTU_REQUEST_DEFAULT

  // 安卓：把 MTU 顶到目标值；成功会返回实际协商到的值
  if (wx.setBLEMTU) {
    try {
      const res = await wxp(wx.setBLEMTU, { deviceId, mtu: target })
      if (res && res.mtu) {
        mtu = res.mtu
      }
    } catch (error) {
      // iOS 不支持手动设置，走下面的读取/兜底
    }
  }

  // 读取真实协商到的 MTU（安卓/较新 iOS 基础库支持）
  if (!mtu && wx.getBLEMTU) {
    try {
      const res = await wxp(wx.getBLEMTU, {
        deviceId,
        writeType: 'writeNoResponse'
      })
      if (res && res.mtu) {
        mtu = res.mtu
      }
    } catch (error) {
      // 读不到就用兜底值
    }
  }

  // 读不到时给个对 iOS 安全的保守值（iOS 实际通常 ≥185），保证整帧塞得下、不丢包
  return mtu || 185
}

// 由 MTU 推算每个图片数据包能装多少字节（缺省上限 236，见 6.8.2）。
// 必须保证「整帧(=chunk+8) ≤ 单次可写(=MTU-3)」，否则数据包会被静默丢弃导致图传卡死。
// maxChunk：数据字节上限，缺省 236（协议整帧上限即 236+8=244）。只有调试台会传更大的值。
function chunkFromMtu(mtu, maxChunk) {
  const cap =
    Number.isFinite(maxChunk) && maxChunk >= 1
      ? Math.round(maxChunk)
      : IMG_DATA_CHUNK_MAX
  const writable = (mtu || 185) - 3 // 单次可写 = MTU - 3
  const maxFrame = Math.min(writable, cap + 8) // 整帧上限 = 数据上限 + 8 字节固定开销
  return Math.min(cap, Math.max(1, maxFrame - 8))
}

// 本次图传实际用的每包数据字节数。
//   · 调用方显式传了 chunkSize（调试台的「0x21 数据字节」输入框）→ 按它走，但仍必须塞得进当前
//     MTU（整帧 = 数据 + 8 ≤ MTU-3），越界即夹回链路能承载的上限，避免写下去被静默丢弃；
//   · 没传 → 用建连时按 236 上限算好的会话值。真实投屏走的就是这条，行为一字未变。
function effectiveChunkSize(session, requested) {
  const fallback = (session && session.dataChunk) || IMG_DATA_CHUNK_MAX
  const value = Math.round(Number(requested))
  if (!Number.isFinite(value) || value < 1) {
    return fallback
  }
  const writable = ((session && session.mtu) || 185) - 3
  return Math.max(1, Math.min(value, writable - 8))
}

// 发现 FF00 主服务：很多机型（尤其安卓）在 createBLEConnection 成功后服务并未立即就绪，
// 立刻 getBLEDeviceServices 常拿到空/不全的列表 → 误报「未找到主服务」。这里短间隔重试直到发现。
async function discoverMainService(deviceId, attempts = 6, interval = 250) {
  let lastUuids = []
  for (let i = 0; i < attempts; i++) {
    const servicesRes = await wxp(wx.getBLEDeviceServices, { deviceId })
    const services = servicesRes.services || []
    lastUuids = services.map(s => s.uuid)
    const service = services.find(s => matchUuid(s.uuid, protocol.SERVICE_UUID))
    if (service) {
      // 每次连接都打印设备实际暴露的服务 UUID 列表，便于核对 FF00/FF10 等
      console.log('[BLE] 设备暴露的服务 UUID 列表：', lastUuids)
      return { service, uuids: lastUuids }
    }
    if (i < attempts - 1) {
      await sleep(interval) // 等服务发现完成再试一次
    }
  }
  // 重试后仍未发现 FF00：打印设备实际暴露的服务 UUID，便于判断是「短码匹配问题」还是「设备根本没有 FF00」
  console.warn(
    '[BLE] 未匹配到 FF00 主服务，设备实际暴露的服务 UUID 列表：',
    lastUuids
  )
  return { service: null, uuids: lastUuids }
}

// 发现主服务下的写(FF01)/通知(FF02)特征，同样对「特征尚未就绪」做短重试。
async function discoverCharacteristics(
  deviceId,
  serviceId,
  attempts = 4,
  interval = 200
) {
  for (let i = 0; i < attempts; i++) {
    const charsRes = await wxp(wx.getBLEDeviceCharacteristics, {
      deviceId,
      serviceId
    })
    const chars = charsRes.characteristics || []
    const writeChar = chars.find(c =>
      matchUuid(c.uuid, protocol.CHAR_WRITE_UUID)
    )
    const notifyChar = chars.find(c =>
      matchUuid(c.uuid, protocol.CHAR_NOTIFY_UUID)
    )
    if (writeChar && notifyChar) {
      return { writeChar, notifyChar }
    }
    if (i < attempts - 1) {
      await sleep(interval)
    }
  }
  return null
}

// 建立底层 BLE 连接，带自动重试。安卓首连常偶发 10003(connection fail)/10012(操作超时)，
// 重试通常即可成功；若底层报「已连接」则直接当成功返回。多次失败才抛出供上层提示。
//
// 连接重试预算（2026-07-20 第二轮，治残留的 connect time out）。
//
// 这是**内层**重试：只负责「同一个 deviceId 上的瞬时失败」（蓝牙栈抖动、CONNECT_IND 丢包）。
// 「deviceId 本身已失效 / 设备不再广播」那一类失败换多少次都没用，由**外层**的重扫兜底
// （active-device.scanMatchConnect 的 SCAN_CONNECT_ROUNDS，失败后重新扫描拿新鲜 deviceId 再连）。
// 分层之后内层不必堆次数，故从上一轮的「4 次 × 6s」收到「2 次」，把预算让给外层重扫。
//
// 超时逐次拉长而不是固定值：首次 5s 快速试错（多数失败是瞬时的，早失败早重试更划算），
// 末次 8s 耐心等——弱信号下 CONNECT_IND 可能要经过好几个广播事件才被设备收到，一刀切的短超时会把
// 「本来能连上、只是慢」误杀成失败。
const CONNECT_ATTEMPTS = 2
const CONNECT_TIMEOUTS = [5000, 8000]
const CONNECT_BACKOFF_MS = [400]

async function createConnectionWithRetry(deviceId, attempts = CONNECT_ATTEMPTS) {
  let lastError = null
  for (let i = 0; i < attempts; i++) {
    try {
      await wxp(wx.createBLEConnection, {
        deviceId,
        timeout: CONNECT_TIMEOUTS[Math.min(i, CONNECT_TIMEOUTS.length - 1)]
      })
      return
    } catch (error) {
      const msg = ((error && error.message) || '').toLowerCase()
      // 底层仍保有该连接：当成功处理，后续照常发现服务/特征
      if (msg.indexOf('already') > -1 || msg.indexOf('connected') > -1) {
        return
      }
      lastError = error
      // 连接失败(含 connect time out)后，底层常残留一条「正在连接/半连接」，必须立即关掉释放设备——
      // 否则设备被占用不再广播，紧接着的重试/重扫就「未搜索到该设备」（表现为「超时后要多点几次才连上」）。
      // 关键：每次失败都关，尤其是最后一次——之前 close 只写在「还要重试」分支里，最后一次超时漏关，
      // 正是「设备-createBLEConnection:fail connect time out → 小程序-未搜索到该设备」这条链路的根因。
      if (wx.closeBLEConnection) {
        try {
          await wxp(wx.closeBLEConnection, { deviceId })
        } catch (closeError) {
          // 没有可关闭的连接，忽略
        }
      }
      if (i < attempts - 1) {
        // 等底层清理干净再重试，显著提升首连成功率。退避递增（300/600/1200ms），
        // 超出数组长度时沿用最后一档，改 CONNECT_ATTEMPTS 不必同步改这里。
        await sleep(CONNECT_BACKOFF_MS[Math.min(i, CONNECT_BACKOFF_MS.length - 1)])
      }
    }
  }
  throw lastError || new Error('蓝牙连接失败')
}

// 会话序列号登记：把这台设备的稳定标识（扫描广播里的 Device_ID 4/6 字节 / 0x01 读到的固件 6 字节）
// 归一化后记到会话上。BLE deviceId 是扫描会话临时值、后端只存序列号，页面刷新/切换后记录常丢 deviceId——
// 有了序列号，上层(active-device.findConnectedDeviceId)才能用「设备ID×广播ID」交叉匹配认出活动会话，
// 避免「假断联 → 重扫（设备被自己占线不广播）→ 未搜索到该设备」。
//
// verified：这个值是不是**连上后 0x01 GET_INFO 从设备真身读回来的**。
// 2026-08-11 补这个标记：广播 Device_ID 从 4 字节扩到 6 字节后，广播值也长得像「完整身份」了，
// 上层若继续只按长度判断，就等于让**明文可伪造的广播**去认领活动会话（一台设备播的 ID 恰好等于
// 另一条记录的完整 ID，操作就会打到错的设备上，OTA 尤其不可逆）。
// 老固件时代广播只有 4 字节、天然被 isComplete 挡在门外，这道闸是隐式的；现在必须显式记下来源。
function attachSessionSerial(deviceId, serial, verified) {
  const session = sessions[deviceId]
  const value = String(serial == null ? '' : serial)
    .replace(/[:\-\s]/g, '')
    .toUpperCase()
  if (!session || !value) {
    return
  }
  session.serials = session.serials || []
  if (session.serials.indexOf(value) === -1) {
    session.serials.push(value)
  }
  if (!verified) {
    return
  }
  session.verifiedSerials = session.verifiedSerials || []
  if (session.verifiedSerials.indexOf(value) === -1) {
    session.verifiedSerials.push(value)
  }
}

// 把扫描广播里的屏幕类型(6.10.7 Screen_Type)登记到会话。交叉匹配活动会话时据此按「物理型号/尺寸」
// 再校验一道：广播 4 字节与后端 6 字节序列号偶合时，不同型号(如 3.7寸 vs 5.89寸)会被尺寸一票否决，防串台。
function attachSessionScreen(deviceId, screenType) {
  const session = sessions[deviceId]
  if (!session || !screenType) {
    return
  }
  session.screenType = screenType
}

// 建立连接并发现 FF00 主服务下的写(FF01)/通知(FF02)特征，开启通知。结果缓存到会话。
// 已连上直接复用；正在连则复用在途 Promise（避免并发重复连接），否则发起一次新连接。
// meta.deviceNo（可选）：扫描广播里的 Device_ID，登记到会话供「设备ID×广播ID」交叉匹配。
// meta.screenType（可选）：扫描广播里的屏幕类型，登记到会话供交叉匹配时按型号/尺寸再校验，防串到不同型号设备。
async function ensureConnection(deviceId, meta) {
  const serial = meta && (meta.deviceNo || meta.serial)
  const screenType = meta && meta.screenType
  if (sessions[deviceId] && sessions[deviceId].ready) {
    attachSessionSerial(deviceId, serial)
    attachSessionScreen(deviceId, screenType)
    return sessions[deviceId]
  }
  if (connecting[deviceId]) {
    const session = await connecting[deviceId]
    attachSessionSerial(deviceId, serial)
    attachSessionScreen(deviceId, screenType)
    return session
  }
  // 单连接：即将新建一条连接，先释放本机持有的其他会话。
  // 复用已就绪会话 / 复用在途 Promise 两个分支都在上面 return 了，所以「连同一台」永远走不到
  // 这里 —— 天然幂等，不会把自己刚建好的连接断掉。
  disconnectOthers(deviceId)
  const promise = establishConnection(deviceId)
  connecting[deviceId] = promise
  try {
    const session = await promise
    // 再释放一次：上面那次只看得见「当时已登记在 sessions 里的」会话。若另一路 ensureConnection
    // 恰好在我们建连期间完成（例如投屏预览页 preview.js 那个 fire-and-forget 的预热连接），
    // 它的会话是在那之后才登记的，会漏网。后完成者胜 —— 与「用户最后点的那台才是要用的」一致。
    disconnectOthers(deviceId)
    attachSessionSerial(deviceId, serial)
    attachSessionScreen(deviceId, screenType)
    return session
  } finally {
    delete connecting[deviceId]
  }
}

// 真正执行一次连接建立（发现服务/特征、开启通知、协商 MTU、缓存会话）。由 ensureConnection 串行调度。
async function establishConnection(deviceId) {
  ensureGlobalListener()
  await createConnectionWithRetry(deviceId)

  // 设备为单连接（PRD 6.2.3）：连接成功后若服务/特征发现或订阅失败，必须立即断开，
  // 否则设备被占用、不再开启广播，会导致下次扫描不到、再也连不上。
  try {
    // 连接成功后服务/特征可能尚未发现完成，带短重试地查找，避免误报「未找到主服务/特征」
    const { service, uuids } = await discoverMainService(deviceId)
    if (!service) {
      // 只描述「检测到什么」，不臆测原因/不给建议：仅暴露 OTA 服务(FF10) 没有业务服务(FF00) 时点明这一事实
      const onlyOta =
        uuids.some(u => matchUuid(u, protocol.OTA_SERVICE_UUID)) &&
        !uuids.some(u => matchUuid(u, protocol.SERVICE_UUID))
      throw new Error(
        onlyOta
          ? '电子纸设备只暴露 OTA 服务(FF10)，未发现相框主服务(FF00)'
          : '未发现相框主服务(FF00)'
      )
    }

    const found = await discoverCharacteristics(deviceId, service.uuid)
    if (!found) {
      throw new Error('未找到读写特征(FF01/FF02)')
    }
    const { writeChar, notifyChar } = found

    await wxp(wx.notifyBLECharacteristicValueChange, {
      deviceId,
      serviceId: service.uuid,
      characteristicId: notifyChar.uuid,
      state: true
    })

    // 关键：协商 MTU 并据此定好每包数据大小，避免大数据包被静默丢弃导致图传卡死
    const mtu = await negotiateMtu(deviceId)

    const session = {
      deviceId,
      serviceId: service.uuid,
      writeCharId: writeChar.uuid,
      notifyCharId: notifyChar.uuid,
      rxBuffer: [],
      pending: {},
      frameListeners: [], // 临时帧监听者（图传等待 0x23 应答时往里塞，用完移除）
      serials: [], // 这台设备的稳定序列号（广播 Device_ID/固件 Device_ID），供交叉匹配活动会话
      mtu, // 协商到的 MTU
      dataChunk: chunkFromMtu(mtu), // 每个图片数据包可装的字节数
      // 实测指定有应答写(write)会报 10007「特征不支持此操作」，与 PRD「FF01: Write Without Response」一致——
      // 这台设备只能用无应答写。无应答写不可靠(可能被手机/链路悄悄丢)，只能靠应用层窗口 ACK 重传兜底。
      writeType: 'writeNoResponse',
      ready: true
    }
    sessions[deviceId] = session
    // 连接建立后把 BLE 连接间隔设为省电的空闲档(100ms)：图传时才临时切到极速档、传完再回落到这里，
    // 保证平时保活挂着的连接不长期跑在费电的极速间隔上。best-effort（内部吞错、2s 短超时），失败不阻断连接。
    // ⚠️ 总开关 IDLE_CONN_INTERVAL_ENABLED 当前为 false → 这里实际是空转，链路停在系统默认间隔上。
    await applyIdleConnectionInterval(deviceId)
    return session
  } catch (error) {
    if (wx.closeBLEConnection) {
      wx.closeBLEConnection({ deviceId }) // 释放被占用的连接，保证设备能重新广播
    }
    throw error
  }
}

// 发送一条指令并等待设备对应的 ACK；返回 { ackCmd, result, data }
async function request(deviceId, cmd, payload, timeout = 6000) {
  const session = await ensureConnection(deviceId)

  if (session.pending[cmd]) {
    // 带 code 供上层判断（如 active-device.verifyReuse）：这个错误说明会话活着且正忙，
    // 不能与「读不动的死会话」混为一谈；靠错误文案匹配太脆弱，故给机器可读的 code。
    const busyError = new Error(`指令 0x${cmd.toString(16)} 正在等待应答`)
    busyError.code = 'CMD_PENDING'
    throw busyError
  }

  const ackPromise = new Promise((resolve, reject) => {
    session.pending[cmd] = {
      resolve,
      reject,
      timer: setTimeout(() => {
        delete session.pending[cmd]
        reject(new Error(`指令 0x${cmd.toString(16)} 应答超时`))
      }, timeout)
    }
  })

  const value = protocol.buildFrame(cmd, payload)
  reportFrame('TX', deviceId, cmd, value)
  try {
    await wxp(wx.writeBLECharacteristicValue, {
      deviceId,
      serviceId: session.serviceId,
      characteristicId: session.writeCharId,
      value
    })
  } catch (error) {
    // 写失败（发送缓冲满/瞬时断连）：立刻回收 pending。否则 6s 超时内同 cmd 的新请求会被
    // 误拒「正在等待应答」，且孤儿 ackPromise 超时 reject 无人接 → unhandled rejection。
    const pending = session.pending[cmd]
    if (pending) {
      clearTimeout(pending.timer)
      delete session.pending[cmd]
    }
    throw error
  }

  const ack = await ackPromise
  // 设备忙（规格书 v1.5 §6.6.1，RESULT=0x0B）：设备正在处理其它指令时对新指令回 0x0B。
  // 所有走 ACK 的设备交互（读设备信息/电量/播放配置、设置播放/校时/删除/刷新、图传起止等）都经此 request()，
  // 在这里集中拦截，无论读写一律提示「当前设备繁忙，请稍后重试」；经 wrapDevice 会补「设备-」来源前缀。
  if (protocol.isBusyResult(ack.result)) {
    throw new Error(protocol.BUSY_MESSAGE)
  }
  return ack
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// 图传数据包之间的发送间隔（毫秒）。FF01 用「无应答写」，写得太快有两个后果：
//   1) 把手机蓝牙发送缓冲冲爆 → writeValueToCharacteristics error；
//   2) 设备端（BLE 收包 + 写 Flash）跟不上 → 收一阵就不再前进（ACK_SEQ 卡住）。
// 默认取「极速」档(3ms)：固件已扩大 MCU 收包内存(可缓 10 包)，配合平台的极速连接间隔
//（安卓/鸿蒙 7.5ms、iOS 15ms，见下方 TRANSFER_CONN_INTERVAL_MS_*）按最快速率喂数据。
// 调试页「保存给真实投屏」可把实测调稳的 pace 写进下面的存储键覆盖它；卡顿时窗口内部还会自动缩窗+减速兜底。
const PACKET_PACE_MS = 3
// 图传前尝试把 BLE 连接间隔调到的默认值：按平台区分（2026-07-10 真机 A/B 数据，iPhone 12）。
//   安卓：7.5ms（CONN_INTERVAL=6，协议最小值）——安卓中心侧通常批准；
//   iOS：15ms——Apple 规范拒绝 <15ms 的参数更新请求，请求 7.5ms 会被系统忽略、链路停在
//        自选的 30/45ms 上（实测请求 15ms 后 dataMs 15.2s→9.6s、吞吐 11.1→17.6KB/s）。
// 调试页「保存给真实投屏」写入的存储值仍优先于平台默认；设置失败不阻断旧图传链路。
const TRANSFER_CONN_INTERVAL_MS_ANDROID = 7.5
const TRANSFER_CONN_INTERVAL_MS_IOS = 15
const TRANSFER_CONN_INTERVAL_STORAGE_KEY = 'transferConnIntervalMs'

// 空闲期(非图传)的省电连接间隔：连接建立后、以及每次图传结束后，都下发 0x13 把 BLE 连接间隔回落到此值。
// 只有真正给设备传图时才由 optimizeConnectionIntervalForTransfer 临时切到极速档(安卓 7.5 / iOS 15ms)，传完回落——
// 连接现在是保活的(app.onShow reconcile，不再传完即断)，长期挂在费电的极速间隔上没必要。
// 100ms = 80 units（1 unit = 1.25ms），落在协议允许的 6~3200 units 内。
const IDLE_CONN_INTERVAL_MS = 100
// 设置空闲连接间隔用的应答超时(ms)：0x13 是 v1.4 才有的指令，老固件可能根本不回。收紧到 2s（默认 6s），
// 别让「连接后设省电间隔」在老固件上把每次连接都白白拖慢 6s（对齐 Flutter 端 0x05/0x13 的 2s 超时）。
const IDLE_CONN_INTERVAL_SET_TIMEOUT = 2000

// 空闲省电连接间隔的总开关（2026-07-20：先关闭）。
// 关闭后 applyIdleConnectionInterval 直接空转：连接建立后、图传结束后都**不再**下发 0x13 回落到 100ms，
// 链路停在上一次设置的间隔上（首连=手机/系统默认，图传后=极速档 7.5/15ms）。
//
// 为什么做成开关而不是直接删掉：省电逻辑本身是对的，但它是一道**加在每条链路上的全局约束**——
// 连接后多一次 0x13 往返（老固件不回时还要空等满 2s），图传收尾还必须排在末张 0x24 刷屏之后才能发
// （刷屏期设备回忙 0x0B，见下方函数注释）。排查连接慢/图传异常时这些都是干扰项，留开关才能一键对照。
// 确认无副作用后再决定去留，别直接删——重写一遍这套时序的成本远高于留一个常量。
const IDLE_CONN_INTERVAL_ENABLED = false
// 存储覆盖键：调试时 wx.setStorageSync('idleConnIntervalEnabled', true) 即可临时开启，不必改代码重编译
//（与 transferConnIntervalMs / transferPaceMs 同一套「存储值优先于默认值」的机制）。
const IDLE_CONN_INTERVAL_STORAGE_KEY = 'idleConnIntervalEnabled'

// 空闲省电连接间隔当前是否启用：存储里显式存了布尔值就以它为准，否则用上面的默认开关。
function idleConnIntervalEnabled() {
  try {
    const stored = wx.getStorageSync(IDLE_CONN_INTERVAL_STORAGE_KEY)
    if (stored === true || stored === false) {
      return stored
    }
  } catch (error) {
    // 读存储失败按默认值走，不影响连接
  }
  return IDLE_CONN_INTERVAL_ENABLED
}

// 按运行平台取图传连接间隔默认值。只有明确是安卓才用 7.5ms；iOS/未知平台（探测失败、
// 桌面端等）一律 15ms 保守取值——15ms 各平台都接受（最多慢一点），反之 iOS 请求 7.5ms
// 会被拒、停在更慢的系统默认值上。鸿蒙(ohos)蓝牙栈行为同安卓，按 7.5ms。
function defaultTransferConnIntervalMs() {
  try {
    const info = wx.getDeviceInfo ? wx.getDeviceInfo() : wx.getSystemInfoSync()
    const platform = (info && info.platform) || ''
    return platform === 'android' || platform === 'ohos'
      ? TRANSFER_CONN_INTERVAL_MS_ANDROID
      : TRANSFER_CONN_INTERVAL_MS_IOS
  } catch (error) {
    return TRANSFER_CONN_INTERVAL_MS_IOS
  }
}
// 真实投屏图传每包发送间隔(ms)的存储键：调试页「保存给真实投屏」把实测 pace 写进来，真实投屏优先读它，
// 没同步过则回落默认 PACKET_PACE_MS(极速 3ms)。与连接间隔同套「调试台调好→同步到真实场景」的机制。
const TRANSFER_PACE_STORAGE_KEY = 'transferPaceMs'
// 图传窗口(发满多少包等一次 0x23 累计应答)。
//   · 默认仍是 10：真实投屏没被「保存给真实投屏」改过时用的就是它，本轮一字未动；
//   · 上限 2026-08-07 由 10 放宽到 50（设备侧扩了收包缓冲，确认可缓 50 包）——调试台的
//     「发包窗口」输入框在 [1,50] 内自由试；超过缓冲仍会溢出丢包，故 normalizeTransferWindow 照旧夹住。
const DEFAULT_TRANSFER_WINDOW = 10
const TRANSFER_WINDOW_MAX = 50
const TRANSFER_WINDOW_STORAGE_KEY = 'transferWindow'

// ── 图传调速策略（pacer）────────────────────────────────────────────────────
// 图传主循环只管「发包 / 等 0x23 / 记账」，窗口多大、每包隔多久、ACK 等多久全部由 pacer 决定。
// 两套策略并存，靠 uploadImage 的 options.adaptive 选择：
//   · legacy（默认，真实投屏走这条）：2026-08-11 之前的原策略，本轮一字未改；
//   · adaptive（只有调试台传 adaptive:true 才启用）：新的 AIMD 拥塞控制，在调试台实测验证中。
// 等调试台跑够真机数据、确认稳定更快，再决定要不要把真实投屏也切过去（改一个默认值即可）。
const LEGACY_ACK_TIMEOUT_MS = 600 // legacy：固定 600ms 等一次 0x23 推进
const PACE_PROBE_AFTER = 6 // 连续几个干净窗口把每包间隔往下探一档
const PACE_PROBE_STEP = 0.5
const MAX_ACK_RETRIES = 15 // 同一位置连续退让这么多次仍不推进 → 判为设备中断

// legacy 策略（真实投屏在用）：窗口/每包间隔恒等于配置值，只在「卡住的那一轮」临时缩窗+加间隔，
// 一有推进立刻弹回满窗满速；ACK 超时固定 600ms。
function createLegacyPacer(maxWindow, basePace) {
  let curPace = basePace
  let cleanRun = 0
  return {
    windowFor: retries => (retries === 0 ? maxWindow : Math.max(1, maxWindow - retries)),
    paceFor: retries =>
      retries === 0 ? curPace : Math.min(150, curPace + 30 * retries),
    ackTimeout: () => LEGACY_ACK_TIMEOUT_MS,
    // legacy 没有「宽限一轮再判丢包」这一步：超时即整窗重发
    grace: false,
    onTimeout() {
      curPace = Math.min(basePace, curPace + PACE_PROBE_STEP)
      cleanRun = 0
    },
    onClean(advanceMs, retries) {
      if (retries !== 0) {
        cleanRun = 0
      } else if (curPace > 0 && ++cleanRun >= PACE_PROBE_AFTER) {
        curPace = Math.max(0, curPace - PACE_PROBE_STEP)
        cleanRun = 0
      }
    },
    state: () => ({ window: maxWindow, pace: curPace, minWindow: maxWindow })
  }
}

// adaptive 策略（调试台）：AIMD 拥塞控制。老策略窗口一大反而更慢更容易卡死——
//   灌满 50 包 → 设备缓冲溢出丢一包 → 其后 49 包全成废包（设备按序累计确认）→ 等满超时
//   → 从丢包处整窗重发 → 又灌满 50 包 → 再溢出……窗口越大，每转一圈的代价越大。
//   （老策略的「减速兜底」还写成 curPace = Math.min(配置值, curPace + 步长)，被配置值封顶，
//     实际永远降不下速，等于只会越跑越快、从不退让。）
// 这里改成：**起步就用配置的最快值，卡了窗口减半 + 每包间隔翻倍并保持住，稳了再慢慢涨回**，
// 外加两条：ACK 超时按实测推进耗时自适应（设备只是慢时别误判成丢包）、超时先宽限等一轮再判丢包。
const ACK_TIMEOUT_START_MS = 600 // 首轮还没有观测值时的超时
const ACK_TIMEOUT_MIN_MS = 300 // 有观测值后的下限：判早了也只是多等一轮宽限，不会立刻整窗重发
const ACK_TIMEOUT_MAX_MS = 3000 // 上限：再慢也该判为丢包/中断
const PACE_BACKOFF_MAX_MS = 40 // 退让时每包间隔的上限
const WINDOW_RECOVER_AFTER = 2 // 连续几个干净窗口涨一档窗口

function createAdaptivePacer(maxWindow, basePace) {
  let curPace = basePace
  let curWindow = maxWindow
  let minWindow = maxWindow
  let cleanRun = 0
  let emaAdvanceMs = 0 // 实测「等一次 0x23 推进」耗时的指数滑动平均
  return {
    windowFor: () => curWindow,
    paceFor: () => curPace,
    // graceRound=true 是宽限那一轮，等更久：真丢包时多花的这点时间，远小于误判后整窗重发的代价
    ackTimeout: graceRound => {
      const base = emaAdvanceMs
        ? Math.min(
            ACK_TIMEOUT_MAX_MS,
            Math.max(ACK_TIMEOUT_MIN_MS, Math.round(emaAdvanceMs * 4) + 150)
          )
        : ACK_TIMEOUT_START_MS
      return graceRound ? Math.min(ACK_TIMEOUT_MAX_MS, base * 2) : base
    },
    grace: true,
    onTimeout() {
      curWindow = Math.max(1, Math.floor(curWindow / 2))
      curPace = Math.min(
        PACE_BACKOFF_MAX_MS,
        Math.max(1, Math.round((curPace || 1) * 2))
      )
      minWindow = Math.min(minWindow, curWindow)
      cleanRun = 0
    },
    onClean(advanceMs) {
      emaAdvanceMs = emaAdvanceMs
        ? emaAdvanceMs * 0.75 + advanceMs * 0.25
        : advanceMs
      cleanRun++
      if (curWindow < maxWindow && cleanRun % WINDOW_RECOVER_AFTER === 0) {
        curWindow = Math.min(
          maxWindow,
          curWindow + Math.max(1, Math.floor(maxWindow / 8))
        )
      }
      if (curPace > 0 && cleanRun % PACE_PROBE_AFTER === 0) {
        // 链路一直干净就继续往下探每包间隔（可以探到 0），配置值只是起点不是下限
        curPace = Math.max(0, curPace - PACE_PROBE_STEP)
      }
    },
    state: () => ({ window: curWindow, pace: curPace, minWindow })
  }
}

// 写一个图传数据包（value 为已组好的完整 0x21 帧 ArrayBuffer，见 buildImgDataFrame/预组包），
// 带「缓冲忙就退避重试」：写失败(常见 writeValueToCharacteristics error 是缓冲暂满)
// 不立刻判死，稍等再试，几次都不行才抛出。
async function writePacket(session, value, stats) {
  const params = {
    deviceId: session.deviceId,
    serviceId: session.serviceId,
    characteristicId: session.writeCharId,
    value
  }
  if (session.writeType) {
    params.writeType = session.writeType // 'write' 有应答(可靠) / 'writeNoResponse' 无应答(快但可能丢)
  }
  let attempt = 0
  for (;;) {
    const startedAt = Date.now()
    if (stats) {
      stats.writeCalls++
    }
    try {
      reportFrame('TX', session.deviceId, protocol.CMD.IMG_DATA, value)
      await wxp(wx.writeBLECharacteristicValue, params)
      if (stats) {
        const duration = Date.now() - startedAt
        stats.writeTotalMs += duration
        stats.writeMaxMs = Math.max(stats.writeMaxMs, duration)
      }
      return
    } catch (error) {
      if (stats) {
        const duration = Date.now() - startedAt
        stats.writeTotalMs += duration
        stats.writeMaxMs = Math.max(stats.writeMaxMs, duration)
        stats.writeFailures++
      }
      if (++attempt > 4) {
        throw error
      }
      await sleep(80) // 发送缓冲可能暂时满，等一下再写
    }
  }
}

// 预组一张图的全部 0x21 数据帧（性能优化 D1）。分批让出事件循环：预取阶段与上一张 BLE 传输
// 并行执行，长同步计算会饿死正在跑的 0x23 ACK 处理，每组 256 帧 yield 一次。
async function buildAllImgDataFrames(bytes, chunkSize) {
  const total = Math.ceil(bytes.length / chunkSize)
  const frames = new Array(total)
  for (let seq = 0; seq < total; seq++) {
    frames[seq] = protocol.buildImgDataFrame(bytes, seq, chunkSize)
    if ((seq & 0xff) === 0xff) {
      await sleep(0)
    }
  }
  return frames
}

// 图传预处理（性能优化 D1/D2）：整图 CRC32 + 按会话分包大小预组好全部 0x21 帧。
// 纯计算、不碰蓝牙，设计为在「预取阶段」调用——与上一张图的 BLE 传输/本张的网络下载重叠，
// 把这两块耗时从「拿到帧 → 发 0x20 → 逐包发送」的串行热路径上挪走。
// 会话未就绪（首张与连接并行预取）时分包大小未知，只算 CRC32、frames 返回 null；
// uploadImage 收到的 prepared 帧数/分包对不上时会自动回退为逐包现组，不影响正确性。
// options.chunkSize：显式指定每包数据字节数（调试台传「0x21 数据字节」的实际生效值）。
// uploadImage 只认 chunkSize 与本次实际分包一致的 prepared，两边不对齐就白预组了。
async function prepareImageTransfer(deviceId, data, options) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  const crc32 = imageCodec.crc32Mpeg2(bytes)
  const session = sessions[deviceId]
  // 会话未就绪（首张预取与连接并行）时分包大小还未知，只算 CRC32
  if (!session || !session.ready || !session.dataChunk) {
    return { crc32, dataSize: bytes.length, chunkSize: 0, frames: null }
  }
  const requested = options && options.chunkSize
  const chunkSize = Number.isFinite(Number(requested))
    ? effectiveChunkSize(session, requested)
    : session.dataChunk
  const frames = await buildAllImgDataFrames(bytes, chunkSize)
  return { crc32, dataSize: bytes.length, chunkSize, frames }
}

// 整个图传期间挂一个常驻监听器，持续记录设备回报的「已连续接收最后包号」的最大值。
// 用「取最大值 + 等待推进」的方式，天然兼容重复/迟到/乱序的 0x23 应答，比一次性等单帧更稳。
function createAckTracker(session) {
  const state = { lastAckSeq: -1, waiters: [], ackFrames: 0, advances: 0 }

  const listener = frame => {
    if (frame.cmd !== protocol.CMD.IMG_ACK || !frame.crcOk) {
      return
    }
    state.ackFrames++
    const seq = protocol.parseImgAck(frame.payload).ackSeq
    if (seq > state.lastAckSeq) {
      state.lastAckSeq = seq
      state.advances++
    }
    state.waiters.splice(0).forEach(wake => wake()) // 唤醒所有在等推进的人
  }
  session.frameListeners.push(listener)

  return {
    get last() {
      return state.lastAckSeq
    },
    get ackFrames() {
      return state.ackFrames
    },
    get advances() {
      return state.advances
    },
    // 等到 lastAckSeq 超过 minExclusive（即至少又确认了一个新包），或超时 reject
    waitAdvance(minExclusive, timeout) {
      return new Promise((resolve, reject) => {
        if (state.lastAckSeq > minExclusive) {
          resolve(state.lastAckSeq)
          return
        }
        const onWake = () => {
          if (state.lastAckSeq > minExclusive) {
            cleanup()
            resolve(state.lastAckSeq)
          }
        }
        const cleanup = () => {
          clearTimeout(timer)
          const i = state.waiters.indexOf(onWake)
          if (i >= 0) {
            state.waiters.splice(i, 1)
          }
        }
        const timer = setTimeout(() => {
          cleanup()
          reject(new Error('IMG_ACK_TIMEOUT'))
        }, timeout)
        state.waiters.push(onWake)
      })
    },
    dispose() {
      const i = session.frameListeners.indexOf(listener)
      if (i >= 0) {
        session.frameListeners.splice(i, 1)
      }
    }
  }
}

// 只读投屏关键路径需要的设备核心信息（CMD=0x01），不附带固件版本请求。
async function readTransferInfo(deviceId) {
  const infoAck = await request(deviceId, protocol.CMD.GET_INFO)
  const info = protocol.parseDeviceInfo(infoAck.data)
  // 固件返回的真实 Device_ID(6 字节)登记到会话：即使连接时没带广播序列号（如直连旧 deviceId），
  // 读过一次设备信息后也能被「设备ID×广播ID」交叉匹配认出来。
  // 这一条是**已核实**的身份来源（0x01 从设备真身读回），只有它有资格认领活动会话。
  attachSessionSerial(deviceId, info.deviceId, true)

  return info
}

// 通用设备详情读取：核心信息之外再用 CMD=0x03 补固件号（失败不阻断主流程）。
async function readDeviceInfo(deviceId) {
  const info = await readTransferInfo(deviceId)

  try {
    const swAck = await request(deviceId, protocol.CMD.GET_SW_VER)
    info.firmwareVersion = protocol.parseSwVer(swAck.data)
  } catch (error) {
    info.firmwareVersion = ''
  }

  return info
}

// 单独读电量（CMD=0x04），用于详情页刷新
async function readBattery(deviceId) {
  const ack = await request(deviceId, protocol.CMD.GET_BATTERY)
  return protocol.parseBattery(ack.data)
}

// 设置播放模式/间隔（CMD=0x10）。成功后设备回带最新 IMG_MASK，这里顺带解析出来。
async function setPlayback(deviceId, mode, intervalSeconds) {
  const ack = await request(
    deviceId,
    protocol.CMD.SET_PLAY,
    protocol.buildSetPlaybackPayload(mode, intervalSeconds)
  )
  // 设备拒绝(result≠0)时抛设备结果码的协议含义，避免「设备没设置成功却显示成功」
  if (ack.result !== 0x00) {
    throw new Error(protocol.resultText(ack.result))
  }
  return Object.assign(
    { result: ack.result },
    protocol.parseMaskResult(ack.data)
  )
}

// 读播放配置（CMD=0x02）：播放模式 + 切换间隔
async function getPlayConfig(deviceId) {
  const ack = await request(deviceId, protocol.CMD.GET_PLAY)
  return protocol.parsePlayConfig(ack.data)
}

// 读软件版本（CMD=0x03）：固件号字符串
async function getSwVersion(deviceId) {
  const ack = await request(deviceId, protocol.CMD.GET_SW_VER)
  return protocol.parseSwVer(ack.data)
}

function normalizeConnectionIntervalUnits(units) {
  const value = Number(units)
  if (
    !Number.isInteger(value) ||
    value < protocol.CONN_INTERVAL_MIN_UNITS ||
    value > protocol.CONN_INTERVAL_MAX_UNITS
  ) {
    throw new Error(
      `连接间隔需在 ${protocol.CONN_INTERVAL_MIN_UNITS}~${protocol.CONN_INTERVAL_MAX_UNITS} 之间`
    )
  }
  return value
}

// 读取 BLE 连接间隔（CMD=0x05）。返回 { units, ms }，units 的单位是 1.25ms。
async function getConnectionInterval(deviceId) {
  const ack = await request(deviceId, protocol.CMD.GET_CONN_INTERVAL)
  if (ack.result !== 0x00) {
    // 设备返回什么就提示什么：直接抛设备结果码的协议含义，不加 App 自造前缀
    throw new Error(protocol.resultText(ack.result))
  }
  return protocol.parseConnectionInterval(ack.data)
}

// 设置 BLE 连接间隔（CMD=0x13）。入参是协议原始 units，1 unit = 1.25ms。
// timeout（可选）：透传给 request 的应答超时；不传沿用默认 6s。空闲档回落用 2s，避免老固件不回时白等。
async function setConnectionInterval(deviceId, units, timeout) {
  const value = normalizeConnectionIntervalUnits(units)
  const ack = await request(
    deviceId,
    protocol.CMD.SET_CONN_INTERVAL,
    protocol.buildSetConnectionIntervalPayload(value),
    timeout
  )
  if (ack.result !== 0x00) {
    // 设备返回什么就提示什么：直接抛设备结果码的协议含义，不加 App 自造前缀
    throw new Error(protocol.resultText(ack.result))
  }
  return {
    result: ack.result,
    units: value,
    ms: protocol.connectionIntervalUnitsToMs(value)
  }
}

// 设置 BLE 连接间隔（毫秒便捷入口）。会按 1.25ms 单位四舍五入。timeout（可选）透传给 setConnectionInterval。
async function setConnectionIntervalMs(deviceId, ms, timeout) {
  return setConnectionInterval(
    deviceId,
    protocol.connectionIntervalMsToUnits(ms),
    timeout
  )
}

// 真实投屏图传前要用的连接间隔(ms)：优先用调试页「保存给真实投屏」存下的值，
// 否则用平台默认（安卓/鸿蒙 7.5ms、iOS 及其他 15ms，见 defaultTransferConnIntervalMs）。
function getTransferConnIntervalMs() {
  try {
    const saved = Number(wx.getStorageSync(TRANSFER_CONN_INTERVAL_STORAGE_KEY))
    if (Number.isFinite(saved) && saved > 0) {
      return saved
    }
  } catch (error) {
    // 读存储失败就用默认值
  }
  return defaultTransferConnIntervalMs()
}

// 把真实投屏图传前要用的连接间隔(ms)持久化（调试页「保存给真实投屏」调用）。
// 先按协议 1.25ms 单位归一并校验范围，越界直接抛错，避免把无效值同步给投屏。
// 返回归一后的 { ms, units }，方便调用方回显「实际生效值」。
function setTransferConnIntervalMs(ms) {
  const units = normalizeConnectionIntervalUnits(
    protocol.connectionIntervalMsToUnits(ms)
  )
  const value = protocol.connectionIntervalUnitsToMs(units)
  wx.setStorageSync(TRANSFER_CONN_INTERVAL_STORAGE_KEY, value)
  return { ms: value, units }
}

// 真实投屏图传每包发送间隔(ms)：优先用调试页「保存给真实投屏」存下的值，否则用默认极速 3ms。
// uploadImage 未显式收到 pace 时会调它，让真实投屏跟随调试台调稳的发送速度。
function getTransferPaceMs() {
  try {
    const saved = Number(wx.getStorageSync(TRANSFER_PACE_STORAGE_KEY))
    if (Number.isFinite(saved) && saved >= 0) {
      return saved
    }
  } catch (error) {
    // 读存储失败就用默认值
  }
  return PACKET_PACE_MS
}

// 把真实投屏图传每包发送间隔(ms)持久化（调试页「保存给真实投屏」调用）。
// 归一为非负数后落库，返回实际生效值用于回显。
function setTransferPaceMs(ms) {
  const value = Math.max(0, Number(ms))
  if (!Number.isFinite(value)) {
    throw new Error('发送间隔需为有效毫秒数')
  }
  wx.setStorageSync(TRANSFER_PACE_STORAGE_KEY, value)
  return value
}

// 把窗口包数夹到 [1, TRANSFER_WINDOW_MAX] 的整数，无效值回落默认 10。
function normalizeTransferWindow(n) {
  const value = Math.round(Number(n))
  if (!Number.isFinite(value) || value < 1) {
    return DEFAULT_TRANSFER_WINDOW
  }
  return Math.min(TRANSFER_WINDOW_MAX, value)
}

// 真实投屏图传窗口包数：优先用调试页「保存给真实投屏」存下的值，否则用默认 10。
function getTransferWindow() {
  try {
    const saved = Number(wx.getStorageSync(TRANSFER_WINDOW_STORAGE_KEY))
    if (Number.isFinite(saved) && saved >= 1) {
      return normalizeTransferWindow(saved)
    }
  } catch (error) {
    // 读存储失败就用默认值
  }
  return DEFAULT_TRANSFER_WINDOW
}

// 把真实投屏图传窗口包数持久化（调试页「保存给真实投屏」调用）。夹到 [1, MAX] 后落库，返回实际生效值用于回显。
function setTransferWindow(n) {
  const value = normalizeTransferWindow(n)
  wx.setStorageSync(TRANSFER_WINDOW_STORAGE_KEY, value)
  return value
}

// 图传前的连接参数优化：读当前值，必要时切到更快的连接间隔，并回读验证是否真实生效。
// 未显式传 ms 时，用「保存给真实投屏」存下的值（没同步过则用平台默认：安卓/鸿蒙 7.5ms、iOS 及其他 15ms）。
// 兼容旧固件/异常链路：调用方可捕获错误后继续走原图传逻辑。
//
// 回读探针（性能测量 A 补充，2026-07-10）：0x13 回 result=0 只代表「设备接受了指令」；
// 连接参数更新要由设备向手机系统发起、中心侧批准——iOS 按 Apple 规范常直接拒绝 <15ms 的
// 请求，链路可能仍跑在旧值（真机 trace 曾见「设 7.5ms 成功」但 10 包窗口要 205ms，倒推
// 间隔并未生效）。故设置后稍等参数更新协商完成，再回读 0x05 取「实际生效值」。
// 返回 { changed, previous, requested, current, verified, applied }：
//   changed 表示传前读到的值与目标不同（仅作诊断，不再据此跳过设置）；
//   current 一律是回读到的真实值（回读失败时回落 requested 并置 verified=false）；
//   applied=true 表示回读值与目标一致（真的生效了）。回读失败不影响图传继续。
//
// 无条件下发 0x13（2026-07-13）：曾按「读到的值已等于目标就跳过设置」短路，但 0x05 读回的可能是
// 固件保存的配置值而非链路实时参数——新连接的链路参数由手机侧决定（iOS 常给 30~45ms），此时跳过
// 0x13 就等于整场图传跑在手机默认间隔上（表现为「传一段停一下」、比调试台明显慢）。调试台的
// applyAndVerifyConnInterval 一直是无条件下发，这里与它对齐：每次图传前都设一遍，代价仅一条指令。
async function optimizeConnectionIntervalForTransfer(deviceId, ms) {
  const targetUnits = normalizeConnectionIntervalUnits(
    protocol.connectionIntervalMsToUnits(ms || getTransferConnIntervalMs())
  )
  const previous = await getConnectionInterval(deviceId)
  const changed = previous.units !== targetUnits
  const requested = await setConnectionInterval(deviceId, targetUnits)
  let verifiedRead = null
  try {
    await sleep(300) // 参数更新要走几个连接事件才落定，立刻回读常拿到旧值
    verifiedRead = await getConnectionInterval(deviceId)
  } catch (error) {
    verifiedRead = null // 探针尽力而为：回读失败不影响图传
  }
  return {
    changed,
    previous,
    requested: { units: requested.units, ms: requested.ms },
    current: verifiedRead || { units: requested.units, ms: requested.ms },
    verified: !!verifiedRead,
    applied: !!verifiedRead && verifiedRead.units === targetUnits
  }
}

// 把 BLE 连接间隔回落到空闲省电档（IDLE_CONN_INTERVAL_MS=100ms）：连接建立后、以及每次图传结束后调用，
// 让链路只在真正传图时跑极速档(7.5/15ms)，其余时间用省电的长间隔。best-effort、绝不抛：
//   ⓪ 总开关关闭（当前默认）直接空转——两个调用点都经过这里，关一处即全局失效；
//   ① 未连接直接跳过——不为了设间隔反而触发一次重连（图传失败后设备可能已断开）；
//   ② 旧固件不支持 0x13 / 设备拒绝时吞掉错误，用 2s 短超时防老固件不回时把调用方拖住。
// 注意：图传最后一张的异步刷屏(0x24)期间设备会对新指令回忙(0x0B)，调用方应等刷屏跑完再调本函数，
// 否则这次回落会撞上 0x0B 白白失败（见 result.js 收尾里对 lastRefreshPromise 的链式处理）。
async function applyIdleConnectionInterval(deviceId) {
  // 开关在函数内而不是各调用点：establishConnection 与 result.js 收尾两处都收敛到这里，
  // 挡在这一层就不会有人绕过去，调用方也不必各自判断（保持 best-effort 语义不变，照旧返回 null）。
  if (!idleConnIntervalEnabled()) {
    return null
  }
  if (!isConnected(deviceId)) {
    return null
  }
  try {
    return await setConnectionIntervalMs(
      deviceId,
      IDLE_CONN_INTERVAL_MS,
      IDLE_CONN_INTERVAL_SET_TIMEOUT
    )
  } catch (error) {
    return null
  }
}

// 校时（CMD=0x11）：把手机当前时间（或指定时间）写进设备 RTC
async function setTime(deviceId, date) {
  const ack = await request(
    deviceId,
    protocol.CMD.SET_TIME,
    protocol.buildSetTimePayload(date)
  )
  // 设备拒绝(result≠0)时抛设备结果码的协议含义，避免「校时没成功却显示成功」
  if (ack.result !== 0x00) {
    throw new Error(protocol.resultText(ack.result))
  }
  return { result: ack.result }
}

// 删除图片（CMD=0x12）：传图片索引数组（如 [0,2] 表示删第 0、2 张），内部转成 12 字节掩码。
// 设备返回更新后的 IMG_MASK。
async function deleteImage(deviceId, indexes, timeout) {
  const mask = protocol.indexesToMask(indexes)
  // 删除由设备逐张擦除 flash，张数越多越慢(一键清空可能一次删几十张，设备全部删完才回一次应答)。
  // 按张数放宽代码侧应答等待，避免设备还在删就被判「应答超时」误报「设备暂时无法连接」：
  // 每张按 2s 预算(60 张≈120s)、下限 6s、上限封顶 180s。调用方可传 timeout 显式覆盖。
  // 注意：设备真正返回的超时/错误结果码(result≠0)仍走下方原逻辑抛出，此处只放宽「等不到应答」的超时。
  const count = indexes ? indexes.length : 0
  const waitMs = timeout || Math.min(180000, Math.max(6000, count * 2000))
  const ack = await request(deviceId, protocol.CMD.DELETE_IMG, mask, waitMs)
  // 设备拒绝(result≠0)时抛设备结果码的协议含义，避免「设备没删成功却显示成功」。
  // 同时把原始结果码挂在错误上：上层要放行 0x05/0x07 这类「设备上本来就没这张图」时，
  // 靠 protocol.isSkippableDeleteError 认码，不必再匹配中文文案（prefixDeviceError 只改 message，属性保留）。
  if (ack.result !== 0x00) {
    const error = new Error(protocol.resultText(ack.result))
    error.resultCode = ack.result
    throw error
  }
  return Object.assign(
    { result: ack.result },
    protocol.parseMaskResult(ack.data)
  )
}

// 切换/刷新当前显示（CMD=0x24）：指定要显示的图片索引；0xFF 表示保持不变。
async function refreshScreen(deviceId, index) {
  const value = index === undefined || index === null ? 0xff : index & 0xff
  const ack = await request(deviceId, protocol.CMD.SET_CUR_IMG, [value])
  // 设备拒绝(result≠0)时抛设备结果码的协议含义，避免「切换/刷新没成功却显示成功」
  if (ack.result !== 0x00) {
    throw new Error(protocol.resultText(ack.result))
  }
  return Object.assign(
    { result: ack.result },
    protocol.parseRefreshResult(ack.data)
  )
}

// 上传一张图片（图传协议 6.8：0x20 帧头 → 0x21 窗口分包 + 0x23 累计应答 → 0x22 结束校验）。
// options: { screenType, index, width, height, data(Uint8Array 已转好的六色帧缓存), onProgress(done,total,phase),
//            prepared(可选，prepareImageTransfer 的预处理结果：整图 CRC32 + 预组好的 0x21 帧；
//                     不传或与本次 data/分包对不上时自动回退为现算现组，行为不变) }
// 返回结束应答里的 { result, imgMask, imgCount, storageFree }。任一步失败会 throw。
function finalizeTransferStats(stats) {
  if (!stats.finishedAt) {
    stats.finishedAt = Date.now()
    stats.totalMs = stats.finishedAt - stats.startedAt
  }
  stats.averageWriteMs = stats.writeCalls
    ? Number((stats.writeTotalMs / stats.writeCalls).toFixed(2))
    : 0
  stats.throughputKbps = stats.dataMs
    ? Number((stats.dataSize / 1024 / (stats.dataMs / 1000)).toFixed(2))
    : 0
  return stats
}

async function uploadImage(deviceId, options) {
  const session = await ensureConnection(deviceId)
  const data =
    options.data instanceof Uint8Array
      ? options.data
      : new Uint8Array(options.data)
  const dataSize = data.length
  const stats = {
    traceId: options.traceId || '',
    imageIndex: Number.isFinite(options.imageIndex) ? options.imageIndex : -1,
    startedAt: Date.now(),
    dataSize,
    mtu: session.mtu,
    chunkSize: 0,
    totalPackets: 0,
    window: 0,
    configuredPace: 0,
    finalPace: 0,
    crcMs: 0,
    startAckMs: 0,
    dataMs: 0,
    endAckMs: 0,
    ackWaitMs: 0,
    ackFrames: 0,
    ackAdvances: 0,
    ackTimeouts: 0,
    ackGraceWaits: 0, // 「先宽限再等一次」的次数：设备只是慢，没到丢包
    minWindow: 0, // 自适应过程中退到过的最小窗口
    finalWindow: 0, // 收尾时的窗口（与配置窗口一对比就知道设备实际吃得下多少）
    retryEvents: 0,
    sentPackets: 0,
    retransmittedPackets: 0,
    confirmedPackets: 0,
    writeCalls: 0,
    writeFailures: 0,
    writeTotalMs: 0,
    writeMaxMs: 0,
    success: false
  }
  const onProgress =
    typeof options.onProgress === 'function'
      ? options.onProgress
      : function () {}
  // 中止钩子：返回 true 时立即停止图传（页面在息屏/切后台时会让它返回 true）。
  // 图传在后台无法继续（蓝牙被挂起、设备 1s 超时会自行中止），所以及时干净地停掉，给出清晰提示。
  const shouldAbort =
    typeof options.shouldAbort === 'function'
      ? options.shouldAbort
      : function () {
          return false
        }

  // 预取阶段的预处理结果（prepareImageTransfer，性能优化 D1/D2）：数据长度对得上才认，
  // 防止上层把别张图的 prepared 传错进来（CRC32/帧都会错，设备端 0x22 校验必失败）。
  const prepared =
    options.prepared && options.prepared.dataSize === dataSize
      ? options.prepared
      : null

  try {
    // 1) 0x20 帧头：告诉设备屏幕类型/索引/宽高/数据大小/整图 CRC32，等设备点头后再发数据。
    // D2：预取阶段已算好整图 CRC32 则直接复用，0x20 前不再同步扫一遍整图（5.89 寸 326KB）。
    const crcStartedAt = Date.now()
    const crc32 =
      prepared && Number.isFinite(prepared.crc32)
        ? prepared.crc32
        : imageCodec.crc32Mpeg2(data)
    stats.crcMs = Date.now() - crcStartedAt
    stats.crcPrecomputed = !!(prepared && Number.isFinite(prepared.crc32))
    const startAckStartedAt = Date.now()
    let startAck
    try {
      startAck = await request(
        deviceId,
        protocol.CMD.IMG_START,
        protocol.buildImgStartPayload({
          screenType: options.screenType,
          index: options.index,
          width: options.width,
          height: options.height,
          format: 0x01,
          dataSize,
          crc32
        }),
        10000
      )
    } finally {
      stats.startAckMs = Date.now() - startAckStartedAt
    }
    if (startAck.result !== 0x00) {
      throw new Error(protocol.resultText(startAck.result))
    }

    // 2) 0x21 数据：按协商 MTU 分包，以累计 ACK 驱动滑动窗口。
    // options.chunkSize 只有调试台会传（试设备侧新支持的 489 字节）；真实投屏不传，用会话值。
    const CHUNK = effectiveChunkSize(session, options.chunkSize)
    const WINDOW = normalizeTransferWindow(
      Number.isFinite(options.window) ? options.window : getTransferWindow()
    )
    const pace = Number.isFinite(options.pace)
      ? Math.max(0, options.pace)
      : getTransferPaceMs()
    const totalPackets = Math.ceil(dataSize / CHUNK)
    stats.chunkSize = CHUNK
    stats.totalPackets = totalPackets
    stats.window = WINDOW
    stats.configuredPace = pace
    stats.finalPace = pace

    // D1：预取阶段按会话分包大小预组好的全部 0x21 帧，分包/帧数对得上才用（会话重建后 MTU
    // 可能变化）；没有或对不上（调试页直调、首张预取早于连接）则发送时逐包现组——
    // buildImgDataFrame 用整块 set + 查表 CRC16，现组也比旧的逐字节 push 版快得多。
    const prebuiltFrames =
      prepared &&
      prepared.chunkSize === CHUNK &&
      prepared.frames &&
      prepared.frames.length === totalPackets
        ? prepared.frames
        : null
    stats.prebuiltFrames = !!prebuiltFrames

    let nextSeq = 0
    let highestSeqSent = -1
    let retries = 0
    // 调速策略：真实投屏走 legacy（原样不动），只有调试台传 adaptive:true 才启用新的 AIMD。
    const pacer = options.adaptive
      ? createAdaptivePacer(WINDOW, pace)
      : createLegacyPacer(WINDOW, pace)
    stats.adaptive = !!options.adaptive
    stats.minWindow = WINDOW
    stats.finalWindow = WINDOW
    // 同一卡点是否已用过一次「宽限等待」（仅 adaptive）：先多等一轮再判丢包，别把「慢」当成「丢」
    let graceUsed = false
    onProgress(0, totalPackets, 'start')

    const tracker = createAckTracker(session)
    const dataStartedAt = Date.now()
    try {
      while (tracker.last < totalPackets - 1) {
        if (shouldAbort()) {
          throw new Error('UPLOAD_ABORTED')
        }

        const window = pacer.windowFor(retries)
        const sendPace = pacer.paceFor(retries)
        const snapshot = pacer.state()
        stats.finalPace = snapshot.pace
        stats.finalWindow = snapshot.window
        stats.minWindow = snapshot.minWindow

        while (nextSeq < totalPackets && nextSeq - tracker.last - 1 < window) {
          if (shouldAbort()) {
            throw new Error('UPLOAD_ABORTED')
          }
          const seq = nextSeq
          const frameValue = prebuiltFrames
            ? prebuiltFrames[seq]
            : protocol.buildImgDataFrame(data, seq, CHUNK)
          await writePacket(session, frameValue, stats)
          stats.sentPackets++
          if (seq <= highestSeqSent) {
            stats.retransmittedPackets++
          }
          highestSeqSent = Math.max(highestSeqSent, seq)
          nextSeq++
          const moreThisRound =
            nextSeq < totalPackets && nextSeq - tracker.last - 1 < window
          if (sendPace > 0 && moreThisRound) {
            await sleep(sendPace)
          }
        }

        // 尾包 ACK 可能已在最后一次 write 的回调返回前到达，先复查，避免完成后再空等一轮超时。
        if (tracker.last >= totalPackets - 1) {
          break
        }

        const before = tracker.last
        const ackWaitStartedAt = Date.now()
        let waitError = null
        try {
          await tracker.waitAdvance(before, pacer.ackTimeout(graceUsed))
        } catch (error) {
          waitError = error
        } finally {
          stats.ackWaitMs += Date.now() - ackWaitStartedAt
        }

        if (waitError) {
          // 超时回调和通知可能同时发生；重发前再复查一次，已推进就直接继续填窗。
          if (tracker.last > before) {
            retries = 0
            graceUsed = false
            stats.confirmedPackets = Math.min(tracker.last + 1, totalPackets)
            onProgress(stats.confirmedPackets, totalPackets, 'data')
            continue
          }
          // adaptive：第一次超时先宽限等一轮。设备只是慢时整窗重发只会把它压得更死（重发的包同样
          // 要排队，而它还没消化完上一批）；真丢包也只多等一个超时，远小于误判后反复整窗重发的代价。
          if (pacer.grace && !graceUsed) {
            graceUsed = true
            stats.ackGraceWaits++
            continue
          }
          stats.ackTimeouts++
          stats.retryEvents++
          if (++retries > MAX_ACK_RETRIES) {
            const now = pacer.state()
            throw new Error(
              `图传中断：电子纸设备停在已接收第 ${tracker.last} 包不再前进` +
                (options.adaptive
                  ? `（已自动退让到窗口 ${now.window} 包 / 每包间隔 ${now.pace}ms 仍无推进）`
                  : '') +
                `。可能电子纸设备忙或处理不过来。当前 MTU=${session.mtu}、每包 ${CHUNK} 字节`
            )
          }
          pacer.onTimeout()
          const after = pacer.state()
          stats.minWindow = after.minWindow
          onProgress(
            Math.min(tracker.last + 1, totalPackets),
            totalPackets,
            'retry',
            {
              stuckAt: tracker.last,
              retries,
              window: after.window,
              pace: after.pace
            }
          )
          nextSeq = tracker.last + 1
          graceUsed = false
          await sleep(Math.min(150, 50 * retries))
          continue
        }

        pacer.onClean(Date.now() - ackWaitStartedAt, retries)
        graceUsed = false
        retries = 0
        stats.confirmedPackets = Math.min(tracker.last + 1, totalPackets)
        onProgress(stats.confirmedPackets, totalPackets, 'data')
      }
      stats.confirmedPackets = totalPackets
      const finalState = pacer.state()
      stats.finalPace = finalState.pace
      stats.finalWindow = finalState.window
      stats.minWindow = finalState.minWindow
    } finally {
      stats.dataMs = Date.now() - dataStartedAt
      stats.ackFrames = tracker.ackFrames
      stats.ackAdvances = tracker.advances
      tracker.dispose()
    }

    // 3) 0x22 结束：设备核对总长度与整图 CRC32，写入 Flash 并更新 IMG_MASK。
    const endAckStartedAt = Date.now()
    let endAck
    try {
      endAck = await request(deviceId, protocol.CMD.IMG_END, [], 20000)
    } finally {
      stats.endAckMs = Date.now() - endAckStartedAt
    }
    if (endAck.result !== 0x00) {
      throw new Error(protocol.resultText(endAck.result))
    }
    stats.success = true
    const summary = Object.assign(
      { result: endAck.result },
      protocol.parseImgEndResult(endAck.data)
    )
    summary.transferStats = finalizeTransferStats(stats)
    onProgress(stats.totalPackets, stats.totalPackets, 'done')
    return summary
  } catch (error) {
    const failure =
      error instanceof Error
        ? error
        : new Error((error && error.message) || '电子纸设备图传失败')
    stats.error = failure.message
    failure.transferStats = finalizeTransferStats(stats)
    throw failure
  }
}

// 是否已与该设备建立可用的 BLE 会话（用于首页等真实展示「已连接/未连接」，不再恒为已连接）。
// 本设备是「即连即传」模型：投屏时才连接、传完即断，所以多数时候为未连接是真实状态。
function isConnected(deviceId) {
  const session = sessions[deviceId]
  return !!(session && session.ready)
}

// 是否存在任意一条可用的 BLE 会话。自动重连据此判断「当前是否已连着设备」，已连着就不再扫描重连。
function hasAnyActiveConnection() {
  return Object.keys(sessions).some(id => sessions[id] && sessions[id].ready)
}

// 列出当前小程序持有的所有可用 BLE 会话（调试页「小程序连接状态」模块用）。
// 设备是单连接：真实投屏/绑定流程结束若没断开，残留会话会在这里出现——它正占着设备，
// 导致再次扫描搜不到 / 连不上。返回每条会话的关键信息，供页面展示并据此判断是否需要释放。
function getActiveConnections() {
  return Object.keys(sessions)
    .filter(id => sessions[id] && sessions[id].ready)
    .map(id => {
      const session = sessions[id]
      return {
        deviceId: id,
        serviceId: session.serviceId,
        // 已登记的稳定序列号（广播/固件 Device_ID）：active-device 据此把「丢了 deviceId 的设备记录」
        // 与活动会话交叉匹配，认出「其实还连着」的设备
        serials: (session.serials || []).slice(),
        // 其中经 0x01 GET_INFO 核实过的那部分。认领会话/回写身份只认这一份——
        // 广播 ID 自 2026-08-04 起也有 6 字节，长度不再能证明它是可信身份（见 attachSessionSerial）。
        verifiedSerials: (session.verifiedSerials || []).slice(),
        // 广播登记的屏幕类型：active-device 交叉匹配时据此按型号/尺寸再校验，防串到不同型号设备
        screenType: session.screenType || 0,
        mtu: session.mtu,
        dataChunk: session.dataChunk,
        writeType: session.writeType,
        pendingCount: Object.keys(session.pending || {}).length
      }
    })
}

// ── 调试台专用的传输参数（真实投屏不调用，调用了也不改变它的行为）──────────────────
//
// renegotiateMtu：按给定值重新协商 MTU 并立刻写回会话，返回实际生效值。安卓 setBLEMTU 可在
// 连接存活期间重协商，所以调试台改完输入框即时生效，不必断开重连；iOS 不支持手动设置，
// 这里会拿回系统协商的实际值（多为 185），调用方据此就知道「这台机子顶不上去」。
// ⚠️ 只改 session.mtu（链路能力），session.dataChunk 仍按 236 上限重算：真实投屏读的是 dataChunk，
//    因此调试台把 MTU 顶到 500 之后即便会话被真实投屏复用，它的分包大小也照旧是 ≤236。
async function renegotiateMtu(deviceId, requestedMtu) {
  const session = sessions[deviceId]
  if (!session || !session.ready) {
    throw new Error('设备未连接')
  }
  const mtu = await negotiateMtu(deviceId, requestedMtu)
  session.mtu = mtu
  session.dataChunk = chunkFromMtu(mtu)
  return { mtu, dataChunk: session.dataChunk }
}

// 给定「想要的每包数据字节数」，返回本条会话实际会用的值（与 uploadImage 内部同一套夹取规则）。
// 调试台用它在真正开传前算准包数/回显，不必等传完看 transferStats。
function getEffectiveChunkSize(deviceId, requested) {
  return effectiveChunkSize(sessions[deviceId], requested)
}

// 断开并清理当前小程序持有的全部 BLE 会话，释放被占用的设备（让它重新广播，能再次被搜索/连接）。
// 返回被断开的 deviceId 列表，方便调用方提示「释放了几个连接」。
function disconnectAll() {
  const ids = Object.keys(sessions)
  ids.forEach(id => disconnect(id))
  return ids
}

// 单连接：释放除 keepDeviceId 之外的全部会话，返回被释放的 deviceId 列表。
//
// 为什么必须有这个：设备是单连接（PRD 6.2.3），残留会话会一直占着那台相框，而相框被占用时
// **不再广播** —— 于是它此后在任何页面都搜不到，用户看到的是「这台相框坏了」，只能杀掉小程序。
// getActiveConnections 头上的注释早就描述了这个故障，但此前只能靠调试页手动「断开全部」兜底。
//
// 注意此前的形状：establishConnection 的**失败**路径严格执行了释放（见其 catch），
// **成功**路径反而没有任何释放策略 —— 缺的就是这里。
function disconnectOthers(keepDeviceId) {
  const ids = Object.keys(sessions).filter(id => id !== keepDeviceId)
  ids.forEach(id => disconnect(id))
  return ids
}

// 断开连接并清理会话（离开详情/绑定页时调用）
function disconnect(deviceId) {
  cleanupSession(deviceId, '已主动断开连接')
  if (wx.closeBLEConnection && deviceId) {
    wx.closeBLEConnection({ deviceId })
  }
}

// 回前台/唤醒时的「连接体检」：微信在后台（尤其鸿蒙 HarmonyOS）会挂起蓝牙，断开时 onBLEConnectionStateChange
// 未必补发断开事件——内存会话可能仍 ready=true 而底层其实已断。此时 isConnected() 会谎报「已连接」，导致：
//   ① 首页/详情页显示「已连接」实为假象；
//   ② 下次操作走 ensureConnection 见 ready=true 直接复用这条死会话、不再重连，指令全部写失败/超时。
// 这里对账真实连接、把已断的会话清掉，使 isConnected() 恢复如实：页面据此显示「未连接」，用户下次点操作时
// 才会重新走一次真正的连接。不主动重连——连接保持「按需手动」（用户点「连接蓝牙」按钮时才连）。
// 判定：① 适配器打不开（后台被关了蓝牙 / 蓝牙异常）→ 所持会话必然全断，全部清理；
//      ② 适配器可用 → 用系统「已连接设备」列表比对，不在列表里的会话判为已断并清理。
// 全程静默、不抛错；查询失败时保守「不动会话」（避免误清一条其实还活着的连接），留待下次操作时真实校验。
async function reconcileConnections() {
  const ids = Object.keys(sessions).filter(id => sessions[id] && sessions[id].ready)
  if (!ids.length) {
    return [] // 没有任何会话，无需体检（零开销，冷启动/无连接时直接返回）
  }

  // ① 适配器不可用 = 用户在后台关了蓝牙 / 蓝牙异常：所持会话必然已断，全部清掉
  if (wx.openBluetoothAdapter) {
    try {
      await wxp(wx.openBluetoothAdapter, {})
    } catch (error) {
      ids.forEach(id => cleanupSession(id, '蓝牙不可用，连接已断开'))
      return ids.slice()
    }
  }

  // ② 适配器可用：用系统「已连接设备」列表对账
  const services = Array.from(
    new Set(ids.map(id => sessions[id].serviceId).filter(Boolean))
  )
  if (!wx.getConnectedBluetoothDevices || !services.length) {
    return [] // 老基础库不支持查询 / 无可用服务过滤：保守不动，留待下次操作时真实校验
  }
  let alive
  try {
    const res = await wxp(wx.getConnectedBluetoothDevices, { services })
    alive = new Set((res.devices || []).map(d => d.deviceId))
  } catch (error) {
    return [] // 查询失败保守不动，避免误清活着的连接
  }
  const dropped = []
  ids.forEach(id => {
    if (!alive.has(id)) {
      cleanupSession(id, '回前台检测到连接已断开')
      dropped.push(id)
    }
  })
  return dropped
}

// 给「设备返回 / 蓝牙链路」类错误统一加「设备-」前缀，便于和接口错误(「接口-」)区分。
// 幂等：已带「接口-」「设备-」前缀，或为纯大写下划线的内部控制信号(如 UPLOAD_ABORTED/IMG_ACK_TIMEOUT) 时原样返回。
function prefixDeviceError(error) {
  const e =
    error instanceof Error
      ? error
      : new Error((error && error.message) || '电子纸设备操作失败')
  const msg = e.message || '电子纸设备操作失败'
  if (/^(?:接口-|设备-|电子纸设备-)/.test(msg) || /^[A-Z][A-Z0-9_]*$/.test(msg)) {
    return e
  }
  e.message = '电子纸设备-' + msg
  return e
}

// 包裹设备方法：同步抛出或 Promise 拒绝的错误都补上「设备-」前缀
function wrapDevice(fn) {
  return function () {
    const args = Array.prototype.slice.call(arguments)
    let ret
    try {
      ret = fn.apply(this, args)
    } catch (error) {
      throw prefixDeviceError(error)
    }
    if (ret && typeof ret.then === 'function') {
      return ret.then(undefined, error => {
        throw prefixDeviceError(error)
      })
    }
    return ret
  }
}

module.exports = {
  ensureConnection,
  request,
  readTransferInfo,
  readDeviceInfo,
  readBattery,
  setPlayback,
  getPlayConfig,
  getSwVersion,
  getConnectionInterval,
  setConnectionInterval,
  setConnectionIntervalMs,
  optimizeConnectionIntervalForTransfer,
  applyIdleConnectionInterval,
  getTransferConnIntervalMs,
  setTransferConnIntervalMs,
  defaultTransferConnIntervalMs, // 平台默认(安卓/鸿蒙 7.5ms、iOS 及其他 15ms)：调试台用它做「最快」默认值
  getTransferPaceMs,
  setTransferPaceMs,
  getTransferWindow,
  setTransferWindow,
  // 调试台专用（真实投屏不调用）：重协商 MTU / 预算每包数据字节数
  renegotiateMtu,
  getEffectiveChunkSize,
  effectiveChunkSize, // 纯函数版（入参 {mtu,dataChunk}），供单测直接验分包夹取规则
  chunkFromMtu,
  IMG_DATA_CHUNK_MAX,
  MTU_REQUEST_DEFAULT,
  TRANSFER_WINDOW_MAX,
  setTime,
  deleteImage,
  refreshScreen,
  prepareImageTransfer,
  uploadImage,
  setMonitor,
  isConnected,
  hasAnyActiveConnection,
  getActiveConnections,
  disconnectAll,
  disconnectOthers,
  disconnect,
  reconcileConnections
}

// 统一给会真正和设备/蓝牙交互的异步方法加「设备-」错误前缀（同步只读方法 isConnected 等不需要）
;[
  'ensureConnection',
  'request',
  'readTransferInfo',
  'readDeviceInfo',
  'readBattery',
  'setPlayback',
  'getPlayConfig',
  'getSwVersion',
  'getConnectionInterval',
  'setConnectionInterval',
  'setConnectionIntervalMs',
  'optimizeConnectionIntervalForTransfer',
  'renegotiateMtu',
  'setTime',
  'deleteImage',
  'refreshScreen',
  'uploadImage'
].forEach(name => {
  if (typeof module.exports[name] === 'function') {
    module.exports[name] = wrapDevice(module.exports[name])
  }
})
