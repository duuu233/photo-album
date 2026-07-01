# OTA / DFU 升级问题排查与修复进度

> 记录日期：2026-06-30（2026-07-01 更新）
> 状态：**修复已实施（`utils/ota-ble.js`），待真机联调验证**
> 入口页面：`subpackages/device/detail/detail` →（长按 OTA 升级 / 跳转）→ `subpackages/device/ota/ota`
> 核心协议实现：`utils/ota-ble.js`
> 规格书来源：`/home/pg/dh/电子相框产品需求规格书1.4.pdf` 第 6.3.2 / 6.3.3 节

---

## 1. 问题现象

OTA 升级失败。线上日志（**注意：这份日志来自一个"多次尝试版"的 ota 代码，当前 git 仓库里没有这份代码，工作区是干净的**）：

```
[OTA] 特征列表：
  FF11 {notify, write, writeNoResponse}
  FF12 {notify, write, writeNoResponse}
  FF13 {notify, write, writeNoResponse}

[OTA] START 尝试：{target:"control"(FF11), writeType:"writeNoResponse", objType:0x00,
                   frame:"F1 00 54 59 02 00 A0"}
[OTA] START 尝试失败：OTA 启动被拒绝：设备返回错误码 0xfc

[OTA] START 应答超时（target=altControl(FF13), writeType=writeNoResponse, objType=0x01,
       service=FF10, control=FF11, data=FF12, altControl=FF13,
       notify=FF11|FF12|FF13）
```

START 帧 `F1 00 54 59 02 00 A0` 解析（校验过，无误）：
- `F1` = START opcode
- `00` = OBJ_TYPE（固件对象）
- `54 59 02 00` = FW_SIZE 小端 = `0x00025954` = 153,940 字节（在合法范围内）
- `A0` = 累加校验（`F1+00+54+59+02+00 = 0x1A0 & 0xFF = 0xA0` ✓）

帧本身完全正确。设备**收到并主动回应**了（不是没反应）。

---

## 2. 根因（已通过规格书 + 时序图双重确认）

### **`0xFC` 不是错误码，而是 OTA 应答帧的「帧头」（RSP_OPCODE）。**

规格书 §6.3.2 OpCode 表：

| OpCode | 值 | 方向 | 含义 |
|--------|-----|------|------|
| START | `0xF1` | APP→设备 | 开始 OTA，携带对象类型 + 固件大小 |
| DATA | `0xF2` | APP→设备 | 固件数据分片 |
| END | `0xF3` | 设备→APP | 设备收满后自动校验，返回最终结果（APP 不主动发 END） |
| **ACK** | **`0xFC`** | **设备→APP** | **START / DATA 的应答帧头** |

设备对 START 的**正常成功**回复其实是：`FC F1 00 FB 03 <CHK>`
（帧头 0xFC，回显 0xF1，RESULT=0x00 成功，MTU=251=0xFB，PRN=3）。

App 把回包的帧头 `0xFC` 当成"错误码"丢掉/误报了。**设备一直在正常接受 START，问题 100% 在 App 端解析。**

两条日志因此都说得通：
- **FF11 + objType=0** → 设备回了 `FC..` 帧，代码不认识 `0xFC` 帧头 → 误报"错误码 0xfc"（实际 `RESULT` 在第 3 字节，很可能是 0x00 成功）。
- **FF13 + objType=1** → FF13 不是控制点，应答仍走 FF11 的 Notify，等在 FF13 上自然超时。**objType 不是问题，0x00 已能拿到应答；FF11 才是控制特征。**

---

## 3. 规格书里的真实帧格式（§6.3.3，权威参考）

**所有 APP→设备 请求末尾都有 1 字节 CHECKSUM = 前面所有字节累加和的低 8 位。**
**OTA 直接在 `0xFF11` 特征上收发，不使用图传那套 `0xAA` 应用层帧格式。**

### START 请求（APP→设备）
```
F1  OBJ_TYPE  FW_SIZE(4,小端)  CHECKSUM
↑   ↑         ↑                ↑
opcode 对象类型 固件大小          前6字节累加和
      (固件对象) 范围0x3000~0x3C000
```

### START 应答（设备→APP，6 字节）
```
偏移:  0     1     2       3     4     5
      FC    F1   RESULT   MTU   PRN  CHECKSUM
      帧头  回显  结果码   251    3   (前5字节累加和)
     RSP_  OPCODE
    OPCODE
```

### DATA 请求（APP→设备）
```
F2  PKT_INDEX(2,小端)  DATA(可变)  CHECKSUM
```
（与当前代码 `buildDataFrame` 一致，✓ 无误）

### DATA 应答（设备→APP，6 字节）
```
偏移:  0     1     2        3-4              5
      FC    F2   RESULT   PKT_INDEX(2,小端)  CHECKSUM
                          已处理的最后包序号
```
设备每累计收到 PRN=3 个 DATA 包后回一次 ACK。

### END / 最终结果（设备→APP）
```
F3  ...  RESULT  CHECKSUM
```
> ⚠️ 待确认：时序图显示 `0xF3` 后面还跟了一个字节（标作 OPCODE=0x01）再到 RESULT。
> 修复时先按 `RESULT = bytes[2]` 处理并加注释，等真机抓一帧确认。

### OTA 结果码表（§6.3.2，**与图传的 0x7F 通用应答码表不同！**）
| 码 | 含义 |
|----|------|
| `0x00` | 成功 |
| `0x01` | 校验 / 芯片信息错误 |
| `0x02` | ACK 超时 |
| `0x03` | 主机主动终止 |
| `0x04` | 设备主动终止 |
| `0x05` | 设备状态错误 |
| `0x06` | 不支持的 opcode |
| `0x07` | 资源不足 |
| `0x08` | 固件大小超限 |
| `0x09` | 参数错误 |

### 其它已确认无误的点
- 服务 `FF10`，控制+数据同一特征 `FF11`（writeNoResponse + Notify）。
- 固件大小范围 `0x3000 ~ 0x3C000`，小端。
- MTU=251（GATT 实际可用 244 字节），PRN=3 信用窗口。
- 超时红线：APP 超过 1 秒没收到应答、或设备超过 1 秒没收到下一包 → 判定传输中断。

---

## 4. `utils/ota-ble.js` 里遗漏 / 写错的地方（待修复清单）

1. **缺 `0xFC` 应答帧头**（`OP` 定义，约 ota-ble.js:29-33）。
   `dispatchNotification`（约 :231）用 `bytes[0]` 去匹配 `0xF1/0xF2/0xF3`。真实应答 `bytes[0]=0xFC` 不命中任何分支 → 通知被整帧忽略 → `startWaiter` 永不 resolve → **START 应答超时**。
   **改法**：识别 `bytes[0]===0xFC`，再用 `bytes[1]`（`0xF1`/`0xF2`）区分 START-ACK / DATA-ACK。

2. **`parseStartAck` 偏移全错**（约 ota-ble.js:178）。
   现在：`result=bytes[1]`、`mtu=readUint16LE(bytes,2)`、`prn=bytes[4]`。
   应为：`result=bytes[2]`、`mtu=bytes[3]`（**单字节**=251）、`prn=bytes[4]`。
   （`bytes[1]` 是回显的 `0xF1`，不是结果。）

3. **`parseDataAckSeq` 偏移错**（约 ota-ble.js:193）。
   现在：`readUint16LE(bytes,1)`。
   应为：`readUint16LE(bytes,3)`（前面隔着 `FC F2 RESULT`）。

4. **`OTA_RESULT_TEXT` 用错了表**（约 ota-ble.js:44-54）。
   现在抄的是图传 `0x7F` 通用应答码表（0x01参数错误/0x02长度错误/0x03 CRC错误/0x04 Flash写入失败/0x05版本不兼容/0x0b设备忙…）。
   应替换为上面第 3 节的 **OTA 结果码表**。

> 对得上、**不用改**的：START 请求组帧、DATA 请求组帧、固件大小范围、PRN 窗口、FF10/FF11 服务发现与开 Notify。
> **唯一硬伤就是对设备应答帧（`0xFC` 帧头）的识别与解析 + 结果码表。**

---

## 5. 待确认 / 决策点（明天先定这两条）

1. **改哪份代码？** 线上跑的是"多次尝试版"（日志里有 `特征列表`/`START 尝试`/`altControl`、区分 control/data/altControl），**这份不在当前 git 仓库里**（工作区干净，grep 不到这些字符串）。
   - 选项 A：直接改仓库里的 `utils/ota-ble.js`（按第 4 节方案）。
   - 选项 B：把线上那份"多次尝试版"贴出来 / 告诉路径，改那一份。
   - ⚠️ 如果只改仓库这份，而线上跑的是另一份，改动不会影响线上现象。

2. **END(`0xF3`) 帧里 RESULT 的偏移**：`bytes[1]` 还是 `bytes[2]`？规格书表述含糊，时序图疑似 `F3` 后多一字节。先按 `bytes[2]` 实现 + 注释，真机抓一帧确认。

---

## 6. 参考 / 复现

- 规格书 PDF：`/home/pg/dh/电子相框产品需求规格书1.4.pdf`（36 页，CID 字体，Latin 部分有字形替换，中文可读）。
- PDF 文本提取脚本（自建，纯 Python，无需 poppler）：解压所有 stream → 合并 bfchar/bfrange 建 CID→Unicode 表 → 解 TJ/Tj 取文。Latin 字形是替换码，需对照上下文还原。本次关键协议值已用「字段表 + 时序图」双向交叉验证，可信。
- 关键页：含 `0xFC`/`RSAQS`(START)/`DASA`(DATA)/`QERTKS`(RESULT) 的几页即 §6.3.2~6.3.3。

---

## 7. 下一步（TL;DR）

1. ✅ 已确认改哪份代码：**仓库里的 `utils/ota-ble.js` 现在就是线上"多次尝试版"**（含 `buildStartAttempts`/`altControl`、以及日志里那条 `target=..., service=..., control=..., data=..., altControl=..., notify=...` 的超时报错串，逐字对得上）。§5.1 决策点关闭。
2. ✅ 已按第 4 节改完 4 处（见第 8 节）。`node --check` 通过；离线用真实应答帧 `FC F1 00 FB 03` 跑通解析单测。
3. ⏳ **真机联调**：抓 START 应答（应为 `FC F1 00 FB 03 EB`）、DATA 应答（`FC F2 00 <seq2>`）、END 帧，确认 §5.2 的 `0xF3` RESULT 偏移。

---

## 8. 本次修复记录（2026-07-01）

### 现象为何从"错误码 0xfc"变成了"应答超时"
上次记录后，代码被打了半个补丁：`dispatchNotification` 已经会在等 START 应答时把帧交给 `parseStartAck`，
但 `parseStartAck` 仍旧不认识 `FC F1 00 FB 03` 这套布局（把 `0xFC` 当结果码、把 MTU 当 2 字节小端读），
于是判定 `valid=false` → 整帧被 `console.warn('忽略…')` 丢掉 → `startWaiter` 永不 resolve → **START 应答超时**。
设备一直在正常应答，问题 100% 仍在 App 端解析。根因与第 2 节完全一致。

### `utils/ota-ble.js` 实际改动（4 处 + 2 处配套）
1. **加 `OP.ACK = 0xFC`** 常量（应答帧头/RSP_OPCODE）。
2. **`dispatchNotification` 改用回显操作码路由**：`echo = bytes[0]===0xFC ? bytes[1] : bytes[0]`，
   再按 `echo` 分派 START(`0xF1`)/DATA(`0xF2`)/RESULT(`0xF3`)。兼容旧固件"不带 0xFC 帧头"。
3. **`parseStartAck` 重写为固定偏移**：跳过 `0xFC`、跳过回显的 `0xF1`，取 `RESULT / MTU(单字节) / PRN`；
   MTU/PRN 越界回落 0（由 `applyStartAck` 用默认值兜底）。删除原先猜偏移的 candidates 逻辑。
4. **`parseDataAckSeq` 偏移** `1 → 3`（`FC F2 RESULT SEQ`，兼容旧固件偏移 1）。
5. **`parseResult`** 兼容 `0xFC` 包裹（`F3` 前若有帧头则偏移 +1）；`0xF3` 后 RESULT 精确偏移仍待真机确认。
6. **`OTA_RESULT_TEXT` 换成规格书 §6.3.2 的 OTA 专用码表**（原先误用图传 `0x7F` 通用码表）。

> START 请求组帧 / DATA 请求组帧 / 固件大小范围 / PRN 窗口 / FF10-FF11 服务发现与开 Notify —— 均未改动（本就无误）。

---

## 9. 第二处修复：DATA 写错特征（2026-07-01，真机验证 START 后发现）

### 现象
第 8 节修好后真机复测：**START 成功了**（应答 `FC F1 00 FB 03 EB` → `{result:0, mtu:251, prn:3, valid:true}`），
但数据传输阶段报：`OTA 中断：设备停在已接收第 -1 包不再前进（共 631 包）。当前 MTU=500、每包 244 字节`。
`lastAckSeq` 始终是初始值 `-1` = 15 次重试里设备**一个 DATA ACK 都没回**。

### 根因
`transferData` 把 DATA 帧**硬编码写到 `target='data'`**（`session.dataCharId`）。本机同时暴露了 FF11/FF12/FF13，
于是 `dataChar` = **FF12**，631 个数据包全写到了 FF12。但本机 OTA 只在 **FF11** 上收发
（START 就是写 FF11、并在 FF11 的 Notify 上拿到应答的；规格书 §6.3.3 / 记忆均确认 FF11 单特征收发）。
数据进了 FF12，设备的 OTA 处理器根本没收到 → 永不回 DATA ACK → 卡在 -1。
（MTU=500 是协商到的 ATT MTU；每包 244 由设备声明的 251 正确算得，均无问题。）

### 改动（`utils/ota-ble.js`）
- `doStart` 握手成功时记录 `session.transferTarget` / `session.transferWriteType` = **START 成功的那条特征/写类型**。
- `transferData` 的 DATA 写入从 `'data'` 改为 `session.transferTarget || 'control'`，写类型沿用 START 的。
- 结果：DATA 与 START 走同一条 FF11。对「真·双特征(FF12=data)」设备也成立——它 START 会在哪应答、DATA 就跟到哪。

### 仍待真机确认
1. 换 FF11 后设备是否按 PRN=3 正常回 DATA ACK（`FC F2 00 <seq2>`）、`lastAckSeq` 正常前进。
2. 收齐后的 `0xF3` 最终结果帧，顺带定 §5.2 的 RESULT 偏移。
3. 若仍卡住，再查：发包节奏 `pace`(默认20ms)/PRN 窗口是否过快、每包 244 是否需按固件要求改定长。

---

## 10. 第三处修复：尾包死循环 + 断连误判失败（2026-07-01，真机跑到 97% 后发现）

> ⚠️ **本节的"软成功"方案（`confirmed:false`/`rebooted` 不抛错、提示核对版本）已被第 11 节推翻**：
> 固件方澄清收满 + CRC 无误必回 `0xF3`，故拿不到 `0xF3` 是真失败。以下"绝不重发尾包 / 返回 confirmed:false"
> 的描述仅作存档，**当前代码以第 11 节为准**。

### 现象
第 9 节修好后真机复测：**数据能传了**，一路到 **97%**（共 631 包，已确认到第 629 包），
然后反复"补发数据（设备停留在第 629 包）第 N 次尝试"，第 7 次后底部提示 **"设备连接已断开"**、判为升级失败。

### 根因（两个叠加）
1. **尾包永远等不到 DATA ACK**：631 包里 0~629 正好凑成 210 组整 PRN(=3)、每组都有 ACK；
   但**第 630 包是落单的残组**，设备"每收满 3 包才回一次 ACK"，于是永远不会为第 630 包单独回 ACK——
   它要等**收满整个固件大小**后直接回 `0xF3`。原代码把"等不到 ACK"当停滞，**一遍遍重发第 630 包**。
2. **重发尾包把设备喂爆**：设备其实已收满，重发的残包让其累计字节数**超过固件大小** → 设备判错 → **主动断开**。
   而断开在传输循环里是致命错误直接上抛 → 报"升级失败"。

### 改动（`utils/ota-ble.js` + `subpackages/device/ota/ota.js`）
- `transferData`：发送窗口一旦把**最后一包发出**（`windowEnd >= totalPackets`）就**跳出发送循环**，
  改去 `waitFinalResult` 等 `0xF3`/设备重启，**绝不重发尾包**。
- `transferData`：数据 100% 发完后若设备**断开**（而非返回错误码），视为"已写入并重启进入新固件"，
  返回 `{ confirmed:false, rebooted:true }` 而不是抛错。收到真正的 `0xF3` 成功码则返回 `{ confirmed:true }`。
  （校验超时等"设备静默/数据不完整"的非断连错误仍照常报错。）
- `ota.js`：`confirmed:false` 时 UI 如实提示"数据已发送，设备重启中，请确认固件版本"，不谎报"升级完成"。

### 真机复测要点
- 进度到 100% 后，理想是收到 `0xF3`（`confirmed:true`，提示"升级完成"）。
- 若设备直接重启断连（`confirmed:false`），提示"请确认固件版本"——到设备端看版本号是否已更新即可判定成功与否；
  顺带抓一帧 `0xF3` 定 §5.2 的 RESULT 偏移。

---

## 11. 第四处修复：固件澄清「0xF3 必达」→ 尾包超时改判真失败 + 受控重发（2026-07-01，固件方澄清后）

### 固件方澄清（权威）
> 现固件在 OTA 最后传输完成时会应答，回复 `0xF3`；**应答完约 2s 后才自动复位重启**。固件不记录升级次数/版本，
> **只要 OTA 传输完毕、验证 CRC32 无误就必回 `0xF3`**。

### 结论：推翻第 10 节的"软成功"
- `0xF3` 是「权威且必达」的成功信号：收满 + CRC 无误 → 必回 `0xF3` → 回完才 2s 后重启。
- 故每次 99% "等待校验结果超时" **不是**"已成功只是没回"，而是**尾包没送达 / 设备没收满**（没算 CRC、没回 `0xF3`）——**是真失败**。
- 第 10 节"数据发完却收不到 0xF3 就当软成功 `confirmed:false`"的判断**错误**，改回**判失败**。

### 改动（`utils/ota-ble.js` `transferData` 收尾段 + `ota.js` / `detail.js`）
- 发完尾包后进入**受控尾包重发循环**：`waitFinalResult(tailWait=3s)` 等 `0xF3`——
  - 等到 → 成功（再看 `final.result` 区分成功/校验失败）；
  - 等不到 → 尾包丢了，从 `session.lastAckSeq+1` 重发到末包再等，`maxTailResends=4`、总期限 `finalDeadline=15s`。
- **只在等够 3s（远大于 CRC 耗时）仍无 `0xF3` 才重发**：设备若已收满必已回 `0xF3` → 不会触发重发 → 不会喂过量（规避第 10 节把设备喂爆的老坑）。
- 回 `0xF3` 前断开 / 超出重发上限或总期限 → **抛错判失败**（不再返回 `confirmed:false` 软成功）。
- `ota.js` / `detail.js` 的 `confirmed:false` 分支降级为**兜底死路**，文案由"请核对版本"改为 **"未确认(请重试)"**。

### 待真机验证
- 能否真收到 `FC F3 00 <CHK>`（顺带定 §5.2 的 RESULT 偏移）。
- 固件对"重发已收尾包(重复 seq)"的容忍度——若重发重复包会报错，需改为只重发真正缺失的那一包。
