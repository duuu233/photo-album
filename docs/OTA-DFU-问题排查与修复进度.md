# OTA / DFU 升级问题排查与修复进度

> 记录日期：2026-06-30
> 状态：**根因已定位，待实施修复**
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

## 7. 明天的下一步（TL;DR）

1. 确认改哪份 ota 代码（第 5.1 条）。
2. 按第 4 节改 4 处：加 `0xFC` 帧头识别、修 `parseStartAck`、修 `parseDataAckSeq`、换 OTA 结果码表。
3. 真机联调：抓 START 应答（应为 `FC F1 00 FB 03 ..`）、DATA 应答、END 帧，顺手确认第 5.2 条 END 偏移。
