# 图片投屏流水线

> 状态：current  
> 最后核对：2026-07-28  
> 适用范围：微信小程序投屏、再次投屏、AI 图片投屏  
> 当前实现：`subpackages/projection/preview/preview.js`、`subpackages/projection/result/result.js`、`utils/dithering.js`、`utils/device-ble.js`

## 当前主链路

```text
选择图片 / AI 图片
  → 预览页按设备比例构图
  → 导出设备物理分辨率图片
  → 结果页确认目标设备完整身份并读取 0x01
  → 两路网络任务并行
      ├─ seekink 抖动接口：设备分辨率图片 → 六色 4bpp frame bin
      └─ BoltFox setUserProductUpload：上传原图/统一压缩图，建立投屏记录
  → 校验 frame 字节数 = width × height ÷ 2
  → 预计算 CRC32，并按当前 BLE 分包大小预组 0x21 帧
  → BLE 发送 0x20 → 0x21 / 0x23 → 0x22
  → 成功后 editUserProductImgRecord 写成功状态和 imgIndex
  → 最后一张按需要发送 0x24 刷新屏幕
```

## 组件职责

| 组件 | 职责 |
| --- | --- |
| 预览页 | 非破坏性构图、横竖向取景、按设备物理分辨率导出 |
| `utils/dithering.js` | 获取/缓存 seekink token，上传图片并取得设备帧；401 时强制刷新 token 一次 |
| `setUserProductUpload` | 保存图库/投屏记录所需图片并返回 `taskId/upirId`；返回的旧 `.bin` URL 不再用于设备图传 |
| `result.js` | 并行调度出帧与建记录、校验帧、预取下一张、收敛记账 |
| `device-ble.js` | BLE 协议发送、ACK 累计、重传、CRC 和预组包 |
| `imgIndex` | 设备物理槽位身份，成功后写入后端，供删除和刷屏定位 |

## 再次/重新投屏

再次投屏和失败后的重新投屏都回到正常投屏链路：

- 记录页只把图片地址包装成 `pendingProjection`；
- 重新进入预览页并按当前设备重新构图/出帧；
- 重新调用 `setUserProductUpload` 建立新记录；
- 不再下载或直传历史 `imgBle`；
- 不再用 `addUserProductImgRecord` 补记旧 `.bin` 直传结果。

## 关键约束

- 发送前必须按[设备身份与 BLE 会话](device-identity-and-connection.md)确认目标物理设备。
- 设备按固定行宽解析帧。横向构图仍必须导出到设备竖向物理画布，不能仅因总像素数相同就直接发送对调宽高的数据。
- 横向构图的顺时针旋转角读取目标设备 `rotationDegree`，历史设备或旧缓存缺少该字段时默认使用 `270°`；手机预览反向旋转必须与该值同源。
- seekink `type` 必须和目标设备尺寸一致；当前颜色参数为 `BWRYGB`，抖动模式为 `2`。
- frame 长度不等于 `width × height ÷ 2` 时禁止发送。
- `imgIndex=0` 是合法槽位，任何判断都不能把 0 当成“无索引”。
- 设备图传成功但后端记账失败会造成设备与云端记录不一致，相关风险见 [imgIndex 决策](../decisions/image-slot-index.md)。

## 性能策略

- 首张出帧与“连接设备 → 读取 0x01”并行。
- 下一张网络出帧、CRC32 和 0x21 预组包与当前张 BLE 传输重叠。
- CRC16/CRC32 使用查表实现。
- 进度 UI 节流，后端记账不阻塞下一张 BLE 传输。
- 任何预取结果都必须在使用前重新校验设备尺寸、帧长度和分包参数。

## 历史来源

- [服务器出帧目标方案（历史）](../archive/designs/server-image-processing-ble-transfer.md)
- [图片传输性能实验与实施记录](../archive/performance/图片传输性能优化计划.md)
- [客户端接口矩阵](../reference/client-api-matrix.md)
- [照片预览需求变更记录](../changes/2026-07-22-照片预览需求调整.md)
