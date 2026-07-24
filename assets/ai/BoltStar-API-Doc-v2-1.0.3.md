# BoltStar API 接口文档

**归档编号**: ARCH-20260723-002  
**最后更新**: 2026-07-24

---

## 目录

- [一、全局配置](#一全局配置)
- [二、API 接口（通用）](#二api-接口通用)
- [三、调用方式 A：SSE 真流式（推荐）](#三调用方式-a-sse-真流式推荐)
- [四、调用方式 B：JSON 非流式](#四调用方式-b-json-非流式)
- [五、前端功能方案](#五前端功能方案)
- [六、前端渲染 & 对接](#六前端渲染--对接)
- [七、Skill 系统](#七skill-系统)
- [八、链式编辑](#八链式编辑)
- [九、被动学习（用户画像）](#九被动学习用户画像)
- [十、参数速查表](#十参数速查表)
- [十一、错误码参考](#十一错误码参考)
- [十二、已知问题 & 注意事项](#十二已知问题--注意事项)

---

## 一、全局配置

| 配置项 | 值 |
|--------|-----|
| Base URL（流式） | `https://boltstagent-web-jncfttrxvt.ap-southeast-1.fcapp.run` |
| Base URL（非流式） | `https://boltstaat-agent-fwdomalzks.ap-southeast-1.fcapp.run` |
| 请求方式 | HTTP POST/GET/DELETE |
| Content-Type | `application/json` |
| 认证方式 | 暂无（后续升级 JWT） |

### 调用方式对比

| | SSE 真流式（推荐） | JSON 非流式 |
|---|---|---|
| URL | `boltstagent-web-jncfttrxvt` | `boltstaat-agent-fwdomalzks` |
| 架构 | Custom Runtime + FastAPI | 事件函数 |
| 响应格式 | `text/event-stream` SSE | `application/json` |
| AI 回复 | **逐字实时推送**，首字延迟低 | 等全部生成后一次性返回 |
| 前端效果 | 打字机实时效果 | 拿到完整 text 后客户端打字机 |
| 适用平台 | Web / Flutter（原生 SSE） | 小程序（不支持 SSE） |

### 统一响应格式

所有 JSON 接口遵循同一结构：

```json
// 成功
{
    "success": true,
    "code": 10000,
    "data": { ... }
}

// 失败
{
    "success": false,
    "code": 22002,
    "params": { "hours": 23 },
    "detail": "用户 user_123 累计违规 5 次"
}
```

| 字段 | 类型 | 何时出现 | 说明 |
|------|------|----------|------|
| `success` | bool | 始终 | 是否成功 |
| `code` | int | 始终 | 5 位错误码，成功=10000，失败见[错误码参考](#十一错误码参考) |
| `data` | object | 成功时 | 业务数据 |
| `params` | object | 失败时(可选) | 动态参数，填充前端 i18n 模板占位符，如 `{"hours":23}` |
| `detail` | string | 失败时(可选) | 开发者排障信息，**前端默认不展示**，仅 debug 模式使用 |

### 通用说明

- 所有 AI 生成图右下角含 **"BoltStar AI"** 半透明水印
- 后端不返回面向用户的文案，**文案由前端 i18n 管理**，随 App 语种切换
- `detail` 可能包含原始异常信息，**严禁直接 toast 给用户**

---

## 二、API 接口（通用）

以下接口在流式和非流式两个 URL 下行为一致。仅 `/chat` 接口不同，见三四节。

### POST /session/new — 新建会话

创建新对话，返回 `session_id`。后续所有操作需携带此 ID。

#### 请求

```json
{
    "user_id": "user_123"
}
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `user_id` | string | ✅ | 用户唯一标识 |

#### 成功响应 (`code=10000`)

```json
{
    "success": true,
    "code": 10000,
    "data": {
        "session": {
            "session_id": "e9b7255a",
            "title": "新对话",
            "created_at": "2026-07-23T11:59:56.167401+00:00",
            "updated_at": "2026-07-23T11:59:56.167401+00:00",
            "msg_count": 0
        }
    }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `session.session_id` | string | 会话唯一 ID |
| `session.title` | string | 标题，首条消息后自动更新为用户第一条消息内容 |
| `session.msg_count` | int | 当前消息数 |
| `session.created_at` | string | 创建时间（ISO 8601 UTC） |
| `session.updated_at` | string | 最后更新时间 |

#### 错误响应

| code | 含义 | params | 说明 |
|------|------|--------|------|
| 20003 | 缺少 user_id | — | 请求体未传 user_id |
| 30003 | OSS 写入失败 | — | 会话元信息持久化失败，可重试 |

---

### GET /session/list — 会话列表

获取用户所有会话，按更新时间倒序。

#### 请求

```http
GET /session/list?user_id=user_123
```

| 参数 | 类型 | 必填 | 位置 |
|------|------|------|------|
| `user_id` | string | ✅ | query |

#### 成功响应 (`code=10000`)

```json
{
    "success": true,
    "code": 10000,
    "data": {
        "sessions": [
            {
                "session_id": "e9b7255a",
                "title": "画一只猫",
                "created_at": "2026-07-23T11:59:56+00:00",
                "updated_at": "2026-07-23T12:06:26+00:00",
                "msg_count": 3
            }
        ]
    }
}
```

#### 错误响应

| code | 含义 | 说明 |
|------|------|------|
| 20003 | 缺少 user_id | query 参数缺失 |
| 30004 | OSS 读取失败 | 历史数据读取异常，可重试 |

---

### DELETE /session — 删除会话

删除指定会话及全部历史记录。不可恢复。

#### 请求

```json
{
    "user_id": "user_123",
    "session_id": "e9b7255a"
}
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `user_id` | string | ✅ | 用户标识 |
| `session_id` | string | ✅ | 目标会话 ID |

#### 成功响应 (`code=10000`)

```json
{ "success": true, "code": 10000 }
```

#### 错误响应

| code | 含义 | 说明 |
|------|------|------|
| 20003 | 缺少 user_id | — |
| 20004 | 缺少 session_id | — |
| 23001 | 会话不存在 | 会话已被删除或 session_id 错误 |
| 30003 | OSS 删除失败 | 可重试 |

---

### GET /chat/history — 拉取历史

获取指定会话的所有消息记录，时间倒序，分页。

#### 请求

```http
GET /chat/history?user_id=user_123&session_id=e9b7255a&page=1&page_size=20
```

| 参数 | 类型 | 必填 | 默认值 | 位置 |
|------|------|------|--------|------|
| `user_id` | string | ✅ | — | query |
| `session_id` | string | ✅ | — | query |
| `page` | int | ❌ | 1 | query |
| `page_size` | int | ❌ | 20 | query |

#### 成功响应 (`code=10000`)

```json
{
    "success": true,
    "code": 10000,
    "data": {
        "data": [
            {
                "id": "a1b2c3d4...",
                "role": "assistant",
                "content": "https://oss.xxx/...jpg",
                "timestamp": "2026-07-23T12:00:23+00:00"
            },
            {
                "id": "e5f6g7h8...",
                "role": "assistant",
                "content": "你好，我是星宝~",
                "timestamp": "2026-07-23T12:00:23+00:00"
            },
            {
                "id": "i9j0k1l2...",
                "role": "user",
                "content": "你好",
                "timestamp": "2026-07-23T12:00:20+00:00"
            }
        ],
        "total": 126,
        "page": 1,
        "page_size": 20
    }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `data.data[].id` | string | 消息唯一 ID |
| `data.data[].role` | string | `user` / `assistant` |
| `data.data[].content` | string | 消息文本或图片 URL（以 `http` 开头=图片） |
| `data.data[].timestamp` | string | ISO 8601 UTC |

**重要**：`assistant` 的 `content` 可能是图片 URL（以 `http` 开头），前端据此区分文字/图片。

**历史过期**：会话最后一条消息超过 7 天未更新，再次拉取时自动清除，返回 `code=10001`，`data` 为空。前端收到 `10001` 应 toast 提示用户「对话记录已过期自动清除」。

#### 错误响应

| code | 含义 | 说明 |
|------|------|------|
| 20003 | 缺少 user_id | — |
| 20004 | 缺少 session_id | — |
| 30004 | OSS 读取失败 | 可重试 |

---

### DELETE /chat/history — 删除单条

#### 请求

```json
{
    "user_id": "user_123",
    "session_id": "e9b7255a",
    "message_id": "a1b2c3d4..."
}
```

#### 成功响应 (`code=10000`)

```json
{ "success": true, "code": 10000 }
```

#### 错误响应

| code | 含义 | 说明 |
|------|------|------|
| 20003 | 缺少 user_id | — |
| 20004 | 缺少 session_id | — |
| 20011 | 缺少 message_id | — |
| 23002 | 消息不存在 | message_id 无效或已删除 |
| 30003 | OSS 写入失败 | 可重试 |

---

### DELETE /chat/history/clear — 清空会话

删除该会话下全部消息，会话本身保留。

#### 请求

```json
{
    "user_id": "user_123",
    "session_id": "e9b7255a"
}
```

#### 成功响应 (`code=10000`)

```json
{ "success": true, "code": 10000 }
```

#### 错误响应

| code | 含义 | 说明 |
|------|------|------|
| 20003 | 缺少 user_id | — |
| 20004 | 缺少 session_id | — |
| 30003 | OSS 删除失败 | 可重试 |

---

### POST /image/enhance — 图片美化

基于原图进行 AI 编辑美化（图生图），保持主体特征，按自然语言指令修改。

> 💡 此接口为独立的美化入口。此外，`POST /chat` 也可以通过传入 `image_urls`（1 张图）并在 `message` 中包含图生图关键词（如"根据这张""暖色调"等）触发美化，详见[图片支持](#图片支持)。

#### 请求

```json
{
    "user_id": "user_123",
    "image_url": "http://oss.xxx.com/photo.png",
    "prompt": "给这只猫加上一对翅膀"
}
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `user_id` | string | ✅ | 用户标识 |
| `image_url` | string | ✅ | 原始图片 OSS URL |
| `prompt` | string | ❌ | 美化指令，不传默认"增强色彩和清晰度" |

#### 成功响应 (`code=10000`)

```json
{
    "success": true,
    "code": 10000,
    "data": {
        "image": "http://inkstar.oss-ap-southeast-1.aliyuncs.com/enhanced-images/test/1784800000_xyz789.png"
    }
}
```

#### 错误响应

| code | 含义 | params | 说明 |
|------|------|--------|------|
| 20003 | 缺少 user_id | — | — |
| 20010 | 缺少 image_url | — | 请提供图片 |
| 22001 | 内容违规 | — | 美化指令包含敏感词 |
| 22002 | 临时封禁 | `{"hours":23}` | 累计违规 3 次，hours 为剩余小时 |
| 22003 | 永久封禁 | — | 累计违规 9 次 |
| 30001 | 百炼 API 错误 | — | 上游异常，可重试 |
| 30002 | 百炼超时 | — | 上游超时，可重试 |
| 30003 | OSS 上传失败 | — | 美化图生成但上传失败，可重试 |

---

## 三、调用方式 A：SSE 真流式（推荐）

### POST /chat（流式）

**URL**: `https://boltstagent-web-jncfttrxvt.ap-southeast-1.fcapp.run/chat`

**响应格式**: `text/event-stream`，逐字实时推送。

#### 请求

```json
{
    "user_id": "user_123",
    "session_id": "e9b7255a",
    "message": "画一只卡通猫",
    "new_session": true,
    "temperature": 0.8,
    "img_orientation": "vertical",
    "img_style": "cartoon"
}
```

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `user_id` | string | ✅ | — | 用户标识 |
| `session_id` | string | ✅ | — | 会话 ID |
| `message` | string | ✅ | — | 用户输入的文本 |
| `img_orientation` | string | ✅ | — | 必传。图片尺寸方向：`horizontal`(1472×1104) / `square`(1328×1328) / `vertical`(1104×1472) |
| `new_session` | bool | ❌ | false | `true`=星宝自我介绍 |
| `temperature` | float | ❌ | 0.8 | 回复随机性：0.3=严谨、0.8=日常、1.5=创意 |
| `img_style` | string | ❌ | 无 | 传了即触发生图并加风格前缀：`cartoon`(卡通) / `landscape`(风景) / `portrait`(人像) / `anime`(动漫)。**一键生图时 message 仍需传值**，建议文案 `"生成图片"` 或 `"一键生图"` |
| `image_urls` | array[string] | ❌ | 无 | 用户上传的图片 URL 列表，最多 4 张。1 张+生图关键词触发图生图，多张+关键词友好拒绝 |

#### 生图触发规则

星宝支持**四层生图触发**，优先级从高到低：

1. 传了 `img_style` → 立即生图
2. 关键词命中（中文/英文/日文）：`画`、`generate`、`描い` 等 → 直接生图
3. AI 自行判断：其他语言用户（德语、法语等）请求生图时，AI 在回复末尾附加 `[IMG_YES]` 标记，**服务端通过缓冲机制自动过滤，前端无需处理**
4. 都不满足 → 纯文字对话

#### 图片支持

`POST /chat` 支持 `image_urls` 参数传入图片，实现多模态对话：

| 场景 | image_urls | message | 行为 |
|------|-----------|---------|------|
| 纯文本 | 无/空 | 必填 | 原有逻辑（聊天/文生图） |
| 仅图片 | 有 | 空 | 返回 `20005 MISSING_MESSAGE` |
| 单图+讨论 | 1 张 | "这张怎么样" | AI 分析讨论 |
| 单图+生图 | 1 张 | "根据这张暖色调" | 图生图（含生图关键词触发） |
| 多图+生图 | 2~4 张 | "根据这张调整" | 友好拒绝"一次只能处理一张" |
| 多图+讨论 | 2~4 张 | "有什么区别" | AI 多图对比讨论 |
| 超限 | 5+ 张 | 任意 | `20012 INVALID_IMAGE_COUNT` |

图生图关键词（`message` 中包含即触发）：`根据这张` `按这个` `照这个` `参照这张` `参考这张` `把这张` `这张图` `基于这张` `based on this` `from this image` `according to this` `この画像` `この写真` `これをもとに`

#### SSE 响应流（正常）

```
data: {"type":"text","content":"你"}
data: {"type":"text","content":"好"}
data: {"type":"text","content":"！"}
data: {"type":"text","content":"😊"}
data: {"type":"image","url":"https://inkstar.oss-ap-southeast-1.aliyuncs.com/chat-images/..."}
data: [DONE]
```

| type | 字段 | 说明 |
|------|------|------|
| `text` | `content`: 文本片段（逐字/词） | 前端拼接到对话气泡 |
| `image` | `url`: OSS URL | 24h 有效，含水印 |
| `error` | `code`: 错误码, `params`: 动态参数(可选), `detail`: 排障信息(可选) | 见下方 SSE 错误格式 |
| `[DONE]` | — | 流结束 |

#### SSE 响应流（错误）

```
data: {"type":"error","code":22001}
data: {"type":"error","code":22002,"params":{"hours":23}}
data: {"type":"error","code":30001,"detail":"Bailian returned 500: ..."}
data: {"type":"error","code":30003,"detail":"Image generated but upload failed"}
```

SSE 中 `type: "error"` 时，`code` 与 JSON 接口错误码完全一致（见[错误码参考](#十一错误码参考)）。

#### 流式特点

- 逐字推送，用户立刻看到 AI 在"打字"
- 不需要客户端打字机模拟——直接 `textContent += content` 即可
- `img_style` 传了立即生图，图片 URL 也在 SSE 流中返回
- 错误也通过 SSE 流推送，前端按 `code` 分发处理

#### SSE 数据解码说明

SSE 流式数据是 **UTF-8 编码的文本流**，前端接收时需要注意：

| 平台 | 解码方式 | 说明 |
|------|----------|------|
| Web (fetch) | `new TextDecoder('utf-8')` 或 `resp.body.getReader()` + `decoder.decode()` | 浏览器原生支持，见 6.1 代码示例 |
| Flutter | `stream.transform(utf8.decoder)` | Dart 内置 `utf8` 编解码器 |
| 微信小程序 | ❌ 不支持 SSE，请使用非流式接口 | `wx.request` 无 ReadableStream |

SSE 数据已包含中文等多字节字符（emoji、中文、日文等），**无需额外转码**，按标准 UTF-8 解析即可。`data:` 行中的 JSON 使用 `ensure_ascii=False`，直接包含原始 Unicode 字符。

> ⚠️ 注意：不要在接收端使用 `latin-1` 或 `ascii` 解码，否则中文会乱码。

---

## 四、调用方式 B：JSON 非流式

### POST /chat（非流式）

**URL**: `https://boltstaat-agent-fwdomalzks.ap-southeast-1.fcapp.run/chat`

**响应格式**: `application/json`，一次性返回完整结果。

#### 请求

参数与流式完全一致（同上表）。

```json
{
    "user_id": "user_123",
    "session_id": "e9b7255a",
    "message": "画一只卡通猫",
    "new_session": true,
    "temperature": 0.8,
    "img_orientation": "vertical",
    "img_style": "cartoon"
}
```

#### 成功响应 (`code=10000`)

```json
{
    "success": true,
    "code": 10000,
    "data": {
        "text": "你好，我是星宝~ 这只卡通猫为你准备好啦！",
        "images": [
            "http://inkstar.oss-ap-southeast-1.aliyuncs.com/chat-images/test/1784800000_abc123.png"
        ]
    }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `data.text` | string | AI 文字回复（前端需打字机渲染） |
| `data.images` | array | 生成图的 OSS 签名 URL（24h 有效，含水印），无图时为空数组 |

#### 错误响应

| code | 含义 | params | 说明 |
|------|------|--------|------|
| 20003 | 缺少 user_id | — | — |
| 20004 | 缺少 session_id | — | — |
| 20005 | 缺少 message | — | — |
| 20006 | 缺少 img_orientation | — | — |
| 20007 | img_orientation 无效 | — | 仅 horizontal/square/vertical |
| 20008 | img_style 无效 | — | 仅 cartoon/landscape/portrait/anime |
| 20009 | temperature 无效 | — | 需在 0~2 之间 |
| 20012 | image_urls 超过 4 张 | — | 最多 4 张图片 |
| 22001 | 内容违规 | — | — |
| 22002 | 临时封禁 | `{"hours":23}` | 累计违规 3-8 次 |
| 22003 | 永久封禁 | — | 累计违规 9 次 |
| 30001 | 百炼 API 错误 | — | detail 含排障信息 |
| 30002 | 百炼超时 | — | — |

#### 调用示例

```bash
curl -X POST https://boltstaat-agent-fwdomalzks.ap-southeast-1.fcapp.run/chat \
  -H "Content-Type: application/json" \
  -d '{"user_id":"test","session_id":"e9b7255a","message":"画一只猫","img_orientation":"vertical"}'
```

#### 非流式特点

- 等待 AI 完整生成后一次性返回（约 2-5 秒）
- 前端收到 `data.text` 后用客户端打字机效果逐字渲染
- **小程序唯一支持的方式**

---

## 五、前端功能方案

### 5.1 输入方式

#### 5.1.1 键盘文字输入

文本框输入 → 点击发送 → `POST /chat`

#### 5.1.2 按住语音说话（小程序）

交互模式：**按住说话，松手直接发送**（类似 DeepSeek，非微信长按转文字填入输入框）。

实现方案：

```
1. 用户按住录音按钮
2. 小程序调用 wx.getRecorderManager() 录音
3. 松手触发 onStop 回调
4. 调微信同声传译插件 (WechatSI) 转文字
5. 拿到文字后直接调 POST /chat，不经过输入框
```

注意：
- 需要在小程序后台开通「同声传译」插件
- 录音最大时长建议 60 秒
- 转文字失败时提示用户重新录入

#### 5.1.3 按住语音说话（Flutter）

交互模式同上：**按住说话，松手直接发送**。

实现方案：

```
1. 用户按住录音按钮
2. 调用 speech_to_text 插件开始监听
3. 松手时调用 stop() 停止录音
4. 获取 recognizedWords 作为最终文字
5. 直接调 POST /chat，不经过输入框
```

依赖：`speech_to_text: ^6.0.0`

#### 5.1.4 选择图片 + 文本发送

**交互规则**：图片必须和文本一起发送，不允许纯图片提交。参考 ima.copilot 输入框交互。**最多选择 4 张图片**，超过 4 张时前端提示「一次最多选择 4 张图片」。

**流程**：

```
[输入框]                    [操作]
┌──────────────────────────────┐
│  📎 选择图片                 │  1. 用户点击相册/拍照
│  ┌─────┐ ┌─────┐           │
│  │     │ │     │ ✕ ← 可删除  │  2. 图片缩略图出现在输入框内
│  │图片1│ │图片2│           │     每张带 ✕ 按钮，点击删除
│  └─────┘ └─────┘           │     最多 4 张，达到上限后隐藏添加按钮
│  描述你想要的修改效果         │  3. placeholder 提示输入文本
│                        ➤    │  4. 发送按钮置灰（仅图片无文本时不可点击）
└──────────────────────────────┘
```

**状态机**：

| 状态 | 输入框中有 | 发送按钮 | 行为 |
|------|-----------|---------|------|
| 空 | 无图片 无文本 | 置灰/隐藏 | 不可发送 |
| 仅文本 | 无图片 有文本 | 可用 | `POST /chat` |
| 仅图片 | 有图片 无文本 | **置灰** | 不可发送 |
| 图片+文本（1张） | 1张图片 有文本 | 可用 | 含生图关键词 → `POST /chat`（图生图）；否则 → `POST /chat`（分析讨论） |
| 图片+文本（2~4张） | 2~4张图片 有文本 | 可用 | 含生图关键词 → `POST /chat`（友好拒绝）；否则 → `POST /chat`（多图对比讨论） |
| 图片超限 | 5+张图片 | — | 前端拦截，提示「一次最多选择 4 张图片」 |

**API 调用**：

```
POST /image/enhance
{
  "user_id": "...",
  "image_url": "<OSS URL>",
  "prompt": "用户输入的文本（必填）"
}
```

> ⚠️ prompt 为**必填**字段，不传返回 `20005 MISSING_MESSAGE`。

**图片上传**：选择后立即上传至 OSS 并获取 URL，但先不调 API——等用户输入文本后点击发送时一并提交。

#### 5.1.5 拍照

调相机 → 拍照 → 前端上传至 OSS → 拿到 URL → 传给 AI

---

### 5.2 会话管理

| 功能 | 接口 | 说明 |
|------|------|------|
| 新建会话 | `POST /session/new` | App 启动或用户点「新建对话」时调用 |
| 会话列表 | `GET /session/list` | 历史对话列表页，按时间倒序 |
| 加载历史 | `GET /chat/history` | 用户点进某个会话后，拉取全部消息渲染 |
| 删除会话 | `DELETE /session` | 滑动删除或长按删除 |

---

### 5.3 AI 对话

#### 5.3.1 发送消息

调 `POST /chat`，必传 `user_id`、`session_id`、`message`、`img_orientation`

#### 5.3.2 一键生图

UI 提供选项区域：

| 选项 | 参数 |
|------|------|
| 方向 | 横 / 方 / 竖 → `img_orientation` |
| 风格 | 卡通 / 风景 / 人像 / 动漫 → `img_style` |

选择后拼入 `POST /chat` 参数

> ⚠️ 一键生图时 `message` 仍为必填字段。前端在用户点击风格按钮时，自动拼接文案：
> 
> | 风格 | message 示例 |
> |------|-------------|
> | 卡通 | `"生成图片-卡通"` / `"Generate image - Cartoon"` / `"画像を生成-漫画"` |
> | 风景 | `"生成图片-风景"` / `"Generate image - Landscape"` |
> | 人像 | `"生成图片-人像"` / `"Generate image - Portrait"` |
> | 动漫 | `"生成图片-动漫"` / `"Generate image - Anime"` |
> 
> 请求示例：`{"message":"生成图片-卡通","img_style":"cartoon",...}`

#### 5.3.3 AI 回复打字机效果

见 [六、前端渲染 & 对接](#六前端渲染--对接)

#### 5.3.4 终止 AI 回复

流式和非流式通用，前端 `AbortController` 中断 fetch：

```javascript
const controller = new AbortController();
fetch(url, { signal: controller.signal, ... });
controller.abort(); // 用户点击停止
```

#### 5.3.5 多终端同步历史

同一 `user_id` 在任何设备拉取的历史一致（OSS 持久化），无需额外处理。切换设备后重新 `GET /chat/history` 即可。

---

### 5.4 图片交互

#### 5.4.1 AI 生图展示

非流式：从 `data.images[]` 取 URL，直接渲染 `<img>` 标签  
流式：SSE 中 `type: "image"` 时取 `url` 渲染

#### 5.4.2 图片美化

用户选图 → 输入美化指令（如"暖色调""虚化背景"）→ 发送按钮可用 → `POST /image/enhance`

> prompt 必填，图片不能单独发送——与 5.1.4 交互规则一致。

#### 5.4.3 长按图片

弹出菜单：

```
┌──────────────┐
│  📥 下载     │  → 保存到系统相册
│  📺 投屏     │  → 弹出设备列表
└──────────────┘
```

#### 5.4.4 投屏流程

```
长按图片 → 选择投屏 → 弹出已绑定设备列表 → 选择目标设备 → 
进入投屏预览页（预览图+确认按钮） → 确认 → 推送至电子相框
```

---

### 5.5 权限控制

| 规则 | 实现 |
|------|------|
| 无绑定设备 | 前端检查设备绑定状态，未绑定时拦截 AI 调用入口，提示「请先绑定设备」 |
| Token 不足 | 前端调 Java 后端判断用户 token 余额，不足时提示购买，拦截至调 AI 接口 |
| Token 扣除 | 每次 `POST /chat` 成功（`success: true`）后，前端调 Java 后端扣除 1 次 token |

> Token 判断、扣除和充值逻辑在 Java 后端实现，FC 不参与

---

## 六、前端渲染 & 对接

### 6.1 SSE 流式对接（方式 A）

#### Web / Flutter：fetch + ReadableStream

```javascript
async function sendMessage(body) {
    const resp = await fetch(STREAM_URL + '/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop();

        for (const line of lines) {
            if (line.startsWith('data: ')) {
                const payload = line.slice(6);
                if (payload === '[DONE]') return;
                const data = JSON.parse(payload);
                if (data.type === 'text') chatBox.textContent += data.content;
                if (data.type === 'image') showImage(data.url);
                if (data.type === 'error') handleError(data.code, data.params, data.detail);
            }
        }
    }
}
```

#### Flutter

```dart
final request = http.Request('POST', Uri.parse('$base/chat'));
request.headers['Content-Type'] = 'application/json';
request.body = jsonEncode(body);

final streamedResponse = await request.send();
final stream = streamedResponse.stream
    .transform(utf8.decoder)
    .transform(const LineSplitter());

await for (final line in stream) {
    if (line.startsWith('data: ')) {
        final payload = line.substring(6);
        if (payload == '[DONE]') break;
        final data = jsonDecode(payload);
        if (data['type'] == 'text') {
            setState(() => _responseText += data['content']);
        }
        if (data['type'] == 'image') {
            _images.add(data['url']);
        }
        if (data['type'] == 'error') {
            handleError(data['code'], data['params'], data['detail']);
        }
    }
}
```

---

### 6.2 非流式对接（方式 B，含小程序）

#### Web / Flutter

```javascript
const resp = await fetch(NON_STREAM_URL + '/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
});
const json = await resp.json();

if (json.success) {
    const { text, images } = json.data;
    // 打字机渲染 text, 渲染 images
} else {
    handleError(json.code, json.params, json.detail);
}
```

#### 小程序

```javascript
wx.request({
    url: NON_STREAM_URL + '/chat',
    method: 'POST',
    data: body,
    success(res) {
        const json = res.data;
        if (json.success) {
            const { text, images } = json.data;
            // 打字机渲染 text
            const queue = text.split('');
            let i = 0;
            const timer = setInterval(() => {
                if (i >= queue.length) { clearInterval(timer); return; }
                that.setData({ reply: that.data.reply + queue[i] });
                i++;
            }, 30);
        } else {
            handleError(json.code, json.params, json.detail);
        }
    }
});
```

> ⚠️ 小程序不支持 SSE / ReadableStream，只能使用非流式接口 + 客户端打字机。

---

### 6.3 AI 回复加载态

用户发送消息后，前端应立即在对话列表中插入一条 AI 消息占位气泡，显示 loading 动画（如三点闪烁或文字渐入），待内容返回后用实际内容替换：

```
用户点击发送
    ↓
前端立即插入 AI 消息占位（loading 动画）
    ↓
方式 A：SSE 逐字直接填充占位气泡
方式 B：等待 POST /chat 返回 → 拿到 text → 用打字机效果逐字填充占位气泡
```

> 注意：loading 占位不是真实消息，不要存入历史。只在当前会话界面临时展示。

---

### 6.4 打字机效果

#### 方式 B（非流式）：客户端打字机

接口返回完整 `data.text`，前端自行逐字渲染：

```javascript
const wordQueue = [];
let timer = null;

wordQueue.push(...text.split(''));

function startTyping() {
    if (timer) return;
    timer = setInterval(() => {
        if (wordQueue.length === 0) {
            clearInterval(timer);
            timer = null;
            return;
        }
        chatBox.textContent += wordQueue.shift();
    }, 30); // 30ms/字
}
```

#### 方式 A（流式）：原生流式

SSE 流式不需要客户端打字机——每收到一个 `data: {"type":"text","content":"..."}` 直接追加到气泡即可。`textContent += content`。

---

### 6.5 历史记录渲染

```javascript
for (const msg of history) {
    if (msg.role === 'assistant' && msg.content.startsWith('http')) {
        renderImageBubble(msg.content);  // 图片 URL
    } else {
        renderTextBubble(msg.content);   // 文字
    }
}
```

---

### 6.6 图片懒加载

AI 生成的图片统一使用 `loading="lazy"`，减少首屏加载压力：

```html
<img src="图片URL" loading="lazy" alt="星宝生成图" />
```

---

### 6.7 统一错误处理

所有接口错误按 `code` 分发，文案由前端 i18n 管理。参考实现：

```javascript
// i18n 文件示例 (zh-CN.json)
const zhCN = {
    "error.20003": "缺少用户标识",
    "error.20005": "请输入内容",
    "error.20006": "请选择图片方向",
    "error.22001": "内容不符合规范，请修改后重试",
    "error.22002": "账号已被临时限制，{hours} 小时后恢复",
    "error.22003": "账号已被永久限制",
    "error.30001": "服务暂时不可用，请稍后重试",
    "error.30002": "响应超时，请稍后重试",
    "error.31001": "系统异常，请稍后重试",
};

// 通用错误处理
function handleError(code, params, detail) {
    // 1. 从 i18n 取模板
    const template = i18n.t(`error.${code}`);
    if (!template) {
        // 未知 code 降级
        showToast(i18n.t('error.31001')); // "系统异常"
        if (detail) console.error('[BoltStar]', code, detail);
        return;
    }

    // 2. 填入动态参数 (如 {hours})
    const message = template.replace(/\{(\w+)\}/g, (_, k) => params?.[k] ?? `{${k}}`);

    // 3. 按 code 区间决定展示方式
    if (code >= 20000 && code < 21000) {
        showToast(message);  // 参数错误 → toast
    } else if (code === 22002 || code === 22003) {
        showDialog({ content: message });  // 封禁 → 弹窗
        disableChat();
    } else if (code === 22001) {
        showToast(message);  // 违规 → toast
    } else if (code >= 30000 && code < 31000) {
        showToast(message, { action: i18n.t('retry'), onAction: retry });  // 上游错误 → toast+重试
    } else {
        showToast(message);
    }

    // 4. debug 模式输出 detail
    if (detail && __DEV__) console.warn(`[BoltStar] code=${code}`, detail);
}
```

### 6.8 典型交互流程

```
App 启动 → POST /session/new → 拿到 session_id
    ↓
用户输入（键盘/语音/图片[1~4张]） → POST /chat → 
    方式 A：SSE 逐字渲染 + 展示 images
    方式 B：打字机渲染 text + 展示 images
    ↓
    ├─ 单图+生图关键词 → 图生图（美化）
    ├─ 单图+讨论 → AI 分析讨论
    ├─ 多图+讨论 → AI 多图对比
    └─ 多图+生图关键词 → 友好拒绝
    ↓
用户长按图片 → 下载或投屏
    ↓
用户进入历史 → GET /chat/history → 渲染聊天记录
```

### 6.9 图片水印说明

- 所有 AI 生成图右下角带 **"BoltStar AI"** 半透明水印
- 防去除：前端拦截关键词 + AI 拒绝
- ⏳ 已知问题：美化原图已有水印时可能重复叠加（待修复）

---

## 七、Skill 系统

### 7.1 概述

Skill 系统是 StarBao 的结构化上下文引擎，通过**渐进式披露（Progressive Disclosure）**机制在 AI 对话中按需注入专业知识、约束规则和工作流程，提升对话质量和专业度。

- **16 个预置 Skill**，覆盖图片生成、美化、摄影、人像、风景、动漫、Logo设计、创意写作、故事、翻译、编程、社交媒体、配色、UI/UX、产品电商、通用问答
- **4 语触发**：中文、英文、日文、繁体中文关键词+正则+上下文链自动匹配
- **合并注入**：多 Skill 命中时，主 Skill 主导决策，辅 Skill 补充约束
- **用户偏好记忆**：支持"记住xxx""忘记偏好"命令，OSS 持久化跨会话共享

### 7.2 Skill 列表

| Skill ID | 名称 | 触发示例 |
|----------|------|----------|
| image_generation | AI图片生成 | "画一只猫""generate an image" |
| image_editing | 图片美化 | "暖色调""虚化背景" |
| photography | 摄影指导 | "如何拍夜景""光圈设置" |
| portrait | 人像设计 | "证件照""角色设计" |
| landscape | 风景场景 | "山水画""日落海滩" |
| anime | 动漫二次元 | "动漫风""赛璐璐" |
| logo_design | Logo设计 | "设计一个logo""品牌标志" |
| creative_writing | 创意写作 | "广告文案""slogan" |
| storytelling | 故事创作 | "写一个故事""世界观" |
| translation | 多语言翻译 | "翻译成日语""translate" |
| coding | 编程技术 | "写函数""debug" |
| social_media | 社交媒体 | "小红书文案""抖音" |
| color_expert | 色彩配色 | "莫兰迪色系""配色" |
| ui_ux | UI/UX设计 | "界面设计""按钮样式" |
| product_photo | 产品电商图 | "白底图""电商主图" |
| general | 通用问答 | 兜底 |

### 7.3 偏好命令

| 命令 | 示例 | 效果 |
|------|------|------|
| 记住偏好 | "记住 我喜欢暖色调" | 持久化到 OSS，后续对话自动注入 |
| 忘记偏好 | "忘记偏好" | 清除所有偏好 |

### 6.4 架构

```
用户消息 → TriggerMatcher → SkillResolver → PromptBuilder → AI
              ↓                   ↓
         关键词/正则/上下文链    方案B合并(主+辅)
              ↓
         用户偏好(OSS) + 会话状态(OSS)
```

---

## 七、参数速查表

### /chat 全部参数（流式 + 非流式通用）

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `user_id` | string | ✅ | — | — |
| `session_id` | string | ✅ | — | — |
| `message` | string | ✅ | — | 用户输入的文本内容 |
| `img_orientation` | string | ✅ | — | `horizontal`(1472×1104) / `square`(1328×1328) / `vertical`(1104×1472)。**前端必传** |
| `new_session` | bool | ❌ | false | `true`=星宝自我介绍 |
| `temperature` | float | ❌ | 0.8 | 0.3 严谨 / 0.8 日常 / 1.5 创意 |
| `img_style` | string | ❌ | 无 | 传了触发一键生图并加风格前缀：`cartoon`(卡通)/`landscape`(风景)/`portrait`(人像)/`anime`(动漫)。**message 仍必填**，建议拼接风格名如 `"生成图片-卡通"` |
| `image_urls` | array[string] | ❌ | 无 | 用户上传的图片 URL 列表，最多 4 张。1 张+生图关键词触发图生图，多张+关键词友好拒绝 |

### 生图触发规则

1. 传了 `img_style` → 立即生图 + 风格前缀
2. 没传，`message` 含「画/生成图/图片/图像/绘/插图」→ 自动生图
3. 都没 → 纯文字对话

### 封禁规则

| 违规次数 | 处罚 |
|----------|------|
| 第 1-2 次 | 拦截 + 返回 `code=22001` |
| 第 3-8 次 | 封禁 24 小时，返回 `code=22002`，`params.hours` = 剩余小时 |
| 第 9 次 | 永久封禁，返回 `code=22003` |

---

## 八、错误码参考

全部错误码及注解。`params` 列为前端 i18n 模板可用的占位变量。

### 1xxxx — 成功

| code | 名称 | 含义 | params |
|------|------|------|--------|
| 10000 | `SUCCESS` | 请求成功 | — |
| 10001 | `SUCCESS_EXPIRED` | 历史记录已过期自动清除 | — |

### 2xxxx — 参数 / 客户端错误

| code | 名称 | 含义 | params | 前端处理建议 |
|------|------|------|--------|-------------|
| 20001 | `MISSING_PARAM` | 缺少必填参数（通用） | `{"field":"xxx"}` | Toast 提示缺少哪个字段 |
| 20002 | `INVALID_PARAM` | 参数值无效（通用） | `{"field":"xxx","value":"yyy"}` | Toast 提示 + 检查前端逻辑 |
| 20003 | `MISSING_USER_ID` | 缺少 user_id | — | Toast「缺少用户标识」，检查登录态 |
| 20004 | `MISSING_SESSION_ID` | 缺少 session_id | — | Toast，检查会话初始化 |
| 20005 | `MISSING_MESSAGE` | 缺少 message | — | Toast「请输入内容」 |
| 20006 | `MISSING_IMAGE_ORIENTATION` | 缺少 img_orientation | — | Toast「请选择图片方向」 |
| 20007 | `INVALID_IMAGE_ORIENTATION` | img_orientation 值无效 | — | 前端检查下拉选项值（仅 horizontal/square/vertical） |
| 20008 | `INVALID_IMAGE_STYLE` | img_style 值无效 | — | 前端检查风格选项值（仅 cartoon(卡通)/landscape(风景)/portrait(人像)/anime(动漫)） |
| 20009 | `INVALID_TEMPERATURE` | temperature 超出 0~2 范围 | — | 前端滑块/输入框加范围限制 |
| 20010 | `MISSING_IMAGE_URL` | /image/enhance 缺 image_url | — | Toast「请提供图片」 |
| 20011 | `MISSING_MESSAGE_ID` | 删除消息缺 message_id | — | Toast，检查消息数据 |
| 20012 | `INVALID_IMAGE_COUNT` | image_urls 超过 4 张 | — | Toast「一次最多处理 4 张图片」 |

### 21xxx — 认证 / 授权

| code | 名称 | 含义 | params | 前端处理建议 |
|------|------|------|--------|-------------|
| 21001 | `UNAUTHORIZED` | 未授权（预留 JWT） | — | 跳转登录页 |

### 22xxx — 业务 / 风控

| code | 名称 | 含义 | params | 前端处理建议 |
|------|------|------|--------|-------------|
| 22001 | `CONTENT_VIOLATION` | 内容违规，被安全审核拦截 | — | Toast + 标红输入框 |
| 22002 | `USER_BANNED_TEMP` | 临时封禁（3-8 次违规） | `{"hours":23}` | **弹窗**，文案模板 `{hours}` 替换为剩余小时，禁用聊天输入 |
| 22003 | `USER_BANNED_PERMANENT` | 永久封禁（9 次违规） | — | **弹窗**，禁用聊天输入，无取消按钮 |
| 22004 | `TOKEN_INSUFFICIENT` | Token 不足（前端 Java 后端返回） | — | 弹窗引导充值 |
| 22005 | `RATE_LIMITED` | 请求过于频繁 | `{"retry_after":30}` | Toast + 倒计时后自动恢复 |

### 23xxx — 资源

| code | 名称 | 含义 | params | 前端处理建议 |
|------|------|------|--------|-------------|
| 23001 | `SESSION_NOT_FOUND` | 会话不存在或已删除 | — | Toast，返回会话列表 |
| 23002 | `MESSAGE_NOT_FOUND` | 消息不存在或已删除 | — | Toast，刷新消息列表 |

### 3xxxx — 服务端 / 上游错误

| code | 名称 | 含义 | params | 前端处理建议 |
|------|------|------|--------|-------------|
| 30001 | `UPSTREAM_API_ERROR` | 百炼 API 调用失败 | — | Toast + 提供重试按钮。**detail 中含有原始错误，勿展示** |
| 30002 | `UPSTREAM_TIMEOUT` | 百炼 API 超时 | — | Toast + 提供重试按钮 |
| 30003 | `OSS_UPLOAD_ERROR` | OSS 上传/写入失败 | — | Toast「请重试」，detail 含排障信息 |
| 30004 | `OSS_READ_ERROR` | OSS 读取失败 | — | Toast「请重试」，detail 含排障信息 |

### 31xxx — 内部错误

| code | 名称 | 含义 | params | 前端处理建议 |
|------|------|------|--------|-------------|
| 31001 | `INTERNAL_ERROR` | 未知内部错误 | — | Toast + 上报监控，detail 含堆栈 |
| 31002 | `NOT_FOUND` | 接口不存在（路由未匹配） | — | Toast，检查 Base URL |

### 前端处理区间速查

| code 区间 | 处理策略 |
|-----------|----------|
| 20000–20099 | Toast 提示，引导用户修正输入 |
| 21000–21999 | 跳转登录 |
| 22000–22099 | Toast 或弹窗（22002/22003 弹窗并禁用聊天） |
| 23000–23999 | Toast，返回上一级 |
| 30000–30999 | Toast + 提供重试按钮 |
| 31000–31999 | Toast + 内部上报 |

---

## 九、已知问题 & 注意事项

| 问题 | 状态 | 说明 |
|------|------|------|
| 水印重复叠加 | ⏳ 待修复 | 美化时需检测原图是否已有水印 |
| 图片 URL 有效期 | ⚠️ 24h | 过期需重新生成 |
| 小程序 SSE | ❌ 不支持 | 使用非流式接口 |
| 多语种 | ✅ | 后端只返 code，文案由前端 i18n 管理 |
| 封禁机制 | ✅ | 3-8 次临时 24h，9 次永久 |
| 防去水印 | ✅ | 关键词拦截 + AI 拒绝 |
| 错误码体系 | ✅ | 统一 code + params + detail，见[八、错误码参考](#八错误码参考) |

### 其他注意事项

- 文本和图片均经过**阿里云内容安全审核**（国内站 `green.cn-shanghai.aliyuncs.com`），违规直接拦截
  - 百炼国际站 `dashscope-intl` 不支持 `X-DashScope-DataInspection` 安全护栏，故改用阿里云内容安全服务替代
- 每个会话最多 **500 条**消息，超量自动清理最早记录
- 每次对话携带最近 **20 条**历史给 AI 作为上下文

---

> 归档编号：ARCH-20260723-002  
> 最后更新：2026-07-24
