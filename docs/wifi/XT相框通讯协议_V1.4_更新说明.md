# XT 相框通讯协议 V1.4 更新说明（前端同步版）

> 版本：v1.1（2026-10-27）
> 配套协议：[XT相框通讯协议_V1.4.md](XT相框通讯协议_V1.4.md)
> 适用端：小程序 / App
> 本次服务端改动：投屏不再等待 ack、失败码细分、关机/休眠状态、休眠多模式、轮播多模式、批量上传 `refresh`、轮播选图 `imgUrls`。

---

## 一、协议 V1.4 的主要变化

### 1.1 新增 104 下载失败子错误码

V1.4 在状态码表后新增 `4.1 esp32 104 错误码细分`，`result=200~212` 是 `104（下载文件失败）` 的具体原因：

| code | 含义 | 服务端处理 |
|---|---|---|
| 200 | 发送 GET 请求失败 | 投屏失败，图片下载失败 |
| 201 | 响应头超过 4096 字节 | 同上 |
| 202 | 读失败/对端关闭/状态行无法解析 | 同上 |
| 203 | HTTP 状态码不是 200 | 同上 |
| 204 | Content-Length 缺失或为 0 | 同上 |
| 205 | 下载完成但文件校验失败 | 同上 |
| 206 | 收到字节数与 Content-Length 不一致 | 同上 |
| 207 | 图片数据长度与实际接收长度不一致 | 同上 |
| 208 | CRC16 与图片数据不一致 | 同上 |
| 209 | CRC16 校验失败 | 同上 |
| 210 | 未收到数据或长度/成功条件不符 | 同上（之前 OSS 直连失败即此码） |
| 211 | 超时或重试次数耗尽 | 同上 |
| 212 | 下载中断或分区设置失败 | 同上 |

> 服务端已把 `200~212` 统一按“图片下载失败”处理；前端按消息通知展示即可。

### 1.2 其他协议修正

- `strategy_bin` 的 action 统一为 `strategy_bin`（V1.3.1 表格误写 `strategy`）。
- `strategy_bin.updatetype` 类型统一为 int（V1.3.1 写成 string）。
- `image_refresh` 描述修正为“刷新当前图片/重新刷新屏幕”（V1.3.1 误写“清空 TF 卡”）。
- `wifi_sleep` 示例 action 修正为 `wifi_sleep`（V1.3.1 示例误写 `wifimode`）。

### 1.3 V1.4 文档仍需注意的语义问题（暂不影响前端）

- 文件名 V1.4，正文版本仍写 V1.3，版本记录没有 1.4 条目。
- 登录示例 `statype="1"`，但 WiFi 基站应为 `2`。
- 心跳字段表写 `statype`，JSON 示例是 `type`。
- `wifimode` 下行 `mode=3` 叫“休眠模式”，ack 表又叫“停机模式”。
- `wifi_sleep.beginTime/endTime` 类型写成 int，实际是字符串。
- `device_config` 的 `batchkey/deviceId/uid` 类型写成 int，实际是字符串。
- 所有 ack 示例使用 `result=1`，状态码表成功是 `0/113`。
- 标签上报 action 表格写 `login`，JSON 示例是 `uptag`。
- `shutdown_ack.ack_msgid` 类型写成 int，实际是字符串。
- 内置图片键 `LOW_BATTORY` 拼写错误，JSON 用 `LOW_BATTERY`。
- 状态码表没有 `180~199`；真机实测这些码是下载进度，服务端按 `DOWNLOADING` 处理。

### 1.4 服务端接口变化摘要（前端必读）

| 能力 | 变化 | 前端要做什么 |
|---|---|---|
| 投屏 | `POST /api/device/play` 新增可选 `refresh`，默认 `true` 刷屏；`false` 只上传 | 批量时前 N-1 张传 `false`，最后一张 `true` |
| 批量上传 | 仍是单图接口，N 张 = N 次调用；没有批量接口 | `refresh=false` 返回 `status=UPLOADED`、`msgid=null`，不要用它轮询状态 |
| 轮播选图 | `POST /api/device/strategy` 新增可选 `imgUrls` | 传相册 `imgBle` URL，最多 200 个；不传=全部相册，传空=4000 |
| 轮播查询 | `GET /api/device/strategy` 返回 `imgUrls` | `null`=全部相册，`[]`=选择已全部失效 |
| 轮播存储 | 改为 MySQL `iot_device_strategy`，不再用 Redis | 接口行为不变，只是查询/保存更稳定 |
| 照片删除 | 相册记录由 App 调老服务删除，本服务只删 OSS bin | 先删老服务记录，再调 `POST /api/device/photo/delete` |

### 1.5 前端页面交互调整

> 只涉及页面入口和文案，接口调用方式不变。

- **设备列表页**：原“状态刷新”改为“轮播设置”，用于进入轮播参数配置；设备在线状态仍通过 `device.status` 推送和列表刷新体现。
- **设备内页**：蓝牙（BLE）设备保留“投屏”按钮；原“连接”按钮改为“轮播设置”。
- **轮播设置页（新增）**：点击“轮播设置”后，需要支持从“我的上传”相册选择照片：
  - 支持单选、多选；
  - 提供“全选”按钮；
  - 选中的照片按选择顺序作为 `imgUrls` 提交给 `POST /api/device/strategy`；
  - 不选择任何照片时不要提交空数组（会返回 `4000`）。

---

## 二、投屏交互变更（重点）

### 2.1 前端不再等待投屏 ack

1. 前端把图片上传到 `POST /api/device/play`。
2. 接口返回 `status=SENT`（指令已成功下发到设备）。
3. **前端到此结束**，不轮询 `/api/device/play/status`，也不依赖 WS `play.result` 结束页面。
4. 页面提示：「已发送，屏幕即将刷新」/「图片已推送，正在刷新屏幕」。
5. 设备真正的成功/失败结果由服务端写入消息通知，前端从消息列表/推送查看。

保留的能力（兼容旧客户端）：

- `GET /api/device/play/status?msgid=` 仍可用，返回新增 `result`、`errorCode`。
- WS `play.result` 仍会推送，新增 `result`、`errorCode` 字段。
- 旧客户端继续等待 ack 不受影响。

### 2.2 投屏结果消息

失败：

| 消息 type | 含义 |
|---|---|
| `PLAY_DOWNLOAD_FAILED` | 图片下载失败（包含 200~212 子码） |
| `PLAY_STORAGE_ERROR` | 设备存储异常（101/105/115/117） |
| `PLAY_FAILED` | 通用失败/指令下发失败/超时 |

成功（新增）：

| 消息 type | category | 含义 |
|---|---|---|
| `PLAY_SUCCESS` | `BUSINESS` | 投屏成功 |

消息 payload 示例：

```json
{
  "msgid": "1793091680960555",
  "result": 113,
  "userNo": "GA6473224",
  "corrected": false,
  "reason": "投屏成功"
}
```

> `corrected=true` 表示设备在超时后才返回成功，服务端已把任务纠正为成功。

### 2.3 超时

- 投屏 ack 超时已从 60 秒调整为 **180 秒**（真机实测约 85 秒）。
- 超时后服务端发送 `PLAY_FAILED`（reason=投屏超时）；如果设备随后返回成功，再发送 `PLAY_SUCCESS`（corrected=true）。
- 前端不需要处理超时倒计时，按消息通知展示即可。

### 2.4 批量上传与 `refresh` 参数

**接口仍是单图指令，批量 = 按图片数量分多次调用；是否刷屏由 `refresh` 控制。**

- 协议 `play` 的 `data.imgs` 是数组，但 V1.4 只定义了单图行为；`play_ack` 只有一条 `result`、没有 `imgid`，多元素时无法区分每张结果。
- `POST /api/device/play` 一次只接收一个 `file`，永远下发单元素 `imgs`，不提供批量接口。
- 新增参数 `refresh`（可选，默认 `true`）：

| `refresh` | 服务端行为 | 返回 `status` | 设备表现 |
|---|---|---|---|
| `true`（默认） | 转换 → 上传 OSS → 下发 `play` | `SENT` | 下载并刷屏 |
| `false` | 转换 → 上传 OSS，不下发 `play` | `UPLOADED`，`msgid=null` | 不刷屏 |

- `refresh=false` 不校验在线/升级，不创建投屏任务、不发消息通知。
- 批量用法：
  1. **批量入库/相册**：N 张全部 `refresh=false`，App 用返回的 `binUrl` 写老服务相册记录；
  2. **批量上传后只刷一次屏**：前 N-1 张 `refresh=false`，最后一张 `refresh=true`；
  3. 单张立即显示：省略 `refresh`。
- 先上传的图之后要显示，需要重新以 `refresh=true` 提交（生成新 bin），或走相册轮播。
- 不要使用多元素 `imgs`，除非固件明确说明排序、刷屏时机和 ack 粒度。

---

## 三、设备状态新增 `SHUTDOWN`

设备主动关机（`shutdown` 上报）现在单独返回：

| status | 含义 | 展示建议 |
|---|---|---|
| `ONLINE` | 在线 | 在线（绿） |
| `OFFLINE` | 离线 | 离线（灰/红） |
| `SLEEPING` | 休眠中 | 休眠中（蓝） |
| `SHUTDOWN` | 已关机 | 已关机（灰） |

- 生效位置：`GET /api/device/online`、`GET /api/device/info`、WS `device.status`、管理后台列表/详情。
- 设备关机不再发送 `DEVICE_OFFLINE` 通知。
- 设备重新开机登录后恢复 `ONLINE`，并清除关机标记。
- 状态优先级：`ONLINE > SHUTDOWN > SLEEPING > OFFLINE`。

---

## 四、休眠支持两种模式

`POST /api/device/sleep` 兼容旧参数，同时新增 `mode`：

| mode | 含义 | 时间字段 | 格式 |
|---|---|---|---|
| `0` | 关闭休眠 | 不需要 | — |
| `1` | 一次性休眠 | `beginTime` / `endTime` | 本地 `yyyy-MM-dd HH:mm` |
| `2` | 周期休眠 | `sleepTime` / `wakeTime` | 本地 `HH:mm` |

请求示例（一次性）：

```json
{
  "deviceNo": "D0CF13F02FF8",
  "mode": 1,
  "beginTime": "2026-10-28 22:00",
  "endTime": "2026-10-29 07:00"
}
```

请求示例（周期，旧格式仍可用）：

```json
{
  "deviceNo": "D0CF13F02FF8",
  "mode": 2,
  "sleepTime": "22:00",
  "wakeTime": "07:00"
}
```

兼容规则：

- 不传 `mode` 时，`enable=true` 等价 `mode=2`，`enable=false` 等价 `mode=0`。
- 一次性休眠必须 `beginTime < endTime`。
- 周期休眠 `sleepTime` 不能等于 `wakeTime`。
- 时间仍是本地时间，服务端转 UTC 下发；前端不要自行转 UTC。
- 服务端按计划计算 `SLEEPING`；计划由本接口写入，旧版本/公版 App 设置的休眠服务端无法识别。

---

## 五、轮播支持两种模式与选图

### 5.1 轮播模式

`POST /api/device/strategy` 新增 `updateType`：

| updateType | 含义 | 必填字段 |
|---|---|---|
| `2`（默认） | 间隔时间 | `beginTime`、`endTime`（HH:mm）、`timingTime`（秒） |
| `1` | 固定时间 | `updateDays`（1~365）、`updateTimeList`（HH:mm 数组） |

请求示例（固定时间）：

```json
{
  "deviceNo": "D0CF13F02FF8",
  "updateType": 1,
  "updateDays": 2,
  "updateTimeList": ["11:00", "15:00"],
  "mode": 1,
  "idle": 1
}
```

请求示例（间隔，旧格式仍可用）：

```json
{
  "deviceNo": "D0CF13F02FF8",
  "updateType": 2,
  "beginTime": "08:00",
  "endTime": "20:00",
  "timingTime": 300,
  "mode": 1,
  "idle": 1
}
```

兼容规则：

- 不传 `updateType` 默认按间隔模式处理。
- 间隔模式必须传 `beginTime/endTime/timingTime`。
- 固定时间模式必须传 `updateDays/updateTimeList`。

### 5.2 轮播选图 `imgUrls`

```json
{
  "deviceNo": "D0CF13F02FF8",
  "updateType": 1,
  "updateDays": 2,
  "updateTimeList": ["11:00", "15:00"],
  "mode": 1,
  "idle": 1,
  "imgUrls": [
    "https://inkstar.oss-ap-southeast-1.aliyuncs.com/wififile/D0CF13F02FF8/a.bin",
    "https://inkstar.oss-ap-southeast-1.aliyuncs.com/wififile/D0CF13F02FF8/b.bin"
  ]
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `imgUrls` | string[] | 否 | 相册 `imgBle` URL；最多 200 个；去重、trim、保持顺序；不传=全部相册，传空数组=`4000` |

- `/device/playlist` 按 `imgUrls` 过滤并保持顺序；相册里不存在的 URL 跳过；全部失效返回空列表，不回退全部。
- `GET /api/device/strategy` 新增返回 `imgUrls`：`null`=未配置选择（全部相册），`[]`=选择已全部失效。
- 删除照片时，服务端自动把对应 URL 从选择里移除；`all=true` 清空选择。
- 轮播保存、照片删除都会清 `/device/playlist` 的 60 秒缓存。
- 轮播配置存 MySQL `iot_device_strategy`；保存要求设备在线并有权限，查询只要求权限（设备离线也能查）。

---

## 六、前端改动清单

| 改动 | 是否必须 |
|---|---|
| 投屏成功后不再等待 ack，展示“屏幕即将刷新”，结果从消息通知查看 | 必须 |
| 消息类型映射增加 `PLAY_SUCCESS`（BUSINESS） | 必须 |
| 失败消息按 `PLAY_DOWNLOAD_FAILED` / `PLAY_STORAGE_ERROR` / `PLAY_FAILED` 展示 | 必须 |
| 设备状态映射增加 `SHUTDOWN`“已关机” | 必须 |
| 休眠页增加模式选择：周期（HH:mm）/一次性（日期+时间） | 必须（如使用一次性休眠） |
| 轮播页增加模式选择：间隔（分钟）/固定时间（每 N 天 + 时间点） | 必须（如使用固定时间轮播） |
| 轮播设置页从“我的上传”选图：单选/多选/全选，作为 `imgUrls` 提交 | 必须（如使用轮播选图） |
| 批量上传按 `refresh` 控制刷屏：前 N-1 张 `false`，最后一张 `true` | 必须（如使用批量上传） |
| `play.result` / 投屏状态接口可展示 `result`、`errorCode`（可选） | 可选 |

---

## 七、服务端接口变更汇总

| 接口 / 消息 | 变更 |
|---|---|
| `POST /api/device/play` | 返回 `SENT` 即前端结束；新增 `refresh`，`false` 返回 `UPLOADED` 且不刷屏 |
| `GET /api/device/play/status` | 新增 `result`、`errorCode` |
| WS `play.result` | 新增 `result`、`errorCode` |
| 消息通知 | 新增 `PLAY_SUCCESS`；失败细分不变 |
| `GET /api/device/online` / `info` | `status` 新增 `SHUTDOWN` |
| WS `device.status` | `status` 新增 `SHUTDOWN` |
| `POST /api/device/sleep` | 新增 `mode/beginTime/endTime`，兼容 `enable` |
| `POST /api/device/strategy` | 新增 `updateType/updateDays/updateTimeList`、`imgUrls` |
| `GET /api/device/strategy` | 返回新增 `updateType/updateDays/updateTimeList`、`imgUrls` |
| `POST /api/device/photo/delete` | 新增；本服务只删 OSS bin，不处理老服务相册 |

---

## 八、联调验收

- [ ] 投屏接口返回 `SENT` 后前端立即结束，不再轮询/等待。
- [ ] 设备投屏成功后消息中心出现 `PLAY_SUCCESS`。
- [ ] 设备下载失败时出现 `PLAY_DOWNLOAD_FAILED`，不再显示为通用失败。
- [ ] 超时场景出现 `PLAY_FAILED`（投屏超时），迟到成功会出现 `PLAY_SUCCESS`（corrected=true）。
- [ ] 设备关机后状态显示“已关机”，且没有离线通知。
- [ ] 周期休眠、一次性休眠都能正确显示“休眠中”。
- [ ] 间隔轮播、固定时间轮播都能下发并查询到对应配置。
- [ ] 批量上传：前 N-1 张返回 `UPLOADED` 不刷屏，最后一张 `SENT` 刷屏。
- [ ] 轮播设置从“我的上传”选图后，`GET /api/device/strategy` 能回显 `imgUrls`。
- [ ] 设备拉取的图片列表与选择一致且顺序正确。
- [ ] 删除照片后，轮播选择中的对应 URL 被自动移除。

---

## 九、照片删除接口

### 9.1 职责划分

- **相册数据由 App 调老服务处理**：新增、删除、批量删除、全量清空都由 App 完成，本服务不写、不删老服务相册记录。
- **本服务只删除云端物理文件**：App 删完记录后，把被删图片的 `imgBle` URL 传给本服务，本服务删除 OSS 上对应的 bin，并清 `/device/playlist` 缓存。
- **协议没有“删除指定照片”的指令**；有 TF 卡时也只有 `clean_tf(ALL/LOCAL/OTHER)`，不支持按张删除。

### 9.2 删除接口

```
POST /api/device/photo/delete
Header: userToken
Content-Type: application/json
```

```json
{
  "deviceNo": "D0CF13F02FF8",
  "imgUrls": [
    "https://inkstar.oss-ap-southeast-1.aliyuncs.com/wififile/D0CF13F02FF8/a.bin"
  ],
  "all": false,
  "currentImageUrl": "https://inkstar.oss-ap-southeast-1.aliyuncs.com/wififile/D0CF13F02FF8/a.bin",
  "nextImageUrl": "https://inkstar.oss-ap-southeast-1.aliyuncs.com/wififile/D0CF13F02FF8/b.bin"
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `deviceNo` | string | 是 | 设备编号 |
| `imgUrls` | string[] | 条件必填 | 被删图片的 `imgBle` URL；最多 200 个 |
| `all` | boolean | 条件必填 | 删除该设备全部云端 bin；与 `imgUrls` 二选一 |
| `currentImageUrl` | string | 否 | 前端已知的当前屏上图 URL；不传则用服务端 `lastplay` |
| `nextImageUrl` | string | 否 | 删的是当前图时传，服务端自动 `play` 下一张 |

返回：

```json
{
  "code": 0,
  "msg": "ok",
  "data": {
    "requested": 1,
    "deleted": 1,
    "failed": 0,
    "skipped": 0,
    "current": true,
    "deviceAction": "PLAY_NEXT",
    "deviceNotified": true
  }
}
```

| 字段 | 说明 |
|---|---|
| `requested` | 请求删除的 URL 数；`all=true` 时为实际删除数 |
| `deleted` | 实际删除的 OSS 文件数 |
| `failed` | OSS 删除失败数 |
| `skipped` | 不属于本服务 OSS bucket/前缀、未删除的 URL 数 |
| `current` | 被删图片是否等于最后一次成功单图投屏的图片 |
| `deviceAction` | `NONE` / `PLAY_NEXT` / `CLEAN_TF` |
| `deviceNotified` | 设备指令是否下发成功；无指令为 `true`，离线导致未发出为 `false` |

### 9.3 行为矩阵

| 场景 | 服务端动作 |
|---|---|
| 单个/批量 `imgUrls` | 删除对应 OSS bin；非本桶 URL 计入 `skipped` |
| `all=true` | 删除 `wififile/{deviceNo}/` 下全部 bin |
| 删除当前图且传 `nextImageUrl` | 自动 `play` 下一张，`deviceAction=PLAY_NEXT` |
| 删除当前图但未传 `nextImageUrl` | 返回 `current=true`、`deviceAction=NONE`，前端自行决定 |
| 有 TF 卡且 `all=true` | 额外下发 `clean_tf(OTHER)`，`deviceAction=CLEAN_TF` |
| 有 TF 卡且单个/批量 | 只删云端 bin，TF 本地文件保留 |
| 设备离线 | 云端文件照删；需要指令时 `deviceNotified=false`，上线后需重新调用 |

### 9.4 前端删除流程

1. App 调老服务删除相册记录（单张/批量/全量）。
2. App 调 `POST /api/device/photo/delete`，传被删 URL；删的是屏上当前图时同时传 `nextImageUrl`。
3. 删除成功提示：「已从相框播放列表移除，设备联网后更新」。
4. `deviceNotified=false` 时提示设备离线，云端文件已删除、设备换图待上线。

### 9.5 当前图由谁判断、谁触发设备指令

**服务端判断，服务端触发；前端可选提供 `currentImageUrl`，并在删当前图时提供 `nextImageUrl`。**

- 当前图判断优先级：`currentImageUrl` → 服务端 `lastplay`（最后一次成功单图投屏，Redis 7 天）。
- 设备指令由服务端下发：服务端有在线状态、MQTT 通道和 ack 跟踪，前端不需要处理。
- 前端只负责“下一张是哪张”，因为相册顺序由老服务/前端掌握。
- 轮播状态下平台不知道屏上是哪张；前端知道就传 `currentImageUrl`，否则可能不自动换图。建议固件在 `strategy_ack` 带 `imgid`。

### 9.6 待确认

1. **设备拉列表时机**：每次到更新时间都拉 `/device/playlist`，还是只在收到轮播设置时拉一次？后者增删图后需重发 `strategy_bin`。
2. **TF 按张删除**：协议不支持，当前只删云端 bin；需要固件新增按 `imgid` 删除。
3. **`clean_tf type=OTHER` 范围**：需固件确认只清用户照片、不含内置图。

### 9.7 设备下载地址

`/device/playlist` 返回的 `host`/`port` 已与 `play` 指令一致，优先使用 `xt.play.device-download-*` 配置的反代地址，`imgList` 路径统一加 `/oss` 前缀；未配置时按 `imgBle` 解析。

---

## 十、文档同步

| 文档 | 变更 |
|---|---|
| [前端对接文档_草稿.md](前端对接文档_草稿.md) | v0.42 删除照片；v0.43 国家码；v0.44 投屏 `refresh`；v0.45 轮播 `imgUrls` |
| [设备入网流程.md](设备入网流程.md) | 国家码完整清单、校验边界、真机已知问题 |
| [删除指定照片方案.md](删除指定照片方案.md) | 与实现一致的定稿 |
