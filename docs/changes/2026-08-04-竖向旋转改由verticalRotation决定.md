# 2026-08-04 照片预览：竖向构图改按设备 `verticalRotation` 旋转（缺省不旋转）

> 状态：**双端已实现**，**未真机验收**（旋转方向必须真机确认）
> 最后核对：2026-08-04
> 适用范围：微信小程序 + Flutter APP 的照片预览/投屏出图链路
> 权威来源：本次产品需求、当前双端源码
> 取代/被取代：取代 `2026-07-31-设备旋转角与AI视觉补全.md` 里「竖向固定 180°」那条约束

## 需求

> 以前只有横向是旋转，现在竖向是根据新增的 `verticalRotation` 参数旋转，假如没有就默认不旋转，
> 然后在调用接口和传给设备。

拆成三条可验证的口径：

1. **竖向**构图的导出旋转角 = 设备接口新增字段 `verticalRotation`；
2. 该字段**缺失 / 为空 / 非法值 → 0°，即不旋转**（此前是所有设备一律固定 180°）；
3. 这个角度作用在**上传给抖动接口、随后 BLE 图传到设备的那张成品图**上，不是页面展示朝向。

**横向不变**：仍取设备 `rotationDegree`，缺失回退历史 270°。

## 行为变化（会影响现网设备，必须知会）

后端补齐 `verticalRotation` 之前，**所有设备的竖向投屏都不再旋转 180°**。
如果现有设备本来就依赖那个 180°（相框正装时画面才正），后端必须给这批设备下发
`verticalRotation = 180`，否则用户会看到画面倒过来。这是本次需求的直接后果，不是缺陷。

## 角度取值口径（两端同源）

| 取景方向 | 角度来源 | 缺省 |
| --- | --- | --- |
| 竖向 portrait | 设备 `verticalRotation` | **0°（不旋转）** |
| 横向 landscape | 设备 `rotationDegree` | 270°（历史行为） |

- **0 是合法角度**：判空只能判 `undefined/null/''`，写成 `raw || 默认角` 会把「设备明确要求不转」
  当成缺失又转回默认角。两端的实现与单测都锁了这一条。
- 同一角度必须同时用于：① 画布导出；② 手机端反向预览；③ 烘焙缓存指纹。
  分头取值就会出现「设备上正了、手机预览里倒了」或「改了角度却命中旧缓存」。

## 小程序改动

| 文件 | 改动 |
| --- | --- |
| `utils/device-rotation.js` | 删除 `PORTRAIT_ROTATION_DEG`（固定 180）；新增 `verticalDegreeFor(device)`（缺省 0）、`normalizeDegree`、`isQuarterTurn`；`exportDegreeFor` 竖向改走 `verticalDegreeFor` |
| `subpackages/projection/preview/preview.js` | `_bakeToFile` 放大系数 `k` 改按「导出角是否对调轴向」判定；`coverCropOne`（未编辑图）由固定 180° 改按竖向导出角，并在奇数直角时对调裁切比例与目标矩形；`computeBakedImgStyle` 反向预览改按导出角，`computeRotatedImgStyle` 增加 `degree` 入参；新增 `verticalRotationDegree` 到 data |
| `pages/home/home.js` | 首页展示模型透传 `verticalRotation`（与 `rotationDegree` 同一处；⚠️ 原样透传，不能在这里补默认值） |
| `subpackages/projection/result/result.js` | 「重新投屏」注释里的「竖向固定 180°」口径更新 |
| `tests/device-rotation.test.js` | 重写：覆盖竖向新字段、0 与缺失的区分、兼容名优先级、`isQuarterTurn` |

设备列表/详情/图库/记录等页面传给预览页的设备对象都是 `Object.assign` 全量展开
（`utils/api.normalizeDevice` 同理），`verticalRotation` 自动透传，只有首页那份**手写字段子集**
需要补一行——这类子集是这次唯一容易漏的地方。

### `k`（取景框 px → 画布 px）的规则被收敛了

原来写成「横向用 `outH/frameW`、竖向用 `outW/frameW`」，实际决定它的是**导出角是否对调轴向**：

- 奇数直角（90/270，横向默认 270 即属此类）→ 框宽落到画布高 → `k = outH / frameW`；
- 0/180（竖向默认 0、旧的竖向 180 都属此类）→ 框宽落到画布宽 → `k = outW / frameW`。

新规则在两个方向的既有取值上与旧写法完全等价，额外支持了「竖向配 90/270」这种设备。

## Flutter 改动

| 文件 | 改动 |
| --- | --- |
| `state.dart` | `DeviceItem` 新增 `verticalRotation`（int，默认 0）；`_deviceFromJson` 解析 `verticalRotation`（`_asInt` 对缺失/非法值返回 0，正好等于「不旋转」） |
| `features/cast/presentation/cast_preview_page.dart` | `_kExportRotateDeg` 更名 `_kLandscapeExportRotateDeg`；新增 `_exportRotateDegOf(orientation)`、`_isQuarterTurn`、`_reverseQuarterTurns`；`_bake` 改按导出角旋转、`k` 按对调轴向判定；`_BakedPreview` 记下 `exportDeg`，展示侧 `RotatedBox` 的圈数改按 `-exportDeg` 算 |
| `features/cast/cast_image_editor.dart` | `coverCropToSize` / `_coverCrop` 新增 `rotateDegrees`：未编辑图裁切缩放后整幅旋转，奇数直角时先对调裁切比例与缩放目标 |

### App 侧两处与小程序不同，需要留意

1. **展示框形状看方向，画面转多少看导出角**——这两件事在 App 里是分开的两个量
   （`_BakedPreview.landscape` 决定 `AspectRatio`，`exportDeg` 决定 `RotatedBox`）。
   小程序那边是一条 `imgStyle` 同时表达，别照抄成一个变量。
2. **未编辑图的旋转只支持 90 的整数倍**：`image` 包的 `copyRotate` 对非直角会放大画布留白边，
   直接破坏「上传图必须正好是设备像素」的铁律（帧字节数 = 宽×高÷2）。给了别的角度时保持不转 ——
   宁可方向不对也不能把尺寸搞错。编辑图走 `ui.Canvas`，任意角度都能保持画布尺寸。
3. **横向角 App 仍写死 270°**，没有读后端 `rotationDegree`（既有差异，本轮未动）。

## 风险与待确认

- **旋转方向需真机确认**：小程序 canvas、Flutter `ui.Canvas` 都是「正角顺时针」，两端一致；
  但 Flutter 未编辑图那条路走的是 `image` 包的 `copyRotate`，**其正角方向本轮未能实测**。
  `180°` 不受方向影响，`90/270` 必须真机对比「编辑过的图」与「没编辑的图」是否同向。
- **`verticalRotation` 的字段名与取值范围待后端确认**：两端都按 `verticalRotation` 读，
  并兼容 `verticalRotationDegree` / 全小写两种写法（定稿后删兼容分支）；
  取值假定是 0/90/180/270。
- Flutter 本机无 SDK，**未编译**（未跑 `flutter analyze` / `flutter test`）。
- 小程序 `tests/device-rotation.test.js` 已通过；画布几何本身没有自动化测试，仍需真机看成像。

## 建议回归（真机）

1. 设备下发 `verticalRotation = 0` / 不下发：竖向投屏画面与手机预览一致，**不旋转**；
2. 下发 `180`：竖向投屏画面在设备上转 180°，手机预览里仍是用户构图的正向画面；
3. 同一台设备上「编辑过的图」与「没编辑直接投的图」方向必须一致（这是最容易漏的回归点）；
4. 横向投屏不受影响（仍按 `rotationDegree`，缺失 270°）；
5. 多图批量投屏里混编辑图与未编辑图，逐张核对方向；
6. 若后端会下发 90/270，另做一轮真机验证（含 App 未编辑图那条路径）。
