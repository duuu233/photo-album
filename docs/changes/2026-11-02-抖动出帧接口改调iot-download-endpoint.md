# 2026-11-02 抖动出帧接口改调 iot.boltfox.cn

> 分支：`main`（`main-wifi` 经合入 main 同步）｜依据：产品口径——投屏抖动出帧接口地址改为 `https://iot.boltfox.cn/api/device/download-endpoint`，参数全部不变

## 做了什么

- `utils/dithering.js`：抖动出帧请求由 `https://api.yikaltd.com/api/Client/Basic/imageDitheringBinDownload` 改为 `https://iot.boltfox.cn/api/device/download-endpoint`。
- 参数不变：公共参数 device / terminal / language / userToken（query + header）、鉴权头、form-data 字段 `color=BWRYGB` / `imageDitheringModes=2` / `type` / `file`、二进制响应解析、业务报错与 401/406 登出、网络失败重试 3 次，全部照旧。
- `utils/request.js`：`clientRequestParts` 的 options 新增 `clientQuery`。公共参数 query 原本只对 `/Client/` 开头的路径拼接，新路径 `/device/download-endpoint` 不在其下，传 `clientQuery: true` 强制拼上，保证参数与原接口一致。其它接口不受影响。
- ⚠️ 小程序后台「request 合法域名」需要加 `https://iot.boltfox.cn`（已有则无需再加），否则真机请求会被拦截。

## 测试

- `tests/dithering-backend.test.js`：请求地址断言改为 `https://iot.boltfox.cn/api/device/download-endpoint?…`，桩按 `clientQuery` 拼公共参数，并断言不再调 api.yikaltd.com；其余断言（multipart 字段、userToken、报错、重试）不变。
- 本机没有 node，测试未运行；未真机、未联调。请本地跑全量：`for f in tests/*.test.js; do node "$f" || echo "FAILED: $f"; done`。
