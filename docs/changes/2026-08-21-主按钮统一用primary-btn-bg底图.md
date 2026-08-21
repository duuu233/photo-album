# 底部主按钮统一改用 primary-btn-bg.png 底图（2026-08-21）

> 状态：**已实现**，**未真机验收**
> 最后核对：2026-08-21
> 适用范围：微信小程序 首页 / 搜索设备 / OTA / 投屏预览 / 投屏结果 / 设置类页面 / 「选择投屏设备」弹层
> 公共样式：`styles/cta-button.wxss`（由 `app.wxss` 全局 `@import`）
>
> ⚠️ 仅小程序，Flutter APP 待同步。

## 一、产品要求

所有用 `background: linear-gradient(90deg, #ff8338, #ff621f)` 的**底部按钮**，改成和图片详情那枚
`.cta-button` 一样、用 `assets/images/primary-btn-bg.png` 当底；**文案与功能不变**。

## 二、做法：底图只能是子节点，不能写进 CSS

⚠️ **小程序的 WXSS 不能用 `url()` 引本地图片**（只认网络图或 base64），所以底图必须是按钮里的一个 `<image>` 子节点：

```html
<view class="某某按钮">
  <image class="cta-button-bg" src="/assets/images/primary-btn-bg.png" mode="scaleToFill"></image>
  文案
</view>
```

公共类 `.cta-button-bg` 原来是给图片详情那枚 654×112rpx 的按钮写的，几何写死成 `726×184rpx` + `-36/-30rpx` 偏移；
本次**改成百分比**，任意尺寸的按钮都能直接套：

| 属性 | 值 | 来历 |
| --- | --- | --- |
| `width` | `111.009%` | 726 / 654（底图整幅 ÷ 胶囊实体宽） |
| `height` | `164.286%` | 184 / 112 |
| `left` | `-5.505%` | −36 / 654（胶囊在底图里的左边距） |
| `top` | `-26.786%` | −30 / 112 |

百分比的 `top` 按父盒**高**算、`left` 按父盒**宽**算，代入后**胶囊实体恰好铺满按钮盒本身**，外发光溢到盒外；
按钮多宽多高都对得上，胶囊圆角跟着按钮高度等比缩放，不会被拉成椭圆。图片详情那三处按钮尺寸正好是 654×112，
换成百分比后渲染结果与改动前完全一致。

## 三、改了哪些按钮（7 个类、14 个节点）

| 页面 / 组件 | 选择器 | 节点数 |
| --- | --- | --- |
| 首页（绑定流程贴底 + 未绑定弹层 + 离线弹层） | `pages/home/home.wxss .primary-action` | 3 |
| 搜索设备（立即绑定 / 取消搜索 / 重新扫描） | `subpackages/device/bind` `.primary-action` | 3 |
| 固件升级 | `subpackages/device/ota` `.ota-primary` | 1 |
| 投屏预览「开始投屏」 | `subpackages/projection/preview` `.preview-submit` | 1 |
| 投屏结果（继续投屏 / 重新投屏） | `subpackages/projection/result` `.result-primary` | 2 |
| 设置类共用主按钮（保存设置 / 立即更新 / 确认） | `subpackages/settings/shared.wxss .primary-btn` | 3 |
| 「选择投屏设备」弹层「连接并投屏」 | `components/device-picker-sheet` `.picker-confirm` | 1 |

每个按钮：去掉橙色渐变**与那层橙色外发光 `box-shadow`**（发光已经画在底图里，两层叠着会糊出一圈脏边），
其余（高度、圆角、字号字重、文案、事件）一律没动。

## 四、两个必须注意的坑

1. **层叠上下文**：底图是 `z-index: -1` 的子节点，只有当按钮自己 `position` 非 static **且 `z-index` 非 auto** 时，
   它才停在按钮这一层（在按钮背景之上、文案之下）。否则会掉到**父级背景**底下——弹层是白底，图直接看不见。
   所以给原本只有 `position: relative` 的按钮补了 `z-index: 0`（`.preview-submit`/`.primary-btn` 本来就有 z-index）。
2. **自定义组件样式隔离**：`app.wxss` 的全局 `@import` **对自定义组件不生效**，
   `device-picker-sheet` 必须自己 `@import "../../styles/cta-button.wxss"`（它在主包，不涉及分包互引）。

**禁用态**（`.preview-submit.is-disabled` / `.picker-confirm--disabled` / `.disabled-btn`）：
把底图 `display: none` 藏掉，露出原来的灰底——否则橙色底图盖在灰底上，按钮看着还是可点的。

## 五、**没有**改的橙色渐变（都不是底部按钮）

- `subpackages/settings/shared.wxss` `.confirm-btn` —— 弹窗里的小确认按钮（72rpx 高，与「取消」成对）；
- `subpackages/device/debug/debug.wxss` 四处 —— 调试台的 `.btn-primary`（84rpx）、`.btn-mini`（64rpx）、
  `.scan-go`（小胶囊）与 **`.progress-fill`（进度条填充，根本不是按钮）**；
- `subpackages/gallery/list` `.category-chip--active`、`subpackages/token/records` `.tab-item--active`
  —— 分类 chip 与 Tab，且用的是 `#f2621f` 那一版渐变；
- `pages/home/home.wxss` `.bind-pill`（未绑定首页中部的「绑定设备」胶囊，`#ff8538` 那一版）。

要一起换的话说一声，做法完全相同。

## 六、测试

`tests/primary-button-bg.test.js`（新增）锁五件事：七个按钮的样式里不许再有那条橙色渐变、
模板里必须有对应数量的 `<image class="cta-button-bg">`、每个按钮都建立了层叠上下文（position + z-index）、
公共类的百分比几何（并代入 654×112 / 638×112 / 500×104 / 320×88 等尺寸验算「胶囊正好铺满按钮」）、
三处禁用态把底图藏掉。全量 54 个用例文件通过。

## 七、待办

- ⚠️ 真机未验：底图是磨砂 + 外发光的整图，深浅背景上的观感、以及各按钮宽度下发光的扩散范围需要真机确认。
