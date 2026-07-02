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

function setMonitor(fn) {
  monitor = typeof fn === 'function' ? fn : null
}

// 向监听器上报一帧收发记录。dir: 'TX' 发送 / 'RX' 接收；cmd: 命令字；bytes: 整帧原始字节。
function reportFrame(dir, deviceId, cmd, bytes, note) {
  if (!monitor) {
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

// 微信返回的 UUID 是 128 位全大写串（如 0000FF01-0000-...），只取其中的 16 位短码做匹配
function short16(uuid) {
  return String(uuid || '')
    .toUpperCase()
    .replace(/-/g, '')
    .slice(4, 8)
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
        cleanupSession(res.deviceId, '设备连接已断开')
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

// 协商 MTU（一次能传多少字节）。这是图传能否成功的关键：
//   数据包整帧 = SOF+CMD+LEN(2)+PKT_SEQ(2)+DATA+CRC(2) = DATA + 8 字节固定开销，
//   而蓝牙单次可写 = MTU - 3（ATT 头），整帧必须塞得下，否则会被静默丢弃 → 图传卡死。
// 安卓默认 MTU 常只有 23，必须主动调大；iOS 由系统自动协商（setBLEMTU 会失败，忽略即可）。
async function negotiateMtu(deviceId) {
  let mtu = 0

  // 安卓：把 MTU 顶到协议设计值 247；成功会返回实际协商到的值
  if (wx.setBLEMTU) {
    try {
      const res = await wxp(wx.setBLEMTU, { deviceId, mtu: 247 })
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
      const res = await wxp(wx.getBLEMTU, { deviceId, writeType: 'write' })
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

// 由 MTU 推算每个图片数据包能装多少字节（上限 236，见 6.8.2）。
// 必须保证「整帧(=chunk+8) ≤ 单次可写(=MTU-3)」，否则数据包会被静默丢弃导致图传卡死。
function chunkFromMtu(mtu) {
  const writable = (mtu || 185) - 3 // 单次可写 = MTU - 3
  const maxFrame = Math.min(writable, 244) // 协议整帧上限 244
  return Math.min(236, Math.max(1, maxFrame - 8)) // 减 8 字节固定开销
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

// 建立底层 BLE 连接，带一次自动重试。安卓首连常偶发 10003(connection fail)/10012(操作超时)，
// 立即重试一次通常即可成功；若底层报「已连接」则直接当成功返回。多次失败才抛出供上层提示。
async function createConnectionWithRetry(deviceId, attempts = 2) {
  let lastError = null
  for (let i = 0; i < attempts; i++) {
    try {
      await wxp(wx.createBLEConnection, { deviceId, timeout: 10000 })
      return
    } catch (error) {
      const msg = ((error && error.message) || '').toLowerCase()
      // 底层仍保有该连接：当成功处理，后续照常发现服务/特征
      if (msg.indexOf('already') > -1 || msg.indexOf('connected') > -1) {
        return
      }
      lastError = error
      if (i < attempts - 1) {
        // 关掉可能残留的半连接，短暂等待后再试一次，显著提升首连成功率
        if (wx.closeBLEConnection) {
          try {
            await wxp(wx.closeBLEConnection, { deviceId })
          } catch (closeError) {
            // 没有可关闭的连接，忽略
          }
        }
        await sleep(400)
      }
    }
  }
  throw lastError || new Error('蓝牙连接失败')
}

// 建立连接并发现 FF00 主服务下的写(FF01)/通知(FF02)特征，开启通知。结果缓存到会话。
// 已连上直接复用；正在连则复用在途 Promise（避免并发重复连接），否则发起一次新连接。
async function ensureConnection(deviceId) {
  if (sessions[deviceId] && sessions[deviceId].ready) {
    return sessions[deviceId]
  }
  if (connecting[deviceId]) {
    return connecting[deviceId]
  }
  const promise = establishConnection(deviceId)
  connecting[deviceId] = promise
  try {
    return await promise
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
          ? '设备只暴露 OTA 服务(FF10)，未发现相框主服务(FF00)'
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
      mtu, // 协商到的 MTU
      dataChunk: chunkFromMtu(mtu), // 每个图片数据包可装的字节数
      // 实测指定有应答写(write)会报 10007「特征不支持此操作」，与 PRD「FF01: Write Without Response」一致——
      // 这台设备只能用无应答写。无应答写不可靠(可能被手机/链路悄悄丢)，只能靠应用层窗口 ACK 重传兜底。
      writeType: 'writeNoResponse',
      ready: true
    }
    sessions[deviceId] = session
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
    throw new Error(`指令 0x${cmd.toString(16)} 正在等待应答`)
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

  return ackPromise
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// 图传数据包之间的发送间隔（毫秒）。FF01 用「无应答写」，写得太快有两个后果：
//   1) 把手机蓝牙发送缓冲冲爆 → writeValueToCharacteristics error；
//   2) 设备端（BLE 收包 + 写 Flash）跟不上 → 收一阵就不再前进（ACK_SEQ 卡住）。
// 留足间隔让两边都喘得过气。先求稳（值偏大），联调通了再往小调提速。
const PACKET_PACE_MS = 45
// 图传前尝试把 BLE 连接间隔调到此值（默认 7.5ms / CONN_INTERVAL=6，即协议最小值，最快连接节奏）。失败时不阻断旧图传链路。
// 调试页「同步投屏」会把输入框的值写进下面这个存储键；真实投屏图传前优先读它，没同步过则回落默认 7.5ms。
const TRANSFER_CONN_INTERVAL_MS = 7.5
const TRANSFER_CONN_INTERVAL_STORAGE_KEY = 'transferConnIntervalMs'

// 裸写一帧（默认写类型，由特征支持的属性决定——本设备 FF01 为无应答写）。
async function writeFrame(session, cmd, payload, writeType) {
  const value = protocol.buildFrame(cmd, payload)
  reportFrame('TX', session.deviceId, cmd, value)
  const params = {
    deviceId: session.deviceId,
    serviceId: session.serviceId,
    characteristicId: session.writeCharId,
    value
  }
  if (writeType) {
    params.writeType = writeType // 'write' 有应答(可靠) / 'writeNoResponse' 无应答(快但可能丢)
  }
  await wxp(wx.writeBLECharacteristicValue, params)
}

// 写一个图传数据包，带「缓冲忙就退避重试」：写失败(常见 writeValueToCharacteristics error 是缓冲暂满)
// 不立刻判死，稍等再试，几次都不行才抛出。
async function writePacket(session, seq, chunk) {
  let attempt = 0
  for (;;) {
    try {
      await writeFrame(
        session,
        protocol.CMD.IMG_DATA,
        protocol.buildImgDataPayload(seq, chunk),
        session.writeType
      )
      return
    } catch (error) {
      if (++attempt > 4) {
        throw error
      }
      await sleep(80) // 发送缓冲可能暂时满，等一下再写
    }
  }
}

// 整个图传期间挂一个常驻监听器，持续记录设备回报的「已连续接收最后包号」的最大值。
// 用「取最大值 + 等待推进」的方式，天然兼容重复/迟到/乱序的 0x23 应答，比一次性等单帧更稳。
function createAckTracker(session) {
  const state = { lastAckSeq: -1, waiters: [] }

  const listener = frame => {
    if (frame.cmd !== protocol.CMD.IMG_ACK || !frame.crcOk) {
      return
    }
    const seq = protocol.parseImgAck(frame.payload).ackSeq
    if (seq > state.lastAckSeq) {
      state.lastAckSeq = seq
    }
    state.waiters.splice(0).forEach(wake => wake()) // 唤醒所有在等推进的人
  }
  session.frameListeners.push(listener)

  return {
    get last() {
      return state.lastAckSeq
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

// 读设备信息：CMD=0x01 拿核心信息，再用 CMD=0x03 补固件号（固件失败不阻断主流程）
async function readDeviceInfo(deviceId) {
  const infoAck = await request(deviceId, protocol.CMD.GET_INFO)
  const info = protocol.parseDeviceInfo(infoAck.data)

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
async function setConnectionInterval(deviceId, units) {
  const value = normalizeConnectionIntervalUnits(units)
  const ack = await request(
    deviceId,
    protocol.CMD.SET_CONN_INTERVAL,
    protocol.buildSetConnectionIntervalPayload(value)
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

// 设置 BLE 连接间隔（毫秒便捷入口）。会按 1.25ms 单位四舍五入。
async function setConnectionIntervalMs(deviceId, ms) {
  return setConnectionInterval(
    deviceId,
    protocol.connectionIntervalMsToUnits(ms)
  )
}

// 真实投屏图传前要用的连接间隔(ms)：优先用调试页「同步投屏」存下的值，否则用默认 7.5ms。
function getTransferConnIntervalMs() {
  try {
    const saved = Number(wx.getStorageSync(TRANSFER_CONN_INTERVAL_STORAGE_KEY))
    if (Number.isFinite(saved) && saved > 0) {
      return saved
    }
  } catch (error) {
    // 读存储失败就用默认值
  }
  return TRANSFER_CONN_INTERVAL_MS
}

// 把真实投屏图传前要用的连接间隔(ms)持久化（调试页「同步投屏」调用）。
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

// 图传前的连接参数优化：读当前值，必要时切到更快的连接间隔。
// 未显式传 ms 时，用「同步投屏」存下的值（没同步过则默认 7.5ms）。
// 兼容旧固件/异常链路：调用方可捕获错误后继续走原图传逻辑。
async function optimizeConnectionIntervalForTransfer(deviceId, ms) {
  const targetUnits = normalizeConnectionIntervalUnits(
    protocol.connectionIntervalMsToUnits(ms || getTransferConnIntervalMs())
  )
  const previous = await getConnectionInterval(deviceId)
  if (previous.units === targetUnits) {
    return {
      changed: false,
      previous,
      current: previous
    }
  }
  const current = await setConnectionInterval(deviceId, targetUnits)
  return {
    changed: true,
    previous,
    current
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
async function deleteImage(deviceId, indexes) {
  const mask = protocol.indexesToMask(indexes)
  const ack = await request(deviceId, protocol.CMD.DELETE_IMG, mask)
  // 设备拒绝(result≠0)时抛设备结果码的协议含义，避免「设备没删成功却显示成功」
  if (ack.result !== 0x00) {
    throw new Error(protocol.resultText(ack.result))
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
// options: { screenType, index, width, height, data(Uint8Array 已转好的六色帧缓存), onProgress(done,total,phase) }
// 返回结束应答里的 { result, imgMask, imgCount, storageFree }。任一步失败会 throw。
async function uploadImage(deviceId, options) {
  const session = await ensureConnection(deviceId)
  const data =
    options.data instanceof Uint8Array
      ? options.data
      : new Uint8Array(options.data)
  const dataSize = data.length
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

  // 1) 0x20 帧头：告诉设备屏幕类型/索引/宽高/数据大小/整图 CRC32，等设备点头(RESULT=0x00)再发数据。
  const crc32 = imageCodec.crc32Mpeg2(data)
  const startAck = await request(
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
  if (startAck.result !== 0x00) {
    // 设备返回什么就提示什么：直接抛设备结果码的协议含义，不加 App 自造前缀
    throw new Error(protocol.resultText(startAck.result))
  }

  // 2) 0x21 数据：每片大小按协商到的 MTU 决定（上限 236）；窗口 5 包，发满 5 包等一次 0x23(ACK_SEQ)。
  const CHUNK = session.dataChunk || 236
  const WINDOW = 5
  // 每包发送间隔(ms)：可由调用方传 pace 调速；越小越快，但太小设备会跟不上而丢包/卡住。默认走保守值。
  const pace = Number.isFinite(options.pace)
    ? Math.max(0, options.pace)
    : PACKET_PACE_MS
  const totalPackets = Math.ceil(dataSize / CHUNK)
  let nextSeq = 0 // 下一个要发送的包号（= 已确认的最后包号 + 1）
  let retries = 0 // 同一窗口的重试次数，连续失败则判定连接中断
  // 窗口之间的停顿必须「小」：PRD 6.4.1 规定「设备超过 1 秒没收到下一包数据即判定传输中断」，
  // 所以图传期间要持续快速喂数据，窗口之间绝不能长时间停顿，否则设备会单方面中止本次传输。
  const windowPause = Math.max(10, pace)
  onProgress(0, totalPackets, 'start')

  const tracker = createAckTracker(session)
  try {
    while (nextSeq < totalPackets) {
      if (shouldAbort()) {
        throw new Error('UPLOAD_ABORTED') // 息屏/切后台：立即停，避免在后台空转后报含糊错误
      }
      // 卡住后主动「收敛」：每多重试一次，窗口就缩小一包（最终降到 1 包）、每包间隔就拉大一截。
      // 很多固件只接收「按序的下一个包」、且 Flash 落盘期间会丢掉来不及处理的包；于是次待收包反复在设备
      // 忙时抵达被丢，ACK_SEQ 就永远停在它前一个不动。缩窗+减速能让这个待收包在设备空闲时「单独」抵达，
      // 打破死结。初次发送(retries===0)完全不受影响，正常速度不变。
      const burst = retries === 0 ? WINDOW : Math.max(1, WINDOW - retries)
      const sendPace = retries === 0 ? pace : Math.min(150, pace + 30 * retries)
      const windowEnd = Math.min(nextSeq + burst, totalPackets)
      // 逐包发送：每包之间留间隔做流控，避免冲爆发送缓冲导致写失败/丢包。
      for (let seq = nextSeq; seq < windowEnd; seq++) {
        const chunk = data.subarray(
          seq * CHUNK,
          Math.min((seq + 1) * CHUNK, dataSize)
        )
        await writePacket(session, seq, chunk)
        if (sendPace > 0) {
          await sleep(sendPace)
        }
      }

      // 等设备的 0x23 把「已连续接收包号」推过 nextSeq-1（= 至少又确认了一个新包）。
      // 超时必须 < 1s（PRD 6.4.1）：等不到 ACK 就尽快补发数据，赶在设备 1 秒接收超时前喂上；
      // 否则设备会判定传输中断、清掉会话，之后再怎么重发都收不进，ACK_SEQ 会永远停住。
      try {
        await tracker.waitAdvance(nextSeq - 1, 600)
      } catch (error) {
        // 没等到推进：可能丢包或 ACK 迟到。立刻（极短退避）重发，务必赶在设备 1s 超时前把数据送到。
        if (++retries > 15) {
          throw new Error(
            `图传中断：设备停在已接收第 ${tracker.last} 包不再前进。可能设备忙或处理不过来。当前 MTU=${session.mtu}、每包 ${CHUNK} 字节`
          )
        }
        // 把卡顿实况抛给页面：停在第几包(stuckAt)、第几次重发。便于判断是「设备中断(stuckAt 死住不动)」
        // 还是「链路慢(stuckAt 缓慢推进)」——这是向硬件提问时最关键的证据。
        onProgress(Math.min(nextSeq, totalPackets), totalPackets, 'retry', {
          stuckAt: tracker.last,
          retries
        })
        await sleep(Math.min(150, 50 * retries)) // 极短退避(≤150ms)：保证「等待+退避」远小于设备 1s 超时
        continue
      }

      nextSeq = tracker.last + 1 // 推进到设备已确认的下一个包
      retries = 0
      onProgress(Math.min(nextSeq, totalPackets), totalPackets, 'data')
      await sleep(windowPause) // 窗口间小停顿（必须远小于 1s，见 6.4.1，否则设备会判定中断）
    }
  } finally {
    tracker.dispose() // 无论成功失败都摘掉常驻监听器
  }

  // 3) 0x22 结束：设备核对总长度与整图 CRC32，写入 Flash 并更新 IMG_MASK。
  // 大图算整图 CRC32 + 落盘可能要好几秒，这里给足 20s 等待，避免误判超时。
  const endAck = await request(deviceId, protocol.CMD.IMG_END, [], 20000)
  if (endAck.result !== 0x00) {
    // 设备返回什么就提示什么：直接抛设备结果码的协议含义，不加 App 自造前缀
    throw new Error(protocol.resultText(endAck.result))
  }
  const summary = Object.assign(
    { result: endAck.result },
    protocol.parseImgEndResult(endAck.data)
  )
  onProgress(totalPackets, totalPackets, 'done')
  return summary
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
        mtu: session.mtu,
        dataChunk: session.dataChunk,
        writeType: session.writeType,
        pendingCount: Object.keys(session.pending || {}).length
      }
    })
}

// 断开并清理当前小程序持有的全部 BLE 会话，释放被占用的设备（让它重新广播，能再次被搜索/连接）。
// 返回被断开的 deviceId 列表，方便调用方提示「释放了几个连接」。
function disconnectAll() {
  const ids = Object.keys(sessions)
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

// 给「设备返回 / 蓝牙链路」类错误统一加「设备-」前缀，便于和接口错误(「接口-」)区分。
// 幂等：已带「接口-」「设备-」前缀，或为纯大写下划线的内部控制信号(如 UPLOAD_ABORTED/IMG_ACK_TIMEOUT) 时原样返回。
function prefixDeviceError(error) {
  const e =
    error instanceof Error
      ? error
      : new Error((error && error.message) || '设备操作失败')
  const msg = e.message || '设备操作失败'
  if (/^接口-|^设备-/.test(msg) || /^[A-Z][A-Z0-9_]*$/.test(msg)) {
    return e
  }
  e.message = '设备-' + msg
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
  readDeviceInfo,
  readBattery,
  setPlayback,
  getPlayConfig,
  getSwVersion,
  getConnectionInterval,
  setConnectionInterval,
  setConnectionIntervalMs,
  optimizeConnectionIntervalForTransfer,
  getTransferConnIntervalMs,
  setTransferConnIntervalMs,
  setTime,
  deleteImage,
  refreshScreen,
  uploadImage,
  setMonitor,
  isConnected,
  hasAnyActiveConnection,
  getActiveConnections,
  disconnectAll,
  disconnect
}

// 统一给会真正和设备/蓝牙交互的异步方法加「设备-」错误前缀（同步只读方法 isConnected 等不需要）
;[
  'ensureConnection',
  'request',
  'readDeviceInfo',
  'readBattery',
  'setPlayback',
  'getPlayConfig',
  'getSwVersion',
  'getConnectionInterval',
  'setConnectionInterval',
  'setConnectionIntervalMs',
  'optimizeConnectionIntervalForTransfer',
  'setTime',
  'deleteImage',
  'refreshScreen',
  'uploadImage'
].forEach(name => {
  if (typeof module.exports[name] === 'function') {
    module.exports[name] = wrapDevice(module.exports[name])
  }
})
