# API Integration Progress

> 🛠 **维护约定**：每次修改本文件涉及的问题/功能，务必在下方「操作日志」补一条（日期 + 改了什么 + 关联文件/commit），**最新在上**——别让文档与代码脱节。

## 操作日志（最新在上）
- **2026-07-18**：个人信息页邮箱行整行隐藏（用户要求），同步把「用户接口」下 `goEmail()` 那条已失效说明划掉并注明现状；`api.js` 的 `sendEmail`/`changeUserEmail` 封装仍保留无调用方。关联 `subpackages/settings/profile/*`、`docs/代码审查修复清单-2026-07-16.md`。
- **2026-07-17**：`setUserProductUpload` 参数参考补「⚠️`targetWidth/targetHeight` 后端目前未消费、上传图须已是设备物理分辨率」实况注（配合 `preview.js` 导出改到设备分辨率的投屏失败修复）。见 memory `projection-upload-must-be-device-resolution`。

接口文档：https://api.boltfox.cn/swagger-ui.html#/

后端地址：https://api.boltfox.cn

当前项目：微信小程序

## 对接规则

- 只对接用户前端模块：产品接口、基础功能接口、用户接口、设备接口。
- 当前为微信小程序，接口名、摘要或语义涉及 `APP` / `App` / `app` 的接口先不接入小程序。
- `/Client/User/userLogin`（用户登录-邮箱）不接入小程序。
- Swagger 当前把公共参数 `device`、`terminal`、`language`、`userToken` 标为 query；`utils/request.js` 已同时写入 query 与 header，兼容旧约定与当前 Swagger 标注；小程序 `terminal=3`。
- BoltFox 响应格式为 `retCode/retMsg/retData`，`retCode=200` 表示成功。
- 现阶段保留 `config.useMock=true`，避免未完成模块影响现有页面；已接入真实服务的方法在 `utils/api.js` 里通过 `mock:false` 单独请求真实接口。
- 当前真实产品接口未携带有效 `userToken` 时会返回 `retCode=406`（请重新登录）；用户模块完成真实登录接入后才能完整联调产品数据。

## 模块进度

| 模块                  | 状态       | 代码位置                                                                                                                                                 | 说明                                                                                                    |
| --------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 用户前端-产品接口     | 已完成     | `utils/api.js`                                                                                                                                           | 本模块 3 个接口均接入                                                                                   |
| 用户前端-基础功能接口 | 已完成     | `utils/api.js`、`utils/request.js`                                                                                                                       | App 版本/安卓下载接口跳过；邮箱验证码、设备图片上传、基础数据、基础文件上传已接入                       |
| 用户前端-用户接口     | 页面已接入 | `utils/api.js`、`app.js`、`pages/login/login.js`、`pages/mine/mine.js`、`subpackages/settings/profile/profile.js`、`subpackages/settings/index/index.js` | 微信手机号一键登录、用户信息、昵称/头像、退出、注销已接入；邮箱/PC 相关登录注册跳过                     |
| 用户前端-设备接口     | 页面已接入 | `utils/api.js`、`pages/home/home.js`、`subpackages/device/*`、`subpackages/album/list/list.js`、`subpackages/projection/*`                               | 设备增删改查、图库、一键清空、投屏记录列表/删除已接入真实接口；轮播/电量/图传/清空设备照片走 BLE 真指令 |

> 2026-06-11 增量：对照 Swagger 最新接口，补齐用户接口、设备接口及基础新增接口（`getBasicData`、`setFileUpload`），并新增了 Swagger 新出现的投屏记录接口（`getUserProductImgRecordList`、`delUserProductImgRecord`）。接口清单见 [`接口清单.md`](接口清单.md)。
>
> 2026-06-16 复核：实时 Swagger `/v2/api-docs` 中小程序相关 `/Client/...` 路径仍为 33 个，未发现新增路径或 HTTP 方法变化；新增发现是公共参数在 Swagger 中标注为 query。已将旧页面方法（`getDevices`、`getAlbumPhotos`、`getProjectionRecords` 等）映射到真实 `/Client/...` 接口，并清理主要演示数据兜底。

## 用户前端-产品接口

### 已接入

| 方法 | 路径                                  | `utils/api.js` 方法                  | Swagger 摘要     |
| ---- | ------------------------------------- | ------------------------------------ | ---------------- |
| GET  | `/Client/Product/getProductList`      | `getProductList(params)`             | 产品列表         |
| GET  | `/Client/Product/getProductFaqList`   | `getProductFaqList(params)`          | 常见问题列表     |
| GET  | `/Client/Product/getProductFaqDetail` | `getProductFaqDetail(faqIdOrParams)` | 常见问题列表详情 |

### 参数参考

- `getProductList(params)`：`pageIndex`、`pageSize`、`keyword`、`startDate`、`endDate`。
- `getProductFaqList(params)`：`pageIndex`、`pageSize`、`keyword`、`startDate`、`endDate`。
- `getProductFaqDetail(faqIdOrParams)`：可直接传 `faqId`，也可传 `{ faqId }`。

### 小程序跳过

- 无。本模块未发现 APP 专属接口。

## 用户前端-基础功能接口

### 已接入

| 方法 | 路径                                 | Swagger 摘要                                         | 小程序计划                              |
| ---- | ------------------------------------ | ---------------------------------------------------- | --------------------------------------- |
| POST | `/Client/Basic/sendEmail`            | 发送邮箱验证码,10分钟有效期                          | 已接入：`sendEmail(data)`               |
| POST | `/Client/Basic/sendEmailToken`       | 发送邮箱验证码(已登录的用户传userToken),10分钟有效期 | 已接入：`sendEmailToken(data)`          |
| POST | `/Client/Basic/setUserProductUpload` | BLE 图片转换上传，form-data 上传原图，后端转换帧并存 OSS，返回 url/taskId/upirId | 已接入：`setUserProductUpload(options)` |
| GET  | `/Client/Basic/getBasicData`         | 获取基础数据                                         | 已接入：`getBasicData(params)`          |
| POST | `/Client/Basic/setFileUpload`        | 基础上传(无关业务)，form-data 文件上传               | 已接入：`setFileUpload(options)`        |

### 页面接入

- `subpackages/settings/bind-email/bind-email.js`：获取验证码调用 `sendEmail({ userEmail, sendType: 3 })`。
- `subpackages/settings/change-email/change-email.js`：获取验证码调用 `sendEmail({ userEmail, sendType: 3 })`。
- `subpackages/settings/forgot-password/forgot-password.js`：获取验证码调用 `sendEmail({ userEmail, sendType: 2 })`。
- `subpackages/projection/result/result.js`：投屏链路改为「后端转换 + BLE 图传」。逐张先调 `setUserProductUpload({ filePath, userProductId, targetWidth, targetHeight, deviceUploadState: 0 })` 把原图传后端按设备宽高转换成帧(.bin)并存 OSS，拿到返回的 `url`(下载地址)/`taskId`/`upirId`；`wx.downloadFile` 下载 `.bin` 后用现有 `deviceBle.uploadImage` 图传给设备；设备图传成功后才调 `editUserProductImgRecord({ upirId, taskId, deviceUploadState: 1 })` 把投屏记录置为成功（设备失败则不调用，记录保持失败态并跳到失败场景）。

### 参数参考

- `sendEmail(data)`：`userEmail`、`sendType`。`sendType` 参考 Swagger：`1=注册邮件`、`2=找回密码邮件/修改密码`、`3=修改邮箱`。
- `sendEmailToken(data)`：按 Swagger 为已登录验证码接口；公共 `userToken` 会通过 header 传递。
- `setUserProductUpload(options)`：`filePath` 或 `filePaths/files`、`userProductId`、`deviceUploadState`、`targetWidth`/`targetHeight`(目标像素宽高)、可选 `formData`；可传 `loading:false` 关闭全局 loading、`showError:false` 自行处理错误。返回 `{ url, taskId, upirId, name }`。
  - ⚠️ **实况（2026-07-17）**：`targetWidth/targetHeight` 目前**后端未消费**——线上后端按「上传图片本身的像素」量化出六色帧（上传 725×1024 就出 726×1024÷2=371712 字节，非设备 680×960 的 326400 → 投屏失败）。所以**上传图必须预先缩到正好设备物理分辨率**（已在 `preview.js` 导出处做），别以为传了 targetWidth/targetHeight 后端就会缩。详见 memory `projection-upload-must-be-device-resolution`。
- 微信小程序原生 `wx.uploadFile` 单次稳定上传一个文件字段；当前封装支持传多个文件路径，并使用同一个 `fileParam` 字段逐个上传。

### 小程序跳过

| 方法 | 路径                               | Swagger 摘要        | 跳过原因                    |
| ---- | ---------------------------------- | ------------------- | --------------------------- |
| GET  | `/Client/Basic/getLastVersion`     | 获取App版本更新状态 | 涉及 App 版本更新           |
| GET  | `/Client/Basic/getAndroidDownload` | 安卓下载            | 安卓 App 专用，小程序不涉及 |

## 用户前端-用户接口

### 已接入

| 方法 | 路径                             | `utils/api.js` 方法        | Swagger 摘要                                                                                   |
| ---- | -------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------- |
| POST | `/Client/User/setWechatAppLogin` | `setWechatAppLogin(data)`  | 微信小程序授权手机号一键登录，返回登录 token                                                   |
| GET  | `/Client/User/getUserInfo`       | `getUserInfo()`            | 获取用户信息                                                                                   |
| POST | `/Client/User/changeNickName`    | `changeNickName(nickName)` | 修改昵称（1-10 字）                                                                            |
| POST | `/Client/User/changeAvatar`      | `changeAvatar(avatar)`     | 修改头像                                                                                       |
| POST | `/Client/User/changeUserEmail`   | `changeUserEmail(data)`    | 绑定/修改邮箱（小程序共用），`userEmail`+`verifyCode`+`password`+`confirmPassword`（密码 md5） |
| POST | `/Client/User/loginOut`          | `loginOut()`               | 用户登录退出                                                                                   |
| POST | `/Client/User/userOff`           | `userOff()`                | 用户注销                                                                                       |

### 参数参考

- `setWechatAppLogin(data)`：透传微信授权数据，`{ code, phoneEncrypted/encryptedData, iv }`，`auth:false`。
- `changeNickName(nickName)`：可传字符串或 `{ nickName }`。
- `changeAvatar(avatar)`：可传头像地址字符串或 `{ avatar }`；头像文件可先经 `setFileUpload` 拿到地址再提交。
- `changeUserEmail(data)`：body `{ userEmail, verifyCode, password, confirmPassword }`，`password`/`confirmPassword` 由 `utils/md5.js` 在 api 层加密为 md5(32位小写) 后传输；兼容传 `code` 作为 `verifyCode` 别名。新邮箱先经 `sendEmail({ userEmail, sendType: 3 })` 获取验证码；`device/language/terminal/userToken` 由 `request.js` 经 header/query 传递。绑定与修改邮箱共用此方法，绑定后邮箱+密码可用于 App 邮箱登录。

### 页面接入

- `subpackages/settings/bind-email/bind-email.js`：绑定邮箱（用户当前未绑定）→ `sendEmail(sendType:3)` 取码 + `changeUserEmail({ userEmail, verifyCode, password, confirmPassword })`。
- ~~`subpackages/settings/profile/profile.js`：`goEmail()` 仅在**未绑定**时进入 bind-email；**已绑定**时弹窗提示「小程序暂不支持修改邮箱，请前往 App 修改」，不跳转。~~ **已失效**：2026-07-16 `goEmail` 已删除、邮箱行改纯展示；2026-07-18 该行整行隐藏，个人信息页不再出现邮箱字段。
- 小程序仅支持首次绑定邮箱，修改邮箱引导至 App。`subpackages/settings/change-email/` 页面当前不在小程序流程内使用（保留备用，调用同一 `changeUserEmail`）。

### 小程序跳过

| 方法 | 路径                                | Swagger 摘要              | 跳过原因                             |
| ---- | ----------------------------------- | ------------------------- | ------------------------------------ |
| POST | `/Client/User/userLogin`            | 用户登录-邮箱             | 小程序走微信一键登录，不需要邮箱登录 |
| POST | `/Client/User/userRegister`         | 用户注册-邮箱             | 邮箱注册，App 专用                   |
| POST | `/Client/User/changePassword`       | 修改密码(已登录)          | 邮箱账号密码体系，小程序不涉及       |
| POST | `/Client/User/chkUserEmailNotExist` | 校验邮箱是否不存在        | 邮箱注册流程相关                     |
| POST | `/Client/User/resetPassword`        | 忘记密码-重置密码(未登录) | 邮箱账号找回密码，小程序不涉及       |
| POST | `/Client/User/userOffPC`            | 用户注销PC版              | PC 版接口                            |

## 用户前端-设备接口

### 已接入

| 方法 | 路径                                              | `utils/api.js` 方法                   | Swagger 摘要                              |
| ---- | ------------------------------------------------- | ------------------------------------- | ----------------------------------------- |
| POST | `/Client/UserProduct/addUserProduct`              | `addUserProduct(data)`                | 添加用户设备（绑定设备到用户）            |
| GET  | `/Client/UserProduct/getUserProductList`          | `getUserProductList(params)`          | 获取用户设备列表                          |
| GET  | `/Client/UserProduct/getUserProductDetail`        | `getUserProductDetail(params)`        | 获取用户设备详情                          |
| POST | `/Client/UserProduct/editUserProduct`             | `editUserProduct(data)`               | 编辑设备信息                              |
| POST | `/Client/UserProduct/delUserProduct`              | `delUserProduct(userProductId)`       | 删除设备,id=userProductId                 |
| POST | `/Client/UserProduct/clearUserProductImg`         | `clearUserProductImg(userProductId)`  | 一键清除设备图片,id=userProductId         |
| GET  | `/Client/UserProduct/getUserProductImgList`       | `getUserProductImgList(params)`       | 用户产品图片列表（我的图库）              |
| POST | `/Client/UserProduct/delUserProductImg`           | `delUserProductImg(ids)`              | 删除产品图片,id=uProductImgId（支持多选） |
| GET  | `/Client/UserProduct/getUserProductImgRecordList` | `getUserProductImgRecordList(params)` | 产品投屏记录列表（新出现接口）            |
| POST | `/Client/UserProduct/delUserProductImgRecord`     | `delUserProductImgRecord(upirId)`     | 删除产品投屏记录,id=upirId（新出现接口）  |
| POST | `/Client/UserProduct/editUserProductImgRecord`    | `editUserProductImgRecord(data)`      | 编辑投屏记录（设备图传成功后置设备上传状态）|

### 参数参考

- `addUserProduct(data)`：`{ productId(必传), productName, deviceId }`。`deviceId` 必须是连接后通过 `0x01 GET_INFO` 读取的完整 6 字节 `Device_ID`（统一 `AA:BB:CC:DD:EE:FF`）；广播 4 字节短 ID、微信 BLE `deviceId` 均禁止传入，缺失或格式不合法时前端直接终止绑定且不发送请求。`bindDevice` 每次绑定都先调 `getProductList` 拉「全部产品列表」，再用本地蓝牙搜索到的设备(型号/屏幕/名称)逐条匹配出 `productId`；匹配不到则中止绑定并提示。
- `getUserProductList/getUserProductImgList/getUserProductImgRecordList(params)`：`pageIndex`、`pageSize`、`keyword`、`startDate`、`endDate`；图库/投屏记录另支持 `userProductId`。
- `getUserProductDetail(params)`：可传 `userProductId` 或 `{ userProductId, productVersionNo }`。
- `editUserProduct(data)`：`{ userProductId, productName }`。
- `delUserProduct/clearUserProductImg(userProductId)`：可传 `id` 或 `{ id }`。
- `delUserProductImg(ids)`：可传单个 id、id 数组或 `{ ids }`。
- `delUserProductImgRecord(upirId)`：可传 `id` 或 `{ id }`。
- `editUserProductImgRecord(data)`：`{ upirId(投屏记录id), taskId(上传接口返回的任务id), deviceUploadState(0=失败,1=成功) }`；`device/language/terminal/userToken` 由 `request.js` 经 header/query 注入。设备图传成功后调用置 `deviceUploadState:1`。

### 页面接入

- `subpackages/device/bind/bind.js`：真实蓝牙扫描/读取设备信息后调用 `addUserProduct` 绑定后端设备。
- `pages/home/home.js`、`subpackages/device/list/list.js`、`subpackages/device/detail/detail.js`：设备列表/详情改为 `getUserProductList`、`getUserProductDetail`、`editUserProduct`、`delUserProduct`。
- `subpackages/device/detail/detail.js`、`subpackages/device/slideshow/slideshow.js`：轮播设置走 BLE `setPlayback(0x10)`；电量/容量刷新走 BLE `readDeviceInfo(0x01)`。
- `subpackages/device/detail/detail.js`：一键清空先走 BLE `deleteImage(0x12)` 删除设备内图片，再调用 `clearUserProductImg` 同步后端。
- `subpackages/album/list/list.js`：图库列表/删除改为 `getUserProductImgList`、`delUserProductImg`，不再补演示占位照片。
- `subpackages/projection/records/records.js`：投屏记录列表/删除改为 `getUserProductImgRecordList`、`delUserProductImgRecord`。
- `subpackages/settings/guide/guide.js`：操作指南接入 `getProductFaqList` / `getProductFaqDetail`，失败时保留静态兜底。

## 硬件调试台能力接入状态

| 调试台能力                                         | 真实页面接入                                                                           |
| -------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 扫描/连接设备                                      | `subpackages/device/bind/bind.js`、`subpackages/device/list/list.js`                   |
| 读设备信息/电量/容量/固件                          | 绑定页、设备列表、设备详情、投屏结果页                                                 |
| 设置轮播顺序/随机/关闭                             | `subpackages/device/detail/detail.js`、`subpackages/device/slideshow/slideshow.js`     |
| 相册/拍照图片转码并图传                            | `subpackages/projection/result/result.js`                                              |
| 图传前优化连接间隔/保持亮屏/后台中断               | `subpackages/projection/result/result.js`                                              |
| 图传后刷新屏幕显示                                 | `subpackages/projection/result/result.js`                                              |
| 删除设备图片/一键清空                              | `subpackages/device/detail/detail.js`                                                  |
| 连接间隔手动读取/设置、彩条测试图、16 进制收发日志 | 仍仅保留在 `subpackages/device/debug/debug.js`，属于硬件联调工具能力，不开放到用户页面 |

太好了，这份文档把最关键的部分给齐了——你之前我担心的"设备 OTA 协议拿不到"的问题，这里 6.3.2 / 6.3.3 章节已经把 DFU 协议完整定义出来了。所以结论很明确：完全可以实现，而且不用去管底层是什么芯片，照着这套自定义协议写就行。
我先把这份 OTA 协议的要点拆给你看，然后直接给你一份可以塞进小程序项目的代码模块。
这份协议的关键点
走的是独立的 OTA 服务，跟图片传输那套 0xAA 帧格式完全无关：

Service 0xFF10，特征 0xFF11（Write Without Response + Notify），所有控制指令和固件数据都在这一根特征上收发。
不用 CRC16，改用 1 字节累加校验：每个 APP→设备的包，末尾 checksum = 前面所有字节累加 & 0xFF。

整个流程是"信用窗口"机制（PRN=3），比你想象的简单：

APP 发 START（0xF1 + 对象类型 + 固件大小4字节小端 + checksum）→ 设备回 ACK，告诉你 MTU=251、PRN=3。
APP 按 DATA（0xF2 + 包序号2字节 + 数据 + checksum）发固件，每发 3 包等一次设备的 DATA ACK，ACK 里带"已连续收到的包号"。
关键细节：APP 不发 END。设备自己累计到固件大小后，自动算 CRC32、校验、写 BootSetting，然后回一个 0xF3 最终结果，约 100ms 后重启跑新固件。

丢包重传也很省事：DATA ACK 的包号没往前走，就说明那一包丢了，从 ACK包号+1 重发即可。
小程序这边必须注意的几个坑
最容易翻车的是 MTU。设备说自己支持 251，但安卓侧默认 ATT MTU 只有 23（每次只能写 20 字节），你必须 wx.setBLEMTU 把它拉上去，否则 244 字节的 DATA 包根本写不进去；iOS 是系统自动协商的。每包固件数据大小要根据真实协商到的 MTU 算（MTU - 3(ATT头) - 4(帧开销)）。
另外写 0xFF11 要用 writeType: 'writeNoResponse'，并且先 notifyBLECharacteristicValueChange 把通知打开。
固件大小范围 0x3000 ~ 0x3C000（约 12KB ~ 240KB），很小，下载和缓存都没压力。
下面这份模块把"从后台下载固件 → 拉 MTU → START → 窗口发包 → 等最终结果"整条链路都实现了，你接上自己的 deviceId 就能跑：Created a file, read a fileCreated a file, read a file几个需要你跟固件那边再对一下的点，我在代码里已标注，但单独提醒：
第一，特征 UUID 的实际格式。小程序在真机上扫到的 service/characteristic UUID 通常是补全后的 128 位大写串（像 0000FF11-0000-...）。你先用 wx.getBLEDeviceCharacteristics 打印一下实际值，跟代码里的常量对齐，否则 write/notify 会找不到特征。
第二，START 帧里的 OBJ_TYPE 具体值。文档只写了"当前作为固件对象使用"，没给确切数值，我默认填了 0x00，最好确认一下固件期望的是不是这个。
第三，每包数据大小。我是按协商到的 MTU 动态算的（最大 244 字节），但文档图片传输那套用的是固定 236，OTA 这边没明说固定值。如果固件要求 OTA 也是某个固定长度，把 chunkSize 改成固定值即可。
剩下的下载、连接、窗口流控、丢包重传都是按文档实现的，逻辑上能直接跑。建议先拿一个小固件在真机上跑通整条链路（开发者工具的蓝牙模拟不靠谱，一定要真机）。
要不要我再帮你把升级前的版本检查那段也写出来？就是先用 0x03 拿设备当前软件版本，跟后台固件版本比一下，决定要不要升级——这块跟 OTA 是配套的。
