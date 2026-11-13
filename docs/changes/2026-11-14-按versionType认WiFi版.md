# 2026-11-14 只按接口 versionType 认 WiFi 版 / 蓝牙版

> 分支：`main`｜依据：用户反馈首页设备卡、我的设备把 WiFi 版设备先显示成蓝牙版，1~2 秒后才变 WiFi 版；接口口径：`getUserProductList` / `getUserProductDetail` 出参 `versionType`（1=蓝牙版，2=wifi版），用户确认只按它判断。

- 原因：
  - 前端没有读 `versionType`，一直按所属产品的 `broadcastId`（`IJ_*`）认 WiFi 版；
  - 设备列表实际返回不带 `productId` / `broadcastId`，要等产品列表和详情接口补上才认得出。冷启动最多等 3 秒，没回来就按蓝牙版显示（首页卡还带 `tab=ble` 进我的设备），之后才变对；
  - 首页 `normalizeDevice` 按白名单裁剪字段，`versionType` 没带过去。
- 改法：
  - `utils/broadcast-match.isWifiDevice` 只认 `versionType`：2 为 WiFi 版、1 为蓝牙版；没有该字段时只认页面已据此判过、往下游传的 `isWifi: true`（如待投屏设备）。不再按 `broadcastId` / `commType` 猜；
  - 首页 `normalizeDevice` 透传 `versionType`；
  - 我的设备列表原来直接按 `broadcastId` 判断，改走 `isWifiDevice`；
  - WiFi 配网绑定返回的设备记录补 `versionType: 2`；
  - 首页、我的设备、设备详情、投屏、图库、AI 对话、相册都走 `isWifiDevice`，一起生效。搜索设备页（绑定前，没有设备记录）仍按扫描时的 `commType`，不变。
- 同日《产品列表本地缓存》仍保留：用于冷启动不再等产品列表 / 详情补机型（设备图）。
- 测试：`device-list-wifi-group`、`home-wifi-entry` 补断言；原按 `broadcastId: 'IJ_*'` 认 WiFi 版的用例数据补上 `versionType`（判据挪到 versionType 上）。本机无 node，未运行、未在开发者工具或真机核对。
