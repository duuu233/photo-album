# 项目知识地图

> 状态：current
> 最后核对：2026-08-04
> 适用范围：`photo-album` 微信小程序及直接相关的接口、BLE/OTA 协议和跨端协作

本目录保存所有项目文档型 Markdown。仓库根目录只保留 `AGENTS.md`，因为它是代理工具自动发现的项目指令文件，不属于普通项目文档。

## 当前长期知识

### Architecture

| 文档 | 职责 |
| --- | --- |
| [设备身份与 BLE 会话](architecture/device-identity-and-connection.md) | 完整 6 字节设备 ID、广播候选、BLE 临时句柄、会话认领和重连不变量 |
| [图片投屏流水线](architecture/image-projection-pipeline.md) | 预览、seekink 出帧、后端建记录、BLE 图传、记账与性能并行 |
| [照片预览与非破坏性编辑](architecture/photo-preview-editing.md) | 常驻编辑、按张状态、横竖向取景、设备动态角度导出和缓存策略 |
| [AI 客户端架构](architecture/ai-client.md) | BoltStar 客户端边界、会话、消息图片、错误处理和未完成能力 |

### Protocols

| 文档 | 职责 |
| --- | --- |
| [OTA / DFU 协议](protocols/ota-dfu.md) | FF10/FF11、F1/F2/F3/FC 帧、结果码、尾包与成功判定 |

### Decisions

| 文档 | 职责 |
| --- | --- |
| [设备图片槽位索引](decisions/image-slot-index.md) | `imgIndex` 物理身份、0 号位、幽灵记录和失败一致性 |
| [电量缓存与平滑刷新](decisions/battery-cache-and-refresh.md) | 15 秒 TTL、在途去重、旧值平滑展示和禁止假值兜底 |

### Reference

| 文档 | 职责 |
| --- | --- |
| [客户端接口矩阵](reference/client-api-matrix.md) | BoltFox 客户端接口、平台适用性和当前接入状态 |
| [BoltStar AI 参考文档](reference/ai/README.md) | 当前/历史 API 版本与错误码草案入口 |

## 变更记录

- [2026-08-04 广播 Device_ID 由 4 字节扩到 6 字节：搜索页设备ID 与详情页对齐](changes/2026-08-04-广播设备ID扩到6字节.md) — **双端已同步**；⚠️ 客户端必须先于固件灰度上线
- [2026-08-04 竖向构图改按设备 `verticalRotation` 旋转（缺省不旋转）](changes/2026-08-04-竖向旋转改由verticalRotation决定.md) — **双端已同步**；取代「竖向固定 180°」口径
- [2026-08-04 首页折叠屏滚动适配 +「我的相册」合并「设备照片」与「投屏管理」](changes/2026-08-04-折叠屏滚动适配与我的相册合并.md) — **双端已同步**（Flutter 见 `flutter/docs/history/2026-08/2026-08-04-我的相册合并与折叠屏核对.md`；折叠屏一项 App 核对后无需改动）
- [2026-08-04 小程序文案、多图首图刷新与竖向旋转](changes/2026-08-04-小程序电子纸设备文案与多图首图刷新.md) — 仅小程序，Flutter 待按文档同步
- [2026-08-03 结果页底部按钮间距 + 抖动接口 `-118` 连接超时定位](changes/2026-08-03-结果页按钮间距与抖动接口连接超时.md) — 仅小程序，Flutter 未同步
- [2026-08-02 选图上限 10 张、预览切图闪回、命名弹窗「稍后」、容量行 `已用/上限`](changes/2026-08-02-选图上限与预览切图四项.md) — **双端已同步**（Flutter 见 `flutter/docs/history/2026-08/2026-08-02-选图上限与预览切图四项.md`）
- [2026-08-02 导航栏设备下拉：与菜单同宽、整体居中、让开微信胶囊](changes/2026-08-02-导航栏设备下拉居中与同宽.md) — **双端已同步**（Flutter 见 `flutter/docs/history/2026-08/2026-08-02-导航栏设备下拉居中与同宽.md`）
- [2026-08-01 交互与文案十一项优化](changes/2026-08-01-交互与文案十一项优化.md) — **双端已同步**（Flutter 见 `flutter/docs/history/2026-08/2026-08-01-交互与文案十一项优化.md`）
- [2026-07-31 设备与照片交互优化阶段记录](changes/2026-07-31-设备与照片交互优化阶段记录.md) — **双端已同步**
- [2026-07-31 设备动态旋转角与 AI 视觉补全](changes/2026-07-31-设备旋转角与AI视觉补全.md)
- [2026-07-30 设备身份登记表（未连接设备被误报「请删除后重新绑定」）](changes/2026-07-30-设备身份登记表.md) — **双端已同步**（Flutter 见 `flutter/docs/history/2026-07/2026-07-30-FBP连接优化与身份登记表.md`）
- [2026-07-29 AI 接口 JWT 鉴权请求头](changes/2026-07-29-AI接口JWT鉴权头.md)
- [2026-07-29 图库设备筛选从设备名改为设备 ID](changes/2026-07-29-图库设备筛选按设备ID.md)
- [2026-07-29 投屏管理 Tab 即时切换与列表局部 loading](changes/2026-07-29-投屏管理Tab即时切换.md)
- [2026-07-29 蓝牙搜索改「边搜边显示」+ AI 发送去重 + 详情页分辨率](changes/2026-07-29-蓝牙边搜边显示与AI发送去重.md)
- [2026-07-28 AI 网关错误提示与服务协议 v2](changes/2026-07-28-AI网关错误与服务协议v2.md)
- [2026-07-28 AI 服务协议与按用户授权](changes/2026-07-28-AI服务协议.md)
- [2026-07-22 照片预览需求调整](changes/2026-07-22-照片预览需求调整.md)
- [2026-07-24 AI 模块开发进度](changes/2026-07-24-AI模块开发进度.md)

新重要变更使用：

```text
docs/changes/YYYY-MM-DD-topic.md
```

建议包含以下章节：

```markdown
# Change Title

## Background
## Problem
## Solution
## Affected Areas
## Technical Decisions
## Risks
## Follow-up
```

## 归档

[archive/](archive/README.md) 保存旧方案、排障过程、性能实验、审查清单、接入进度和跨仓库交接。归档文档只回答历史问题，不能作为当前实现的权威来源。

## CodeGraph 与 Markdown

### CodeGraph：当前代码真相

用于回答：

- 文件、函数和常量当前在哪里；
- 谁调用谁、改动影响哪些代码；
- 当前入口、调用链、数据流和测试候选；
- 重构前后的依赖变化。

不要在 Markdown 中长期手工维护可由 CodeGraph 实时推导的完整函数、调用者和行号清单。

### Markdown：长期项目记忆

用于回答：

- 为什么这样设计；
- 产品和业务口径是什么；
- API、BLE、OTA 等外部约束是什么；
- 哪些方案被否决以及原因；
- 重要 Bug、性能、安全和一致性风险；
- 真机验证结果、跨端交接和后续工作。

## 维护流程

### 修改前

1. 运行 `codegraph status`。
2. 用 `codegraph explore "<问题、文件或符号>"` 理解当前实现和影响面。
3. 从本页找到该领域唯一的长期主文档。

### 修改后

1. 运行相关测试、静态检查和必要的真机验证。
2. 代码结构变化时运行：

   ```powershell
   codegraph sync
   codegraph status
   ```

3. 架构、协议、API、安全、性能或重要 Bug 变化时更新长期主文档，并创建日期型变更记录。
4. 纯重命名或等价重构通常只需同步 CodeGraph，删除文档中的过期符号引用。

## 文档生命周期

新文档在标题后加入：

```markdown
> 状态：current | draft | planned | superseded | archived
> 负责人：姓名或团队
> 最后核对：YYYY-MM-DD
> 适用范围：小程序 | Flutter | 后端 | 固件
> 权威来源：链接或文档路径
> 取代/被取代：无或文档路径
```

冲突处理顺序：

1. 上游当前 API/协议/固件规范；
2. 当前源码和已同步 CodeGraph；
3. 标记为 `current` 的架构、协议和决策文档；
4. 日期型变更记录；
5. archive 中的历史快照。

实现与批准的需求或外部契约不一致时，不静默修改文档迁就代码；应明确决定修改实现还是更新决策。

## 定期维护

- 每个重要变更：探索影响、测试、同步 CodeGraph、更新主文档和变更记录。
- 每两周：核对待真机验证、待后端确认和跨端同步事项。
- 每个发布：复核接口、设备协议、权限、安全和数据一致性。
- 每季度：检查断链、乱码、截断、重复主文档和长期未核对的 `current` 文档。
