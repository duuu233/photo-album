# 本地 .raw 直发测试（临时调试功能）

> 目的：投屏时**绕过后端转换**，把本地一份固定的六色 4bpp 帧 `assets/demo.raw` **原样**发给设备，
> 用于在真机上直接验证某份帧的真实显示效果（朝向 / 颜色 / 裁剪）。
> **正式上线前请删除**，恢复「后端转换 + 下载 .bin」的真实流程。

## 当前开关
`subpackages/projection/result/result.js` 顶部：
```js
const USE_LOCAL_DEMO_RAW = true   // true=发本地 demo.raw；false=走真实后端流程
```
- 为什么用内嵌 base64：小程序 `FileSystemManager` 读不了代码包内任意文件（`readFile:fail file not exist`），
  所以把 `demo.raw` 在编译期编进 `demo-raw-base64.js`，运行时解码成字节再发。

## 怎么用
1. 把要测的 `.raw` 覆盖到 `assets/demo.raw`（字节数必须 = 所连设备 `宽×高÷2`，EF6-370 480×720 = **172800**）。
2. 重新生成内嵌 base64（二选一）：
   - 手动：`node scripts/gen-demo-raw-base64.js`
   - 自动：`node scripts/watch-demo-raw.js`（挂着，覆盖 demo.raw 即自动重生成）
3. 微信开发者工具 **Ctrl+B 重新编译**（`require` 有模块缓存，不重编不会用上新数据）。
4. 连接设备 → 投屏 → 随便选张图（内容被忽略）→ 看屏幕。

## 关掉 / 删除

### 方式 A：临时关（保留代码，最快）
把开关改回 `false` 即走真实流程：
```js
const USE_LOCAL_DEMO_RAW = false
```

### 方式 B：彻底删除（上线前做）
1. **删文件**：
   - `subpackages/projection/result/demo-raw-base64.js`
   - `scripts/gen-demo-raw-base64.js`
   - `scripts/watch-demo-raw.js`
   - （可选）`assets/demo.raw`
   - （可选）本文件 `docs/local-raw-test.md`
2. **改 `subpackages/projection/result/result.js`**（3 处，都有 `本地 .raw 直发测试` / `测试块` 注释标记）：
   1. 删掉顶部 `╔══ 本地 .raw 直发测试 ══╗ … ╚══ 测试块结束 ══╝` 整块（`USE_LOCAL_DEMO_RAW`、`DEMO_RAW_BASE64`、`base64ToUint8Array` 等）。
   2. `acquireFrame` 方法里删掉开头的 `if (USE_LOCAL_DEMO_RAW) { … return … }` 分支（保留后端转换那部分即可）。
   3. `editUserProductImgRecord` 处把 `if (!USE_LOCAL_DEMO_RAW && upirId) { … } else if (…) {…}` 还原成**无条件调用**：
      ```js
      await api.editUserProductImgRecord({ upirId, taskId, deviceUploadState: 1, showError: false })
      console.log(`[投屏] 第 ${i + 1}/${total} 张 投屏记录已置成功：upirId=${upirId} taskId=${taskId}`)
      ```
3. 删除后 `node --check subpackages/projection/result/result.js` 确认无语法错误。

> 提示：搜索关键字 `USE_LOCAL_DEMO_RAW` 能一次定位 result.js 里所有测试代码点。

## 注意
- 测试模式**只跟设备打交道**，不调后端（不建/不改投屏记录）。
- `demo.raw` 字节数与设备分辨率对不上时，会在 `0x20` 前被长度校验拦下并报清晰错误。
- 每次换图后**必须重新生成 base64 + 重新编译**，否则发的还是旧图（这是 `require` 模块缓存导致的，不是设备缓存）。
