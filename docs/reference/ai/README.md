# BoltStar AI 参考文档

> 状态：current  
> 最后核对：2026-08-07

- [BoltStar SSE 前端接入文档（「-改」版）](<../../../assets/BoltStar-SSE-前端接入文档 -改.md>)：`/chat` 的 SSE 接入说明（事件类型、进度条实现、`stage` 对照表）。**请求体、参数、错误码仍以 v1.0.4 为准**，变的只有接收方式。2026-08-07 与上一版（`assets/BoltStar-流式版接入文档 (1).md`，已删）逐条比对：地址/请求体/事件类型/字段名/事件顺序一律未变，仅新增可选 `model_type`，并明确「后端只发里程碑、前端负责补间」。小程序落地见 [2026-08-06 AI 流式对接与生成进度条](../../changes/2026-08-06-AI流式对接与生成进度条.md) 与 [2026-08-07 SSE 文档核对与进度补间](../../changes/2026-08-07-SSE文档核对与进度补间.md)。
- [BoltStar API v1.0.4](BoltStar-API-Doc-v2-1.0.4.md)：当前外部接口契约。文件尾部内容安全说明存在一处上游文本截断，修复时应从原始文档重新取得，不能用历史版本静默猜补。
- [BoltStar API v1.0.3](archive/BoltStar-API-Doc-v2-1.0.3.md)：历史版本，仅用于差异追溯。
- [BoltStar 错误码草案](archive/BoltStar-Error-Codes-draft.md)：历史草案。当前错误码定义以 v1.0.4 为准，客户端分发策略见 [AI 客户端架构](../../architecture/ai-client.md)。

