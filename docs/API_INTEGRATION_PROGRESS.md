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

| 模块 | 状态 | 代码位置 | 说明 |
| --- | --- | --- | --- |
| 用户前端-产品接口 | 已完成 | `utils/api.js` | 本模块 3 个接口均接入 |
| 用户前端-基础功能接口 | 已完成 | `utils/api.js`、`utils/request.js` | App 版本接口跳过；邮箱验证码和设备图片上传已接入 |
| 用户前端-用户接口 | 已完成 | `utils/api.js` | 邮箱登录、PC 注销接口跳过；其余 11 个接口均接入 |
| 用户前端-设备接口 | 已完成 | `utils/api.js` | 本模块 8 个接口均接入 |

## 用户前端-产品接口

### 已接入

| 方法 | 路径 | `utils/api.js` 方法 | Swagger 摘要 |
| --- | --- | --- | --- |
| GET | `/Client/Product/getProductList` | `getProductList(params)` | 产品列表 |
| GET | `/Client/Product/getProductFaqList` | `getProductFaqList(params)` | 常见问题列表 |
| GET | `/Client/Product/getProductFaqDetail` | `getProductFaqDetail(faqIdOrParams)` | 常见问题列表详情 |

### 参数参考

- `getProductList(params)`：`pageIndex`、`pageSize`、`keyword`、`startDate`、`endDate`。
- `getProductFaqList(params)`：`pageIndex`、`pageSize`、`keyword`、`startDate`、`endDate`。
- `getProductFaqDetail(faqIdOrParams)`：可直接传 `faqId`，也可传 `{ faqId }`。

### 小程序跳过

- 无。本模块未发现 APP 专属接口。

## 用户前端-基础功能接口

### 已接入

| 方法 | 路径 | Swagger 摘要 | 小程序计划 |
| --- | --- | --- | --- |
| POST | `/Client/Basic/sendEmail` | 发送邮箱验证码,10分钟有效期 | 已接入：`sendEmail(data)` |
| POST | `/Client/Basic/sendEmailToken` | 发送邮箱验证码(已登录的用户传userToken),10分钟有效期 | 已接入：`sendEmailToken(data)` |
| POST | `/Client/Basic/setUserProductUpload` | 设备上传，form-data 文件上传 | 已接入：`setUserProductUpload(options)` |

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

| 方法 | 路径 | Swagger 摘要 | 跳过原因 |
| --- | --- | --- | --- |
| GET | `/Client/Basic/getLastVersion` | 获取App版本更新状态 | 涉及 App 版本更新 |

## 用户前端-用户接口

### 已接入

| 方法 | 路径 | `utils/api.js` 方法 | Swagger 摘要 |
| --- | --- | --- | --- |
| GET | `/Client/User/getUserInfo` | `getUserInfo()` | 获取用户信息 |
| POST | `/Client/User/changeAvatar` | `changeAvatar(avatar)` | 修改头像 |
| POST | `/Client/User/changeNickName` | `changeNickName(nickName)` | 修改昵称 |
| POST | `/Client/User/changePassword` | `changePassword(data)` | 修改密码(已登录) |
| POST | `/Client/User/changeUserEmail` | `changeUserEmail(data)` | 修改邮箱/绑定邮箱 |
| POST | `/Client/User/chkUserEmailNotExist` | `chkUserEmailNotExist(userEmail)` | 校验邮箱是否不存在,存在返回异常码 |
| POST | `/Client/User/loginOut` | `loginOut()` | 用户登录退出 |
| POST | `/Client/User/resetPassword` | `resetPasswordByEmail(data)` | 忘记密码-重置密码(未登录) |
| POST | `/Client/User/setWechatAppLogin` | `wechatAppLogin(data)` | 微信小程序授权手机号码 一键登录返回登录token |
| POST | `/Client/User/userOff` | `userOff()` | 用户注销 |
| POST | `/Client/User/userRegister` | `userRegister(data)` | 用户注册-邮箱 |

### 参数参考

- 公共参数 `device`/`terminal`/`language`/`userToken` 由 `request.js` 统一写入 headers，业务方法只传业务字段。
- 密码相关字段（`password`、`confirmPassword`、`oldPassword`）需调用方先做 `md5`（32 位小写）再传入；项目当前无 md5 工具，需调用前自行接入。
- `changePassword(data)`：`password`、`confirmPassword`、`verifyCode`（Swagger `SetPasswordApiIn`，校验走邮箱验证码而非旧密码）。
- `changeUserEmail(data)`：`userEmail`、`verifyCode`，可选 `password`/`confirmPassword`（Swagger `SetUserEmailApiIn`）。
- `chkUserEmailNotExist(userEmail)`：可传 `userEmail` 字符串或 `{ userEmail }`；`showError:false` 静默，由调用方判断异常码。
- `resetPasswordByEmail(data)`：`userEmail`、`password`、`confirmPassword`、`verifyCode`（`ResetPasswordApiIn`，未登录 `auth:false`）。命名避开旧 mock `resetPassword`，避免 `utils/api.js` 对象重复键。
- `wechatAppLogin(data)`：`code`（微信授权 code）、`wxEncrypData`、`wxIvData`（`WechatAlipayGetPhoneNumberApiInput`）；成功返回含 `userToken` 的 `UserInfoDetailApiOut`，需写入 Storage `token`。**已接入登录流程**见下文「登录流程接入」。
- `userRegister(data)`：`userEmail`、`password`、`confirmPassword`、`verifyCode`，可选 `countryId`；成功同样返回含 `userToken` 的 `UserInfoDetailApiOut`。
- `getUserInfo()` 返回 `UserInfoApiOut`：`avatar`、`nickName`、`userEmail`、`userNo`、`imgCount`、`productCount`。

### 登录流程接入

- `pages/login/login.wxml`：登录按钮 `open-type="{{agreed ? 'getPhoneNumber' : ''}}"`，未勾选协议时退化为普通按钮（`bindtap` 提示），勾选后才具备手机号授权能力（`bindgetphonenumber="onWechatLogin"`），避免提前弹授权框。
- `pages/login/login.js`：`onLoginTap()` 处理未同意协议的提示；`onWechatLogin(event)` 校验授权结果（拒绝/取消静默返回），调用 `app.loginWithWechatPhone(event.detail)` 后 `switchTab` 进首页。
- `app.js`：
  - `loginWithWechatPhone(detail)` 调 `api.wechatAppLogin({ code, wxEncrypData: detail.encryptedData, wxIvData: detail.iv })`。
  - `applyWechatSession(profile)` 写 `userToken`→Storage `token`，并把用户信息内存/缓存双写。
  - `normalizeUserInfo(profile)` 把 BoltFox 字段（`avatar`/`userEmail`）映射成旧页面字段（`avatarUrl`/`email`）并保留新字段，兼容现有页面。
- 旧的 mock `loginWithWechat()` 与 `ensureLogin()` 保留：`config.useMock=true` 时其余页面仍走 mock；`ensureLogin` 在无 token 时仍以 mock 静默登录兜底（真机一键登录需走登录页）。

### 小程序跳过

| 方法 | 路径 | Swagger 摘要 | 跳过原因 |
| --- | --- | --- | --- |
| POST | `/Client/User/userLogin` | 用户登录-邮箱 | 用户明确不需要 |
| POST | `/Client/User/userOffPC` | 用户注销PC版 | PC 版接口 |

## 用户前端-设备接口

### 已接入

| 方法 | 路径 | `utils/api.js` 方法 | Swagger 摘要 |
| --- | --- | --- | --- |
| GET | `/Client/UserProduct/getUserProductList` | `getUserProductList(params)` | 获取用户设备列表 |
| GET | `/Client/UserProduct/getUserProductDetail` | `getUserProductDetail(params)` | 获取用户设备详情 |
| GET | `/Client/UserProduct/getUserProductImgList` | `getUserProductImgList(params)` | 用户产品图片列表 |
| POST | `/Client/UserProduct/addUserProduct` | `addUserProduct(data)` | 添加用户设备 |
| POST | `/Client/UserProduct/editUserProduct` | `editUserProduct(data)` | 编辑设备信息 |
| POST | `/Client/UserProduct/delUserProduct` | `delUserProduct(id)` | 删除设备,id=userProductId |
| POST | `/Client/UserProduct/clearUserProductImg` | `clearUserProductImg(id)` | 一键清除设备图片,id=userProductId |
| POST | `/Client/UserProduct/delUserProductImg` | `delUserProductImg(idList)` | 删除产品图片,id=uProductImgId |

### 参数参考

- 公共参数 `device`/`terminal`/`language`/`userToken` 同样由 `request.js` 写入 headers。
- `getUserProductList(params)` / `getUserProductImgList(params)`：`pageIndex`、`pageSize`、`keyword`、`startDate`、`endDate`。
- `getUserProductDetail(params)`：可直接传 `userProductId`，也可传 `{ userProductId, productVersionNo }`（`productVersionNo`=设备当前版本号，用于判断是否需要 OTA）。
- `addUserProduct(data)`：`productId`（产品 ID）、`deviceId`（设备 ID，1-20 位）、`productName`（系列名称，1-30 位）。
- `editUserProduct(data)`：`userProductId`、`productName`。
- `delUserProduct(id)` / `clearUserProductImg(id)`：`id=userProductId`，可传数字或 `{ id }`（Swagger `BaseIdInput`）。
- `delUserProductImg(idList)`：可传 `uProductImgId` 数组（例 `[1,2,3]`）或 `{ idList }`（Swagger `BaseIdsIn`，字段名 `idList`）。
- 列表/详情返回字段：`userProductId`、`productId`、`productName`、`productImg`、`deviceId`；详情含 OTA 字段 `isUpdate`、`newVersionNo`、`downloadPath`、`compulsory`。图片列表（`getUserProductImgList`）每项含 `uProductImgId`、`img`、`deviceId`、`productId`、`productName`。

### 小程序跳过

- 无。本模块未发现 APP/PC 专属接口。
