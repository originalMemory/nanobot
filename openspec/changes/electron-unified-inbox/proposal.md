## Why

nanobot 的 `unifiedSession: true` 已合并了 Agent 上下文（`unified:default`），但展示层仍然 per-thread 隔离——每个 WebSocket 连接拿到随机 UUID 作为 `chat_id`，导致 session/transcript 无法跨连接复用。用户在 Telegram/Discord/CLI 等多通道产生的对话历史无法在一个界面统一查看和继续。

需要一个跨端桌面入口（Electron），配合后端统一 Inbox 能力，实现「一个窗口看到所有通道对话，无缝继续对话」的体验。

## What Changes

- **稳定主会话 ID**：允许 WebSocket 客户端在 `attach` 时指定预定义 `chat_id`（如 `electron-main`），不再每次连接分配随机 UUID，使 session 和 transcript 跨重连持久化
- **统一 Transcript 写入**：`unifiedSession: true` 时，所有通道的入站/出站消息同步 append 到统一 transcript 文件，额外携带 `source_channel` 字段
- **WebSocket Fan-out**：`unifiedSession: true` 时，除回复原通道外，同时推送事件给订阅了统一会话的 Electron 客户端，实现实时收件箱
- **Inbox HTTP 端点**：新增 `GET /api/inbox/thread`，返回统一 transcript 的重放结果，供 Electron 启动时加载完整历史
- **Electron 桌面应用**：基于 Electron 的跨端桌面客户端，通过 WebSocket 连接本地 nanobot gateway，提供统一 Inbox 视图

## Capabilities

### New Capabilities
- `stable-session-attach`: 允许 WebSocket 客户端在 attach 时指定持久化 chat_id，实现跨重连的 session 和 transcript 复用
- `unified-inbox-backend`: 统一 Inbox 后端能力——统一 transcript 写入、WebSocket fan-out、inbox HTTP 端点
- `electron-app`: Electron 跨端桌面应用——连接 nanobot gateway，提供统一 Inbox 视图、通道标签、系统级功能
### Modified Capabilities

（无现有 spec 需要修改）

## Impact

- **后端代码**：`nanobot/channels/websocket.py`（attach 逻辑、fan-out）、`nanobot/agent/loop.py`（统一 transcript 写入）、`nanobot/webui/transcript.py`（transcript 格式扩展）
- **新目录**：`electron/`（Electron 应用代码，主进程 + 渲染进程）
- **新依赖**：Electron、相关前端构建工具链
- **API 变更**：新增 `/api/inbox/thread` 端点
- **WebSocket 协议**：transcript 事件增加 `source_channel` 字段、fan-out 推送机制
