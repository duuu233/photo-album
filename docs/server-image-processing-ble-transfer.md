# 服务器图片转换与 BLE 图传方案说明

> 🛠 **维护约定**：每次修改本文件涉及的问题/功能，务必在下方「操作日志」补一条（日期 + 改了什么 + 关联文件/commit），**最新在上**——别让文档与代码脱节。

## 操作日志（最新在上）
- **2026-07-24（二）**：**seekink 抖动接口域名升 https**。由 `http://cloud.seekink.cn:8091` 迁到
  `https://cloud.seekink.cn:8443`（对方启用 SSL）。仅换 host+scheme+端口，路径/参数/请求头/鉴权不变。
  关联：小程序 `utils/dithering.js`（`DITHERING_API`）、Flutter `lib/src/network/dithering_api.dart`（`_endpoint`）、
  本文件及 `docs/接口清单.md`、`docs/2026-07-22-照片预览需求调整.md` URL 引用。
  ⚠️ 小程序需在管理后台把 `https://cloud.seekink.cn:8443` 加进 **request 合法域名**白名单（https 才可加白）；
  真机走白名单、开发者工具可继续勾「不校验合法域名」。小程序 + Flutter 均已改。
- **2026-07-24**：**抖动接口 401（token 过期）自愈刷新改为强制重新登录**。`getXTYUserToken` 新增入参
  `isNewLogin`（默认 `0`=复用后端已有会话）。抖动接口回 401（`{"msg":"…认证失败，无法访问系统资源","code":401}`）
  或业务 token 类报错时，`utils/dithering.js` 的 `ensureAuthToken(forceNewLogin=true)` 清缓存后带
  **`isNewLogin=1`** 重取一次 token 再重发出帧请求——避免后端把刚过期的同一会话原样返回、重试仍 401 打转。
  刷新只做一次（`authRetried`），不消耗网络退避重试次数；常规首取/预热仍 `isNewLogin=0`。关联：
  `utils/api.js`（`getXTYUserToken(isNewLogin=0)`）、`utils/dithering.js`（`ensureAuthToken`/`requestFrameBin.run(left,forceNewLogin)`）。
  仅小程序，Flutter 待同步。
- **2026-07-23（二）**：**再次/重新投屏并入正常链路，imgBle(.bin) 直传整链路删除**（后端已不再
  生成/返回 .bin，07-22 风险②就此定夺关闭）。投屏管理页点「再次/重新投屏」→ 连设备 → 只带
  记录图片地址（优先图库原图）进预览页 → 与手选图片流程无差别：出帧走抖动接口、记录走
  setUserProductUpload+editUserProductImgRecord，每次再投都产生一条新投屏记录。删除清单：
  records.js imgBle 门槛/透传、result.js `isRetry`/`_retryImageInFlight`/`addRetryRecord`/
  `downloadFrameBin`/首张预取 `firstDirect`、preview.js `cropW||imgBle` 保留判定（改只看 cropW）。
  关联：`records.js`、`result.js`、`preview.js`、`utils/api.js`（addUserProductImgRecord 已无调用方，
  方法保留）、`docs/接口清单.md`。仅小程序，Flutter 待同步。
- **2026-07-23**：**抖动接口鉴权由写死联调 token 改为接口动态获取**：新增
  `GET /Client/Basic/getXTYUserToken`（api.js），`utils/dithering.js` 删除 `DITHERING_AUTH` 常量，
  请求头改 `Authorization: Bearer+空格+动态token`。策略：`ensureAuthToken` 会话级内存缓存
  （一次会话只取一次、所有投屏复用，杀进程失效重取；在途请求去重）+ 预览页 onLoad 调
  `prefetchAuthToken` 前置预热（构图期间取好，出帧零等待）+ 收到 401/业务 token 类报错时清缓存
  刷新重试一次（长会话过期自愈，只刷一次防打转）。07-22 遗留的「⚠️token 写死待换」就此关闭。
  ⚠️getXTYUserToken 返回字段形态为假设待联调。关联：`utils/api.js`、`utils/dithering.js`、
  `subpackages/projection/preview/preview.js`、`docs/接口清单.md`。仅小程序，Flutter 待同步。
- **2026-07-22**：**正常投屏的设备帧改由第三方 seekink 抖动接口生成，不再下载后端转码的 .bin**
  （仅小程序，Flutter 待同步）。result.js `acquireFrame` 正常链路改为两路网络并行：
  - **设备帧**：预览处理后的设备分辨率图 → `compressForUpload` 统一压缩（已是设备尺寸则原样通过）→
    `utils/dithering.js requestFrameBin`（`POST https://cloud.seekink.cn:8443/prod-api/api/v1/label/imageDitheringBinDownload`，
    form-data `color=BWRYGB`/`imageDitheringModes=2`/`type`(0=5.8寸 EF6-589、1=3.7寸 EF6-370，按分辨率判型)/`file`；
    请求头 `Authorization`(⚠️写死联调 token，正式鉴权前必须替换)+`AcceptLanguage=en`；
    手拼 multipart + `wx.request(responseType:'arraybuffer')` 收二进制，网络类失败退避重试 3 次）；
  - **投屏记录**：`setUserProductUpload` 改传**原图**（进预览页前未操作过的图，`_origSrc` 回溯，
    同一套 `compressForUpload` 统一压缩）只为建记录拿 `taskId/upirId` + 后端存图（图库/记录页展示），
    返回的 `.bin url` 不再下载（`convertOnServer`/正常链路的 `downloadFrameBin` 已移除/仅剩 imgBle 用）。
  - 图传成功后 `editUserProductImgRecord` 置成功、失败回滚 0x12、0x24 只刷最后一张、A3 预取/F1
    首张并行/「帧字节数=宽×高÷2」铁闸**全部保持不变**；帧失败时记录可能已按未成功(0)建好，与旧
    链路「转码成功后图传失败」同态。
  - 预览页 07-22 当天的「抖动Bin」调试按钮已下线（逻辑即本条的前身）。
  - ⚠️ **风险/待确认**：① seekink bin 的六色索引映射/扫描顺序未真机验证，花屏/串色先核对调色板；
    ② 后端仍按「原图」转码存 `imgBle` → **再次投屏直传 imgBle 的内容将与本次实际投屏不一致**
    （旧链路二者同源），需后端/产品定夺（后端不再出帧？或 imgBle 改存抖动接口结果？）；
    ③ http + 未加白名单域名，联调需关域名校验，上线前要加白名单或走 https。
  - 关联：`subpackages/projection/result/result.js`、`utils/dithering.js`、`subpackages/projection/preview/preview.{js,wxml,wxss}`、
    `docs/接口清单.md`、`docs/2026-07-22-照片预览需求调整.md`。
- **2026-07-17**：§5.3 加「实况提示」——本文是目标设计，**线上后端实际按上传图像素出帧、并未按设备尺寸缩放**；后端落地本节前，端上须把上传图预缩到设备物理分辨率（`preview.js` 导出已实现）。见 memory `projection-upload-must-be-device-resolution`。

## 1. 背景

当前微信小程序调试页的图片上传链路大致是：

```text
选择原图 chooseMedia(original)
  -> 可选 wx.compressImage 预压缩
  -> OffscreenCanvas.drawImage 缩放/裁剪
  -> getImageData 取 RGBA 像素
  -> 小程序 JS 做六色量化
  -> 小程序通过 BLE 分包发送给固件
```

APP 端调试页的效果更好，主要原因不是 Flutter UI，而是 APP 端图片处理走了 Android 原生能力：

```text
Android BitmapFactory 解码
  -> 读取 EXIF 方向
  -> ARGB_8888 像素
  -> inSampleSize 控制大图解码
  -> Bitmap.createScaledBitmap 缩放
  -> 输出 RGBA
  -> Dart 做六色量化
  -> BLE 分包发送给固件
```

普通微信小程序不能直接调用 Android 的 `BitmapFactory`、`ExifInterface`、`Bitmap.createScaledBitmap`，只能使用微信提供的图片 API 和 Canvas 能力。即使后面的六色量化算法尽量对齐 APP，前面“解码 + 缩放 + getImageData”得到的 RGBA 像素仍可能和 APP 不一致，最终上屏效果就会有明显差距。

因此可以考虑把“影响画质的图片转换工作”放到服务器做，让小程序只负责选图、上传原图、下载转换结果、通过 BLE 发送给固件。

## 2. 核心思路

服务器方案的解释：

**服务器不是直接把图片传给固件。固件仍然只和手机小程序通过 BLE 通信。服务器只负责把原图加工成固件可以直接接收的图片数据。**

也就是说：

```text
小程序：负责选图、上传、下载转换结果、BLE 发送
服务器：负责解码、纠正方向、裁剪缩放、调色、六色量化、打包 raw 数据
固件：继续接收现有 0x20 / 0x21 / 0x22 图传协议
```

服务器相当于一个“图片加工厂”。小程序把原图交给服务器，服务器返回一份已经处理好的 `frame.bin`。小程序拿到 `frame.bin` 后，不再用 Canvas 处理图片，只按现有 BLE 图传协议把这段二进制数据搬给固件。

## 3. 整体流程

推荐流程如下：

```text
1. 小程序连接设备
2. 小程序读取设备信息 0x01
   得到 screenType / width / height / capacity / imgMask
3. 用户选择相册原图
4. 小程序把原图上传给服务器
5. 服务器按设备尺寸处理图片
6. 服务器生成固件需要的六色 4bpp raw 帧数据
7. 小程序下载 raw 帧数据和元信息
8. 小程序校验数据长度和 CRC
9. 小程序按现有 BLE 协议发送给固件
10. 固件写入 Flash 并刷新显示
```

关键点：

- 服务器只处理图片，不直接连设备。
- 小程序仍然负责 BLE。
- 固件协议可以保持不变。
- 画质相关逻辑统一放到服务器，避免受小程序 Canvas 底层实现影响。

## 4. 数据最终要变成什么

固件不是接收 JPG / PNG。固件最终接收的是“已经量化好的六色 4bpp 原始帧缓存”。

假设设备分辨率是 `680 x 960`：

```text
像素数 = 680 x 960 = 652800
每个像素 = 4 bit
两个像素 = 1 byte
最终数据大小 = 680 x 960 / 2 = 326400 bytes
```

这 326400 字节就是要通过 BLE 发给固件的 `frame.bin`。

每个像素的 4bit 值是固件协议定义好的颜色编号：

| 颜色 | nibble |
| --- | --- |
| 黑 | 0x0 |
| 白 | 0x1 |
| 黄 | 0x2 |
| 红 | 0x3 |
| 蓝 | 0x5 |
| 绿 | 0x6 |

打包规则：

```text
第 1 个像素放高 4 位
第 2 个像素放低 4 位
```

例如两个像素分别是：

```text
红 0x3，白 0x1
```

打包成一个字节：

```text
0x31
```

这个规则必须和当前小程序 / APP / 固件保持一致。

## 5. 服务器处理步骤详解

### 5.1 接收原图

小程序上传用户选择的原图。

第一版可以先不用复杂的分段上传，直接用普通文件上传验证效果：

```text
POST /image-convert/tasks
Content-Type: multipart/form-data
file: 原图
screenType: 设备屏幕类型
width: 设备宽度
height: 设备高度
mode: cover
palette: app-6color
```

后端收到后，需要做基础校验：

- 文件是否为空。
- 文件大小是否超过限制，比如 20MB 或 30MB。
- 图片格式是否支持，比如 JPG / PNG / HEIC / WebP。
- 目标宽高是否合理。
- 用户是否有权限给这个设备转换图片。

### 5.2 解码图片

服务器需要把原图解码成像素数据。建议使用成熟图片库，而不是自己写解码。

可选技术栈：

- Node.js：`sharp`，底层是 libvips。
- Java：ImageIO + TwelveMonkeys，或 Thumbnailator。
- Python：Pillow。
- Go：标准 image 包 + 第三方 HEIC/WebP 支持。

解码时需要注意：

- 读取 EXIF 方向，避免竖拍照片横着显示。
- 统一转换到 sRGB。
- 如果图片有透明通道，建议用白底合成。
- 不要直接用缩略图代替原图。

### 5.3 裁剪和缩放

服务器要把原图处理成设备实际分辨率。

> ⚠️ **实况提示（2026-07-17）**：本文是**目标设计**，不是当前线上后端的实际行为。**实测线上后端并未按设备尺寸缩放**——它按「上传图片的像素分辨率」直接量化出帧（上传 725×1024 → 出 726×1024÷2 = 371712 字节，而设备 680×960 只要 326400 → 帧大小对不上设备、投屏失败），即 `targetWidth/targetHeight` 目前没被后端消费。**在后端落地本节「缩到设备实际分辨率」之前，小程序端必须把上传图预先缩到正好设备物理分辨率**（已在 `preview.js` 导出处实现：coverCropOne/applyCrop 直接 fit 到设备尺寸；见 `代码审查修复清单-2026-07-16.md` D5 / memory `projection-upload-must-be-device-resolution`）。**切勿因为本文写了「服务器按设备尺寸处理」，就在端上省掉这一步**——那会立刻复现投屏失败。

目前 APP 调试页使用的是 `cover` 逻辑，也就是“铺满屏幕，超出部分从中心裁掉”：

```text
原图等比缩放到刚好盖满目标画布
然后从中心裁出 width x height
```

例如：

```text
原图：3024 x 4032
设备：680 x 960
```

服务器先计算缩放比例：

```text
scale = max(680 / 3024, 960 / 4032)
```

然后等比缩放，再居中裁出 `680 x 960`。

第一版建议只支持 `cover`，因为 APP 调试页也是这个逻辑。后续如果产品需要完整显示整张图，可以再加 `contain`：

```text
contain = 整张图完整显示，不裁剪，不足区域用白底填充
```

### 5.4 生成 RGBA

裁剪缩放后，服务器得到一张刚好等于设备尺寸的 RGBA 图片。

要求：

```text
RGBA 长度 = width x height x 4
每个像素顺序 = R, G, B, A
```

如果目标是尽量对齐 APP，可以先按 APP 当前逻辑：

- 对比度：`1.12`
- 饱和度：`1.28`
- 调色板：APP 6 色基准
- 颜色距离：RGB 欧氏距离
- 抖动：Floyd-Steinberg

### 5.5 六色量化

电子墨水屏只有六种可用颜色。服务器要把每个 RGB 像素归到这六个颜色之一。

APP 当前使用的六色调色板是：

| 颜色 | nibble | RGB 参考值 |
| --- | --- | --- |
| 黑 | 0x0 | 0, 0, 0 |
| 白 | 0x1 | 255, 255, 255 |
| 黄 | 0x2 | 255, 246, 32 |
| 红 | 0x3 | 129, 22, 0 |
| 蓝 | 0x5 | 47, 77, 151 |
| 绿 | 0x6 | 57, 109, 68 |

量化步骤：

```text
1. 读取当前像素 RGB
2. 先做对比度和饱和度增强
3. 计算它和六个调色板颜色的距离
4. 选择距离最近的颜色
5. 写入这个颜色对应的 nibble
```

RGB 欧氏距离的公式：

```text
dist = (r - paletteR)^2 + (g - paletteG)^2 + (b - paletteB)^2
```

### 5.6 Floyd-Steinberg 抖动

如果只做最近色匹配，照片会出现大色块，过渡很硬。APP 当前用了 Floyd-Steinberg 抖动。

大白话解释：

```text
当前像素被强行变成六色之一以后，肯定会有误差。
比如原来是浅红色，但只能变成红色或白色。
这个误差不要直接丢掉，而是分一点给右边和下一行的像素。
肉眼看起来就会像更多中间色。
```

标准 Floyd-Steinberg 权重：

```text
当前像素 X

        X   7/16
  3/16 5/16 1/16
```

也就是误差分给：

```text
右边：7/16
左下：3/16
下方：5/16
右下：1/16
```

### 5.7 打包成 4bpp

量化后，每个像素已经变成一个 nibble。

服务器需要把两个 nibble 打包成一个 byte：

```text
byte = (leftPixelNibble << 4) | rightPixelNibble
```

注意：

- 高 4 位是前一个像素。
- 低 4 位是后一个像素。
- 这个顺序要和固件当前协议一致。

### 5.8 计算 CRC32

服务器生成 `frame.bin` 后，计算整图 CRC32。

当前协议使用的是 CRC32-MPEG2：

```text
初始值：0xFFFFFFFF
多项式：0x04C11DB7
输入不反转
输出不反转
最终不异或
```

服务器返回给小程序时带上 CRC，小程序可以先校验一次，再交给 BLE 协议发送。

固件最终也会在 `0x22` 结束阶段校验 CRC。

## 6. 小程序和服务器接口建议

### 6.1 最小可验证版本

第一版建议先做最小链路，快速验证画质：

```text
小程序直接 uploadFile 上传原图
服务器同步处理
服务器返回 frame.bin 或 frame 下载地址
小程序下载 frame.bin
小程序走现有 BLE 发送
```

接口示例：

```http
POST /api/image-frame/convert
Content-Type: multipart/form-data
```

表单字段：

| 字段 | 说明 |
| --- | --- |
| file | 原图文件 |
| width | 设备宽度 |
| height | 设备高度 |
| screenType | 设备屏幕类型 |
| cropMode | 默认 cover |
| paletteId | 默认 app-6color |
| dither | 默认 true |
| contrast | 默认 1.12 |
| saturation | 默认 1.28 |

返回方式一：直接返回二进制。

```http
HTTP/1.1 200 OK
Content-Type: application/octet-stream
X-Frame-Width: 680
X-Frame-Height: 960
X-Frame-Size: 326400
X-Frame-Crc32: 1A2B3C4D
```

返回 body 就是 `frame.bin`。

返回方式二：返回 JSON + 下载地址。

```json
{
  "taskId": "img_20260622_001",
  "width": 680,
  "height": 960,
  "format": "six-color-4bpp",
  "dataSize": 326400,
  "crc32": "1A2B3C4D",
  "downloadUrl": "https://example.com/api/image-frame/img_20260622_001/frame.bin",
  "pipeline": {
    "cropMode": "cover",
    "paletteId": "app-6color",
    "dither": "floyd-steinberg",
    "contrast": 1.12,
    "saturation": 1.28
  }
}
```

建议第一版用“JSON + 下载地址”，调试和排查会更方便。

### 6.2 分段上传版本

如果原图较大，或者用户网络不稳定，可以做分段上传。

大白话解释：

```text
不要一次性上传整个大文件。
先把图片切成很多小片，比如每片 512KB。
哪一片失败，就只重传那一片。
全部传完后，服务器再拼回完整原图。
```

分段上传流程：

```text
1. 小程序请求创建上传任务
2. 服务器返回 uploadId 和建议分片大小
3. 小程序按 partIndex 上传每个分片
4. 服务器记录每片是否收到
5. 小程序通知服务器合并
6. 服务器校验完整文件 hash
7. 服务器开始图片转换
```

接口示例：

创建上传任务：

```http
POST /api/image-frame/uploads/init
Content-Type: application/json
```

请求：

```json
{
  "fileName": "photo.jpg",
  "fileSize": 8388608,
  "mimeType": "image/jpeg",
  "fileHash": "sha256-of-full-file",
  "width": 680,
  "height": 960,
  "screenType": 2
}
```

响应：

```json
{
  "uploadId": "upl_abc123",
  "partSize": 524288,
  "uploadedParts": []
}
```

上传单个分片：

```http
POST /api/image-frame/uploads/upl_abc123/parts
Content-Type: multipart/form-data
```

表单字段：

| 字段 | 说明 |
| --- | --- |
| partIndex | 第几片，从 0 开始 |
| partHash | 当前分片 hash |
| chunk | 当前分片二进制 |

响应：

```json
{
  "uploadId": "upl_abc123",
  "partIndex": 0,
  "received": true
}
```

完成上传并开始转换：

```http
POST /api/image-frame/uploads/upl_abc123/complete
Content-Type: application/json
```

请求：

```json
{
  "fileHash": "sha256-of-full-file",
  "cropMode": "cover",
  "paletteId": "app-6color",
  "dither": true,
  "contrast": 1.12,
  "saturation": 1.28
}
```

响应：

```json
{
  "taskId": "img_20260622_001",
  "status": "processing"
}
```

查询转换任务：

```http
GET /api/image-frame/tasks/img_20260622_001
```

响应：

```json
{
  "taskId": "img_20260622_001",
  "status": "done",
  "width": 680,
  "height": 960,
  "dataSize": 326400,
  "crc32": "1A2B3C4D",
  "downloadUrl": "https://example.com/api/image-frame/img_20260622_001/frame.bin"
}
```

状态可以包括：

```text
pending     等待处理
processing  正在处理
done        处理成功
failed      处理失败
expired     任务过期
```

## 7. 小程序拿到 frame.bin 后怎么发给固件

小程序拿到服务器生成的 `frame.bin` 后，后续继续走现有图传协议。

当前固件图传流程：

```text
0x20 IMG_START  开始图传
0x21 IMG_DATA   分包发送图片数据
0x22 IMG_END    结束并让固件校验 CRC / 写入 Flash
```

小程序需要做：

```text
1. 下载 frame.bin
2. 确认 dataSize == width x height / 2
3. 可选：本地计算 CRC32，确认和服务器返回一致
4. 选择设备空闲槽位
5. 调用现有 deviceBle.uploadImage
6. 上传成功后刷新显示该槽位
```

这一步不需要服务器参与。

## 8. 为什么这能提升效果

普通小程序的问题在于图片处理能力不可控：

- Canvas 缩放算法由微信底层决定。
- `imageSmoothingQuality` 不一定在所有设备上表现一致。
- `getImageData` 拿到的像素可能受微信解码、颜色空间、压缩路径影响。
- 小程序不能像 Android 原生一样控制 `BitmapFactory`、`ARGB_8888`、`inSampleSize`。

服务器方案可以把这些不可控因素移走：

- 服务端图片库固定。
- 缩放算法固定。
- EXIF 方向处理固定。
- sRGB 转换固定。
- 六色量化算法固定。
- 同一张图在不同手机上处理结果一致。

这样小程序端就不再负责“画质相关计算”，只负责传输。

## 9. 风险和代价

### 9.1 需要网络

用户必须联网才能转换图片。如果用户离线，无法使用服务器转换。

可选兜底：

```text
联网时：服务器转换，效果更好
离线时：小程序本地 Canvas 转换，效果一般但可用
```

### 9.2 有服务器成本

图片解码、缩放、抖动会消耗 CPU 和内存。

建议：

- 限制单图大小。
- 限制并发任务。
- 转换结果设置过期时间。
- 相同文件 hash + 相同参数可以复用缓存。

### 9.3 图片隐私

用户照片会上传到服务器，需要有明确策略。

建议：

- 明确告知用户图片会用于生成设备图传数据。
- 原图只临时保存。
- 转换完成后定时删除原图。
- `frame.bin` 也设置过期时间。
- 后台日志不要记录图片内容。

### 9.4 HEIC / Live Photo 等格式

iPhone 相册可能有 HEIC。服务器需要明确是否支持。

如果第一版不支持 HEIC，需要返回清晰错误：

```text
当前图片格式暂不支持，请选择 JPG/PNG 图片
```

如果支持，需要后端图片库确认部署环境有 HEIC 解码能力。

## 10. 推荐落地阶段

### 阶段 1：验证画质

目标：先证明服务器转换确实比小程序 Canvas 好。

做法：

```text
1. 小程序 uploadFile 上传原图
2. 服务器同步转换
3. 返回 frame.bin 下载地址
4. 小程序下载后走现有 BLE
```

这一阶段不做复杂分段上传，不做任务队列，不做缓存。先用最短路径验证画质。

### 阶段 2：补齐稳定性

目标：让真实用户可用。

增加：

- 转换任务状态。
- 错误码。
- 文件大小限制。
- 超时处理。
- 下载重试。
- 转换结果过期删除。

### 阶段 3：支持分段上传

目标：解决大图和弱网问题。

增加：

- 分片上传。
- 断点续传。
- 分片 hash。
- 完整文件 hash 校验。
- 上传任务恢复。

### 阶段 4：效果继续调优

目标：比 APP 更稳定、更接近原图。

可继续优化：

- 不同屏幕型号使用不同 palette。
- 不同设备批次使用不同校准档。
- 支持 Atkinson / Floyd / 有序抖动切换。
- 做上传前预览图。
- 存储每次转换参数，方便问题复现。

## 11. 后端需要确认的问题

后端实现前建议确认：

1. 后端技术栈是什么，是否方便使用成熟图片库。
2. 是否需要支持 HEIC。
3. 单张图片最大允许多大。
4. 服务器转换结果保存多久。
5. 原图是否保存，保存多久。
6. 是否需要用户鉴权和设备归属校验。
7. 第一版是否先用普通上传，不做分段。
8. `frame.bin` 是直接返回二进制，还是返回下载地址。
9. 是否需要把转换参数和 CRC 存入数据库。
10. 如果同一张图重复转换，是否做缓存。

## 12. 小程序需要改什么

第一版小程序需要改动：

```text
1. 新增“服务器转换上传”入口
2. 选择原图后上传给服务器
3. 等服务器返回 frame.bin 元信息
4. 下载 frame.bin 为 ArrayBuffer
5. 校验 dataSize / CRC
6. 复用现有 deviceBle.uploadImage 发送给固件
```

已有 BLE 图传逻辑可以继续使用，不需要重写。

## 13. 固件需要改什么

第一版固件不需要改。

原因：

```text
服务器生成的仍然是固件当前协议要求的六色 4bpp raw 数据。
小程序仍然按现有 0x20 / 0x21 / 0x22 发送。
固件看到的数据格式没有变化。
```

除非后续想让固件直接支持 JPG/PNG 解码，否则固件无需参与服务器转换方案。

## 14. 最小闭环总结

最小可落地版本可以这样理解：

```text
小程序选原图
  -> 上传给服务器
  -> 服务器生成 frame.bin
  -> 小程序下载 frame.bin
  -> 小程序用现有 BLE 图传发给固件
```

这个方案的价值是：

```text
绕开微信小程序 Canvas/getImageData 对画质的影响，
把图片处理放到可控的服务器环境，
让不同手机、不同微信版本处理出来的图尽量一致。
```

