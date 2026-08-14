# 图片投屏流水线

> 状态：current  
> 最后核对：2026-08-14
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

失败页「重新投屏」额外一条不变量（2026-08-03）：**跳回预览页前必须把图还原成原图**
（`result.js restorePendingOriginals`，口径同预览页「原图」按钮），构图由
`pendingProjection.editStates` 恢复。原因是投屏时预览页已把成品图写回 `tempFilePath`，
拿它当编辑底图会造成竖向二次裁剪/二次 `180°` 旋转、横向二次设备角旋转（设备上错位）。

每重投一次就多一条 `deviceUploadState=0` 的记录：接口没有「复用 `upirId` 重传」入口，
连续重试会在记录页失败页累积同一张图，待与后端确认口径。

## 关键约束

- 发送前必须按[设备身份与 BLE 会话](device-identity-and-connection.md)确认目标物理设备。
- 竖向构图必须固定顺时针旋转 `180°` 后导出，且不受目标设备 `rotationDegree` 影响；编辑与未编辑出图路径必须保持一致。
- 设备按固定行宽解析帧。横向构图仍必须导出到设备竖向物理画布，不能仅因总像素数相同就直接发送对调宽高的数据。
- 横向构图的顺时针旋转角读取目标设备 `rotationDegree`，历史设备或旧缓存缺少该字段时默认使用 `270°`；手机预览反向旋转必须与该值同源。
- seekink `type` 必须和目标设备尺寸一致；当前颜色参数为 `BWRYGB`，抖动模式为 `2`。
- frame 长度不等于 `width × height ÷ 2` 时禁止发送。
- `imgIndex=0` 是合法槽位，任何判断都不能把 0 当成“无索引”。
- 设备图传成功但后端记账失败会造成设备与云端记录不一致，相关风险见 [imgIndex 决策](../decisions/image-slot-index.md)。

## BLE 图传参数（2026-08-14 起的默认口径）

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| 请求 MTU | 500 | 建连即协商；`setBLEMTU` 直接报错的安卓栈按 247 再请求一次；**成功也要 `getBLEMTU` 读回、两者取小**（部分安卓机型虚报请求值，信了会写出被静默丢弃的大包） |
| 0x21 每包数据 | ≤489 字节 | 由协商到的 MTU 反算，恒满足「数据 ≤ MTU-11」：247→236、185→174 |
| 发包窗口 | 50 包 | 这是**上限**，AIMD 会按设备实际吞吐往下收；卡顿减半、稳定后涨回 |
| 每包发送间隔 | 3ms | 起点，链路干净会继续往 0 探；退让上限 16ms、干净后快速砍半回落 |
| 图传连接间隔 | 安卓/鸿蒙 7.5ms、iOS 及其他 15ms | iOS 不能更低：Apple 规范拒绝 <15ms 的参数更新请求 |
| 调速策略 | AIMD 自适应（带丢包记忆） | `uploadImage` 默认；显式 `adaptive:false` 才回 legacy 老策略。超时后窗口最多涨回丢包点减半值(capWindow)，每 8 个干净窗口才 +1 上探——设备收包缓冲是固定容量，丢包点必须钉住，否则反复「涨回→再溢出」每次白付 1~2s |
| 大包不可用降级 | 236 字节 / 窗口 10 | 两种触发：开传 3 轮零推进（≈2.5s，一包未被确认——老固件帧解析器只认 ≤244 字节整帧 / MTU 虚高漏网）、或传输中途连续 5 轮无推进（≈3~4s，固件在持续大包流下接收卡死，真机实录停在第 17 包）。自动重发 0x20（复位设备接收状态）按安全档从头重传，写回会话，**并记入按机持久档案 `imgSafeChunkDevices`**——重连后直接走安全档，不再拿大包撞设备（卡死后设备会整个失联）。调试台显式传参不受档案约束；固件升级核验通过后用 `clearSafeChunkProfile` 恢复 |

窗口 50 与 AIMD 是**一组**：老策略在大窗口下会退化成「灌满→设备缓冲溢出丢包→其后整窗按序作废→
等满超时→整窗重发」的死循环，回滚必须一起回。每张传完把收敛出的稳态窗口记到 `session.tunedWindow`，
多张连传只有第一张付收敛成本。调试台（`subpackages/device/debug`）与真实投屏自此
同参数，两边耗时可直接对照。四项前者可在页面上临时改（只作用于当次调试），连接间隔/发送速度/发包窗口
还可经「保存给真实投屏」写入本地存储**覆盖**上表默认值——存储值优先级更高。
详见 [2026-08-14 投屏传输参数同步为默认值](../changes/2026-08-14-投屏传输参数同步为默认值.md)（含当日续修：
真机回归「慢好几倍 + 电子纸设备未连接」的五处根因与修复）。

## 性能策略

- 首张出帧与“连接设备 → 读取 0x01”并行。
- 下一张网络出帧、CRC32 和 0x21 预组包与当前张 BLE 传输重叠。
- CRC16/CRC32 使用查表实现。
- 进度 UI 节流，后端记账不阻塞下一张 BLE 传输。
- 任何预取结果都必须在使用前重新校验设备尺寸、帧长度和分包参数。

## 常见故障判读

| 报错 | 含义 | 判读 |
| --- | --- | --- |
| `接口-抖动bin转换失败：request:fail errcode:-118 error_msg:net::ERR_CONNECTION_TIMED_OUT` | Chromium `ERR_CONNECTION_TIMED_OUT`，**建连阶段** SYN 无应答 | 请求没到服务器。首查非标准端口 `8443` 是否被本地网络（运营商/公司 WiFi/路由器策略）丢包——切 4G 能恢复即可确认；其次查 seekink 单 IP 线路是否异常。详见 [2026-08-03 记录](../changes/2026-08-03-结果页按钮间距与抖动接口连接超时.md) |
| `request:fail timeout` | 命中 `dithering.js` 的 20s 超时 | 连上了但服务端迟迟不返回，属出帧服务处理慢/卡住 |
| `url not in domain list` | 域名白名单未配 | 管理后台 request 合法域名需含 `https://cloud.seekink.cn:8443` |
| `-102 ERR_CONNECTION_REFUSED` / `-105` / `-107` | 拒绝连接 / DNS 解析失败 / 证书链问题 | 与 `-118` 是不同故障，勿混为一谈 |

网络类失败（`timeout|connect|网络|ERR_`）由 `dithering.js` 退避重试 3 次；用户看到报错即表示三次都失败，不是瞬时抖动。

## 历史来源

- [服务器出帧目标方案（历史）](../archive/designs/server-image-processing-ble-transfer.md)
- [图片传输性能实验与实施记录](../archive/performance/图片传输性能优化计划.md)
- [客户端接口矩阵](../reference/client-api-matrix.md)
- [照片预览需求变更记录](../changes/2026-07-22-照片预览需求调整.md)
- [调试台改走真实投屏竖向链路与传输参数（2026-08-07）](../changes/2026-08-07-调试台改走真实投屏竖向链路与传输参数.md)
