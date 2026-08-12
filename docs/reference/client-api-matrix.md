# 客户端接口矩阵

> 状态：current  
> 最后核对：2026-07-28  
> 适用范围：微信小程序；App/PC 差异仅作接口边界参考  
> 上游权威来源：BoltFox Swagger

当前实现补充：

- `utils/config.js` 当前 `useMock:false`；正式版在 `utils/request.js` 中强制禁用 Mock。
- 小程序邮箱入口、个人信息邮箱行和相关页面路由当前均不可达；接口封装和页面源码仅作备用。
- 再次/重新投屏走正常 seekink 出帧与 `setUserProductUpload` 建记录链路，不再使用历史 `imgBle` 直传。

> 🛠 **维护约定**：每次修改本表涉及的接口/字段，务必在下方「操作日志」补一条（日期 + 改了什么 + 关联文件/commit），**最新在上**——别让文档与代码脱节。

## 操作日志（最新在上）
- **2026-08-08**：**支付体系（Token）由 mock 切到真实后端，微信支付走小程序虚拟支付**。
  新增章节「支付体系（Token）」，接入 `/Client/Order/getUserAccount`、`getGoodsList`、
  `getUserAccountTrade`、`addOrder` 与支付查单（2026-08-11 改为 `/Client/Pay/getPayQuery`）；
  新增 `utils/wx-virtual-pay.js` 封装 `wx.requestVirtualPayment`，`utils/token-api.js` 全量改写
  （`createOrder` → `purchase`，`getRecords` 改为分页返回 `{list,hasMore,pageIndex}`）。
  到账判据是**服务端余额变多**（退避轮询 ~9.4s），不是支付 success 回调。
  记录页补上拉翻页（后端默认一页 10 条，不翻页等于记录只显示第一页）。
  ~~⚠️ `addOrder` 出参还缺 `signData`/`paySig`/`signature`~~ → 2026-08-11 核对：后端已补齐。
  关联：`utils/token-api.js`、`utils/wx-virtual-pay.js`、`subpackages/token/*`、
  `tests/token-pay.test.js`。详见 `docs/changes/2026-08-08-微信虚拟支付对接.md`。Flutter 未同步。
- **2026-08-05**：「我的」页「我的相册」卡片的张数改为**全部设备的投屏成功记录条数**，与该页列表同口径
  （原来取用户信息的 `imgCount`，相册口径，把失败/已删的也算在内，和点进去看到的列表对不上）。
  新增 `api.getProjectionSuccessCount()`：`getUserProductImgRecordList` 带 `deviceUploadState=1`、
  **不带 `userProductId`**；整页都是成功记录时直接采信分页元数据 `recordCount`（一次请求，超一页也不截断），
  后端忽略过滤参数时退回逐页翻 + 按状态计数（判停看 `pageCount`/`recordCount`，同 FAQ 的翻页口径，20 页封顶）。
  `pages/mine/mine.js` 相应把 `getAlbumPhotos()` 换成它。回归用例 `tests/projection-success-count.test.js`。
  详见 `docs/changes/2026-08-05-我的相册计数与全站折叠屏适配.md`。Flutter 同步已实现。
- **2026-07-27**：修复收紧完整 6 字节 ID 后出现的**首页、设备列表、设备详情跨页连接态丢失**
  回归。根因是三个页面重新拉接口/裁剪展示对象时，可能只保留
  `deviceNo`、`productDeviceId`、`firmwareDeviceId` 中的一部分；活动 BLE 会话仍存在，却因页面
  对象缺少预期字段被判成未连接。现统一从以上稳定字段提取完整 ID，页面合并时继承同一
  `userProductId` 的完整身份，连接成功后把 `0x01` 校验值同时回写到三个稳定字段，并继续用完整
  ID 与活动会话精确匹配。任意一个页面连接 A 后，另外两个页面显示 A 时均认领同一会话为
  “已连接”；其他设备仍为未连接，不放开短 ID/名称兜底。关联：`utils/active-device.js`、
  `pages/home/home.js`、`subpackages/device/list/list.js`、
  `subpackages/device/detail/detail.js`、`tests/active-device-identity.test.js`。
- **2026-07-27**：设备列表新增后端设备 ID 展示。`subpackages/device/list/list` 读取
  `/Client/UserProduct/getUserProductList` 返回的 `deviceId`（API 归一化后为
  `productDeviceId`），值非空且通过完整 6 字节校验时在设备名称下方展示；空值不显示、不占位，
  且不使用微信 BLE 临时 `deviceId` 兜底。关联：`subpackages/device/list/list.wxml`、
  `subpackages/device/list/list.wxss`、`utils/api.js`。
- **2026-07-27**：设备身份最终统一为**完整 6 字节 `Device_ID`**。完整 ID 只能来自连接后
  `0x01 GET_INFO` 返回值，并统一为 `AA:BB:CC:DD:EE:FF` 格式；广播中的 4 字节短 ID 和微信
  BLE `deviceId` 仅用于扫描/建立连接，不得展示为“设备ID”、不得传给
  `addUserProduct.deviceId`、不得写入 `productDeviceId/deviceNo` 等稳定身份字段。
  绑定链路和 API 出口均增加完整 ID 硬校验，缺失或长度不符时直接终止绑定，不发送后端请求；
  详情页删除末 6 位截断回退，只在已连接时显示固件/后端的完整 6 字节 ID；设备列表、详情、
  投屏记录及活动会话认领只接受完整 ID。历史后端记录若仍是 4 字节短 ID，将标记为无效身份，
  不再兼容连接，需后端迁移为完整 ID 或删除后重新绑定。关联：
  `utils/device-id.js`、`utils/frame-protocol.js`、`utils/api.js`、`utils/active-device.js`、
  `subpackages/device/bind/bind.js`、`subpackages/device/list/list.js`、
  `subpackages/device/detail/detail.js`、
  `subpackages/projection/records/records.js`、`tests/device-id.test.js`、
  `tests/active-device-identity.test.js`。
- **2026-07-27**：电量最终改为**缓存优先 + 15 秒后台刷新**，覆盖同日“进入页面先清空并每次真读”的方案。
  页面立即展示 `selectedDevice`/Storage 最近一次有效值；15 秒内不重复发送 `0x04 GET_BATTERY`，
  超窗后旧值保持可见并后台读取，成功再替换，失败/非法返回保留旧值，从未读到有效值才显示 `--`。
  同一设备仍共享在途请求以避免 `CMD_PENDING`，日志区分缓存命中、刷新成功和失败回退。关联：
  `utils/battery.js`、`utils/active-device.js`、`app.js`、
  `pages/home/home.js`、`subpackages/device/list/list.js`、`subpackages/device/detail/detail.js`、
  `subpackages/device/ota/ota.js`、`tests/battery.test.js`。详见
  `docs/decisions/battery-cache-and-refresh.md`。
- **2026-07-27**：修复**两台同尺寸设备点击 A 却连接到 B**。根因是扫描广播仅含 4 字节
  `Device_ID`，同批次设备可能短 ID 相同；旧链路用「短 ID + 屏幕尺寸」命中首个候选后直接认领，
  未用 `0x01` 返回的 6 字节完整 ID 二次校验，并会把错误的微信 BLE `deviceId` 写入 A 的直连缓存。
  现改为：广播信息仅筛候选 → 建连后读取完整 ID 严格确认 → 不一致则断开并排除该候选后重扫；
  错误直连缓存自动清除，缓存仅在完整 ID 校验通过后写入。绑定判重、首页/设备列表/详情的状态合并
  同步采用「后端记录主键/完整 ID 优先」，设备自定义名称不参与物理身份判断。列表投屏、预览预连接、
  正式图传、轮播与 OTA 等跳转后的入口也必须重新认领已校验会话，禁止仅凭旧 BLE 句柄在线就继续操作。关联：
  `utils/active-device.js`、`utils/device-conn-cache.js`、`subpackages/device/bind/bind.js`、
  `pages/home/home.js`、`subpackages/device/list/list.js`、`subpackages/device/detail/detail.js`、
  `subpackages/projection/preview/preview.js`、`subpackages/projection/result/result.js`、
  `subpackages/device/slideshow/slideshow.js`、`subpackages/device/ota/ota.js`、
  `tests/active-device-identity.test.js`。
- **2026-07-24**：`GET /Client/Basic/getXTYUserToken` 新增入参 `isNewLogin`（api.js `getXTYUserToken(isNewLogin=0)`）。
  语义：`0`=复用后端已有会话（默认，首取/预热用）；`1`=强制重新登录取新 token。用途：抖动接口
  （`imageDitheringBinDownload`）回 401（形如 `{"msg":"…认证失败，无法访问系统资源","code":401}`，token 过期）时，
  `utils/dithering.js` 先清会话缓存、**带 `isNewLogin=1` 重取一次 token** 再重发出帧请求（否则后端可能把刚过期的
  同一会话原样返回，重试仍 401 死循环）。刷新只做一次防打转，不消耗网络退避重试次数。关联：`utils/api.js`、
  `utils/dithering.js`（`ensureAuthToken(forceNewLogin)`）。仅小程序，Flutter 待同步。
- **2026-07-23**：**再次/重新投屏改走正常投屏链路**（后端已不再生成/返回 `.bin`）：投屏管理页点按钮
  只把记录里的图片地址（优先图库原图，兜底记录 `img`）写进 `pendingProjection`（与手选图片同形态）
  进预览页，点「开始投屏」后照常 seekink 抖动接口出帧 + `setUserProductUpload` 建新记录 +
  `editUserProductImgRecord` 记账。**删除**：records.js 的 `imgBle` 硬门槛与透传、result.js 的
  imgBle 直传分支（`downloadFrameBin`）与 `addRetryRecord` 补记机制、preview.js 的 imgBle 保留判定。
  `addUserProductImgRecord` 小程序侧已无调用方（api.js 方法保留，Flutter 同步前还在用）；
  07-22 风险②「imgBle 与实际投屏内容不一致」随之关闭。仅小程序，Flutter 待同步。
- **2026-07-23**：新增 `GET /Client/Basic/getXTYUserToken`（api.js `getXTYUserToken`）——获取 seekink
  抖动接口的访问 token，替代 `utils/dithering.js` 写死的联调 token；用法 `Authorization: Bearer+空格+token`。
  调用策略：**会话级内存缓存**（本次启动首次要用时取一次、整程复用，不落 Storage）、投屏预览页 onLoad
  **前置预热**（`dithering.prefetchAuthToken`，与预热设备连接同理）、抖动接口回 401/token 类报错时
  清缓存**自动刷新重试一次**。⚠️返回字段形态（data 即 token 串或包在 `token/xtyToken` 等字段）为假设待联调确认
  （兼容解析在 dithering.js `normalizeAuthToken`）。仅小程序，Flutter 待同步。
- **2026-07-22**：投屏设备帧改由**第三方 seekink 抖动接口**生成（`POST https://cloud.seekink.cn:8443/prod-api/api/v1/label/imageDitheringBinDownload`，form-data：`color=BWRYGB`/`imageDitheringModes=2`/`type`(0=5.8寸大设备、1=3.7寸小设备)/`file=设备分辨率图`；请求头 `Authorization`(⚠️暂写死联调 token)+`AcceptLanguage=en`；响应体即二进制 .bin，封装在 `utils/dithering.js`）。`setUserProductUpload` 改为**上传原图（进预览页前未操作过的图）只为建投屏记录**（拿 `taskId/upirId`，图库/记录页展示用），其返回的 `url`(.bin) 客户端**不再下载使用**；两路上传共用 result.js `compressForUpload` 统一压缩。设备图传成功后 `editUserProductImgRecord` 置成功的记账逻辑不变。仅小程序，Flutter 待同步。见 `docs/archive/designs/server-image-processing-ble-transfer.md` 操作日志。
- **2026-07-19**：操作指南**详情内容按富文本渲染**。`faqContent` 后端可能给三种形态——转义 HTML（`&lt;p&gt;`）、原始 HTML（含 `section` 等 rich-text 不支持的标签）、纯文本（只有 `\n`）——原来直接丢给 `<rich-text nodes>`，分别表现为「标签当文字显示」「整块内容消失」「全挤成一行」。新增 `utils/rich-html.js` 统一归一：解转义 → 丢 `script/style` → 不支持的块级标签降级为 `div` → 图片补 `max-width:100%` → 段落补间距 → 纯文本按换行拆 `<p>`；末了包一层带内联 style 的 div（**rich-text 的外部 class 不作用于内部节点**，字号/行高/颜色只能内联）。落点 `subpackages/settings/guide/guide.js`（列表与详情两处入口都过一遍）。
- **2026-07-19**：操作指南 `getProductFaqList` 改为**全量翻页读取**（按 `recordCount`/`pageCount` 判停，**不再用「返回条数 < 请求 pageSize」**——后端可能无视 pageSize 按默认 10 条分页，那样第一页就停、只能拿到 10 条）。同时明确：Client 侧接口无 `productId`，**不做设备过滤**；权重 `grade` 只在后台 DTO，**排序归后端**，前端不重排。落点 `subpackages/settings/guide/guide.js`；语种收口到新增的 `utils/language.js`（语种设置页原本不落盘，选了等于没选）。详见 `flutter/docs/2026-07-19-faq-guide-round.md`。
- **2026-07-18**：新增设备槽位索引字段 `imgIndex`（String，0 合法）。入参：`editUserProductImgRecord`、`addUserProductImgRecord`（再次/重新投屏链路，需后端确认是否已加）；出参：`getUserProductImgList`（图库）、`getUserProductImgRecordList`（投屏记录）。图库「删除图片」「刷新屏幕」改按该索引定位设备物理位置。方案、待确认项与已知问题见 `docs/decisions/image-slot-index.md`。
- **2026-07-17**：`setUserProductUpload` 行补「⚠️后端按上传图像素出帧、`targetWidth/targetHeight` 未消费、上传图须已是设备物理分辨率」实况注。见 memory `projection-upload-must-be-device-resolution`。

> 来源：产品提供的《接口清单02.png》 + 后端 Swagger（https://api.boltfox.cn/swagger-ui.html）对照整理。
>
> 适用系统：`App IOS` / `App Android` / `小程序`。本表以页面功能为主线，标注每个功能对应的后端接口，并区分 **小程序** 与 **App** 的接入差异。
>
> 小程序适配规则：
> - 登录走 **微信授权一键登录**，不接入邮箱登录/注册/找回密码等接口与页面。
> - App 版本更新、安卓下载、PC 注销等平台专属接口不接入。
> - 公共参数 `device` / `terminal`（小程序 `=3`）/ `language` / `userToken` 通过 headers 传递。
> - 接入状态：✅ 已接入（`utils/api.js`） · ⏳ 接口已就绪待页面联调 · ⛔ 小程序跳过 · ➖ 无对应接口（纯前端/端能力）

## 基础公共

| 二级 | 三级 | 接口 | 小程序 | api.js 方法 | 备注 |
| --- | --- | --- | --- | --- | --- |
| 邮箱发送 | 未登录 | `POST /Client/Basic/sendEmail` | ✅ | `sendEmail` | 验证码 10 分钟有效 |
| 邮箱发送 | 已登录 | `POST /Client/Basic/sendEmailToken` | ✅ | `sendEmailToken` | 已登录用户传 userToken |
| app版本 | 获取 App 版本更新状态 | `GET /Client/Basic/getLastVersion` | ⛔ | - | App 专用 |
| app版本 | 安卓新版下载（看实际情况） | `GET /Client/Basic/getAndroidDownload` | ⛔ | - | 安卓 App 专用 |
| 获取基础数据 | 配置/字典等（看实际情况） | `GET /Client/Basic/getBasicData` | ✅ | `getBasicData` | 按需取用 |
| 文件上传 | 基础上传（无关业务） | `POST /Client/Basic/setFileUpload` | ✅ | `setFileUpload` | form-data，字段名 `fileParam`，如头像等通用文件 |
| 文件上传 | BLE 图片转换上传 | `POST /Client/Basic/setUserProductUpload` | ✅ | `setUserProductUpload` | form-data 上传原图，带 `targetWidth/targetHeight`，后端转换帧并存 OSS，返回 `url/taskId/upirId`。**2026-07-22 起客户端只用它建投屏记录（传「进预览页前的原图」，拿 `taskId/upirId`）**，返回的 `url`(.bin) 不再下载——设备帧改由 seekink 抖动接口生成（`utils/dithering.js`）。（2026-07-23 定夺：后端不再生成/返回 .bin，`imgBle` 直传链路已在端上删除，再次投屏改走正常链路，见 07-23 操作日志。）旧实况注(2026-07-17，后端按上传图像素出帧)仍适用于它自己的转码 |
| 投屏记录 | 编辑投屏记录 | `POST /Client/UserProduct/editUserProductImgRecord` | ✅ | `editUserProductImgRecord` | 设备图传成功后置 `deviceUploadState:1`，body 传 `upirId/taskId/deviceUploadState/imgIndex`。`imgIndex`(String，**0 合法**)=这张图写入设备的物理槽位，供图库删除/刷屏定位，见 `docs/decisions/image-slot-index.md` |

## 首页

| 二级 | 三级 | 接口 | 小程序 | api.js 方法 | 备注 |
| --- | --- | --- | --- | --- | --- |
| 拍照 | - | ➖ | ✅ | - | 调用手机相机拍照 → 处理图片 → 投屏流程 |
| 相册 | - | ➖ | ✅ | - | 调用手机相册选择 → 处理图片 → 投屏流程 |
| 用户权限 | - | ➖ | ✅ | - | 位置、蓝牙、相册权限 |
| 搜索设备 | 拉取后端产品列表 | `GET /Client/Product/getProductList` | ✅ | `getProductList` | 配合蓝牙搜索 |
| 绑定设备 | 绑定设备 | `POST /Client/UserProduct/addUserProduct` | ✅ | `addUserProduct` | `deviceId` 必须是连接后 `0x01` 返回的完整 6 字节 ID（统一 `AA:BB:CC:DD:EE:FF`）；禁止广播 4 字节短 ID 或微信 BLE deviceId |
| 投屏流程 | - | ➖ | ✅ | - | 选图 → 选设备 → 预览（预处理尺寸）→ 确认投屏；内存已满提示清理/联系相册所有者 |
| 设备选择 | - | ➖ | ✅ | - | 切换连接设备 |

## 我的

| 二级 | 三级 | 接口 | 小程序 | api.js 方法 | 备注 |
| --- | --- | --- | --- | --- | --- |
| 登录\注册-小程序 | 微信授权登录/绑定手机号 | `POST /Client/User/setWechatAppLogin` | ✅ | `setWechatAppLogin` | 一键登录返回登录 token |
| 登录\注册-app | 邮箱验证码注册\登录 | `POST /Client/User/userRegister`、`POST /Client/User/userLogin` | ⛔ | - | App 邮箱登录/注册，小程序不接入 |
| 个人信息 | 昵称、头像、ID | `GET /Client/User/getUserInfo` | ✅ | `getUserInfo` | 获取用户信息 |
| 个人信息 | 拉取微信昵称头像-小程序 | ➖ | ✅ | - | 小程序端能力获取微信头像昵称 |
| 个人信息 | 昵称/头像自定义编辑、上传 | `POST /Client/User/changeNickName`、`POST /Client/User/changeAvatar` | ✅ | `changeNickName`、`changeAvatar` | 昵称 1-10 字；头像可先经 `setFileUpload` 取地址 |
| 个人信息 | 绑定/修改邮箱 | `POST /Client/User/changeUserEmail` | ⛔ | `changeUserEmail`（封装保留） | 当前小程序不暴露邮箱入口：个人信息邮箱行已隐藏，bind/change-email 页面未注册路由。页面源码和接口封装仅作备用 |
| 个人信息 | 忘记密码（未登录） | `POST /Client/User/resetPassword` | ⛔ | - | 邮箱账号找回密码 |
| 个人信息 | 修改密码 | `POST /Client/User/changePassword` | ⛔ | - | 邮箱账号密码体系 |
| 个人信息 | 用户注销 PC 版 | `POST /Client/User/userOffPC` | ⛔ | - | PC 版接口 |
| 我的相册 | 相册列表/删除（支持多选） | `GET /Client/UserProduct/getUserProductImgRecordList`、`GET /Client/UserProduct/getUserProductImgList`、`POST /Client/UserProduct/delUserProductImg`、`POST /Client/UserProduct/delUserProductImgRecord` | ✅ | `getProjectionRecords`、`getAlbumPhotos`、`deleteAlbumPhotos`、`deleteProjectionRecords` | **2026-08-10 起**：删除只取**该条投屏记录自己的** `imgIndex`（下午修订，此前经 `uProductImgId` 关联图库照片、只认图库列表那份），转成固定 12 字节 `IMG_INDEX_MASK` 后发设备 `0x12`；不推算缺失索引。**同日下午补**：发 `0x12` 前读一次 `0x01` 的 `IMG_MASK`，设备上已经没有的槽位跳过（另一部手机删过图时本机列表还留着那条记录，一起下发会被固件回 `0x07` 打回整批），`0x05`/`0x07` 结果码也按「设备侧本来就没有」放行；设备侧无论跳过还是删成功，来源投屏记录一律删；中间的 `delUserProductImg`（删图库相册记录）**同日起暂时屏蔽**，代码保留在 `confirmDeleteSelected` 第 4 步 |
| 我的（首屏统计） | 「我的相册」卡片的张数 | `GET /Client/UserProduct/getUserProductImgRecordList` | ✅ | `getProjectionSuccessCount` | **2026-08-05 起**：全部设备的投屏成功记录条数（`deviceUploadState=1`、不带 `userProductId`），与「我的相册」列表同口径，不再用 `getUserInfo` 的 `imgCount`。整页均为成功记录时取分页元数据 `recordCount`（一次请求即真实总数）；后端忽略过滤参数时逐页翻并按状态计数，20 页封顶 |
| 我的设备 | 设备连接流程 | ➖ | ✅ | - | 稳定设备身份一律为 `0x01` 返回的完整 6 字节 ID；广播 4 字节短 ID + 尺寸仅用于筛选候选。连接后必须用完整 ID 严格确认，校验通过后才认领会话并写直连缓存。身份不一致时断开、排除错误候选并重扫，同时清理被污染的缓存。设备自定义名称不作为物理身份依据（2026-07-27） |
| 我的设备 | 设备列表（设备图、名称、设备 ID） | `GET /Client/UserProduct/getUserProductList` | ✅ | `getUserProductList` | 接口 `deviceId` 非空且为完整 6 字节时展示，空值不显示；页面字段为 `productDeviceId`，避免与微信 BLE 临时句柄混淆 |
| 我的设备 | 设备详情 | `GET /Client/UserProduct/getUserProductDetail` | ✅ | `getUserProductDetail` | 出参含投屏导出旋转角：`rotationDegree`(横向构图，缺失回退 `270°`) 与 **`verticalRotation`(竖向构图，2026-08-04 新增，缺失即 `0°`=不旋转)**。两者各管一个取景方向、互不兜底；`0` 是合法值。列表接口同样透传（`normalizeDevice` 全量展开），首页展示模型需手动透传这两个字段 |
| 我的设备 | 设备电量 | ➖ | ✅ | - | 缓存优先：最近一次有效值跨页/落盘保留，同一设备 15 秒内复用；超窗后台发送 BLE `0x04 GET_BATTERY`，旧值持续展示，成功后平滑替换，失败/非法值保留旧值，从未成功读取才显示 `--`（2026-07-27 最终口径） |
| 我的设备 | 设备名称编辑 | `POST /Client/UserProduct/editUserProduct` | ✅ | `editUserProduct` | - |
| 我的设备 | 删除设备 | `POST /Client/UserProduct/delUserProduct` | ✅ | `delUserProduct` | id=userProductId |
| 我的设备 | 一键清空（格式化设备） | `POST /Client/UserProduct/clearUserProductImg` | ✅ | `clearUserProductImg` | 后端文档口径是「一键删除我的图库」，端上**保持调它不变**。**2026-08-10 后端确认**：这一次调用会由后端**同步删掉该设备的投屏记录**（不只是图库照片）。名字与实际影响面有差：「我的相册」渲染的是投屏成功记录，所以一键清空后相册随之清空，不会留幽灵条目；端上仍先发设备 `0x12` 全删，再调本接口 |
| 我的设备 | 开启\关闭轮播模式 | ➖ | ✅ | - | 顺序/随机轮播、关闭轮播；纯设备控制 |
| 我的图库 | 列表 | `GET /Client/UserProduct/getUserProductImgList` | ✅ | `getUserProductImgList` | 2026-08-04 起不再直接渲染；2026-08-10 下午起**删除也不再读它的 `imgIndex`**（实测该字段不稳定回传，索引改取投屏记录那份），现仅作「我的相册」的原图来源与默认设备判断依据 |
| 我的图库 | 删除 | `POST /Client/UserProduct/delUserProductImg` | ✅ | `delUserProductImg` | id=uProductImgId，支持多选。删除前先按 `imgIndex` 发 BLE `0x12` 删掉设备对应槽位 |
| 投屏管理 | 投屏记录图片列表（成功/失败） | `GET /Client/UserProduct/getUserProductImgRecordList` | ✅ | `getUserProductImgRecordList` | **Swagger 新增**。出参含 `imgIndex`(String)，记录页本身不消费，仅排查用。2026-08-04 起「我的相册」也用它（只取成功、按 `userProductId` 分类）；投屏记录页保留，入口改为投屏结果页「投屏明细」 |
| 投屏管理 | 新增投屏记录（历史接口） | `POST /Client/UserProduct/addUserProductImgRecord` | ➖ | `addUserProductImgRecord`（无调用方） | 小程序已删除 `imgBle` 直传和补记链路；再次/重新投屏统一走正常投屏流程，由 `setUserProductUpload` 建立新记录 |
| 投屏管理 | 操作：投屏\删除 | `POST /Client/UserProduct/delUserProductImgRecord` | ✅ | `delUserProductImgRecord`、`deleteProjectionRecords` | id=upirId，**Swagger 新增**。批量版 `deleteProjectionRecords` 串行逐条调用（后端无批量接口），供「我的相册」删照片时连同来源记录一并删。**级联问题（2026-08-04 挂起）已部分有结论**：`clearUserProductImg`（一键清空）后端**会**同步删投屏记录（2026-08-10 确认），一键清空链路无需端上再删记录；`delUserProductImg` 是否级联仍**待后端确认**，但该调用自 2026-08-10 起已在相册删除链路屏蔽（见 144 行），暂时不影响 |
| 操作指南 | 查看帮助文档（**不分设备，全局**） | `GET /Client/Product/getProductFaqList` | ✅ | `getProductFaqList` | 详情 `getProductFaqDetail`；按 `pageCount`/`recordCount` 翻页**全量**读取；Client 侧接口无 productId 参数，不做设备过滤；权重 `grade` 只在后台 DTO，排序由后端负责，前端不重排；随 `language` 走（2026-07-19） |
| 设置 | 关于我们/联系方式/隐私政策/用户协议 | ➖ | ✅ | - | 静态页面 |
| 设置 | 语种设置（简中\繁中\英\日） | ➖ | ✅ | - | 小程序默认中文；App 跟随手机语言（其他默认英语） |
| 设置 | 退出登录 | `POST /Client/User/loginOut` | ✅ | `loginOut` | - |
| 设置 | 用户注销 | `POST /Client/User/userOff` | ✅ | `userOff` | - |

## 支付体系（Token）

小程序端的「微信支付」= **小程序虚拟支付**（`wx.requestVirtualPayment`）。Token 是虚拟商品，
普通微信支付（`wx.requestPayment` / JSAPI prepay）不适用于这类商品，两条链路不要混。
客户端封装：`utils/token-api.js`（业务）+ `utils/wx-virtual-pay.js`（拉起支付）。

| 二级 | 三级 | 接口 | 小程序 | token-api.js 方法 | 备注 |
| --- | --- | --- | --- | --- | --- |
| Token管理 | 账户概览 | `GET /Client/Order/getUserAccount` | ✅ | `getAccount` | 出参 `availableToken`/`totalToken`/`consumeToken` 均为 **String**，端上归一为数字 `balance`/`totalPurchased`/`totalSpent` |
| AI 助手 | 能否发起 AI 对话 | `GET /Client/Order/chkAiDialogue` | ✅ | `checkAiDialogue` | 2026-08-12 新增。无入参（用户由公共参数 `userToken` 带出）。⚠️ **两种答复不对称**（真机实测）：可以发＝`retCode 200` + `retData true`；**不能发＝`retCode 403`** + `retMsg"token余额不足，需要最低余额：30.0 token"` + `retData null`，即否定答复走 request.js 的**失败**分支 —— 只认 `retData===true` 会把 403 当成「接口挂了」而放行。端上封装成 `aiToken.canDialogue()` → `{allowed, required, message}`（`required` 从 retMsg 抠数字，供页面拼「至少需要 30 星币」），聊天页每次发送前调一次；⚠️ **除 403 外的失败一律放行**（读不到判据就锁死 AI 是更糟的失败模式，`/chat` 侧服务端会再拒一次）。它取代了端上按余额比大小的老闸（`LIMIT_ENABLED`/`hasBalance` 已删除） |
| Token管理 | 商品（套餐）列表 | `GET /Client/Order/getGoodsList` | ✅ | `getPackages` | 出参 `goodsId`/`num`/`giveNum`/`amount`/`wxProductId`/`appleProductId`。`wxProductId` 即微信侧道具 id，**由服务端签进 signData**，端上不直接使用。`unitPrice`(integer) 端上不用，单价按「含赠送总数」自算 |
| Token管理 | 购买 & 消费记录 | `GET /Client/Order/getUserAccountTrade` | ✅ | `getRecords` | `inOutType` 1=购买 2=消费；分页 `pageIndex`/`pageSize`，判停优先 `pageCount`。出参**无主键**，wx:key 由端上按「类型+页码+下标」拼 |
| 确认购买 | 创建订单 | `POST /Client/Order/addOrder` | ✅ | `addOrder` | 入参 `goodsId` + `payType`(1=微信支付 2=IOS内购 3=payPal)；`device`/`terminal`/`language`/`userToken` 走 header。出参 `amount`/`orderId`/`orderNo` + **`signData`/`paySig`/`signature`**（2026-08-11 核对：后端已补齐，08-08 记的缺口关闭） |
| 确认购买 | 拉起支付 | `wx.requestVirtualPayment`（端能力） | ✅ | `purchase` | 只传微信文档列出的 `mode`/`signData`/`paySig`/`signature`；`env`、`offerId`、`productId`、`outTradeNo` 都在 signData 内 |
| 确认购买 | 查支付侧订单 | `GET /Client/Pay/getPayQuery` | ✅ | `queryPayOrder` | 兜底用：余额轮询超时后查一次。入参 `payType` + **`orderNo`（我们平台的订单号）**，出参 `payState`/`payNo`/`exceptionMsg`。⚠️ 2026-08-11 核对：原先调的 `getWxVirtualPayQueryOrder` **在当前 swagger 里已不存在**，字段也由 `payStatus` 改名 `payState`；`payState` 的枚举文档未给，端上沿用「1=已支付」判定，待后端明确 |
| — | 虚拟支付-扣减代币 | `POST /Client/Pay/setWxVirtualPay` | ⛔ | - | 代币模式（`short_series_coin`）的**服务端**接口，端上不调 |
| — | 虚拟支付-余额/取消/退款 | `GET /Client/Pay/getWxVirtualPayBalance`、`POST /Client/Pay/setWxVirtualPayCancel`、`POST /Client/Pay/setWxVirtualPayRefund` | ⛔ | - | 服务端/客服侧使用 |
| — | Apple Pay 三件套 | `/Client/Pay/setApplePayVerify*`、`getApplePayQuery*` | ⛔ | - | iOS APP 内购专用，属 Flutter 端 |
| — | 用户信息 / 登录 | `GET /Client/User/getUserInfo`、`POST /Client/User/setWechatAppLogin` | ✅ | `api.getUserProfile` / `app.applyWechatSession` | 出参新增 **`availableToken`(String，可用 Token 数)**：「我的」页与 AI 模块直接取它，不必再固定打一次 `getUserAccount`。⚠️ 端上按 `null`=未下发 / `0`=真的没余额 区分，缺失才回退查账户 |

✅ **2026-08-11 已关闭**：`addOrder` 的出参 `ClientAddOrderApiOut` 现已包含
`signData` / `paySig` / `signature`（连同 `amount`/`orderId`/`orderNo`）。这三个值只能服务端算——
`paySig` 要虚拟支付 `appKey`、`signature` 要 `session_key`，都是服务端秘密：

```
paySig    = hex(hmac_sha256(appKey,      'requestVirtualPayment&' + signData))
signature = hex(hmac_sha256(session_key, signData))

`signData` 必须把**服务端签名时用的那个字符串**原样下发（端上重新序列化会因键顺序/空格差异导致微信回 `-15005`）。
端上已按「平铺或包一层（`payParams`/`payData`/`virtualPay`…）都认」解析，后端就位后无需再改客户端；
在那之前走到支付这步会抛 `ORDER_PAY_PARAMS_MISSING`。

## 官方图库（`/Client/Product/*`）

2026-08-12 由本地 mock 切到真实后端（接口清单 `assets/图库接口地址清单.png`）。
客户端封装：`utils/gallery-api.js`；页面 `subpackages/gallery/{list,detail,favorites}`。

| 二级 | 接口 | 小程序 | gallery-api.js 方法 | 备注 |
| --- | --- | --- | --- | --- |
| 分类 | `GET /Client/Product/getImgCategory` | ✅ | `getCategories` | 出参 `categoryId`(int)/`categoryName`。**没有「全部」**——端上补一项 `id:''` 放在首位（列表接口的 `categoryId` 可选，不传即全部）。`id` 归一为字符串（页面比对 + 进 URL），提交时仍是数字 |
| 图库列表 | `GET /Client/Product/getProductImgList` | ✅ | `getPhotos` | 分页 `pageIndex`/`pageSize`(+`categoryId`/`keyword`/`startDate`/`endDate`)，出参 `BasePageOutput<ClientProductImgApiOut>`：`productImgId`/`title`/`img`/`imgThumb`。判停优先 `pageCount`。⚠️ **无图片宽高/比例**、**无收藏态**，端上兜底见下 |
| 图库详情 | `GET /Client/Product/getProductImgDetail` | ✅ | `getPhotoDetail` | 入参 `id`＝`productImgId`。出参 `content`(简介，**不叫 desc**)/`img`/`title`/`isAlreadyCollected`(**0/1，不是布尔**)/`productSizeList`+`productSizes`（「适用设备尺寸」，2026-08-12 已按产品要求从页面去掉，字段仍解出备用）。**这是唯一直接给收藏态的接口** |
| 收藏/取消 | `POST /Client/Product/setImgCollected` | ✅ | `toggleFavorite` | 入参只有 `productImgId`（同一接口来回切）。⚠️ 出参 `BaseOutput<boolean>` 的布尔**语义未定**（「操作是否成功」还是「切换后的收藏态」文档没写），端上一律按**取反当前态**推新状态，原值只打日志 |
| 收藏列表 | `GET /Client/Product/getProductImgCollectionList` | ✅ | `getFavorites` / `getFavoriteIds` | 分页，项与图库列表同结构（按定义都是已收藏）。`getFavoriteIds` 拉一页（200 条）只取 id，用于给图库列表标记收藏态 |

⚠️ **两处后端缺口，端上正在兜**（补齐后端上兜底即可删，见 `utils/gallery-api.js` 文件头）：

1. `ClientProductImgApiOut` **没有图片宽高/比例**。瀑布流必须在渲染前占好高度（否则图陆续到达时
   把下方卡片一路顶走），现在按默认 3:4 占位、图片 `bindload` 后按真实宽高校正**那一张**。
   请后端补 `width`/`height` 或 `ratio`（端上两种写法都已认）。
2. `ClientProductImgApiOut` **没有收藏态**（只有详情有 `isAlreadyCollected`）。图库列表右上角的红心
   要按收藏态显示实心/描边，现在另拉一页收藏列表在端上标记，等于每次进图库多一个请求。
   请后端给列表项补 `isAlreadyCollected`。

## 小程序跳过清单（仅 App/PC 适用）

| 接口 | 摘要 | 跳过原因 |
| --- | --- | --- |
| `GET /Client/Basic/getLastVersion` | 获取 App 版本更新状态 | App 专用 |
| `GET /Client/Basic/getAndroidDownload` | 安卓下载 | 安卓 App 专用 |
| `POST /Client/User/userLogin` | 用户登录-邮箱 | 小程序走微信一键登录 |
| `POST /Client/User/userRegister` | 用户注册-邮箱 | App 邮箱注册 |
| `POST /Client/User/changePassword` | 修改密码（已登录） | 邮箱账号密码体系 |
| `POST /Client/User/chkUserEmailNotExist` | 校验邮箱是否不存在 | 邮箱注册流程相关 |
| `POST /Client/User/resetPassword` | 忘记密码-重置密码（未登录） | 邮箱账号找回密码 |
| `POST /Client/User/userOffPC` | 用户注销 PC 版 | PC 版接口 |

## 与上一版清单的差异（Swagger 新增）

- `GET /Client/Basic/getBasicData`、`POST /Client/Basic/setFileUpload`：基础公共补充。
- `GET /Client/UserProduct/getUserProductImgRecordList`、`POST /Client/UserProduct/delUserProductImgRecord`：投屏管理（投屏记录列表/删除），上一版进度文档未覆盖，本次已接入。

## 2026-06-16 Swagger 复核

- 实时 Swagger `/v2/api-docs` 中小程序相关 `/Client/...` 路径仍为 33 个，未发现新增路径或 HTTP 方法变化。
- Swagger 当前把公共参数 `device` / `terminal` / `language` / `userToken` 标为 query；`utils/request.js` 已同时写入 query 与 header，兼容旧约定与当前标注。
- 用户真实页面已从旧 mock 方法切到 `/Client/...` 兼容层：设备列表/详情/绑定/删除/重命名、我的图库、投屏记录、用户信息、头像昵称、退出/注销、操作指南均已接入真实接口。
- 硬件调试台中的可用户化能力已接入真实页面：扫描连接、读设备信息/电量、设置轮播、真实图传、图传后刷新屏幕、一键清空设备图片。连接间隔手动调试、彩条测试图、16 进制日志仍保留在调试台，不进入用户页面。
