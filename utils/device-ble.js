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
  return String(uuid || '').toUpperCase().replace(/-/g, '').slice(4, 8)
}

function matchUuid(uuid, shortCode) {
  return short16(uuid) === shortCode
}

function wxp(fn, options) {
  return new Promise((resolve, reject) => {
    fn(Object.assign({}, options, {
      success: resolve,
      fail: error => reject(new Error((error && error.errMsg) || '蓝牙操作失败'))
    }))
  })
}

// 全局只注册一次特征值变化监听，按 deviceId 分发到对应会话
function ensureGlobalListener() {
  if (globalListenerBound || !wx.onBLECharacteristicValueChange) {
    return
  }
  globalListenerBound = true
  wx.onBLECharacteristicValueChange(res => {
    const session = sessions[res.deviceId]
    if (!session) {
      return
    }
    handleNotify(session, res.value)
  })
}

// 处理一次通知数据：追加到接收缓冲，循环解出完整帧并派发给等待中的请求
function handleNotify(session, value) {
  session.rxBuffer = session.rxBuffer.concat(protocol.toBytes(value))

  // 可能粘包/分包：从头不断尝试解帧，解出一帧就消费掉对应字节
  while (session.rxBuffer.length) {
    const parsed = protocol.tryParseFrame(session.rxBuffer)
    if (!parsed) {
      break
    }
    const rawBytes = session.rxBuffer.slice(0, parsed.consumed) // 整帧原始字节，给监听器打日志
    session.rxBuffer = session.rxBuffer.slice(parsed.consumed)

    const frame = parsed.frame
    reportFrame('RX', session.deviceId, frame.cmd, rawBytes, frame.crcOk ? '' : 'CRC校验失败')

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

// 建立连接并发现 FF00 主服务下的写(FF01)/通知(FF02)特征，开启通知。结果缓存到会话。
async function ensureConnection(deviceId) {
  if (sessions[deviceId] && sessions[deviceId].ready) {
    return sessions[deviceId]
  }

  ensureGlobalListener()
  await wxp(wx.createBLEConnection, { deviceId, timeout: 10000 })

  const servicesRes = await wxp(wx.getBLEDeviceServices, { deviceId })
  const service = (servicesRes.services || []).find(s => matchUuid(s.uuid, protocol.SERVICE_UUID))
  if (!service) {
    throw new Error('未找到相框主服务(FF00)，请确认是相框设备')
  }

  const charsRes = await wxp(wx.getBLEDeviceCharacteristics, { deviceId, serviceId: service.uuid })
  const chars = charsRes.characteristics || []
  const writeChar = chars.find(c => matchUuid(c.uuid, protocol.CHAR_WRITE_UUID))
  const notifyChar = chars.find(c => matchUuid(c.uuid, protocol.CHAR_NOTIFY_UUID))
  if (!writeChar || !notifyChar) {
    throw new Error('未找到读写特征(FF01/FF02)')
  }

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
    ready: true
  }
  sessions[deviceId] = session
  return session
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
  await wxp(wx.writeBLECharacteristicValue, {
    deviceId,
    serviceId: session.serviceId,
    characteristicId: session.writeCharId,
    value
  })

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

// 裸写一帧（默认写类型，由特征支持的属性决定——本设备 FF01 为无应答写）。
async function writeFrame(session, cmd, payload) {
  const value = protocol.buildFrame(cmd, payload)
  reportFrame('TX', session.deviceId, cmd, value)
  await wxp(wx.writeBLECharacteristicValue, {
    deviceId: session.deviceId,
    serviceId: session.serviceId,
    characteristicId: session.writeCharId,
    value
  })
}

// 写一个图传数据包，带「缓冲忙就退避重试」：写失败(常见 writeValueToCharacteristics error 是缓冲暂满)
// 不立刻判死，稍等再试，几次都不行才抛出。
async function writePacket(session, seq, chunk) {
  let attempt = 0
  for (;;) {
    try {
      await writeFrame(session, protocol.CMD.IMG_DATA, protocol.buildImgDataPayload(seq, chunk))
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
  const ack = await request(deviceId, protocol.CMD.SET_PLAY, protocol.buildSetPlaybackPayload(mode, intervalSeconds))
  return Object.assign({ result: ack.result }, protocol.parseMaskResult(ack.data))
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

// 校时（CMD=0x11）：把手机当前时间（或指定时间）写进设备 RTC
async function setTime(deviceId, date) {
  const ack = await request(deviceId, protocol.CMD.SET_TIME, protocol.buildSetTimePayload(date))
  return { result: ack.result }
}

// 删除图片（CMD=0x12）：传图片索引数组（如 [0,2] 表示删第 0、2 张），内部转成 12 字节掩码。
// 设备返回更新后的 IMG_MASK。
async function deleteImage(deviceId, indexes) {
  const mask = protocol.indexesToMask(indexes)
  const ack = await request(deviceId, protocol.CMD.DELETE_IMG, mask)
  return Object.assign({ result: ack.result }, protocol.parseMaskResult(ack.data))
}

// 切换/刷新当前显示（CMD=0x24）：指定要显示的图片索引；0xFF 表示保持不变。
async function refreshScreen(deviceId, index) {
  const value = index === undefined || index === null ? 0xff : index & 0xff
  const ack = await request(deviceId, protocol.CMD.SET_CUR_IMG, [value])
  return Object.assign({ result: ack.result }, protocol.parseRefreshResult(ack.data))
}

// 上传一张图片（图传协议 6.8：0x20 帧头 → 0x21 窗口分包 + 0x23 累计应答 → 0x22 结束校验）。
// options: { screenType, index, width, height, data(Uint8Array 已转好的六色帧缓存), onProgress(done,total,phase) }
// 返回结束应答里的 { result, imgMask, imgCount, storageFree }。任一步失败会 throw。
async function uploadImage(deviceId, options) {
  const session = await ensureConnection(deviceId)
  const data = options.data instanceof Uint8Array ? options.data : new Uint8Array(options.data)
  const dataSize = data.length
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : function () {}
  // 中止钩子：返回 true 时立即停止图传（页面在息屏/切后台时会让它返回 true）。
  // 图传在后台无法继续（蓝牙被挂起、设备 1s 超时会自行中止），所以及时干净地停掉，给出清晰提示。
  const shouldAbort = typeof options.shouldAbort === 'function' ? options.shouldAbort : function () { return false }

  // 1) 0x20 帧头：告诉设备屏幕类型/索引/宽高/数据大小/整图 CRC32，等设备点头(RESULT=0x00)再发数据。
  const crc32 = imageCodec.crc32Mpeg2(data)
  const startAck = await request(deviceId, protocol.CMD.IMG_START, protocol.buildImgStartPayload({
    screenType: options.screenType,
    index: options.index,
    width: options.width,
    height: options.height,
    format: 0x01,
    dataSize,
    crc32
  }), 10000)
  if (startAck.result !== 0x00) {
    throw new Error(`帧头被拒绝(0x20)：${protocol.resultText(startAck.result)}`)
  }

  // 2) 0x21 数据：每片大小按协商到的 MTU 决定（上限 236）；窗口 5 包，发满 5 包等一次 0x23(ACK_SEQ)。
  const CHUNK = session.dataChunk || 236
  const WINDOW = 5
  // 每包发送间隔(ms)：可由调用方传 pace 调速；越小越快，但太小设备会跟不上而丢包/卡住。默认走保守值。
  const pace = Number.isFinite(options.pace) ? Math.max(0, options.pace) : PACKET_PACE_MS
  const windowPause = Math.max(10, pace) // 窗口之间的停顿，至少 10ms，随 pace 调整
  const totalPackets = Math.ceil(dataSize / CHUNK)
  let nextSeq = 0 // 下一个要发送的包号（= 已确认的最后包号 + 1）
  let retries = 0 // 同一窗口的重试次数，连续失败则判定连接中断
  onProgress(0, totalPackets, 'start')

  const tracker = createAckTracker(session)
  try {
    while (nextSeq < totalPackets) {
      if (shouldAbort()) {
        throw new Error('UPLOAD_ABORTED') // 息屏/切后台：立即停，避免在后台空转后报含糊错误
      }
      const windowEnd = Math.min(nextSeq + WINDOW, totalPackets)
      // 逐包发送：每包之间留 PACKET_PACE_MS 间隔做流控，避免冲爆发送缓冲导致写失败/丢包。
      for (let seq = nextSeq; seq < windowEnd; seq++) {
        const chunk = data.subarray(seq * CHUNK, Math.min((seq + 1) * CHUNK, dataSize))
        await writePacket(session, seq, chunk)
        if (pace > 0) {
          await sleep(pace)
        }
      }

      // 等设备的 0x23 把「已连续接收包号」推过 nextSeq-1（= 至少又确认了一个新包）
      try {
        await tracker.waitAdvance(nextSeq - 1, 2500)
      } catch (error) {
        // 超时没等到推进：设备多半在忙/落盘没收下这窗。退避(等更久)再重发，给它时间恢复。
        if (++retries > 15) {
          throw new Error(`图传中断：设备停在已接收第 ${tracker.last} 包不再前进。可能设备忙或处理不过来。当前 MTU=${session.mtu}、每包 ${CHUNK} 字节`)
        }
        await sleep(Math.min(1500, 250 * retries)) // 指数退避：第1次250ms，逐次加长，最多1.5s
        continue
      }

      nextSeq = tracker.last + 1 // 推进到设备已确认的下一个包
      retries = 0
      onProgress(Math.min(nextSeq, totalPackets), totalPackets, 'data')
      await sleep(windowPause) // 窗口间停顿，给设备落盘/处理留时间
    }
  } finally {
    tracker.dispose() // 无论成功失败都摘掉常驻监听器
  }

  // 3) 0x22 结束：设备核对总长度与整图 CRC32，写入 Flash 并更新 IMG_MASK。
  // 大图算整图 CRC32 + 落盘可能要好几秒，这里给足 20s 等待，避免误判超时。
  const endAck = await request(deviceId, protocol.CMD.IMG_END, [], 20000)
  if (endAck.result !== 0x00) {
    throw new Error(`结束校验失败(0x22)：${protocol.resultText(endAck.result)}`)
  }
  const summary = Object.assign({ result: endAck.result }, protocol.parseImgEndResult(endAck.data))
  onProgress(totalPackets, totalPackets, 'done')
  return summary
}

// 断开连接并清理会话（离开详情/绑定页时调用）
function disconnect(deviceId) {
  const session = sessions[deviceId]
  if (session) {
    Object.keys(session.pending).forEach(key => {
      clearTimeout(session.pending[key].timer)
    })
    delete sessions[deviceId]
  }
  if (wx.closeBLEConnection && deviceId) {
    wx.closeBLEConnection({ deviceId })
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
  setTime,
  deleteImage,
  refreshScreen,
  uploadImage,
  setMonitor,
  disconnect
}
