# Project Context

> 文档用途：供 Codex 和其他 AI 助手快速建立项目上下文，不是面向普通用户的 README。  
> 状态：current  
> 最后核对：2026-07-28  
> 覆盖范围：当前仓库中的微信小程序代码、直接调用的 HTTP 服务、BLE/OTA 协议和项目文档。  
> 事实优先级：外部当前契约与已确认硬件规范 → 当前源码与同步后的 CodeGraph → `docs/` 中标记为 `current` 的文档 → 变更记录 → `docs/archive/`。

## Project Overview

这是 BoltStar 智能相框的微信小程序客户端。它解决的核心问题是让用户在微信内完成：

- 微信授权登录和本地会话恢复；
- 搜索、绑定、选择和管理 BoltStar 相框；
- 通过 BLE 连接真实设备，读取设备信息、电量和播放配置；
- 从相机、相册或 AI 生成结果中选择图片，进行非破坏性构图并投屏到六色电子纸相框；
- 在「我的相册」按设备管理投屏成功的照片（再次投屏 / 删除）以及设备上的图片槽位；
- 设置相框轮播模式、刷新指定图片、清空设备图片；
- 检查并执行设备固件 OTA/DFU；
- 使用“星宝”AI 进行文字、图片和生图对话；小程序正式入口已开放。

本仓库只包含微信小程序客户端，不包含 BoltFox 后端、BoltStar AI 服务、seekink 抖动服务、设备固件或 Flutter 客户端源码。涉及这些系统的行为只能依据接口文档、协议文档和客户端观察结果，不能假设其内部实现。

## Tech Stack

- 平台：原生微信小程序，`project.config.json` 的 `compileType` 为 `miniprogram`。
- UI 与页面：
  - JavaScript、WXML、WXSS、JSON；
  - 小程序基础库版本 `3.16.1`；
  - `style: v2`；
  - 组件框架 `glass-easel`；
  - 自定义导航栏和自定义 TabBar。
- JavaScript：
  - CommonJS `require/module.exports`；
  - ESLint 解析目标为 ECMAScript 2018；
  - 没有 `package.json`、lockfile 或仓库内 npm 依赖。
- 微信能力：
  - `wx.request`、`wx.uploadFile`；
  - BLE 扫描、连接、Notify、MTU 和特征写入；
  - Canvas/离屏 Canvas、图片选择、下载、压缩和文件系统；
  - `wx.getStorageSync/setStorageSync`；
  - `getLocation` 私有信息权限，用于附近设备搜索和绑定。
- 插件：
  - `WechatSI` `0.3.5` 已在 `app.json` 声明；
  - 聊天页包含同声传译接入和普通录音降级；
  - 小程序管理后台是否已批准并启用该插件：**待确认**。
- 网络服务：
  - BoltFox API：`https://api.boltfox.cn`；
  - seekink 图片抖动：`https://cloud.seekink.cn:8443/.../imageDitheringBinDownload`；
  - BoltStar AI 服务：阿里云 FC 独立域名，定义在 `utils/ai-api.js`；2026-08-06 起切到流式版部署 `boltstagent-web-...`；
  - `/chat` 走 SSE：`wx.request` 开 `enableChunked`、`onChunkReceived` 收流，事件为 `pre_text`/`progress`/`image`/`text`/`done`；
  - 基础库拿不到 `onChunkReceived` 时降级回旧的非流式部署（完整 JSON + 客户端打字机）。
- 测试：
  - 使用 Node.js 内置测试运行器；
  - 当前有 `device-id`、`active-device-identity`、`battery`、`ai-service-consent` 四组单元测试；
  - BLE、投屏、OTA、HTTP 和 AI 主链路仍依赖真机或人工联调。
- 代码理解：
  - 仓库已接入 CodeGraph；
  - `.codegraph/` 是每台电脑各自生成的本地索引，已被 Git 忽略。

运行配置要点：

- `utils/config.js` 当前 `useMock: false`。
- release 环境在 `utils/request.js` 中强制禁用 Mock，即使本地误开开关也不会在线上使用模拟数据。
- BoltFox 普通请求单次超时 10 秒，网络层失败最多静默重试 2 次；文件上传超时 20 秒且不自动重试。
- AI 普通请求超时 15 秒，聊天和生图超时 600 秒（10 分钟）且不自动重试。
- `app.json` 预加载 device、projection、AI 三个分包；设置和相册分包按需加载。

## Architecture Overview

项目采用原生小程序的页面层加共享工具模块架构，没有额外状态管理框架。

```text
页面与组件
  pages/ + subpackages/ + components/
          │
          ├─ 业务/API 层
          │   utils/api.js
          │   utils/request.js
          │   utils/ai-api.js
          │   utils/dithering.js
          │
          ├─ 设备领域层
          │   utils/device-id.js
          │   utils/active-device.js
          │   utils/bluetooth.js
          │   utils/device-ble.js
          │   utils/frame-protocol.js
          │   utils/ota-ble.js
          │
          └─ 本地状态与平台适配
              app.globalData
              wx Storage
              battery/device-info/media/system/language/toast
```

全局长期状态只保留在 `app.globalData` 和微信 Storage 中，核心字段是：

- `token`：BoltFox 登录令牌；
- `userInfo`：规范化后的用户信息；
- `selectedDevice`：当前用户选择的后端设备记录及最近有效设备状态；
- `prefetchedDevices`：登录完成后为首页一次性预取的设备列表。

三类外部网络客户端刻意分离：

1. BoltFox 业务 API 经 `utils/api.js` 和 `utils/request.js`；
2. BoltStar AI 经 `utils/ai-api.js`，不继承 BoltFox 公共参数/错误码，但共用登录下发的 `jwtToken` 自拼 `Authentication: Bearer` 头（2026-07-29 起网关强制）；
3. seekink 抖动经 `utils/dithering.js`，其认证 token 由 BoltFox `getXTYUserToken` 提供。

设备协议也分为两个独立会话层：

- 普通设备操作使用 FF00/FF01/FF02 和 `utils/device-ble.js`；
- OTA 使用 FF10/FF11 等特征和 `utils/ota-ble.js`；
- 物理设备是单连接模型，跨模块操作必须释放或复用正确的 GATT 连接。

## Directory Structure

| 路径 | 职责 |
| --- | --- |
| `app.js` | 应用启动、会话恢复、登录、选中设备、前台 BLE 会话对账、强制固件升级检查 |
| `app.json` | 主包页面、分包页面、TabBar、权限、插件、预加载和全局组件 |
| `pages/` | 主包页面：首页、登录、我的 |
| `subpackages/device/` | 设备列表、绑定、详情、轮播、OTA 和硬件调试台 |
| `subpackages/album/` | 「我的相册」：按设备分类展示投屏成功的照片，支持多选再次投屏与删除（2026-08-04 合并原「设备照片」「投屏管理」两个入口） |
| `subpackages/projection/` | 图片预览编辑、投屏执行、投屏记录 |
| `subpackages/ai/` | 星宝聊天和会话管理 |
| `subpackages/settings/` | 设置、资料、语言、指南、更新、协议与隐私页面 |
| `components/` | 品牌按钮、TabBar、表单、页面导航和全局 Toast |
| `utils/` | API、网络、BLE、协议、身份、图片、缓存、权限、语言和平台适配（含折叠屏适配 `fold-adapt.js`） |
| `styles/` | 跨页公共样式方案，目前只有折叠屏/分屏适配 `fold-adapt.wxss`（由 `app.wxss` 统一 `@import`） |
| `assets/` | 图片和 AI 错误文案 JSON 等静态资源 |
| `tests/` | Node 单元测试，目前集中于设备身份和电量 |
| `docs/` | 当前架构、协议、决策、接口参考、变更记录和历史归档 |
| `.codegraph/` | 本机生成的 CodeGraph 索引；不得提交 |
| `AGENTS.md` | AI 工作规则；必须留在根目录供工具自动发现 |
| `AI_CONTEXT.md` | 本文件；未来 AI 的快速上下文入口 |

只有 `app.json` 注册的页面才是运行时路由。源码目录存在不代表功能可达：

- `subpackages/settings/bind-email`、`change-email`、`forgot-password` 有页面源码但未注册；
- 小程序当前不暴露邮箱账号体系；
- AI 页面已注册，并通过自定义底栏“AI对话”入口公开可达；官方图库仍未接入。

## Core Modules

### 应用与会话

- 职责：启动、登录态恢复、用户信息规范化、全局选中设备和强制升级检查。
- 关键文件：
  - `app.js`
  - `pages/login/login.js`
  - `pages/home/home.js`
  - `pages/mine/mine.js`

### BoltFox API 与传输层

- 职责：
  - 对 `/Client/...` 接口做字段归一化；
  - 自动附加 `terminal=3`、语言、设备型号、`userToken` 和 Bearer token；
  - 同时兼容 `retCode/retData` 与 `code/data` 响应；
  - 统一处理登录过期、错误提示、网络重试和文件上传。
- 关键文件：
  - `utils/config.js`
  - `utils/request.js`
  - `utils/api.js`
  - `utils/mock.js`

### 设备发现、身份和活动会话

- 职责：
  - 共享 BLE 扫描会话；
  - 从厂商广播中提取候选信息；
  - 使用完整 6 字节设备 ID 验证物理身份；
  - 复用活动连接、直连缓存或扫描重连；
  - 将有效会话同步回 `selectedDevice`。
- 关键文件：
  - `utils/bluetooth.js`
  - `utils/device-id.js`
  - `utils/active-device.js`
  - `utils/device-conn-cache.js`
  - `subpackages/device/bind/bind.js`

### 普通 BLE 与设备协议

- 职责：
  - 建立 FF00 会话，发现 FF01 写特征和 FF02 Notify；
  - 合并并发连接；
  - 管理请求/ACK、接收缓冲、MTU 和单连接；
  - 读取设备信息、电量、播放配置；
  - 设置轮播、时间、删除图片、刷新屏幕；
  - 执行图片滑动窗口传输和重传。
- 关键文件：
  - `utils/device-ble.js`
  - `utils/frame-protocol.js`
  - `utils/device-info.js`
  - `utils/battery.js`

### 图片选择、预览和投屏

- 职责：
  - 选择原图；
  - 按设备比例进行平移、缩放、旋转和横竖构图；
  - 导出设备物理分辨率 JPG；
  - 调 seekink 生成六色 4bpp frame；
  - 建立 BoltFox 投屏记录；
  - 通过 BLE 传输并同步 `imgIndex`。
- 关键文件：
  - `utils/media.js`
  - `subpackages/projection/preview/preview.js`
  - `subpackages/projection/result/result.js`
  - `utils/dithering.js`
  - `utils/device-ble.js`
  - `subpackages/projection/records/records.js`

### 我的相册和设备图片槽位

- 职责：
  - 按电子纸设备分类展示**投屏成功记录**（列表数据源，只取成功）；
  - 云端图库列表作为槽位账本与原图来源，不直接渲染；
  - 使用 `imgIndex` 定位设备物理槽位；
  - 单选/多选再次投屏（多选走批量传输链路）、删除设备图片 + 相册记录 + 来源投屏记录；
  - 设备详情的「一键清空」不归本模块，但会清掉本页数据源：端上保持调 `clearUserProductImg`
    （后端文档口径为「一键删除我的图库」），**后端在同一次调用里同步删该设备的投屏记录**
    （2026-08-10 确认）。名字说的是图库、实际影响的是相册的数据源，故清空后相册随之为空；
  - 「我的」页卡片上的张数 = 全部设备的投屏成功记录条数（`api.getProjectionSuccessCount`，2026-08-05）；
  - 默认选中的设备（`list.js pickDefaultFilter`，2026-08-05）：
    保留当前选中 → **连接中的设备** → 第一台有照片的设备 → 第一台
    （连接态按真实 BLE 会话现算 `activeDevice.findConnectedDeviceId`，与投屏管理页同口径）。
- 关键文件：
  - `subpackages/album/list/list.js`
  - `pages/mine/mine.js`
  - `utils/api.js`
  - `utils/upload-limit.js`
  - `utils/frame-protocol.js`
  - `docs/decisions/image-slot-index.md`
  - `docs/changes/2026-08-04-折叠屏滚动适配与我的相册合并.md`
  - `docs/changes/2026-08-05-我的相册计数与全站折叠屏适配.md`

### OTA / DFU

- 职责：
  - 从设备详情取得升级元数据；
  - 下载或读取本地固件；
  - 校验/拆分 128 字节头和固件 payload；
  - 建立 FF10 OTA 会话并执行握手、数据传输、ACK、最终校验和中止；
  - 支持开发者工具中的本地 dry-run。
- 关键文件：
  - `subpackages/device/ota/ota.js`
  - `utils/ota-ble.js`
  - `subpackages/device/detail/detail.js`

### AI 客户端

- 职责：
  - 会话创建、列表、历史和删除；
  - 流式（SSE）文本/生图/图文对话，含预描述与生成进度；
  - 图片压缩、BoltFox 上传和 URL 传递；
  - 客户端打字机、停止生成、错误本地化；
  - 按登录用户 ID 缓存 AI 服务协议同意状态，并在发送前强制校验；
  - AI 图片下载后复用统一投屏链路。
- 关键文件：
  - `subpackages/ai/chat/chat.js`
  - `subpackages/ai/sessions/sessions.js`
  - `utils/ai-api.js`
  - `utils/ai-service-consent.js`
  - `utils/ai-i18n.js`
  - `utils/media.js`

### 设置和帮助

- 职责：用户资料、语言、操作指南、协议、隐私、退出和注销。
- 关键文件：
  - `subpackages/settings/`
  - `utils/language.js`
  - `utils/rich-html.js`
  - `utils/api.js`

## Data Flow

### 启动与登录

```text
App.onLaunch
  → restoreSession 从 Storage 恢复 token/userInfo/selectedDevice
  → 对当前选中设备做强制固件升级检查

App.onShow
  → deviceBle.reconcileConnections
  → 清理后台挂起后已经失效、但内存仍认为在线的 BLE 会话

登录页手机号授权
  → 再调用一次 wx.login 获取新鲜登录 code
  → api.setWechatAppLogin
  → app.applyWechatSession
  → globalData + Storage 双写
  → 预取设备列表
  → 首页
```

`getPhoneNumber` 回调中的 code 不能代替 `wx.login` code；两者用途不同。

### 绑定与连接设备

```text
位置/蓝牙权限
  → 打开蓝牙适配器
  → 共享扫描
  → 广播短 ID、型号、屏幕类型只筛选候选
  → 连接候选的微信 BLE deviceId
  → 0x01 GET_INFO
  → 读取并严格比较完整 6 字节 Device_ID
      ├─ 匹配：认领会话、写本机直连缓存、绑定/同步后端记录
      └─ 不匹配：断开、清污染缓存、排除候选、继续扫描
```

后续操作先查活动会话，再尝试本机直连缓存，最后才扫描。设备已被本应用连接时通常不广播，无条件重扫会制造“未搜索到设备”的假故障。

### 图片投屏

```text
相机/相册/AI/历史记录
  → 写入 Storage: pendingProjection
  → preview.js 按设备比例非破坏性构图
  → 导出设备物理分辨率 JPG
  → result.js 重新确认目标设备身份并读取 0x01
  → 并行：
      ├─ dithering.js → seekink → 六色 4bpp frame
      └─ setUserProductUpload → BoltFox 投屏记录 taskId/upirId
  → 校验 frame.length == width × height ÷ 2
  → CRC32 + 按 BLE chunk 预组 0x21 帧
  → 0x20 开始
  → 0x21 数据 / 0x23 累计 ACK / 超时回退重传
  → 0x22 结束和设备校验
  → editUserProductImgRecord 写成功状态和 imgIndex
  → 最后一张按需 0x24 刷屏
```

多张投屏会让下一张网络出帧、CRC 和预组包与当前张 BLE 传输重叠。预取只用于性能优化，使用前仍要重新校验设备尺寸、帧长度和 chunk 参数。

### 我的相册删除与再次投屏

```text
投屏成功记录（按 userProductId 分类）
  → 按 uProductImgId 关联到云端图库记录
  → 删除：只取后端 imgIndex → 组成固定 12 字节 IMG_INDEX_MASK
          → 确认设备完整身份和活动连接 → 直接发送设备 0x12
          → 设备应答成功后删图库记录 → 删来源投屏记录
  → 再次投屏：取图库原图（缺失回退记录图）→ 连接该记录所属设备
          → 写 pendingProjection → 走正常预览/投屏链路建**新记录**（多选即批量传输）
```

删除链路不读取 `0x01`、不按设备掩码/上传顺序/列表顺序推算缺失索引，也不在 `0x12` 报错后
重读或放行。任一选中项缺少有效 `imgIndex` 时整批终止，不删除设备或后端记录。

设备操作和云端操作不是事务。设备删除成功、后端删除失败时会产生幽灵记录；设备投屏成功、后端记账失败时会产生孤儿槽位。这是当前已知的一致性风险。

### AI 对话与 AI 图片投屏

```text
进入 AI 页面
  → 按当前用户 ID 检查 BoltStar AI 服务协议缓存
      ├─ 已同意：继续
      └─ 未同意：弹确认框；拒绝后仍可输入，但不能发送
  → 检查绑定设备
  → 每次发送前再次校验协议；未同意则原样保留草稿和待发图片
  → 首次真实发送且已同意协议时才创建会话
  → 可选图片先压缩到约 100KB
  → BoltFox setFileUpload 获取公网 URL
  → BoltStar 流式 /chat（SSE，最多 4 张图片）
  → 用户气泡立即上屏（不等建会话；建会话失败则回滚这条气泡与本地标题）
  → pre_text 预描述先上屏 → progress 里程碑由前端补间成 0→100 连续读数
  → image 排在 progress 90 之后（不是 50%），读数爬到 100 时才把占位盒换成真图 → text 逐条推送
  → 边收边打字机显示文字，预描述、进度、图片和文字都在同一气泡；done 后隐藏进度条

AI 图片投屏
  → 下载远程图片到本地临时文件
  → 写 pendingProjection
  → 进入统一 preview/result 投屏链路
```

AI 侧 `user_id` 取登录用户 `id/userNo/userId` 后加 `boltfox_` 前缀；未登录会退到共享演示 ID。正式业务是否允许未登录 AI：**待确认**。

### OTA / DFU

当前代码流程为：

```text
设备详情/OTA 页面
  → 拉取设备升级元数据并验证版本号、.bin URL
  → 确认目标设备活动会话
  → 下载远程固件或读取本地测试固件
  → 拆分 128 字节包头与 payload，计算 CRC
  → 建立 FF10 OTA 会话
  → START 0xF1
  → DATA 0xF2（当前代码的 v1.5 变体无包序号，按 PRN 等 ACK）
  → APP 发送 END 0xF3
  → 等待设备最终校验结果
```

本地测试包且设备未连接时会自动 dry-run，只验证文件、编码和分包，不写设备。

## Important Design Decisions

1. **稳定设备身份必须是完整 6 字节 ID。**
   - 后端记录主键只标识绑定记录；
   - 广播 4 字节 ID 只用于候选筛选；
   - 微信 BLE `deviceId` 只是当前手机/会话的临时连接句柄；
   - 名称、尺寸和型号不能单独证明物理身份。

2. **微信 BLE 句柄只存本机。**
   - `utils/device-conn-cache.js` 以完整设备 ID 为键保存本机句柄；
   - iOS UUID 和 Android MAC/随机地址不能跨设备、跨电脑或上传后端复用。

3. **设备是单连接模型。**
   - 连接新设备前释放其他会话；
   - 复用已有会话优先于扫描；
   - 建连中 Promise 去重，避免预热连接和正式连接竞态；
   - 建连后服务发现失败必须主动断开，防止设备被无主连接占住且停止广播。

4. **BoltFox、BoltStar AI、seekink 三个客户端边界分离。**
   - 三者 Base URL、鉴权、响应结构、错误码和重试语义不同；
   - 不应为了“统一”而把 AI 或 seekink 强塞进 `utils/request.js`。

5. **当前投屏 frame 来自 seekink，不来自 BoltFox 的历史 `.bin`。**
   - `setUserProductUpload` 只负责建立和保存投屏记录；
   - 再次投屏和失败重投都重新走预览、seekink 出帧和正常建记录链路；
   - 不恢复 `imgBle` 直传或 `addUserProductImgRecord` 的历史补记分支。

6. **预览是非破坏性编辑。**
   - 每张图片独立保存平移、缩放、旋转和方向；
   - “开始投屏”时才烘焙输出；
   - 竖向构图按设备字段 `verticalRotation` 顺时针旋转导出，**字段缺失即 `0°`（不旋转）**（2026-08-04 起；此前的“固定 `180°`”口径已废止）；
   - 横向构图必须“横向取景、竖向物理画布导出并按设备 `rotationDegree` 旋转”（缺失时 `270°`），不能直接对调设备宽高；
   - 两个方向各取各的字段、绝不互相兜底；`0` 是合法角度，不能用真假值判空；
   - 未编辑图的中心裁切必须与编辑图转同样的角度，否则同设备上两类图方向不一致。

7. **`imgIndex` 是设备图片的物理身份。**
   - 设备只维护 12 字节图片占用掩码，不知道槽位里是哪张业务图片；
   - `imgIndex=0` 合法，不能用真假值判断；
   - 云端记录与设备槽位一旦失配，设备无法凭内容自动修复。

8. **电量采用缓存优先和平滑刷新。**
   - 最近合法值立即展示；
   - 同一设备 15 秒内复用；
   - 超时后保留旧值并后台刷新；
   - 失败时不写假值，从未成功读取才显示 `--`；
   - 与 `0x01` 设备信息读取的策略不同，后者只做在途去重、不做时间缓存。

9. **AI 使用流式 SSE（2026-08-06 起）。**
   - 服务端只推里程碑（5/15/30/45/50/80/85/90/100），中间读数由前端补间（2026-08-07 起）：只增不减、只补到服务端给的目标值、绝不自己往前跑；
   - 进度文案以 `stage` 为准、数值分档兜底（`progress=5` 有两种 `stage`，光看数值分不开），文案跟随已上屏的读数而非尚未爬到的目标；
   - 老基础库降级到非流式 JSON，功能不缺，只是没有预描述和进度；
   - 聊天、生图和上传不做自动重试，避免重复生成、上传或计费；
   - 欢迎语由前端静态展示，不写入服务端历史；
   - 首次真实消息才创建会话，避免空会话；
   - 大写字段网关响应只有固定 `JWTTokenIsMissing` 签名允许生成用户可见提示，并必须带上动态 `RequestId`；其它 `detail` 仍只写日志。

10. **AI 服务协议同意状态按用户和协议版本隔离。**
    - `utils/ai-service-consent.js` 以原始登录用户 ID 为键、当前协议版本 `2026-07-28-v2` 为版本；
    - 缓存缺失、换账号、退出、注销或登录态失效后必须重新同意；
    - 同意校验必须早于会话创建、草稿清空、图片上传和 AI 请求。

11. **折叠屏/分屏适配走公共方案，不各页自创。**（2026-08-05）
    - 样式在 `styles/fold-adapt.wxss`（已由 `app.wxss` 统一 `@import`），JS 在 `utils/fold-adapt.js`；
    - 两种模式：`disableScroll: true` 的页用「一屏高根容器 `.fold-viewport` + `.fold-scroll` 容器滚动」，
      `disableScroll: false` 的页只要根容器别写死高度；
    - 页面高度**只用 CSS 的 `100vh`**，绝不用 `wx.getWindowInfo().windowHeight`
      （tabBar 页会扣掉已隐藏的原生 tabBar，展开态冷启动快照失真）；
    - `.fold-scroll` 必须 `flex: 1 1 0` + `min-height: 0`，写成 `auto` 会把导航栏一起压扁；
    - 固定底栏、弹层、toast 一律留在滚动区**外**；留在外面**又与滚动区重叠**的可点元素
      （设置类页面那摞 `position: absolute` 贴底按钮）必须显式 `z-index ≥ 2`——
      `.fold-scroll` 是 `z-index: 1` 的透明层，缺省层级的按钮会被它盖住，
      表现为「看得见、点不动」（2026-08-05 退出登录/用户注销的线上故障）；
    - 内容搬进 `.fold-scroll-body` 后**父容器由 flex 变成了普通块级**，两条后果都踩过：
      ① 原先靠根容器的 `align-self / align-items` 做水平居中的块会整体贴左（登录页协议勾选行），
      套壳时逐个检查这类居中，一律改成 `margin: … auto`（块级/flex 下都成立）；
      ② **撑满视口的滚动内容块**（写了 `min-height: 100%` / `min-height: calc(100vh - 导航)`）
      必须自成 BFC（`display: flow-root`）或自带 `padding-top`，否则首个子元素的 `margin-top`
      会**穿透出去**变成该块自己的上外边距、把整块下推同样的距离，滚动内容 = 外边距 + 一屏
      → **内容明明装得下也多出一截滚动条**（登录页 376rpx、更新页 276rpx、首页绑定态 56rpx，
      所有机型都有，与折叠无关）；约束由 `tests/fold-scroll-phantom.test.js` 锁住；
    - 手势编辑页（投屏预览）**不套滚动容器**（滚动与拖拽/缩放抢手势、实测矩形会漂移），
      改为根容器 `height: 100vh`（**必须是确定高度**，`min-height` 时 flex 没有剩余空间可分，
      `flex-shrink` 永不生效）+ 舞台 `flex: 1 1 0; min-height: 0` 吃掉剩余高度，其余块 `flex: 0 0 auto`；
      宽高比媒体查询只用来收紧留白（纯观感，正确性不依赖它）；
      `onResize` 作废实测矩形缓存并**强制**重进编辑态（`enterEdit({ remeasure: true })`）。

12. **「我的」页两张卡片的数字各有口径。**（2026-08-05）
    - 「我的相册」= 全部设备的**投屏成功记录条数**（`api.getProjectionSuccessCount`），与该页列表同口径；
    - 「我的设备」= `getUserInfo` 的 `productCount`，缺失才回退设备列表长度；
    - 用户信息里的 `imgCount` 仍解析但不再用于展示（相册口径，含失败/已删，与列表对不上）。

13. **CodeGraph 和 Markdown 分工。**
    - CodeGraph 是当前符号、依赖、调用链和影响范围的来源；
    - Markdown 保存设计原因、协议契约、历史、风险和跨端约束；
    - 不能用归档 Markdown 覆盖当前代码事实，也不能用 CodeGraph 取代决策历史。

## Development Rules

1. 分析架构、依赖、调用链或改动影响前，先执行：

   ```powershell
   codegraph status
   codegraph explore "<问题、文件或符号>"
   ```

2. 拉取代码或发生有意义的代码结构变化后执行：

   ```powershell
   codegraph sync
   codegraph status
   ```

3. `.codegraph/` 永远只保留在本机，不提交到 Git。Git 仓库是办公室、家庭和远程环境之间的唯一事实源。

4. 修改设备相关逻辑时必须保持：
   - 完整 6 字节 ID 校验；
   - 单连接约束；
   - 活动会话优先；
   - 建连失败清理；
   - 不把 BLE 临时句柄写成稳定身份。

5. 修改投屏时必须同时验证：
   - 预览方向和物理导出尺寸；
   - seekink `type`、`BWRYGB` 和抖动模式；
   - frame 长度；
   - CRC、MTU/chunk、窗口 ACK 和重传；
   - `imgIndex=0`；
   - 设备成功与云端记账失败的分支。

6. 修改 OTA 前必须先拿当前固件规范与 `utils/ota-ble.js` 对齐，不能只照现有 `docs/protocols/ota-dfu.md` 改代码。

7. 修改 API 字段时同时检查：
   - `utils/api.js` 入参/出参归一化；
   - `utils/request.js` header 与 query；
   - 页面使用字段；
   - `docs/reference/client-api-matrix.md`；
   - BoltFox Swagger 或后端确认结果。

8. 网络请求语义：
   - BoltFox 普通请求会对网络失败自动重试，包括非幂等请求；
   - 文件上传、AI 聊天和生图不自动重试；
   - 新增有副作用的 POST 前应判断自动重试是否可能造成重复操作。

9. 修改 AI 发送链路时必须保留按用户的协议校验；退出、注销和登录态失效必须在清空
   `userInfo` 前删除当前用户的同意缓存。

10. 页面是否可达以 `app.json` 为准，不要因为目录存在就认为功能已上线。

11. 重要架构、协议、API、安全、性能或一致性变化应更新 `docs/` 中对应长期主文档，并按需新增 `docs/changes/YYYY-MM-DD-topic.md`。

12. 验证顺序：
    - 运行相关 Node 测试和语法/静态检查；
    - BLE、投屏、后台切换、权限、OTA 必须做真机测试；
    - 设备身份至少用两台同型号设备做防串台验证；
    - iOS、Android，以及已知存在特殊后台 BLE 行为的平台分别验证。

## Known Risks

### 高风险代码区域

- `utils/device-ble.js`：连接生命周期、全局 Notify、同命令 pending、MTU、图传窗口和重传集中在一个大模块中。
- `utils/active-device.js`：后端设备记录、完整 ID、广播候选、活动会话和直连缓存交汇处，任何宽松匹配都可能串台。
- `subpackages/projection/preview/preview.js`：手势状态、按张快照、离屏导出和横向旋转耦合；尺寸“看起来相同”仍可能导致设备花屏。
- `subpackages/projection/result/result.js`：网络、图片处理、BLE、进度和异步记账并行，竞态和部分成功分支多。
- `utils/ota-ble.js`：不可逆硬件操作，协议版本、尾包、ACK 时序和断连处理都需要真机确认。
- `subpackages/ai/chat/chat.js`：会话栈、消息、图片、录音、打字机和中止逻辑集中，页面栈变化容易引入状态错乱。
- `utils/request.js`：所有 BoltFox 请求共享，修改错误处理、登录过期或重试会影响整个应用。
- `subpackages/device/debug/debug.js`：硬件调参和内部入口很多，调试参数可能通过 Storage 影响真实投屏。

### 数据一致性风险

- 设备删除成功、后端删除失败会留下幽灵记录，后续槽位复用可能误删新图。
- BLE 投屏成功、后端成功状态或 `imgIndex` 记账失败会留下设备孤儿图片。
- 图传失败后的回滚也可能因断连失败，只能靠一键清空兜底。
- 后端仍需确认同一设备下 `imgIndex` 的唯一性覆盖规则。

### OTA 代码与文档不一致

当前源码与 `docs/protocols/ota-dfu.md` 存在明确差异：

- 源码 `MIN_FW_SIZE = 0x30000`，并注明 v1.5 从旧值 `0x3000` 更正；文档仍写 `0x3000`。
- 源码的 v1.5 DATA 帧不含两字节包序号；文档仍描述 `PKT_INDEX`。
- 源码由 APP 发送 END `0xF3`；文档写成仅设备返回 `0xF3`。

处理原则：以当前固件规范和真机行为确认后，再决定更新代码还是文档。未经确认不要任选一边“修正”另一边。

### 当前可见的配置/资源问题

- `project.config.json` 和 `subpackages/device/ota/ota.js` 引用了
  `docs/BR1601A02_260609_r8122_5139_5D89_V100_OTA.bin`，但该文件当前不存在。
- BoltStar API v1.0.4 本地参考文档尾部有上游文本截断，安全部分不能从旧版本猜补。
- AI 生成图片 URL 有有效期，历史图片能否长期下载或再次投屏不能保证。
- AI 小程序入口已开放；支付/Token 后端接口与官方图库仍未接入。
- `WechatSI` 插件是否已在小程序后台获批：**待确认**。
- seekink token 接口实际返回字段形态仍有兼容解析，最终稳定契约：**待确认**。
- 微信后台 request/upload/download 合法域名、插件权限和隐私配置是否与当前代码一致：**待确认**。
- OTA 是否需要显式最低电量门槛：当前页面会读取并展示电量，但未发现阻断升级的阈值判断，产品/固件要求：**待确认**。
- OTA 最终结果帧布局、重复尾包容忍、不同手机 MTU/Notify/断连行为：仍需真机确认。

### 测试覆盖风险

当前自动测试只覆盖设备 ID、活动会话身份和电量缓存。以下区域没有发现对应自动测试：

- HTTP 响应归一化、登录过期和网络重试；
- 图片预览手势与横向导出；
- seekink 出帧和 frame 长度；
- BLE 图传 ACK/重传；
- 图库设备/云端部分成功；
- OTA 组帧和状态机；
- AI 会话与页面栈。

## Documentation Map

- [`docs/README.md`](docs/README.md)
  - 项目知识地图、文档状态规则、CodeGraph/Markdown 分工和维护流程。
- `docs/architecture/`
  - 当前长期架构知识；
  - 设备身份与连接、图片投屏、照片编辑、AI 客户端。
- `docs/decisions/`
  - 已做出的长期设计选择及其原因；
  - 当前包括 `imgIndex` 和电量缓存策略。
- `docs/protocols/`
  - 外部硬件协议的长期说明；
  - OTA 文档当前与代码有差异，使用前必须核对。
- `docs/reference/`
  - BoltFox 客户端接口矩阵和 BoltStar AI API 版本入口。
- `docs/changes/`
  - 某一日期的重要需求、实现和阶段结果；
  - 用于理解演进，不自动覆盖当前架构文档。
- `docs/archive/`
  - 被取代的设计、排障、性能实验、进度、审查和交接快照；
  - 只能回答历史问题，不能作为当前实现权威来源。
- `AGENTS.md`
  - 根目录 AI 工作规则、跨环境 Git/CodeGraph 约束。
- `AI_CONTEXT.md`
  - 当前项目的快速全景入口；应保持短于所有专题文档之和，并链接而不是复制全部历史。

## AI Working Notes

1. 开始任务时先读 `AGENTS.md`、本文件和 `docs/README.md`，再按领域打开唯一的 current 主文档。
2. 对代码结构和调用链使用 CodeGraph，不手工从文件名猜调用关系。
3. CodeGraph 不索引 JSON/WXML/WXSS/Markdown 时，再直接读取对应配置和文档。
4. 遇到文档与代码冲突时：
   - 记录冲突；
   - 查当前外部契约或真机结果；
   - 不静默把“代码现状”写成“已批准产品规则”。
5. 不要恢复已删除的历史链路：
   - 后端 `.bin` / `imgBle` 直传；
   - 用广播短 ID、设备名或 BLE 句柄认领物理设备；
   - 把 `imgIndex=0` 当空值；
   - 在 release 使用 Mock。
6. 不要把 `selectedDevice.connected` 当作真实连接证明；使用 `active-device` 和活动会话核验。
7. `device-info` 的 `0x01` 与 `battery` 的 `0x04` 缓存策略不同，不要合并成同一种 TTL。
8. AI 图片压缩与投屏图片缩放目标不同：
   - AI 压到目标字节数以减少上传；
   - 投屏缩到设备物理分辨率以保画质和帧布局。
9. BLE/OTA 错误应保留具体来源：
   - 接口错误通常带“接口-”；
   - 设备/BLE 错误通常带“设备-”；
   - 不要把具体权限、扫描、身份或协议错误统一吞成模糊提示。
10. 仓库可能在不同电脑和远程环境修改。不要依赖未提交的本机缓存、BLE 句柄、CodeGraph 数据库或小程序开发工具私有状态。
11. 本文中的“待确认”不得被后续 AI 自动补全为事实；需要代码、官方接口/协议或真机证据后才能改为确认。
