# 设备身份与 BLE 会话

> 状态：current  
> 最后核对：2026-07-31
> 适用范围：微信小程序 + Flutter（身份补齐链 2026-07-30 已双端同步）  
> 2026-07-31 补充（Flutter）：`refreshDevices` 里「按会话回填 connected」原本排在
> `_carryOverBleFields`（本地上一版身份）与 `_completeDeviceIdentities`（登记表）**之前**，
> 身份还没补齐就先判连接，刷新一次列表正连着的设备会整体掉成「未连接」——
> 轮播设置/一键清空等入口据此拦人，就是「明明连着却提示请先连接设备」。已把判连接移到补齐之后；
> 入口门禁另加 `PhotoFrameState.resolveDeviceConnected`（先查登记表补完整 ID 再判），
> 等价小程序的 `activeDevice.inheritStableIdentity`。  
> 当前实现：`utils/device-id.js`、`utils/active-device.js`、`utils/device-identity.js`、`utils/device-conn-cache.js`、`utils/device-ble.js`

## 目标

用户选择、页面展示、后端设备记录和 BLE 物理连接必须始终指向同一台相框。不得因为设备尺寸、名称、广播短 ID 或历史连接句柄相同而串用另一台设备的会话。

## 身份分层

| 字段 | 含义 | 是否可作为稳定物理身份 |
| --- | --- | --- |
| `userProductId` / 页面 `id` | 后端“用户绑定设备记录”的主键 | 只标识后端记录，不直接证明当前 BLE 会话属于该物理设备 |
| `productDeviceId` / `deviceNo` | `0x01 GET_INFO` 返回的完整 6 字节 `Device_ID`，统一为 `AA:BB:CC:DD:EE:FF` | 是 |
| 广播 Device ID | 厂商广播包中的设备地址：老固件 4 字节；**2026-08-04 起新固件为完整 6 字节 MAC** | **否**，只用于缩小扫描候选范围与列表展示。⚠️ 即使新固件长度已够，也**不得**用它认领会话/判重/入库——广播是明文、可被伪造重放，稳定身份一律以连上后 `0x01` 读回的值为准 |
| 微信 BLE `deviceId` / `bleDeviceId` | 本次扫描/系统分配的连接句柄 | 否，只在当前 BLE 会话中有效 |
| 设备名称、型号、屏幕尺寸 | 展示或候选筛选字段 | 否 |

## 身份补齐来源（2026-07-30）

后端「设备详情」`getUserProductDetail` 不返回设备 ID，详情页记录天生没有完整 6 字节身份，必须从别处补齐。
补齐来源按固定顺序取，登记表只作最后兜底，永不反向覆盖后端最新值：

```text
记录自身的完整 ID  >  fallback（selectedDevice，仅确认是同一台时才传入）  >  身份登记表
```

`utils/device-identity.js` 是按后端记录主键存的身份登记表（`userProductId -> AA:BB:CC:DD:EE:FF`，本机 storage）。
它的存在意义是让「这台设备的完整 ID」与「当前选中的是哪一台」解耦：`selectedDevice` 表示当前选中的那一台，
首页滑轮播卡、在列表里连别的设备都会改写它，只靠它补齐会在「连了 A 再进 C 的详情」时落空，
把一台没连接的好设备报成「请删除后重新绑定」（见
[2026-07-30 变更记录](../changes/2026-07-30-设备身份登记表.md)）。

登记时机：设备列表接口返回记录时、连接后 0x01 校验通过时。
清除时机：解绑该设备 `forget(userProductId)`、退出登录 `clear()`。

**凡是自己拉后端记录再发起连接的页面都必须走 `inheritStableIdentity`**：详情
`detail.js`、设备列表 `list.js`、轮播设置 `slideshow.js`、首页 `home.js`、固件升级 `ota.js`
（升级页 2026-08-11 补上，此前漏掉，表现为「点升级必报请删除后重新绑定」，见
[当日变更记录](../changes/2026-08-11-OTA删除测试模块与真实升级修复.md)）。

`utils/api.js normalizeDevice` 取设备 ID 时**完整 6 字节候选优先**：老记录同时带历史 4 字节
`deviceNo` 和完整 `deviceId` 时，按「第一个非空」会取到短的并被 `canonical` 归零，等于把一台
有完整身份的设备判成无身份。

Flutter 对应实现：`flutter/lib/src/device/device_identity_registry.dart`（同语义，
SharedPreferences 落盘）。**触发路径两端不同**：小程序是详情页 `selectedDevice` 继承落空；
Flutter 是 `refreshDevices` 整体替换列表而 `_carryOverBleFields` 不搬 `serialNumber`，
接口一次没下发 `deviceId` 就丢身份，之后 `connectBoundDevice` 的身份闸把好设备
拦在扫描之前。同一类故障、不同触发点。

## 连接与认领流程

```text
后端设备记录（完整 6 字节 ID）
  → 查找已连接会话
  → 若完整 ID 匹配，直接复用
  → 否则扫描广播，只筛选候选
  → 连接候选 BLE deviceId
  → 发送 0x01 GET_INFO
  → 严格比较完整 6 字节 Device_ID
      ├─ 匹配：认领会话、写直连缓存、回写 selectedDevice
      └─ 不匹配：断开、排除候选、继续扫描
```

设备是单连接设备。已经被本应用连接时通常不会继续广播，因此复用前必须先查活动会话；不能无条件重新扫描。

## 不变量

- 缺少合法完整 ID 时，绑定和自动重连必须终止，不能用短 ID、名称、尺寸或 BLE 句柄兜底。
  但「记录一时缺 ID」不等于「这台设备没有身份」：必须先走完上面的补齐来源，再判定拦截，
  否则会把没连接的正常设备报成需要删除重新绑定。
- 身份登记表只收完整 6 字节 ID，且只按记录自己的主键登记；短广播 ID、BLE 句柄不得入表，
  也不得借用另一条记录的主键登记，否则等于用缓存制造串台。
- 直连缓存只能保存“完整 ID 已校验通过”的映射；身份不匹配时必须清除被污染的缓存。
- 页面跳转传递后端记录主键；执行投屏、轮播、清空、删除、OTA 等物理操作前再次确认目标会话。
- `selectedDevice.connected` 只是缓存状态，不能单独证明真实连接；应以活动 BLE 会话和完整 ID 校验为准。
- 一个页面成功连接后，应把有效句柄和完整身份同步到全局选中设备，使首页、列表、详情和后续操作共享同一会话。
- 设备名称只用于展示，最长 20 个 Unicode 码点；改名不得写入或替换 BLE 身份字段。
- 新设备绑定落库并回填 `userProductId` 后，在绑定页带出默认名称进行一次“可跳过”的命名引导；确认保存后再按原路径返回。
- 设备列表展示顺序为“真实连接中的设备 > 最近绑定设备 > 接口原顺序”。排序与上移动画只影响 UI，不参与身份匹配。

## 失败处理

- 权限、蓝牙关闭、扫描超时、未找到目标和连接失败应保留具体原因，不统一吞成“请先连接设备”。
- 连接候选后发现完整 ID 不匹配不是普通网络失败，而是身份校验失败；应断开并继续寻找正确候选。
- 后端历史记录若只有 4 字节短 ID，应视为无效身份，迁移或删除后重新绑定。

## 验证

- `tests/device-id.test.js`
- `tests/active-device-identity.test.js`
- 真机至少使用两台相同型号、相同尺寸设备验证点击 A 不会连接 B。

## 历史来源

- [Flutter 设备身份同步交接快照](../archive/handoffs/flutter-device-identity-sync-handoff-2026-07-27.md)
- [客户端接口矩阵](../reference/client-api-matrix.md)
- [2026-07-16 代码审查记录](../archive/reviews/代码审查修复清单-2026-07-16.md)

