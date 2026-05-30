## Context

nanobot Electron 桌面端目前缺两类能力：

1. **模型/会话参数配置**：`maxTokens`（单次回复上限）、`contextWindowTokens`（上下文窗口）、`maxMessages`（回放消息条数上限）只能通过手动编辑 `~/.nanobot/config.json`。Settings UI 的 ModelsSection 已有模型/preset/provider/vision 的配置，但缺少这三个数值型参数。

2. **Token 用量可视化**：后端 `AgentRunner` 在每轮 agent loop 内累加 LLM 调用的 usage（prompt_tokens, completion_tokens, cached_tokens），结果暂存在 `AgentLoop._last_usage`，但未持久化到 session 消息，也未通过 WebSocket 协议下发。前端只展示 `latencyMs`（耗时），无法展示 token 消耗和上下文占用。

现有数据通路：`AgentRunner.usage` → `AgentLoop._last_usage` → `/status` 文本。需要新增：`→ session message metadata` → `turn_end WS 帧` → `UIMessage.usage` → `MessageBubble footer`。

## Goals / Non-Goals

**Goals:**
- 在 ModelsSection 中暴露 maxTokens、contextWindowTokens、maxMessages 三个字段，使用现有 `/api/settings/update` 保存
- 每轮 agent 结束时将 usage 持久化到 assistant 消息、通过 turn_end 下发
- 在 MessageBubble footer 展示 `↑in ↓out Rcache ctx%`，位于耗时标签左侧
- Transcript 回放（历史消息重新加载）也能展示 usage

**Non-Goals:**
- 不做实时 streaming usage（边生成边显示 token 数）
- 不做累计 session 用量展示（只展示单轮）
- 不做费用估算或计费展示
- 不做 cache write (W) 展示（用户侧感知弱、仅首次写入出现）
- 不改动其他 channel（Telegram、Discord 等）的 usage 展示

## Decisions

### D1: Settings 字段放在 ModelsSection 的模型组下方

**决策**：在 ModelsSection 现有的模型选择器（preset/provider/model/vision）下方增加一个「Generation & Context」分组，包含三个数字输入：maxTokens、contextWindowTokens、maxMessages。

**理由**：这三个参数与模型直接相关（不同模型的上限不同），放在模型分区比放在 Runtime 或 Advanced 更直觉。遵循现有 ModelsSection 的 Group/Label/NumberInput 模式。

**替代方案**：放入 AdvancedSection —— 但 Advanced 目前是只读的信息展示区，不适合放编辑型字段。

### D2: Usage 通过 turn_end 帧下发，不在 message 帧里

**决策**：在 `turn_end` WebSocket 事件中增加 `usage` 对象（与 `latency_ms` 同级），前端在收到 turn_end 时一并 stamp 到最后一条 assistant UIMessage 上。

**理由**：
- 复用 `latencyMs` 的现有路径（`stampLastAssistantLatency`），改动最小
- Usage 是整轮累计值（多次 LLM 调用的和），在 turn 结束时才有完整数据
- 避免在 streaming 的每个 message 帧里带 usage，减少带宽

**替代方案**：在最后一条 assistant message 帧里附带 usage —— 但 message 帧和 turn_end 帧可能不是同一条消息（中间可能有 tool_hint），且 turn_end 是唯一的"本轮结束"信号。

### D3: Usage 同时持久化到 session message metadata

**决策**：在 `_save_turn` 中将 `result.usage` 写入最后一条 assistant 消息的 `usage` 字段（与 `latency_ms` 同级）。Transcript 回放时读取此字段映射为 `UIMessage.usage`。

**理由**：确保历史消息重新加载时也能展示 token 用量，而不仅限于实时收到 turn_end 的那次。

### D4: Context 占用百分比在后端计算后下发

**决策**：在 turn_end 帧的 `usage` 对象中包含 `context_pct`（整数百分比），由后端根据 `_last_usage.prompt_tokens`、`context_window_tokens`、`max_completion_tokens` 计算（复用 `build_status_content` 的公式）。

**理由**：前端不持有 `context_window_tokens` 运行时值（Settings API 只在设置页加载时取），后端计算更准确。

**替代方案**：前端从 Settings API 拿 context_window_tokens 后自己算 —— 但运行时可能通过 `/model` 命令或 `my` 工具修改过，前端拿到的是 config 文件值不是当前值。

### D5: 数字格式化在前端完成

**决策**：后端下发原始数字，前端 `formatTokenCount(n)` 负责 ≥1000 → `X.Xk` 格式化。

**理由**：国际化和显示格式是 UI 关注点，后端只管数据。

### D6: 消息时间戳后端写入带 UTC offset、前端本地时间展示

**决策**：后端写入 `timestamp` 时统一使用 `datetime.now(timezone.utc).astimezone().isoformat()`，输出带 UTC offset 的 ISO 字符串（如 `2026-05-30T18:14:17.626800+08:00`）。前端 `new Date(ts)` 解析后用本地时间格式化为 `MM-DD HH:MM:SS`。

**理由**：
- 带 TZ offset 的 ISO 字符串语义无歧义，`new Date()` 在任何时区均正确解析
- Electron 单机运行，服务端与渲染端在同一台机器，时区天然一致
- 用户在 `config.json` 配置的 `timezone` 是 agent 时间感知用的，不影响 timestamp 写入格式

**直播流时间戳**：直播结束时无法从 session 拿到落盘 timestamp（保存异步发生），改为在 `turn_end` 事件到达时用 `Date.now()` stamp，近似精度足够。

## Risks / Trade-offs

- **[Risk] 多 iteration 累加可能产生大数字** → 目前 Runner 已累加整轮所有 LLM 调用（包括 consolidation、tool-call retry），展示的是真实总消耗，用户可能对单轮几万 input token 感到意外 → 可加 tooltip 解释"含工具调用等中间步骤"
- **[Risk] 不同 provider 的 usage 字段名不统一** → 后端已在 provider 层做了归一化（prompt_tokens / completion_tokens / cached_tokens），前端只需处理统一接口
- **[Risk] 历史 session 消息无 usage 字段** → 前端对 `usage` 做可选处理，无数据时不显示 token 行，只显示耗时
- **[Trade-off] 不展示 cache write (W)** → 简化 UI、减少用户认知负担；W 只在首次写缓存时出现，实际意义有限
