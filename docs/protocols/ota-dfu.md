# OTA / DFU 协议

> 状态：current  
> 最后核对：2026-07-28  
> 适用范围：`utils/ota-ble.js`、`subpackages/device/ota/ota.js`  
> 权威来源：设备 OTA 规格书 §6.3.2 / §6.3.3 与固件方澄清

## GATT

- 服务：`FF10`
- 控制与数据特征：`FF11`
- `FF11` 同时承担 `writeNoResponse` 和 Notify。
- OTA 不使用普通设备协议的 `0xAA` 应用层帧格式。

## OpCode

| OpCode | 值 | 方向 | 含义 |
| --- | --- | --- | --- |
| START | `0xF1` | APP → 设备 | 开始 OTA，携带对象类型和固件大小 |
| DATA | `0xF2` | APP → 设备 | 固件数据分片 |
| END | `0xF3` | 设备 → APP | 收满并完成 CRC 校验后的最终结果；APP 不主动发送 |
| ACK | `0xFC` | 设备 → APP | START/DATA 应答帧头，不是错误码 |

所有 APP → 设备请求最后一字节为前面所有字节累加和的低 8 位。

## 帧格式

```text
START 请求
F1 OBJ_TYPE FW_SIZE(4, little-endian) CHECKSUM

START 应答
FC F1 RESULT MTU PRN CHECKSUM

DATA 请求
F2 PKT_INDEX(2, little-endian) DATA... CHECKSUM

DATA 应答
FC F2 RESULT PKT_INDEX(2, little-endian) CHECKSUM

最终结果
F3 ... RESULT CHECKSUM
```

当前规格参数：

- 固件大小范围：`0x3000 ~ 0x3C000`
- MTU：251，GATT 实际数据约 244 字节
- PRN：3，即每累计三包 DATA 返回一次 ACK
- APP 或设备超过约 1 秒未收到预期数据/应答，应按中断处理

## 结果码

| 码 | 含义 |
| --- | --- |
| `0x00` | 成功 |
| `0x01` | 校验或芯片信息错误 |
| `0x02` | ACK 超时 |
| `0x03` | 主机主动终止 |
| `0x04` | 设备主动终止 |
| `0x05` | 设备状态错误 |
| `0x06` | 不支持的 opcode |
| `0x07` | 资源不足 |
| `0x08` | 固件大小超限 |
| `0x09` | 参数错误 |

这套结果码与普通图传 `0x7F` 通用应答码表不同。

## 尾包与成功判定

- 固件方确认：收满全部数据且 CRC32 正确时必回 `0xF3`，约 2 秒后才重启。
- 因此没有收到 `0xF3` 不能判“软成功”。
- 最后不足 PRN 的残组可能没有 DATA ACK，应进入最终结果等待，而不是立即无限重发尾包。
- 当前策略是在等待窗口内未收到 `0xF3` 时，从最后确认包之后受控重发，受最大次数和总期限限制。
- 收到 `0xF3` 前断开、超过重发次数或总期限都判失败。

## 尚需真机确认

- 最终 `0xF3` 实际帧中 RESULT 的确切偏移。
- 固件对重复尾包序号的容忍行为。
- 不同手机平台的 MTU、Notify 时序和断连行为。

## 历史来源

- [OTA/DFU 排障与修复记录](../archive/incidents/OTA-DFU-问题排查与修复进度.md)

