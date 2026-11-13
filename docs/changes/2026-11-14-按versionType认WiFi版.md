# 2026-11-14 按接口 versionType 认 WiFi 版 / 蓝牙版

> 分支：`main`｜依据：用户反馈首页设备卡、我的设备把 WiFi 版设备先显示成蓝牙版，1~2 秒后才变 WiFi 版；接口口径：`getUserProductList` / `getUserProductDetail` 出参 `versionType`（1=蓝牙版，2=wifi版）。

- 原因：前端没有读 `versionType`，一直按所属产品的 `broadcastId`（`IJ_*`）认 WiFi 版。列表记录要等产品列表回来才补上 `broadcastId`；冷启动产品列表最多等 3 秒，没回来就按蓝牙版显示（首页卡还带 `tab=ble` 进我的设备），之后才变对。
- 改法：
  - `utils/broadcast-match.isWifiDevice` 先认 `versionType`：2 为 WiFi 版、1 为蓝牙版；没有该字段（搜索结果、旧缓存等）再按原来的 isWifi / commType / `broadcastId`；
  - 我的设备列表原来直接按 `broadcastId` 判断，改为同样走 `isWifiDevice`；
  - 首页、我的设备、设备详情、投屏、图库、AI 对话等原本都走 `isWifiDevice`，一起生效。
- 同日《产品列表本地缓存》仍保留：它解决的是冷启动等产品列表（设备图 / 机型）拖慢首页 loading；那篇里「设备列表接口不带 WiFi / 蓝牙类型」的说法有误，以本篇为准。
- `tests/device-list-wifi-group.test.js` 补断言。本机无 node，未运行、未在开发者工具或真机核对。
