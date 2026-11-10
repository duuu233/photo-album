# 2026-11-10 restore-builtin 新增 scene，一键清空与「我的上传」全删后恢复内置图片

> 分支：`main-wifi`｜依据：接口文档口径——`POST /api/device/restore-builtin` 新增选填参数 `scene`，原入参与返回不变；删除设备流程可不传。

## 做了什么

- `utils/iot-api.js`：`restoreBuiltin` 支持 `scene`（有值才带、原样传），导出常量 `RESTORE_SCENE_DELETE_ALL_PHOTOS = 'DELETE_ALL_PHOTOS'`。
- WiFi 详情「删除设备」不变：① `clearUserProductImg` 清相册记录 → ② `photo/delete all=true` 删云端照片 → ③ `restore-builtin`（不传 `scene`）→ ④ `delUserProduct` 删设备。
- WiFi 详情「一键清空」：同一套 `wipePhotos`，第 ③ 步传 `scene=DELETE_ALL_PHOTOS`；其余（出错只有 401 / 403 停下）不变。
- 「我的上传」WiFi 版删除（`subpackages/album/list/list.js` 的 `deleteWifiPhotos`）：判定为**全删**时，在记录与云端删除之后新调 `restore-builtin`（`deviceNo` + 产品 `renderMode`（取不到不传）+ `scene=DELETE_ALL_PHOTOS`）。
  - 全删 = 当前设备列表已加载完（没有下一页）且全部选中，记录一条不剩地删掉、云端删除也成功；只选了部分、还有下一页没加载、有记录没删掉、云端删除失败都不调。
  - 照片已经删了，这一步不影响删除结果：返回 `SENT` 提示「已删除，相框将恢复显示内置图片」；`SKIPPED` 或出错（只打日志，401 由接口层引导重登）照原提示。
  - 请求与返回用 `[相册删除][WiFi]` 前缀打进 console（同删除的其它请求日志）。

## 涉及文件

`utils/iot-api.js`、`subpackages/device/wifi-detail/wifi-detail.js`、`subpackages/album/list/list.js`、`tests/wifi-restore-scene.test.js`（新增）、`tests/wifi-tf-local-mode.test.js`、`tests/album-wifi-delete.test.js`。

## 验证

新增 `tests/wifi-restore-scene.test.js`（body 带 / 不带 scene）；`tests/wifi-tf-local-mode.test.js` 一键清空的恢复参数断言加 `scene`（有意改口径，用例内注明），删除设备断言不变（仍不带）；`tests/album-wifi-delete.test.js` 新增 ⑥ 全删调用、SENT / SKIPPED / 出错提示与五种不调的情形。本次修改所在环境没有 Node，`tests/` 未运行；未真机、未联调 `scene`。
