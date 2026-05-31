# Electron 跨端应用 + 统一收件箱

## 背景

nanobot 当前采用「Agent 大脑」与「WebUI 展示」双轨设计：

- **Agent Session**（`unified:default` 或 `channel:chat_id`）：LLM 看到的上下文
- **WebUI Transcript**（`websocket:{chat_id}`）：前端展示的聊天记录

`unifiedSession: true` 只合并了大脑，展示层仍然 per-thread 隔离。目标是用 Electron 重写跨端入口，实现类似 OpenClaw「主会话统管」的体验：**在一个窗口看到所有通道的对话，并无缝继续对话**。

## 当前可用能力

开启 `unifiedSession: true` 后，Electron 作为 WebSocket 客户端连接 nanobot，**继续对话零成本**：

```text
Telegram 历史 ──┐
Discord 历史  ──┼──→ unified:default Agent 上下文
CLI 历史      ──┘

用户从 Electron 发消息
  → InboundMessage(channel=websocket, chat_id=xxx)
  → 读取 unified:default（包含所有通道历史）
  → 模型知道 Telegram/Discord 里说过什么
  → 回复推回 Electron
```

这覆盖了 80% 的使用场景——换设备后对话是连续的。

## Phase 2：后端统一 Inbox 能力

使 Electron 能**看到**所有通道的历史对话与实时消息。后端改动约 200 行，工作量 2-3 天。

### 2.0 稳定的主会话 ID

**问题**：当前 WebSocket 客户端每次连接，Gateway 分配随机 UUID 作为 `chat_id`（`default_chat_id = str(uuid.uuid4())`）。Electron 每次重连会拿到新 ID，导致 session 文件和 transcript 无法复用。虽然 `unifiedSession: true` 下 Agent 上下文（`unified:default`）是连续的，但展示层会断裂。

**方案**：允许客户端在 `attach` 时指定一个预定义的 `chat_id`（如 `"electron-main"`）：

```json
{ "type": "attach", "chat_id": "electron-main" }
```

- Session 已存在 → 挂载并加载历史
- Session 不存在 → 以该 ID 创建

Electron 端在配置或本地存储中持久化这个 ID，每次启动 attach 同一个。后端改动集中在 `_dispatch_envelope` 的 `attach` 分支，确保对未知 `chat_id` 自动创建 session 即可。

**文件**：`nanobot/channels/websocket.py` → `_dispatch_envelope`

### 2.1 Sessions API 放开过滤

**文件**：`nanobot/channels/websocket.py` → `_handle_sessions_list`

当前硬过滤 `websocket:*`，需放开（或新增 `/api/inbox/sessions`），附带 `channel` 字段供 Electron 分组展示。

```python
# 当前
if not (isinstance(key, str) and key.startswith("websocket:")):
    continue

# 改为：暴露所有通道，或新增独立端点
```

### 2.2 统一 Transcript 写入（核心）

**文件**：`nanobot/agent/loop.py` 出站路径（或 Bus outbound handler）

`unifiedSession: true` 时，所有通道的入站/出站消息同步 append 到统一 transcript 文件（`data/webui/unified_default.jsonl`），格式与现有 WebUI transcript 一致，额外带 `source_channel` 字段：

```json
{"event": "user", "source_channel": "telegram", "chat_id": "8281248569", "text": "..."}
{"event": "message", "source_channel": "telegram", "chat_id": "8281248569", "text": "..."}
```

### 2.3 WebSocket Fan-out（实时性）

**文件**：`nanobot/channels/websocket.py` → `send()`

`unifiedSession: true` 时，除了回复原通道，同时把事件推送给订阅了 `unified:default` 的 Electron 客户端，实现实时收件箱。

### 2.4 Inbox HTTP 端点

新增 `GET /api/inbox/thread`，返回统一 transcript 重放结果，供 Electron 启动时加载完整历史。

## Phase 3：Electron 前端

### 技术栈

- Electron（主进程 + 渲染进程）
- 设备截屏等系统级能力（Electron 原生）
- 通过 WebSocket 连接本地 nanobot gateway

### 核心界面设计

```
┌─────────────────────────────────────────────────────┐
│  侧边栏                │  主聊天区（统一 Inbox）        │
│                        │                              │
│  📥 统一收件箱 ●       │  [Telegram] 你好              │
│  ─────────────         │  助手：你好！                 │
│  💬 Telegram           │                              │
│  💬 Discord            │  [Discord] 帮我查一下...      │
│  💻 CLI                │  助手：好的，正在查询...       │
│  🖥 本地               │                              │
│                        │  [输入框]              发送   │
└─────────────────────────────────────────────────────┘
```

每条消息标注来源通道（`source_channel`），视觉上区分但逻辑上是同一条时间线。

### 关键实现点

- 连接到 `unified:default` 而非 per-thread `websocket:{uuid}`
- 历史加载：`GET /api/inbox/thread`
- 实时消息：订阅 fan-out 推送
- `UIMessage` 扩展 `sourceChannel?: string` 字段

## Phase 4：后续优化项

暂不实现，记录备用：

### 跨通道回复路由

**方案 A（工具）**：给 Agent 加 `send_to_channel(channel, chat_id, message)` 工具，用户自然语言指令回复到指定通道，约 30 行。

**方案 B（UI 选择器）**：Electron 输入框旁增加通道下拉选择器，消息携带 `reply_target: { channel, chat_id }`，Gateway 层处理路由，约 70 行后端 + Electron UI。

**方案 C（智能默认）**：Fan-in 推送时记录 `source_channel`，Electron 自动将 reply_target 默认设为最后一条来信的通道。

### 设备截屏集成

利用 Electron 的 `desktopCapturer` API，截屏后作为 `media` 附件随消息发送，复用 nanobot 现有的图片处理管线。

## 实施顺序

```
Phase 2  后端统一 Inbox（2-3 天）
  ├─ 2.0 稳定主会话 ID（attach 支持客户端指定 chat_id）
  ├─ 2.1 Sessions API 放开
  ├─ 2.2 统一 Transcript 写入
  ├─ 2.3 WebSocket fan-out
  └─ 2.4 Inbox HTTP 端点

Phase 3  Electron 前端
  ├─ 基础壳：Electron 主进程 + WebSocket 连接
  ├─ 统一 Inbox 视图（历史 + 实时）
  ├─ 通道标签与分组
  └─ 系统级功能（截屏等）

Phase 4  跨通道回复路由（后续优化）
```

## Transcript 文件架构

`unifiedSession: true` 模式下，对话数据写入两个文件：

| 文件 | Session Key | 用途 | 格式 |
|------|-------------|------|------|
| `~/.nanobot/workspace/sessions/unified_default.jsonl` | `unified:default` | **权威数据源**：AI 上下文 + Electron 启动历史的唯一数据来源。包含完整的 user/assistant/tool 消息，附带 `source_channel` 和 `source_chat_id` | `{role, content, source_channel?, timestamp}` |
| `~/.nanobot/webui/websocket_inbox_unified.jsonl` | `websocket:inbox:unified` | **WebSocket wire 日志**：每帧协议事件（delta 分片、stream_end、turn_end 等），仅供调试 | `{event, text, stream_id, ...}` |

> **已废弃**：`~/.nanobot/webui/unified_default.jsonl`（原文件 2）不再写入。历史数据由 `GET /api/inbox/thread` 直接从 Session 转换生成。

### 数据流

```
用户发消息
    │
    ├─→ Session (文件 1)：agent loop 写入 user/assistant/tool 消息（含 source_channel）
    │     ↓
    │   GET /api/inbox/thread → session_messages_to_wire_events() → replay_transcript_to_ui_messages()
    │     ↓
    │   返回 UI 格式消息给 Electron（含 tool trace、source_channel 标签）
    │
    └─→ WebSocket wire 日志 (文件 2)：_try_append_webui_transcript() 逐帧写入
```

### `source_channel` 字段

在 `unifiedSession: true` 模式下，`AgentLoop._source_extras(msg)` 统一生成 `{"source_channel": msg.channel, "source_chat_id": msg.chat_id}`，由以下三处注入 Session 消息：

- `_persist_user_message_early()`：用户消息提前持久化时
- `_save_turn()`：每轮 agent loop 结束保存 assistant/tool 消息时
- `_state_command()`：命令快捷路径的 assistant 回复时

这使得 Electron 能在重启后从 Session 恢复每条消息的来源通道信息。

### 生命周期与清理

| 操作 | Session (文件 1) | Wire 日志 (文件 2) |
|------|-----------------|-------------------|
| `/new` 命令 | ✅ 清空（session.clear()） | ❌ 不清 |
| AutoCompact（自动压缩） | ✅ 旧消息替换为摘要 | ❌ 不受影响 |
| REST API 删除 session | ✅ 删除 | ❌ 不清 |
| 文件超过 8 MB | 不适用 | ⚠️ 读取被跳过（不自动截断） |

**注意**：wire 日志只追加、不自动清理，因记录每条 delta 分片增长较快，长期运行需关注大小。

## 相关代码位置

| 改动点 | 文件 |
|--------|------|
| session_key 生成 | `nanobot/bus/events.py` |
| unifiedSession 路由 | `nanobot/agent/loop.py` → `_effective_session_key()` |
| source_channel 写入 Session | `nanobot/agent/loop.py` → `_source_extras()`, `_persist_user_message_early()`, `_save_turn()`, `_state_command()` |
| Session → wire events 转换器 | `nanobot/webui/transcript.py` → `session_messages_to_wire_events()` |
| Inbox thread 构建 | `nanobot/webui/transcript.py` → `build_inbox_thread_from_session()` |
| 工具调用 → UI 展示全链路 | [`tool-call-ui.md`](./tool-call-ui.md) |
| WebUI transcript 写入 | `nanobot/webui/transcript.py` → `append_transcript_object()` |
| 实时 fan-out 推送 | `nanobot/channels/websocket.py` → `_fan_out_to_unified_inbox()` |
| Sessions API 过滤 | `nanobot/channels/websocket.py` → `_handle_sessions_list` |
| WebSocket envelope 路由 | `nanobot/channels/websocket.py` → `_dispatch_envelope` |
| 稳定主会话 ID（attach 自动创建） | `nanobot/channels/websocket.py` → `_dispatch_envelope` attach 分支 |
| Session 持久化 | `nanobot/session/manager.py` |
