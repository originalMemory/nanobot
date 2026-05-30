## 1. 后端 Usage 持久化与协议扩展

- [x] 1.1 在 `AgentLoop._save_turn` 中将 `result.usage` 写入最后一条 assistant 消息的 `usage` 字段（与 `latency_ms` 同级）
- [x] 1.2 在 `AgentLoop` turn 结束时计算 `context_pct`（复用 `build_status_content` 公式），合并进 usage dict
- [x] 1.3 在 `_turn_end` metadata 中传递 `usage` 对象（经 websocket.py `send_turn_end` 下发）
- [x] 1.4 扩展 `WebSocketChannel.send_turn_end` 方法，接受并序列化 `usage` 参数到 turn_end 帧
- [x] 1.5 在 `nanobot/webui/transcript.py` 的 transcript 回放中将 assistant 消息的 `usage` 字段映射为前端格式

## 2. 前端类型与 Hook 扩展

- [x] 2.1 在 `UIMessage` interface 中新增 `usage?: { prompt_tokens: number; completion_tokens: number; cached_tokens?: number; context_pct?: number }`
- [x] 2.2 在 `InboundEvent` 的 `turn_end` 类型中新增 `usage` 可选字段
- [x] 2.3 在 `useNanobotStream` hook 中处理 turn_end 的 usage：创建 `stampLastAssistantUsage` 函数，与 `stampLastAssistantLatency` 配合调用

## 3. 气泡底部 Token 用量与时间戳展示

- [x] 3.1 创建 `formatTokenCount(n: number): string` 工具函数（≥1M→X.Xm, ≥1K→X.Xk, <1K→原值）
- [x] 3.2 在 `MessageBubble` 中新增 `TokenUsageFooter` 子组件，渲染 `↑in ↓out Rcache pct% ctx` 格式
- [x] 3.3 将 `TokenUsageFooter` 集成到 assistant footer 行，位于耗时标签左侧
- [x] 3.4 添加 i18n 翻译 key（en/zh-CN）：tooltip 文案（"Input tokens", "Output tokens", "Cache read tokens", "Context window usage"）
- [x] 3.5 在 `MessageBubble` 中新增 `MessageTimestamp` 子组件，格式为 `MM-DD HH:MM:SS`，位于 token 用量左侧
- [x] 3.6 后端 session 消息 `timestamp` 字段带 UTC offset（`datetime.now(timezone.utc).astimezone().isoformat()`），确保前端解析无歧义
- [x] 3.7 直播流结束时（`turn_end`）通过 `stampLastAssistantTs(Date.now())` 将时间戳打到最后一条 assistant 消息上

## 4. Settings UI 模型参数配置

- [x] 4.1 在 `ModelsSection` 中新增「Generation & Context」分组，包含 maxTokens（Min: 1）、contextWindowTokens（Min: 4096）、maxMessages（Min: 0）三个 NumberInput 字段
- [x] 4.2 确认 `/api/settings/update` 端点已支持 `max_tokens`、`context_window_tokens`、`max_messages` 参数的更新（如不支持需后端补充）
- [x] 4.3 设置页加载时回显当前值，保存时校验范围并调用 update API

## 5. 测试

- [x] 5.1 后端测试：turn_end 帧包含 usage 对象、_save_turn 写入 usage 字段、context_pct 计算正确
- [x] 5.2 前端测试：MessageBubble 渲染 token 用量行、无 usage 时不显示、formatTokenCount 格式化正确
