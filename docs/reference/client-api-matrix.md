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
| 我的相册 | 相册列表/删除（支持多选） | `GET /Client/UserProduct/getUserProductImgList`、`POST /Client/UserProduct/delUserProductImg` | ✅ | `getUserProductImgList`、`delUserProductImg` | 仅显示成功上传至设备的照片；删除仅删本人上传，不删云照片 |
| 我的设备 | 设备连接流程 | ➖ | ✅ | - | 稳定设备身份一律为 `0x01` 返回的完整 6 字节 ID；广播 4 字节短 ID + 尺寸仅用于筛选候选。连接后必须用完整 ID 严格确认，校验通过后才认领会话并写直连缓存。身份不一致时断开、排除错误候选并重扫，同时清理被污染的缓存。设备自定义名称不作为物理身份依据（2026-07-27） |
| 我的设备 | 设备列表（设备图、名称、设备 ID） | `GET /Client/UserProduct/getUserProductList` | ✅ | `getUserProductList` | 接口 `deviceId` 非空且为完整 6 字节时展示，空值不显示；页面字段为 `productDeviceId`，避免与微信 BLE 临时句柄混淆 |
| 我的设备 | 设备详情 | `GET /Client/UserProduct/getUserProductDetail` | ✅ | `getUserProductDetail` | - |
| 我的设备 | 设备电量 | ➖ | ✅ | - | 缓存优先：最近一次有效值跨页/落盘保留，同一设备 15 秒内复用；超窗后台发送 BLE `0x04 GET_BATTERY`，旧值持续展示，成功后平滑替换，失败/非法值保留旧值，从未成功读取才显示 `--`（2026-07-27 最终口径） |
| 我的设备 | 设备名称编辑 | `POST /Client/UserProduct/editUserProduct` | ✅ | `editUserProduct` | - |
| 我的设备 | 删除设备 | `POST /Client/UserProduct/delUserProduct` | ✅ | `delUserProduct` | id=userProductId |
| 我的设备 | 一键清空（格式化设备） | `POST /Client/UserProduct/clearUserProductImg` | ✅ | `clearUserProductImg` | 同步删除“我的相册”和设备内照片 |
| 我的设备 | 开启\关闭轮播模式 | ➖ | ✅ | - | 顺序/随机轮播、关闭轮播；纯设备控制 |
| 我的图库 | 列表 | `GET /Client/UserProduct/getUserProductImgList` | ✅ | `getUserProductImgList` | 出参含 `imgIndex`(String，设备槽位索引，0 合法)：图库删除/刷新屏幕据此定位设备位置 |
| 我的图库 | 删除 | `POST /Client/UserProduct/delUserProductImg` | ✅ | `delUserProductImg` | id=uProductImgId，支持多选。删除前先按 `imgIndex` 发 BLE `0x12` 删掉设备对应槽位 |
| 投屏管理 | 投屏记录图片列表（成功/失败） | `GET /Client/UserProduct/getUserProductImgRecordList` | ✅ | `getUserProductImgRecordList` | **Swagger 新增**。出参含 `imgIndex`(String)，记录页本身不消费，仅排查用 |
| 投屏管理 | 新增投屏记录（历史接口） | `POST /Client/UserProduct/addUserProductImgRecord` | ➖ | `addUserProductImgRecord`（无调用方） | 小程序已删除 `imgBle` 直传和补记链路；再次/重新投屏统一走正常投屏流程，由 `setUserProductUpload` 建立新记录 |
| 投屏管理 | 操作：投屏\删除 | `POST /Client/UserProduct/delUserProductImgRecord` | ✅ | `delUserProductImgRecord` | id=upirId，**Swagger 新增** |
| 操作指南 | 查看帮助文档（**不分设备，全局**） | `GET /Client/Product/getProductFaqList` | ✅ | `getProductFaqList` | 详情 `getProductFaqDetail`；按 `pageCount`/`recordCount` 翻页**全量**读取；Client 侧接口无 productId 参数，不做设备过滤；权重 `grade` 只在后台 DTO，排序由后端负责，前端不重排；随 `language` 走（2026-07-19） |
| 设置 | 关于我们/联系方式/隐私政策/用户协议 | ➖ | ✅ | - | 静态页面 |
| 设置 | 语种设置（简中\繁中\英\日） | ➖ | ✅ | - | 小程序默认中文；App 跟随手机语言（其他默认英语） |
| 设置 | 退出登录 | `POST /Client/User/loginOut` | ✅ | `loginOut` | - |
| 设置 | 用户注销 | `POST /Client/User/userOff` | ✅ | `userOff` | - |

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
