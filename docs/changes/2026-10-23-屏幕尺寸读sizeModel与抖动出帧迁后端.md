# 2026-10-23 屏幕尺寸读 sizeModel、抖动出帧迁到我方后端

> 分支：`main`；修改前：0b2006e。

## 需求

1. 后台产品新增/编辑/详情加了「尺寸型号」`sizeModel`（如“3.6寸”），设备列表、详情接口同样下发。端上直接展示，不再按屏型或宽高去推算；没配就不展示。
2. 照片预览投屏用的抖动出帧，原来调第三方 seekink 接口返回 .bin；现已迁到我方后端 `POST /Client/Basic/imageDitheringBinDownload`（图片上传且抖动，form-data，返回 .bin 二进制）。参数一样，headers 里带我们自己用户的 userToken，第三方的 token 不再需要。

## 改动

- 设备详情「屏幕尺寸」行（`subpackages/device/detail/*`）：`resolutionText`（0x01 屏型查表 → 后端宽高 → `--`）改为 `sizeModelText`，只读记录的 `sizeModel`（去首尾空白）；为空时整行连同分隔线不渲染。列表/详情归一化 `normalizeDevice` 用 `Object.assign` 透传后端字段，`sizeModel` 无需另加映射。
- `utils/dithering.js`：地址改为 `/Client/Basic/imageDitheringBinDownload`；删掉 seekink token 的获取、缓存、预热、401 强制重登重试；请求的 URL 与 header 改由 `request.clientRequestParts` 生成（与其它 `/Client/` 接口同口径：device/terminal/language/userToken 同时放 header 与 query，外加 Authorization/Authentication）。multipart 字段 `color=BWRYGB`、`imageDitheringModes=2`、`type`（沿用原取值：480×720 传 1，其余 0）、`file` 不变；仍用 `wx.request` + `arraybuffer` 收二进制。
- 报错：前缀由「接口(第三方)-」改为「接口-」。网络失败显示「接口-网络超时，图片转化失败，请重新尝试」并退避重试 3 次；业务 JSON 报错显示「接口-」+ retMsg（无则「接口-图片转化失败，请重新尝试」），不重试；HTTP 401 或 retCode 401/406 调 `request.expireSession`（即 `handleSessionExpired`）登出引导。
- `utils/request.js`：新增导出 `clientRequestParts`、`expireSession`；接口中文名表加 `imageDitheringBinDownload: '图片抖动出帧'`。
- 删除：`api.getXTYUserToken`、预览页 `dithering.prefetchAuthToken()` 预热、调试台「第三方 Token」卡片（js/wxml/wxss）。调试台与结果页的说明文字、日志把“第三方 seekink”改为“抖动接口”。
- 测试：新增 `tests/dithering-backend.test.js`（地址/header/multipart 字段、二进制原样返回、业务报错不重试、406 登出、网络失败重试 3 次）；`tests/projection-preview-demo.test.js` 原「正式预览页会预热抖动 token」断言按有意删除改为「预览页不得再碰抖动模块」，演示页断言不变。

## 未改 / 待确认

- 搜索设备列表（绑定前）的屏幕文案仍来自蓝牙广播屏型字节：此时还没有设备记录，要改成 `sizeModel` 需按广播名匹配产品列表，待确认是否需要。调试台的屏幕/分辨率显示是协议调试信息，不改。
- 后端 Swagger 把 `type` 描述为“屏幕类型(1=顺时针90° 2=逆时针90°)”，与原第三方用法（抖动策略 0/1）字面不同；按“参数一样”沿用原取值，需联调确认 3.7 寸设备传 1 不会被旋转。
- 后端返回二进制时的 `Content-Type` 未实测；判定沿用原逻辑（json/text，或小体积且以 `{` / `[` 开头视为报错体）。
- 微信后台 request 合法域名中的 `https://cloud.seekink.cn:8443` 已不再使用，是否移除由用户决定；`api.boltfox.cn` 原已在白名单。

## 验证

- 本机无 Node.js，`tests/*.test.js` 全量未运行，新增用例也未跑过；未在开发者工具或真机验证。
- `git diff --check` 通过。

## 同日追加（用户确认后）

- 搜索设备列表改为按蓝牙广播名匹配产品列表 `broadcastId`（去首尾空白、大小写不敏感的包含匹配，多个命中取最长），显示该产品的 `sizeModel`；匹配不到、没配或产品列表没拉到都不显示，不再用广播屏型字节。产品列表与扫描并行拉（`api.getProductCatalog`，会话缓存、失败静默），回来后补到已搜到的设备上。绑定时传给 `bindDevice` 的 `screen` 仍是广播屏型（只用于匹配打分），未改。新增 `tests/scan-size-model.test.js`。
- `type`：用户确认数值与原来一致不改（0=5.8寸大设备 680×960、1=3.7寸小设备 480×720，2026-07-22 对接第三方时的定义，是出帧策略不是旋转角），后端按此对齐；代码注释与文档改为该口径，不再列为待确认。
- 微信后台 request 合法域名 `https://cloud.seekink.cn:8443`：用户决定删除，需在小程序管理后台操作（代码仓库里没有域名配置）。代码里几处还写着 seekink 出帧的注释一并改为“抖动接口”。
- 验证：本机仍无 Node.js，新增用例与全量测试未运行，未真机。
