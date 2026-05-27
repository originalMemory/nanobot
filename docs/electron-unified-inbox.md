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

## 相关代码位置

| 改动点 | 文件 |
|--------|------|
| session_key 生成 | `nanobot/bus/events.py` |
| unifiedSession 路由 | `nanobot/agent/loop.py` → `_effective_session_key()` |
| WebUI transcript 写入 | `nanobot/webui/transcript.py` |
| Sessions API 过滤 | `nanobot/channels/websocket.py` → `_handle_sessions_list` |
| WebSocket envelope 路由 | `nanobot/channels/websocket.py` → `_dispatch_envelope` |
| 稳定主会话 ID（attach 自动创建） | `nanobot/channels/websocket.py` → `_dispatch_envelope` attach 分支 |
| Session 持久化 | `nanobot/session/manager.py` |
