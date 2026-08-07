# BoltStar SSE 进度与调用文档

## 一、接口

```
POST https://boltstagent-web-jncfttrxvt.ap-southeast-1.fcapp.run/chat
```

### 请求头

```
Content-Type: application/json
Authentication: Bearer <JWT_TOKEN>
```

### 请求体

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| user_id | string | ✅ | 用户 ID |
| session_id | string | ✅ | 会话 ID |
| message | string | ✅ | 用户消息 |
| img_orientation | string | ✅ | horizontal / square / vertical |
| img_style | string | ❌ | 一键生图: cartoon / landscape / portrait / anime |
| model_type | string | ❌ | 生图模型: lite / pro，默认 pro |
| image_urls | string[] | ❌ | 参考图 URL 列表 |
| temperature | float | ❌ | LLM 温度，默认 0.8 |

---

## 二、SSE 事件类型

### 完整事件流（生图场景）

```
    ← ~15s 无事件（前端展示自定义 loading）
data: {"type":"pre_text","content":"正在为您绘制海边奔跑的金毛狗狗…"}
data: {"type":"progress","progress":5,"stage":"starting"}
data: {"type":"progress","progress":5,"stage":"request_sent"}
data: {"type":"progress","progress":15,"stage":"generating"}
data: {"type":"progress","progress":30,"stage":"generating"}
data: {"type":"progress","progress":45,"stage":"generating"}
data: {"type":"progress","progress":50,"stage":"partial_succeeded"}
data: {"type":"progress","progress":80,"stage":"completed"}
data: {"type":"progress","progress":85,"stage":"downloading"}
data: {"type":"progress","progress":90,"stage":"uploaded"}
data: {"type":"image","content":"https://inkstar.oss-.../xxx.jpg"}
data: {"type":"text","content":"画面里"}
data: {"type":"text","content":"金色的"}
data: {"type":"text","content":"…"}
    ↓ (文字逐条推送)
data: {"type":"progress","progress":100,"stage":"done"}
data: {"type":"done","orientation":"square"}
```

### 纯文字场景（无生图）

```
    ← ~10s 无事件（前端展示自定义 loading）
data: {"type":"text","content":"你好呀"}
data: {"type":"text","content":"…"}
    ↓
data: {"type":"done","orientation":"square"}
```

---

## 三、进度条实现（0→100，每次+1）

### ⚠️ 后端只发里程碑，前端负责平滑动画

后端发的 progress 值：`0, 5, 15, 30, 45, 50, 80, 85, 90, 100`

前端收到新 progress 值后，用 `requestAnimationFrame` 或定时器从当前值平滑过渡到目标值。

### 微信小程序实现

```javascript
Page({
  data: {
    displayProgress: 0,   // 平滑显示值
    targetProgress: 0,    // 后端最新值
    progressText: '',     // 进度文案
    preDesc: '',          // 预描述
    aiText: '',           // AI 回复文字
    generatedImage: '',   // 生成图片 URL
  },

  // 发起 SSE 请求
  sendChat() {
    const requestTask = wx.request({
      url: 'https://boltstagent-web-jncfttrxvt.ap-southeast-1.fcapp.run/chat',
      method: 'POST',
      header: {
        'Content-Type': 'application/json',
        'Authentication': 'Bearer ' + this.data.token,
      },
      data: {
        user_id: 'xxx',
        session_id: 'xxx',
        message: '画一只猫',
        img_orientation: 'square',
        model_type: 'pro',
      },
      enableChunked: true,
      responseType: 'text',
    });

    let buffer = '';
    requestTask.onChunkReceived((chunk) => {
      buffer += chunk.data;
      const lines = buffer.split('\n');
      buffer = lines.pop(); // 最后一行可能不完整

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const event = JSON.parse(line.slice(6));
            this.handleEvent(event);
          } catch (e) {}
        }
      }
    });
  },

  // 事件分发
  handleEvent(event) {
    switch (event.type) {
      case 'pre_text':
        this.setData({ preDesc: event.content });
        break;

      case 'progress':
        this.setData({ targetProgress: event.progress });
        this.animateProgress();
        // 可选：根据 stage 切换文案
        this.updateProgressText(event.stage);
        break;

      case 'image':
        this.setData({ generatedImage: event.content });
        break;

      case 'text':
        this.setData({ aiText: this.data.aiText + event.content });
        break;

      case 'done':
        this.setData({ targetProgress: 100, displayProgress: 100, preDesc: '' });
        break;
    }
  },

  // 平滑进度动画
  animateProgress() {
    if (this._animTimer) return;
    this._animTimer = setInterval(() => {
      let current = this.data.displayProgress;
      const target = this.data.targetProgress;
      if (current >= target) {
        clearInterval(this._animTimer);
        this._animTimer = null;
        return;
      }
      // 每次 +1，间隔根据剩余距离动态调整
      const remaining = target - current;
      const step = remaining > 20 ? 3 : 1; // 远时跳得快
      current = Math.min(current + step, target);
      this.setData({ displayProgress: current });
    }, 80);
  },

  // 进度文案
  updateProgressText(stage) {
    const map = {
      'request_sent': '正在连接生图引擎…',
      'generating': 'AI 正在创作中…',
      'partial_succeeded': '初稿已完成 ✨',
      'completed': '正在优化细节…',
      'downloading': '正在下载图片…',
      'done': '完成！',
    };
    this.setData({ progressText: map[stage] || '' });
  },
});
```

### Flutter 实现

```dart
import 'dart:async';
import 'dart:convert';
import 'package:http/http.dart' as http;

class ChatService {
  final String baseUrl = 'https://boltstagent-web-jncfttrxvt.ap-southeast-1.fcapp.run';
  final String token = 'YOUR_JWT_TOKEN';
  
  Stream<Map<String, dynamic>> sendChat(Map<String, dynamic> body) async* {
    final client = http.Client();
    final request = http.Request('POST', Uri.parse('$baseUrl/chat'));
    request.headers['Content-Type'] = 'application/json';
    request.headers['Authentication'] = 'Bearer $token';
    request.body = jsonEncode(body);

    final response = await client.send(request);
    String buffer = '';

    await for (final chunk in response.stream.transform(utf8.decoder)) {
      buffer += chunk;
      final lines = buffer.split('\n');
      buffer = lines.removeLast();

      for (final line in lines) {
        if (line.startsWith('data: ')) {
          try {
            final event = jsonDecode(line.substring(6));
            yield event;
          } catch (_) {}
        }
      }
    }
    client.close();
  }
}

// ── 进度动画 Widget ──
class ProgressWidget extends StatefulWidget {
  final Stream<Map<String, dynamic>> eventStream;
  const ProgressWidget({required this.eventStream});

  @override
  State<ProgressWidget> createState() => _ProgressWidgetState();
}

class _ProgressWidgetState extends State<ProgressWidget> 
    with SingleTickerProviderStateMixin {
  double _displayProgress = 0;
  double _targetProgress = 0;
  String _preDesc = '';
  String _progressText = '';
  String _aiText = '';
  String? _imageUrl;
  Timer? _animTimer;

  @override
  void initState() {
    super.initState();
    widget.eventStream.listen(_handleEvent);
  }

  void _handleEvent(Map<String, dynamic> event) {
    final type = event['type'] as String?;
    switch (type) {
      case 'pre_text':
        setState(() => _preDesc = event['content'] ?? '');
        break;
      case 'progress':
        _targetProgress = (event['progress'] as num).toDouble();
        _startAnim();
        _updateText(event['stage'] as String? ?? '');
        break;
      case 'image':
        setState(() => _imageUrl = event['content']);
        break;
      case 'text':
        setState(() => _aiText += event['content'] ?? '');
        break;
      case 'done':
        setState(() {
          _displayProgress = 100;
          _targetProgress = 100;
          _preDesc = '';
        });
        break;
    }
  }

  void _startAnim() {
    _animTimer?.cancel();
    _animTimer = Timer.periodic(const Duration(milliseconds: 80), (timer) {
      if (_displayProgress >= _targetProgress) {
        timer.cancel();
        return;
      }
      final remaining = _targetProgress - _displayProgress;
      final step = remaining > 20 ? 3.0 : 1.0;
      setState(() {
        _displayProgress = (_displayProgress + step).clamp(0, _targetProgress);
      });
    });
  }

  void _updateText(String stage) {
    const map = {
      'request_sent': '正在连接生图引擎…',
      'generating': 'AI 正在创作中…',
      'partial_succeeded': '初稿已完成 ✨',
      'completed': '正在优化细节…',
      'downloading': '正在下载图片…',
      'done': '完成！',
    };
    setState(() => _progressText = map[stage] ?? '');
  }

  @override
  Widget build(BuildContext context) {
    return Column(children: [
      if (_preDesc.isNotEmpty) Text(_preDesc),
      if (_displayProgress > 0 && _displayProgress < 100)
        Column(children: [
          LinearProgressIndicator(value: _displayProgress / 100),
          Text('${_displayProgress.toInt()}% $_progressText'),
        ]),
      if (_imageUrl != null) Image.network(_imageUrl!),
      if (_aiText.isNotEmpty) Text(_aiText),
    ]);
  }

  @override
  void dispose() {
    _animTimer?.cancel();
    super.dispose();
  }
}
```

---

## 四、progress 值与 stage 对照表

| progress | stage | 含义 | 前端展示 |
|---|---|---|---|
| 5 | request_sent | 请求已发送 | "正在连接生图引擎…" |
| 5-45 | generating | AI 创作中 | 进度条缓慢增长 |
| 50 | partial_succeeded | 图片初稿完成 | "初稿已完成 ✨" |
| 80 | completed | 生成完成 | "正在优化细节…" |
| 85 | downloading | 下载图片 | |
| 90 | uploaded | OSS 上传完成 | |
| 100 | done | 全部完成 | 隐藏进度条 |

---

## 五、注意事项

1. **pre_text 第一个事件**：~15s 后出现（等 LLM 第一轮返回），前端在此之前展示自定义 loading
2. **进度动画由前端实现**：后端发里程碑，前端用定时器平滑过渡，每次 +1~+3
3. **文字逐条推送**：每次 1-3 字符，前端追加渲染实现打字机效果
4. **image 事件单独推送**：收到后直接展示图片，不混在文字流中
