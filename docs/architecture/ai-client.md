# AI 客户端架构

> 状态：current  
> 最后核对：2026-07-31
> 适用范围：微信小程序“星宝”聊天与会话列表  
> 外部契约：[BoltStar API v1.0.4](../reference/ai/BoltStar-API-Doc-v2-1.0.4.md)

## 边界

- BoltStar 使用独立的 `utils/ai-api.js`，不复用 BoltFox `utils/request.js`。
- 原因是两者 Base URL、响应结构、错误码、超时和公共参数完全不同。
- 鉴权是唯一交集（2026-07-29 起网关强制）：每个 AI 请求带 `Authentication: Bearer <jwtToken>` 头，token 与 BoltFox 共用登录接口下发的 `jwtToken`（头名是 `Authentication`，不是 `Authorization`）；未登录不带头，由网关回 `JWTTokenIsMissing` 走白名单提示。
- 小程序使用 JSON 非流式 `/chat`；SSE 仅适用于支持流式读取的其它客户端。
- 聊天/生图超时较长，POST 不自动重试，避免重复生成或重复计费。

## 会话

- `user_id` 统一为 `boltfox_<userNo>`；未登录仅在演示场景使用兜底用户。
- 会话在首次真实发送消息时创建，并对并发创建做在途去重。
- `new_session` 参数已废弃；欢迎语由前端静态展示，不写入 API 历史。
- 每个用户最多 20 个会话；错误 `20013` 引导用户清理旧会话。
- 会话列表 `msg_count` 不可靠时，只对当前渲染项按需读取历史补数。
- 删除会话后通知正在打开该会话的聊天页重置。

## 消息与图片

- 小程序收到完整 JSON 回复后，用客户端打字机逐步展示。
- AI 同一轮的文字和图片属于同一个气泡。
- 用户图片先压缩到约 100KB，再经 BoltFox `setFileUpload` 取得 URL，最多 4 张并与文字一起发送。
- `img_orientation` 对外只发送 `vertical`、`horizontal`、`square`；界面别名在客户端归一化。
- 图片在加载前按已知比例预占空间，加载后用真实宽高校正。
- AI 图片投屏复用统一的[图片投屏流水线](image-projection-pipeline.md)。

## AI 服务协议与用户授权

- 文本对话、文生图和上传图片美化都会把用户本次主动发送的文字或图片交给阿里云百炼处理；用户可在“设置 → AI服务协议”查看完整条款。
- 用户首次进入 AI 聊天页时显示协议确认框。拒绝后输入框和历史浏览保持可用，但任何发送动作都必须再次提示并阻断，直到同意。
- 同意状态由 `utils/ai-service-consent.js` 按 BoltFox 用户 ID 隔离，并带协议版本 `2026-07-28-v2`；缓存缺失或协议版本更新都视为未同意。
- 普通发送、图文多模态、语音识别后直发和一键生图最终都经过同一授权检查，禁止新增绕过检查直接调用 `aiApi.chat()` 的页面路径。
- `app.clearSession()` 必须在清除 `userInfo` 前删除当前用户的同意记录，因此主动退出、注销成功和 401/406 登录态失效后都要重新确认。
- 同意缓存只表示用户已看过并授权本地客户端发起操作，不替代服务端内容安全、违规次数和封禁状态。

## 错误处理

- `utils/ai-i18n.js` 是客户端错误文案与分发入口。
- 2xxxx 参数/违规通常 toast；22002/22003 封禁使用弹窗并禁用输入。
- 20013 引导清理旧会话。
- 30xxx 上游错误在有重试回调时显示确认框。
- 未知错误降级到 31001。
- `detail` 只用于日志和排障，禁止展示给用户。
- 阿里云网关固定返回 `Code=JWTTokenIsMissing` 且 `Message=the jwt token is missing` 时例外：AI 请求层生成独立的受信 `userMessage`，toast 同时展示错误码、Message 和动态 `RequestId`，便于按请求追踪。不得把这一白名单机制扩展成直接展示任意 `detail` 或未知响应字段。
- 错误码定义以当前 BoltStar API 文档为准；历史草案只用于追溯。

## 当前未完成能力

- 语音转文字仍依赖未接入的小程序插件/服务。
- Token 支付体系仍是客户端演示逻辑，需等待后端接口。
- AI 图片 URL 有有效期，过期后不能保证下载或再次投屏。
- UI 部分图标仍可能使用占位资源。
- 官方图库模块未接入；当前自定义底栏只开放“首页 / AI对话 / 我的”三项。

## 当前 UI 与入口

- 小程序自定义底栏已开放“AI对话”，AI 仍为分包页面，通过 `navigateTo` 进入，不改变原生 TabBar 路由。
- 聊天页按 `assets/ai/UI` 重写为顶部会话入口与 Token、常驻工具输入卡、图片内联操作条和投屏设备底部弹层。
- 会话页按日期分组，顶部复用全局 `page-nav` 统一标题与返回样式；左滑时卡片实时跟随手指并在松手后吸附到删除位，删除操作使用 `assets/images/ai-del-btn-bg.png` 作为背景，同时保留长按删除兜底。
- 对话页与会话页统一使用 2026-07-31 指定的 OSS 全屏背景；新增设计稿中实际使用的图标已以英文名迁移到 `assets/images`。
- Token 胶囊读取微信原生胶囊位置，固定放在其左侧并垂直居中，避免自定义导航内容重叠。
- `assets/images/ai-*.png` 是运行时资源；仅供设计对照或尚未启用的 `assets/ai/UI`、`assets/ai/图标` 已在 `project.config.json` 中排除打包。
- 调试台暗门已移除，正式入口不再依赖口令。

## 历史来源

- [AI 小程序 UI 接入与入口开放](../changes/2026-07-30-AI小程序UI接入与入口开放.md)
- [设备动态旋转角与 AI 视觉补全](../changes/2026-07-31-设备旋转角与AI视觉补全.md)
- [AI 网关错误提示与服务协议 v2](../changes/2026-07-28-AI网关错误与服务协议v2.md)
- [AI 服务协议与按用户授权记录](../changes/2026-07-28-AI服务协议.md)
- [AI 模块开发记录](../changes/2026-07-24-AI模块开发进度.md)
- [BoltStar 错误码草案（归档）](../reference/ai/archive/BoltStar-Error-Codes-draft.md)
