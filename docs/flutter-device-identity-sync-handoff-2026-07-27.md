# Flutter 兄弟项目设备身份串台修复中断记录

- 记录时间：2026-07-27 17:57（Asia/Shanghai）
- 兄弟项目：`D:\Work\learn\flutter`
- 当前项目：`D:\Work\learn\photo-album`
- 状态：按用户要求停止，尚未完成最终回归验收，未提交 Git。

## 问题

设备列表、首页、设备详情及后续投屏/轮播/OTA 页面之间跳转时，不能因为设备尺寸相同、广播短 ID 相同或旧的 `connected` 状态仍为 `true`，复用到另一台设备的 BLE 会话。页面和后续操作都应继续绑定用户点击的同一个后端设备 ID，并在物理操作前用固件 `0x01` 返回的完整设备 ID 校验当前会话。

## 2026-07-27 最终设备 ID 口径

- 稳定设备身份、页面“设备ID”展示及 `addUserProduct.deviceId` 一律使用 `0x01` 返回的完整
  6 字节 `Device_ID`，统一为 `AA:BB:CC:DD:EE:FF` 格式。
- 广播 4 字节短 ID 和平台 BLE 连接句柄仅用于扫描/建立连接，不得保存或上传为设备身份。
- 缺少完整 ID 时必须终止绑定/重连，不允许用短 ID、设备名、尺寸或 BLE 句柄兜底。
- 当前 Flutter 兄弟项目修复尚未按这一新增最终口径完成回归，后续同步时需补齐绑定 API 出口校验、
  展示字段和历史短 ID 记录处理。
- 本轮曾尝试同步 `D:\work\flutter`，后按用户最终要求已完整撤回；当前实际代码改动仅保留在
  微信小程序项目，Flutter 工作区未保留本轮同步代码。

## 已完成

已把修复写入 `D:\Work\learn\flutter`，当前为未提交修改，共涉及 13 个 Dart 文件：

- 路由进入设备详情时携带并快照 `userProductId`，详情页不再依赖可被其它页面改变的全局 `selectedDevice`。
- 详情、轮播、清空、删除和 OTA 全程使用进入页面时的同一个设备 ID。
- 新增 `PhotoFrameState.isDeviceActuallyConnected(deviceId)`，统一通过完整设备序列号和屏幕型号判断当前 BLE 会话是否属于目标设备。
- 断开和删除设备时，不再因过期的 `device.connected` 标记误断开另一台设备。
- 首页、设备列表、设备详情和 AI 投屏入口不再只看缓存的 `connected` 布尔值。
- 投屏进度页在真正传图前再次按目标设备 ID 确认/重连；投屏服务拒绝复用不匹配的 BLE 会话。
- OTA 页面固定目标设备 ID；读取版本和升级前均校验当前会话属于目标设备。
- `BleController.upgradeFirmware` 增加目标完整序列号和屏幕型号守卫。

## 已完成验证

1. `dart analyze lib test`
   - 本次新增代码的编译错误已修复。
   - 最终结果无 error。
   - 项目仍有 2 个 warning 和 38 个 info，均为原有未使用成员、异步 `BuildContext`、弃用 API 等存量问题。

2. `flutter test --reporter compact`
   - 运行到 42 项通过。
   - `test/widget_test.dart` 中 `app restores a persisted session and renders home safely` 失败：
     - 断言位置：第 30 行。
     - 现象：未找到文本“首页”。
   - 该测试不直接经过本次设备身份逻辑，但尚未完成单独复跑，不能在此时认定为偶发或无关。

## 中断点与后续待办

下次继续时按以下顺序执行：

1. 检查 `D:\Work\learn\flutter` 的 `git status --short` 和 `git diff --check`，确认这 13 个文件的未提交修改仍在。
2. 单独复跑失败用例：

   ```powershell
   & 'D:\Work\Flutter\flutter\bin\flutter.bat' test test\widget_test.dart --plain-name "app restores a persisted session and renders home safely" --reporter expanded
   ```

3. 运行设备 ID 专项测试：

   ```powershell
   & 'D:\Work\Flutter\flutter\bin\flutter.bat' test test\serial_match_test.dart --reporter expanded
   ```

4. 再跑一次全量测试，确认没有设备身份修复导致的回归。
5. 复核详情路由、投屏、轮播、清空、删除和 OTA 的最终 diff；必要时补充页面/状态层回归测试。
6. 用户确认后再决定是否提交 Git；当前没有创建提交。

## 临时文件

为了在无兄弟项目直接写权限的环境中安全生成补丁，当前项目根目录下创建过以下临时内容：

- `.flutter-sync-final/`
- `.flutter-sync-work/`
- `.flutter_identity_sync.patch`
- `.test.patch`

这些仅用于补丁生成和校验。按本次“立即停止”要求尚未清理；下次继续前可在确认路径完全位于 `D:\Work\learn\photo-album` 后删除。
