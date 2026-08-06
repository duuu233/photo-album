# BoltStar 流式版接入文档

## 一、地址切换

| | 非流版（旧） | 流式版（新） |
|---|---|---|
| 地址 | `boltstaat-agent-...fcapp.run` | `boltstagent-web-jncfttrxvt.ap-southeast-1.fcapp.run` |

请求格式、参数、JWT 认证方式**完全不变**。

---

## 二、请求→响应模式变更

```
非流版：  POST /chat → 等15-30秒 → json {text, images}
流式版：  POST /chat → SSE 实时推送 → 逐步接收事件
```

**请求 body 完全一样，不需要改。只需要把接收方式从 JSON 改为 SSE。**

---

## 三、SSE 事件类型

### 事件顺序（生图场景）

```
1. pre_text     → "正在为您绘制…"          展示预描述文案
2. progress     → {progress: 5}             进度条 5%
3. progress     → {progress: 5-45 递增}     进度条缓慢增长
4. progress     → {progress: 50}            进度条 50%（图已就绪）
5. progress     → {progress: 80}            进度条 80%
6. progress     → {progress: 85,90}         进度条 85-90%
7. image        → {content: "https://..."}  展示图片
8. text         → "画面里..."（逐条推送）   打字机渲染描述文字
9. progress     → {progress: 100}           进度条 100%
10. done         → {orientation: "square"}   完成
```

### 纯文字场景（无生图）

```
1. text         → "你好呀"（逐条推送）      打字机渲染
2. done         → {orientation: "square"}   完成
```

---

## 四、小程序改动点

### 4.1 请求方式改为 SSE 流式读取

```javascript
// 旧版（非流）
const res = await wx.request({ url, method: 'POST', data: body });
const { text, images } = res.data.data;

// 新版（流式 SSE）
const requestTask = wx.request({
  url: 'https://boltstagent-web-jncfttrxvt.ap-southeast-1.fcapp.run/chat',
  method: 'POST',
  header: { 'Content-Type': 'application/json', 'Authentication': 'Bearer ' + token },
  data: body,
  enableChunked: true,  // ✅ 关键：开启分块传输
  responseType: 'text',
});

let buffer = '';
requestTask.onChunkReceived((chunk) => {
  buffer += chunk.data;
  // 按行解析 SSE
  const lines = buffer.split('\n');
  buffer = lines.pop();  // 最后一行可能不完整，保留

  for (const line of lines) {
    if (line.startsWith('data: ')) {
      const event = JSON.parse(line.slice(6));
      handleEvent(event);
    }
  }
});
```

### 4.2 handleEvent 事件分发

```javascript
function handleEvent(event) {
  switch (event.type) {
    case 'pre_text':
      // 展示预描述："正在为您绘制赛博朋克城市的雨夜夜景…"
      this.setData({ preDesc: event.content, showProgress: true });
      break;

    case 'progress':
      // 更新进度条 0→100
      const pct = event.progress;  // 5, 8, 15, ..., 50, 80, 85, 90, 100
      this.setData({ progress: pct });
      // 可选：根据 stage 展示不同文案
      // event.stage: "request_sent" | "generating" | "partial_succeeded" | "completed" | "downloading" | "uploaded" | "done"
      break;

    case 'image':
      // 展示生成的图片
      this.setData({ generatedImage: event.content });
      break;

    case 'text':
      // 打字机效果：逐条追加文字
      const newText = (this.data.aiText || '') + event.content;
      this.setData({ aiText: newText });
      break;

    case 'done':
      // 生成完成
      this.setData({ progress: 100, showProgress: false, done: true });
      break;
  }
}
```

### 4.3 进度条 UI 映射

| progress 值 | 建议展示文案 |
|---|---|
| 0-5 | "正在连接…" |
| 5-45 | "AI 正在创作中…" + 进度条动画 |
| 50 | "图片初稿已完成 ✨" |
| 80-90 | "正在优化细节…" |
| 100 | 完成，隐藏进度条 |

---

## 五、改动清单

| # | 改动项 | 说明 |
|---|---|---|
| 1 | 请求地址 | 切到流式版 URL |
| 2 | `wx.request` → `enableChunked: true` | 开启分块传输 |
| 3 | 回调从 `success` → `onChunkReceived` | 监听 SSE 数据流 |
| 4 | 新增 `handleEvent` 函数 | 分发 pre_text/progress/image/text/done |
| 5 | 进度条 UI | 用 `event.progress` 驱动，0→100 平滑递增 |
| 6 | 预描述展示 | `pre_text` 到来时展示一句话描述 |
| 7 | 打字机效果 | `text` 逐条追加而非一次性渲染 |

**请求参数（user_id、session_id、message、img_orientation、image_urls）完全不动。**
