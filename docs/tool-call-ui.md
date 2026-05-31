# 工具调用 → UI 展示映射

本文说明 nanobot 如何把 agent 的工具调用（tool calls）转换成 WebUI / Electron 里用户看到的 activity 卡片（如 `Using message`、`Shell`、`Reading` 等）。

WebUI 与 Electron 共用同一套前端类型与渲染逻辑（`UIMessage`、`useNanobotStream`、`AgentActivityCluster`），后端 wire 格式也一致。

## 概览

工具调用在系统里会经历 **四层表示**，最后才变成 UI：

| 层级 | 形态 | 用途 |
|------|------|------|
| 1. Agent 执行 | OpenAI 格式 `assistant.tool_calls` + `tool` result | LLM 上下文、Session 持久化 |
| 2. Progress / Wire | WebSocket `message` 帧，`kind: tool_hint`，附带 `tool_events` | 直播实时展示、WebUI transcript 调试日志 |
| 3. UI 消息 | `UIMessage`，`role: tool`，`kind: trace` | 前端状态树 |
| 4. 展示单元 | `assistant-turn` 气泡内的 `AgentActivityCluster` | 折叠 activity、文案与图标 |

**重要**：Session 里存的 `assistant` + `tool_calls` 行 **不会直接渲染**。UI 展示的是 progress/wire 层的 **tool hint + structured tool_events**，或在回放时由 `tool` result 合并生成等价事件。

```text
直播：LLM tool_calls → AgentProgressHook → WebSocket tool_hint → useNanobotStream → AgentActivityCluster
回放：Session tool_calls + tool → session_messages_to_wire_events → replay_transcript_to_ui_messages → 同上
```

## 1. Agent 执行层

### 1.1 LLM 返回与 Runner

`AgentRunner` 收到带 `tool_calls` 的 LLM 响应后：

1. 调用 `AgentProgressHook.before_execute_tools()` — 发 **start** 阶段 progress
2. 执行工具（`ToolRegistry.execute`）
3. 调用 `AgentProgressHook.after_iteration()` — 发 **end/error** 阶段 progress
4. 将 `assistant`（含 `tool_calls`）和 `tool` result 写入 Session

相关代码：

- `nanobot/agent/runner.py` — 工具执行循环
- `nanobot/agent/progress_hook.py` — 生命周期 → progress 信号
- `nanobot/utils/progress_events.py` — `tool_events` 结构化 payload

### 1.2 Progress 回调

`AgentProgressHook` 通过 `on_progress` 回调发出两类信息：

**文本 hint**（`tool_hint=True`）：

- 由 `format_tool_hints()` 生成，例如 `read /path/to/file`、`search "query"`
- 对部分工具有专用缩写模板（`read_file`、`exec`、`web_search` 等）
- 见 `nanobot/utils/tool_hints.py`

**结构化事件**（`tool_events`）：

```json
{
  "version": 1,
  "phase": "start | end | error",
  "call_id": "call_xxx",
  "name": "read_file",
  "arguments": {"path": "notes.md"},
  "result": "...",
  "error": null
}
```

WebSocket 通道上，progress 经 `build_bus_progress_callback()` 包装为 outbound 消息，metadata 带 `_progress`、`_tool_hint`、`_tool_events`。见 `nanobot/session/webui_turns.py`。

## 2. Wire 层（WebSocket / Transcript）

### 2.1 直播帧格式

WebSocket 客户端收到的是 `event: "message"` 帧，工具相关时带：

```json
{
  "event": "message",
  "chat_id": "...",
  "text": "read_file({\"path\": \"notes.md\"})",
  "kind": "tool_hint",
  "tool_events": [
    {
      "phase": "start",
      "call_id": "call_1",
      "name": "read_file",
      "arguments": {"path": "notes.md"}
    }
  ]
}
```

工具执行结束后会再发一帧，`phase` 升级为 `end` 或 `error`，`call_id` 相同，前端按 `call_id` 合并同一条 trace。

`WebSocketChannel.send()` 会把 `_tool_events` 透传到 payload，并 append 到 per-chat WebUI transcript（wire 日志）。见 `nanobot/channels/websocket.py`。

### 2.2 配置开关

| 配置 | 作用 |
|------|------|
| `channels.sendToolHints` | 是否向通道发送 tool hint 文本 |
| `channels.sendProgress` | 是否发送非 hint 的 progress 文本 |
| `agents.defaults.toolHintMaxLength` | hint 文本最大长度 |

CLI 等通道可单独关闭 tool hint；WebSocket / Electron 通常保持开启。

### 2.3 Session 持久化（与 UI 不同源）

每轮结束后，Session 写入的是 **OpenAI 对话格式**，不是 wire 帧：

```json
{"role": "assistant", "content": "", "tool_calls": [{"id": "call_1", "function": {"name": "read_file", "arguments": "..."}}]}
{"role": "tool", "tool_call_id": "call_1", "name": "read_file", "content": "file contents..."}
{"role": "assistant", "content": "根据文件内容..."}
```

这是 LLM 的上下文来源。Electron inbox 回放也读这份 Session，但需要 **转换** 才能复用直播 UI 逻辑（见下文第 3 节）。

## 3. 回放转换层

### 3.1 Session → Wire Events

`session_messages_to_wire_events()`（`nanobot/webui/transcript.py`）策略：

1. 遇到 `assistant.tool_calls`：**按 `call_id` 缓存** `{name, arguments}`，不立即产出 UI 事件
2. 遇到匹配的 `tool` 消息：合并参数与结果，产出 **单条** `kind: tool_hint` wire event，`phase: end`
3. 这样回放不会出现 start + end 两行重复 trace（与 wire 日志在 turn 结束后的形态一致）

`GET /api/inbox/thread` 路径：

```text
Session → session_messages_to_wire_events() → replay_transcript_to_ui_messages() → JSON 给 Electron
```

`GET /api/webui/thread/{key}` 路径（单 WebSocket chat）直接读 wire transcript JSONL，跳过 Session 转换。

### 3.2 Wire Events → UIMessage

`replay_transcript_to_ui_messages()` 处理 `kind: tool_hint | progress`：

1. `tool_trace_lines_from_events()` / `_format_tool_call_trace()` 生成 trace 文本，如 `read_file({"path": "notes.md"})`
2. 合并相邻 trace 行到同一条 `UIMessage`（`role: tool`, `kind: trace`）
3. 同一 `call_id` 的 start/end 按 phase rank 合并 `toolEvents`

最终结构与 `useNanobotStream` 在直播时构造的 `UIMessage` 对齐，前端无需区分来源。

### 3.3 与直播的差异

| 方面 | 直播 | 回放（Session） |
|------|------|----------------|
| tool 事件 phase | 通常先有 `start`，后有 `end` | 多为合并后的单条 `end` |
| hint 文本 | `format_tool_hints()` 缩写 | `_format_tool_call_trace()` 完整 `name(args)` |
| 时序 | 严格按执行顺序 push | 按 Session 落盘顺序；部分镜像（如 channel delivery）可能需 replay 层重排 |
| turn 边界 | 真实 `turn_end` 帧 | Session 转换时在末尾补一个 `turn_end` |

## 4. 前端 UIMessage 层

### 4.1 直播：`useNanobotStream`

收到 `event: "message"` 且 `kind: tool_hint | progress` 时：

1. `normalizeToolProgressEvents(ev.tool_events)` 规范化 phase
2. `toolTraceLinesFromEvents()` 生成 trace 文本行
3. 若上一条也是同 segment 的 trace，**合并** `traces` 与 `toolEvents`（同 `call_id` 更新 phase）
4. 写入 `UIMessage`：

```typescript
{
  role: "tool",
  kind: "trace",
  content: "read_file({\"path\": \"notes.md\"})",
  traces: ["read_file({\"path\": \"notes.md\"})"],
  toolEvents: [{ phase: "end", name: "read_file", call_id: "...", ... }],
  activitySegmentId: "activity-1",
}
```

相关代码：

- `electron/src/renderer/hooks/useNanobotStream.ts`（WebUI 镜像在 `webui/src/hooks/useNanobotStream.ts`）
- `electron/src/renderer/lib/tool-traces.ts`

### 4.2 一轮内的 segment

同一 agent turn 内的 reasoning、tool trace、file edit 共享 `activitySegmentId`，便于折叠成一组 activity。segment 在首个 activity 事件时分配，assistant 正文开始时关闭。

## 5. 展示层：ThreadMessages → AgentActivityCluster

### 5.1 收成 assistant-turn 气泡

`ThreadMessages.buildDisplayUnits()` / `coalesceAssistantTurnUnits()`：

1. 把连续的 `trace` 行收成 `cluster`
2. 与 assistant 正文收成单个 `assistant-turn` SAP 气泡
3. `channelDelivery` 等边界条件会拆泡（见 `docs/electron-unified-inbox.md`）

### 5.2 Activity 卡片文案

`AgentActivityCluster` 读取 cluster 内 `UIMessage`：

- **折叠标题**：统计 reasoning 步数、tool 次数、文件编辑等（`Working… · 2 tool calls`）
- **展开列表**：对每条 trace 调用 `describeTraceLine(line)`

`describeTraceLine()` 把 trace 文本解析为 `{ label, detail }`：

| trace 模式 | label | detail 示例 |
|------------|-------|-------------|
| `web_search(...)` | Searching | 查询关键词 |
| `web_fetch(...)` / `read_file(...)`（含 URL） | Reading | 域名或路径 |
| `exec(...)` | Shell | 命令摘要 |
| `run_cli_app(...)` | （专用 CliRunGroup） | `@github` 等 |
| `mcp_*` | （专用 McpRunGroup） | preset 名 |
| 其他 `name(...)` | **Using** | **工具名**，如 `message` → 显示为 **Using message** |
| 无函数形式 | Working | 原始文本 |

因此 `message(...)` 工具在 UI 上显示为 **Using message**，detail 为工具名 `message`；参数 JSON 默认不在 label 里展开（除非走 CLI/MCP/Shell 等专用分支）。

### 5.3 文件编辑（独立通道）

`edit_file` / `write_file` 等编辑类工具除 tool hint 外，还可能发 `event: file_edit` 帧，携带结构化 diff 统计。前端写入 `UIMessage.fileEdits`，由 `AgentActivityCluster` 的文件 activity 区块展示，与纯 trace 行并列。

## 6. 端到端示例

用户问：「读一下 notes.md」

**Session 落盘：**

```text
user: 读一下 notes.md
assistant: (tool_calls: read_file)
tool: (result: 文件内容...)
assistant: 文件里写了...
```

**直播 WebSocket（简化）：**

```text
message kind=tool_hint  tool_events=[{phase:start, name:read_file, ...}]
message kind=tool_hint  tool_events=[{phase:end, name:read_file, result:...}]
delta / message: 文件里写了...
turn_end
```

**UIMessage（前端状态）：**

```text
trace: read_file({"path":"notes.md"})  + toolEvents
assistant: 文件里写了...
```

**用户看到：**

```text
┌─ assistant turn ─────────────────┐
│ ▸ Working… · 1 tool call        │
│   Using read_file  notes.md       │  ← describeTraceLine
│                                   │
│ 文件里写了...                      │
└───────────────────────────────────┘
```

## 7. 相关代码索引

| 环节 | 位置 |
|------|------|
| Progress hook | `nanobot/agent/progress_hook.py` |
| tool_events 构造 | `nanobot/utils/progress_events.py` |
| 直播 hint 缩写 | `nanobot/utils/tool_hints.py` |
| WebSocket 出站 | `nanobot/channels/websocket.py` → `send()` |
| Session → wire | `nanobot/webui/transcript.py` → `session_messages_to_wire_events()` |
| wire → UIMessage | `nanobot/webui/transcript.py` → `replay_transcript_to_ui_messages()` |
| Inbox thread API | `nanobot/webui/transcript.py` → `build_inbox_thread_from_session()` |
| 直播状态机 | `electron/src/renderer/hooks/useNanobotStream.ts` |
| trace 文本工具 | `electron/src/renderer/lib/tool-traces.ts` |
| 气泡合并 | `electron/src/renderer/components/thread/ThreadMessages.tsx` |
| Activity 渲染 | `electron/src/renderer/components/thread/AgentActivityCluster.tsx` |

## 参见

- [WebSocket 协议](./websocket.md) — 连接、流式帧、reasoning 帧
- [Electron 统一收件箱](./electron-unified-inbox.md) — Session 权威数据源与 inbox replay 数据流
