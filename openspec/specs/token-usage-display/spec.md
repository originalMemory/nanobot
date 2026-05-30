## ADDED Requirements

### Requirement: 后端在 assistant 消息中持久化 token 用量
AgentLoop SHALL 在每轮 agent loop 结束后，将 `result.usage` 写入当前轮最后一条 assistant 消息的 `usage` 字段。`usage` 对象 SHALL 至少包含 `prompt_tokens`（int）、`completion_tokens`（int）；当 provider 返回缓存信息时还 SHALL 包含 `cached_tokens`（int）。

#### Scenario: 正常轮次结束后 usage 写入 session
- **WHEN** agent loop 完成一轮并调用 `_save_turn`
- **THEN** session 中最后一条 role=assistant 的消息 SHALL 包含 `usage` 字段，其值为该轮所有 LLM 调用的累加 usage dict

#### Scenario: LLM 返回错误时 usage 仍写入
- **WHEN** agent loop 结束且 `result.stop_reason` 为 "error"
- **THEN** 若 `result.usage` 非空，usage 仍 SHALL 写入最后一条 assistant 消息

### Requirement: turn_end WebSocket 帧携带 usage
WebSocket channel SHALL 在 `turn_end` 事件中包含 `usage` 对象，与 `latency_ms` 同级。`usage` 对象 SHALL 包含 `prompt_tokens`、`completion_tokens`，可选 `cached_tokens` 和 `context_pct`（整数百分比）。

#### Scenario: 正常 turn_end 下发 usage
- **WHEN** 后端发送 turn_end 帧
- **THEN** 帧 payload SHALL 包含 `usage: { prompt_tokens: number, completion_tokens: number, cached_tokens?: number, context_pct?: number }`

#### Scenario: usage 为空时 turn_end 不含 usage 字段
- **WHEN** `_last_usage` 为空 dict 或 prompt_tokens=0
- **THEN** turn_end 帧 SHALL 不包含 `usage` 字段

### Requirement: context_pct 后端计算
WebSocket turn_end 中的 `context_pct` SHALL 由后端计算：`min(prompt_tokens / (context_window_tokens - max_completion_tokens - 1024) * 100, 999)`，取整。

#### Scenario: 上下文占用 50%
- **WHEN** prompt_tokens=50000, context_window_tokens=128000, max_completion_tokens=8192
- **THEN** context_pct SHALL 为 `int(50000 / (128000 - 8192 - 1024) * 100)` = 42

#### Scenario: context_window_tokens 为 0
- **WHEN** context_window_tokens ≤ 0
- **THEN** context_pct SHALL 为 0 或不包含在 usage 中

### Requirement: Transcript 回放映射 usage
Transcript 重放（历史消息从 session 重新加载）SHALL 将 assistant 消息中的 `usage` 字段映射为 `UIMessage.usage`，格式与 turn_end 一致。

#### Scenario: 打开历史会话
- **WHEN** Electron 加载历史 session 的 transcript
- **THEN** 有 `usage` 字段的 assistant 消息 SHALL 在 UIMessage 上带有 `usage` 属性

#### Scenario: 旧消息无 usage 字段
- **WHEN** session 中的 assistant 消息不含 `usage` 字段（历史数据）
- **THEN** UIMessage.usage SHALL 为 undefined，UI 不展示 token 行

### Requirement: UIMessage 类型扩展 usage 字段
`UIMessage` interface SHALL 新增可选字段 `usage?: { prompt_tokens: number; completion_tokens: number; cached_tokens?: number; context_pct?: number }`。

#### Scenario: TypeScript 类型定义
- **WHEN** 开发者引用 UIMessage.usage
- **THEN** TypeScript 编译 SHALL 通过且类型完备

### Requirement: useNanobotStream 处理 turn_end 中的 usage
`useNanobotStream` hook SHALL 在收到 turn_end 事件时，若 `ev.usage` 存在，将其 stamp 到最后一条 assistant UIMessage 的 `usage` 字段上。

#### Scenario: 实时接收 turn_end 带 usage
- **WHEN** WebSocket 收到 `{ event: "turn_end", latency_ms: 5000, usage: { prompt_tokens: 1200, completion_tokens: 340, cached_tokens: 800, context_pct: 32 } }`
- **THEN** messages 中最后一条 assistant UIMessage SHALL 同时拥有 `latencyMs: 5000` 和 `usage: { prompt_tokens: 1200, completion_tokens: 340, cached_tokens: 800, context_pct: 32 }`

### Requirement: MessageBubble footer 展示消息时间戳
assistant 消息气泡底部 SHALL 在 token 用量左侧展示消息时间戳，格式为 `MM-DD HH:MM:SS`（本机本地时间，到秒整数）。

#### Scenario: 历史消息回放带时间戳
- **WHEN** session 中 assistant 消息的 `timestamp` 字段为带 UTC offset 的 ISO 字符串（如 `2026-05-30T18:14:17+08:00`）
- **THEN** footer SHALL 展示 `05-30 18:14:17`

#### Scenario: 直播流结束后显示时间戳
- **WHEN** WebSocket `turn_end` 事件收到时
- **THEN** 最后一条 assistant UIMessage SHALL 在 `messageTs` 字段被 stamp 当前 `Date.now()`，时间戳随 token 用量同时出现

#### Scenario: 无时间戳数据
- **WHEN** UIMessage.messageTs 为 undefined
- **THEN** footer SHALL 不展示时间戳区域

### Requirement: MessageBubble footer 展示 token 用量
assistant 消息气泡底部 SHALL 在耗时标签左侧展示 token 用量行。格式为 `↑{in} ↓{out} R{cache} {pct}% ctx`，各指标间以空格分隔。

#### Scenario: 完整 usage 展示
- **WHEN** UIMessage.usage = { prompt_tokens: 1200, completion_tokens: 340, cached_tokens: 62300, context_pct: 32 }
- **THEN** footer 左侧 SHALL 展示 `↑1.2k ↓340 R62.3k 32% ctx`

#### Scenario: 无缓存数据
- **WHEN** UIMessage.usage 中 cached_tokens 为 0 或不存在
- **THEN** footer SHALL 不展示 R 段，只显示 `↑{in} ↓{out} {pct}% ctx`

#### Scenario: 无 context_pct
- **WHEN** UIMessage.usage 中 context_pct 不存在
- **THEN** footer SHALL 不展示 ctx% 段

#### Scenario: 无 usage 数据
- **WHEN** UIMessage.usage 为 undefined
- **THEN** footer SHALL 仅展示耗时，不展示 token 行（向后兼容）

### Requirement: Token 数字格式化
展示 token 数字时 SHALL 使用缩写：≥1000 显示为 `X.Xk`（保留一位小数，如 1200→1.2k, 62300→62.3k, 340→340），≥1000000 显示为 `X.Xm`。

#### Scenario: 数字缩写
- **WHEN** token 值为 62300
- **THEN** 格式化结果 SHALL 为 "62.3k"

#### Scenario: 不足 1000
- **WHEN** token 值为 340
- **THEN** 格式化结果 SHALL 为 "340"

#### Scenario: 百万级
- **WHEN** token 值为 1500000
- **THEN** 格式化结果 SHALL 为 "1.5m"
