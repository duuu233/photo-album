# BoltStar 标准错误码体系（草案）

**版本**: draft-2  
**日期**: 2026-07-24

---

## 设计原则

- **后端只返 code + 动态参数**，不返面向用户的文案
- **文案由前端 i18n 管理**，随 App 语种自动切换
- `detail` 仅 debug 模式展示，给开发排查用

---

## 响应格式

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
    "detail": "用户 user_123 累计违规 5 次，临时封禁至 2026-07-25 10:00"
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `success` | bool | 请求是否成功 |
| `code` | int | 5 位错误码，前端 switch 分发 |
| `params` | object | 动态参数，用于填充 i18n 模板中的占位符（可选） |
| `detail` | string | 面向开发者的排障信息，仅 debug 模式展示（可选） |
| `data` | object | 成功时携带的业务数据 |

---

## 错误码总表

### 1xxxx — 成功

| code | 名称 | 前端 i18n key | params | HTTP |
|------|------|---------------|--------|------|
| 10000 | `SUCCESS` | — | — | 200 |
| 10001 | `SUCCESS_EXPIRED` | 对话记录已过期自动清除 | — | 200 |

### 2xxxx — 参数 / 客户端

| code | 名称 | 前端 i18n key（示例中文） | params | HTTP |
|------|------|--------------------------|--------|------|
| 20001 | `MISSING_PARAM` | 缺少必填参数 | `{"field":"user_id"}` | 400 |
| 20002 | `INVALID_PARAM` | 参数值无效 | `{"field":"img_orientation","value":"abc"}` | 400 |
| 20003 | `MISSING_USER_ID` | 缺少用户标识 | — | 400 |
| 20004 | `MISSING_SESSION_ID` | 缺少会话标识 | — | 400 |
| 20005 | `MISSING_MESSAGE` | 请输入内容 | — | 400 |
| 20006 | `MISSING_IMAGE_ORIENTATION` | 请选择图片方向 | — | 400 |
| 20007 | `INVALID_IMAGE_ORIENTATION` | 图片方向无效 | — | 400 |
| 20008 | `INVALID_IMAGE_STYLE` | 风格选项无效 | — | 400 |
| 20009 | `INVALID_TEMPERATURE` | temperature 取值需在 0~2 之间 | — | 400 |
| 20010 | `MISSING_IMAGE_URL` | 请提供图片 | — | 400 |
| 20011 | `MISSING_MESSAGE_ID` | 缺少消息标识 | — | 400 |

### 21xxx — 认证 / 授权

| code | 名称 | 前端 i18n key（示例中文） | params | HTTP |
|------|------|--------------------------|--------|------|
| 21001 | `UNAUTHORIZED` | 请先登录 | — | 401 |

### 22xxx — 业务 / 风控

| code | 名称 | 前端 i18n key（示例中文） | params | HTTP |
|------|------|--------------------------|--------|------|
| 22001 | `CONTENT_VIOLATION` | 内容不符合规范，请修改后重试 | — | 200 |
| 22002 | `USER_BANNED_TEMP` | 账号已被临时限制，{hours} 小时后恢复 | `{"hours":23}` | 200 |
| 22003 | `USER_BANNED_PERMANENT` | 账号已被永久限制 | — | 200 |
| 22004 | `TOKEN_INSUFFICIENT` | 使用次数不足，请充值 | — | 200 |
| 22005 | `RATE_LIMITED` | 请求过于频繁，请稍后再试 | `{"retry_after":30}` | 429 |

### 23xxx — 资源

| code | 名称 | 前端 i18n key（示例中文） | params | HTTP |
|------|------|--------------------------|--------|------|
| 23001 | `SESSION_NOT_FOUND` | 会话不存在或已删除 | — | 404 |
| 23002 | `MESSAGE_NOT_FOUND` | 消息不存在或已删除 | — | 404 |

### 3xxxx — 服务端 / 上游

| code | 名称 | 前端 i18n key（示例中文） | params | HTTP |
|------|------|--------------------------|--------|------|
| 30001 | `UPSTREAM_API_ERROR` | 服务暂时不可用，请稍后重试 | — | 502 |
| 30002 | `UPSTREAM_TIMEOUT` | 响应超时，请稍后重试 | — | 504 |
| 30003 | `OSS_UPLOAD_ERROR` | 图片上传失败，请重试 | — | 500 |
| 30004 | `OSS_READ_ERROR` | 数据读取失败，请重试 | — | 500 |

### 31xxx — 内部

| code | 名称 | 前端 i18n key（示例中文） | params | HTTP |
|------|------|--------------------------|--------|------|
| 31001 | `INTERNAL_ERROR` | 系统异常，请稍后重试 | — | 500 |
| 31002 | `NOT_FOUND` | 接口不存在 | — | 404 |

---

## 前端处理指南

### i18n 文件示例

```json
// zh-CN.json
{
    "error.20003": "缺少用户标识",
    "error.20005": "请输入内容",
    "error.22001": "内容不符合规范，请修改后重试",
    "error.22002": "账号已被临时限制，{hours} 小时后恢复",
    "error.30001": "服务暂时不可用，请稍后重试"
}
```

```json
// en.json
{
    "error.20003": "Missing user ID",
    "error.20005": "Please enter a message",
    "error.22001": "Content does not comply with guidelines. Please modify and try again.",
    "error.22002": "Account temporarily restricted. Recovery in {hours} hours.",
    "error.30001": "Service temporarily unavailable. Please try again later."
}
```

### 统一错误处理

```javascript
function handleBoltStarError(res) {
    const { code, params, detail } = res;

    // 1. 从 i18n 取模板
    const template = i18n.t(`error.${code}`);
    if (!template) {
        // 未知 code 降级
        showToast(i18n.t('error.31001'));  // "系统异常，请稍后重试"
        if (detail) console.error('[BoltStar]', code, detail);
        return;
    }

    // 2. 填入动态参数
    const message = fillTemplate(template, params || {});

    // 3. 按 code 区间决定展示方式
    if (code >= 20000 && code < 21000) {
        // 参数错误：toast
        showToast(message);
    } else if (code >= 22000 && code < 23000) {
        // 业务风控：可弹窗可 toast，看具体 code
        if (code === 22002 || code === 22003) {
            showDialog({ title: i18n.t('notice'), content: message, confirmText: i18n.t('got_it') });
            disableChat();
        } else {
            showToast(message);
        }
    } else if (code >= 30000 && code < 31000) {
        // 服务端错误：toast + 可重试
        showToast(message, { action: i18n.t('retry'), onAction: () => retry() });
    } else {
        showToast(message);
    }
}

function fillTemplate(tmpl, params) {
    return tmpl.replace(/\{(\w+)\}/g, (_, key) => params[key] ?? `{${key}}`);
}
```

### 区间速查

| code 区间 | 处理策略 |
|-----------|----------|
| 20000–20099 | 参数缺失/非法 → Toast，引导用户修正 |
| 21000–21999 | 鉴权 → 跳登录 |
| 22000–22099 | 违规/封禁 → Toast 或弹窗，按需禁用输入 |
| 23000–23999 | 资源不存在 → Toast，返回列表 |
| 30000–30999 | 上游异常 → Toast + 提供重试按钮 |
| 31000–31999 | 内部错误 → Toast + 内部上报 |

---

## 与现有代码对照（待改）

| 现有写法 | 改为 |
|----------|------|
| `{'error': '缺少 user_id'}` | `{'success': false, 'code': 20003}` |
| `{'error': '缺少 message'}` | `{'success': false, 'code': 20005}` |
| `{'error': '接口不存在'}` | `{'success': false, 'code': 31002}` |
| `{'success': false, 'error': '内容违规...', 'code': 'CONTENT_VIOLATION'}` | `{'success': false, 'code': 22001}` |
| `{'success': false, 'error': f'调用百炼 API 失败: {e}'}` | `{'success': false, 'code': 30001, 'detail': str(e)}` |
| OSS 静默吞异常 | `{'success': false, 'code': 30003}` / `30004` |
| 封禁拦截（目前硬编码文案） | `{'success': false, 'code': 22002, 'params': {'hours': ...}}` |
