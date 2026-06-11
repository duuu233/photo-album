# API Integration Progress

接口文档：https://api.boltfox.cn/swagger-ui.html#/

后端地址：https://api.boltfox.cn

当前项目：微信小程序

## 对接规则

- 只对接用户前端模块：产品接口、基础功能接口、用户接口、设备接口。
- 当前为微信小程序，接口名、摘要或语义涉及 `APP` / `App` / `app` 的接口先不接入小程序。
- `/Client/User/userLogin`（用户登录-邮箱）不接入小程序。
- Swagger 公共参数 `device`、`terminal`、`language`、`userToken` 按文档说明通过 headers 传递；小程序 `terminal=3`。
- BoltFox 响应格式为 `retCode/retMsg/retData`，`retCode=200` 表示成功。
- 现阶段保留 `config.useMock=true`，避免未完成模块影响现有页面；已接入真实服务的方法在 `utils/api.js` 里通过 `mock:false` 单独请求真实接口。
- 当前真实产品接口未携带有效 `userToken` 时会返回 `retCode=406`（请重新登录）；用户模块完成真实登录接入后才能完整联调产品数据。

## 模块进度

| 模块                  | 状态         | 代码位置                           | 说明                                                                                      |
| --------------------- | ------------ | ---------------------------------- | ----------------------------------------------------------------------------------------- |
| 用户前端-产品接口     | 已完成       | `utils/api.js`                     | 本模块 3 个接口均接入                                                                     |
| 用户前端-基础功能接口 | 已完成       | `utils/api.js`、`utils/request.js` | App 版本/安卓下载接口跳过；邮箱验证码、设备图片上传、基础数据、基础文件上传已接入         |
| 用户前端-用户接口     | 接口层已接入 | `utils/api.js`                     | 邮箱/PC 相关登录注册跳过；微信一键登录、用户信息、昵称/头像、退出、注销已接入；待页面联调 |
| 用户前端-设备接口     | 接口层已接入 | `utils/api.js`                     | 设备增删改查、图库、一键清空、投屏记录列表/删除均接入；待页面联调                         |

> 2026-06-11 增量：对照 Swagger 最新接口，补齐用户接口、设备接口及基础新增接口（`getBasicData`、`setFileUpload`），并新增了 Swagger 新出现的投屏记录接口（`getUserProductImgRecordList`、`delUserProductImgRecord`）。接口清单见 [`接口清单.md`](接口清单.md)。

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
| POST | `/Client/Basic/setUserProductUpload` | 设备上传，form-data 文件上传                         | 已接入：`setUserProductUpload(options)` |
| GET  | `/Client/Basic/getBasicData`         | 获取基础数据                                         | 已接入：`getBasicData(params)`          |
| POST | `/Client/Basic/setFileUpload`        | 基础上传(无关业务)，form-data 文件上传               | 已接入：`setFileUpload(options)`        |

### 页面接入

- `subpackages/settings/bind-email/bind-email.js`：获取验证码调用 `sendEmail({ userEmail, sendType: 3 })`。
- `subpackages/settings/change-email/change-email.js`：获取验证码调用 `sendEmail({ userEmail, sendType: 3 })`。
- `subpackages/settings/forgot-password/forgot-password.js`：获取验证码调用 `sendEmail({ userEmail, sendType: 2 })`。

### 参数参考

- `sendEmail(data)`：`userEmail`、`sendType`。`sendType` 参考 Swagger：`1=注册邮件`、`2=找回密码邮件/修改密码`、`3=修改邮箱`。
- `sendEmailToken(data)`：按 Swagger 为已登录验证码接口；公共 `userToken` 会通过 header 传递。
- `setUserProductUpload(options)`：`filePath` 或 `filePaths/files`、`userProductId`、`deviceUploadState`、可选 `formData`。
- 微信小程序原生 `wx.uploadFile` 单次稳定上传一个文件字段；当前封装支持传多个文件路径，并使用同一个 `fileParam` 字段逐个上传。

### 小程序跳过

| 方法 | 路径                               | Swagger 摘要        | 跳过原因                    |
| ---- | ---------------------------------- | ------------------- | --------------------------- |
| GET  | `/Client/Basic/getLastVersion`     | 获取App版本更新状态 | 涉及 App 版本更新           |
| GET  | `/Client/Basic/getAndroidDownload` | 安卓下载            | 安卓 App 专用，小程序不涉及 |

## 用户前端-用户接口

### 已接入

| 方法 | 路径                             | `utils/api.js` 方法        | Swagger 摘要                                 |
| ---- | -------------------------------- | -------------------------- | -------------------------------------------- |
| POST | `/Client/User/setWechatAppLogin` | `setWechatAppLogin(data)`  | 微信小程序授权手机号一键登录，返回登录 token |
| GET  | `/Client/User/getUserInfo`       | `getUserInfo()`            | 获取用户信息                                 |
| POST | `/Client/User/changeNickName`    | `changeNickName(nickName)` | 修改昵称（1-10 字）                          |
| POST | `/Client/User/changeAvatar`      | `changeAvatar(avatar)`     | 修改头像                                     |
| POST | `/Client/User/loginOut`          | `loginOut()`               | 用户登录退出                                 |
| POST | `/Client/User/userOff`           | `userOff()`                | 用户注销                                     |

### 参数参考

- `setWechatAppLogin(data)`：透传微信授权数据，`{ code, phoneEncrypted/encryptedData, iv }`，`auth:false`。
- `changeNickName(nickName)`：可传字符串或 `{ nickName }`。
- `changeAvatar(avatar)`：可传头像地址字符串或 `{ avatar }`；头像文件可先经 `setFileUpload` 拿到地址再提交。

### 小程序跳过

| 方法 | 路径                                | Swagger 摘要              | 跳过原因                             |
| ---- | ----------------------------------- | ------------------------- | ------------------------------------ |
| POST | `/Client/User/userLogin`            | 用户登录-邮箱             | 小程序走微信一键登录，不需要邮箱登录 |
| POST | `/Client/User/userRegister`         | 用户注册-邮箱             | 邮箱注册，App 专用                   |
| POST | `/Client/User/changePassword`       | 修改密码(已登录)          | 邮箱账号密码体系，小程序不涉及       |
| POST | `/Client/User/changeUserEmail`      | 修改邮箱/绑定邮箱         | App 邮箱登录相关                     |
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

### 参数参考

- `addUserProduct(data)`：`{ productId, productName, productSerialNo }`。
- `getUserProductList/getUserProductImgList/getUserProductImgRecordList(params)`：`pageIndex`、`pageSize`、`keyword`、`startDate`、`endDate`；图库/投屏记录另支持 `userProductId`。
- `getUserProductDetail(params)`：可传 `userProductId` 或 `{ userProductId, productVersionNo }`。
- `editUserProduct(data)`：`{ userProductId, productName }`。
- `delUserProduct/clearUserProductImg(userProductId)`：可传 `id` 或 `{ id }`。
- `delUserProductImg(ids)`：可传单个 id、id 数组或 `{ ids }`。
- `delUserProductImgRecord(upirId)`：可传 `id` 或 `{ id }`。
