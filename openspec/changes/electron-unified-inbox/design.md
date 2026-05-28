## Context

nanobot 采用 `MessageBus` 解耦通道与 Agent 核心。`unifiedSession: true` 已将所有通道的消息路由到同一个 `unified:default` session key 进行 LLM 上下文管理，但展示层（WebUI transcript）仍按 `websocket:{chat_id}` per-thread 隔离。

当前 WebSocket 通道的关键行为：
- `_connection_loop` 每次连接分配 `uuid.uuid4()` 作为 `default_chat_id`
- `_dispatch_envelope` 支持 `attach` 到指定 `chat_id`，但不验证 session 是否存在
- `send()` 只推送给当前 `chat_id` 的订阅者
- `_try_append_webui_transcript` 写入 `websocket:{chat_id}` 作为 session key

## Goals / Non-Goals

**Goals:**
- Electron 客户端每次重连能恢复同一 session 和 transcript（稳定 chat_id）
- 在一个界面聚合所有通道的入站/出站消息（统一 transcript + fan-out）
- 提供 HTTP 端点加载完整历史（inbox API）
- 交付可用的 Electron 桌面应用（统一 Inbox 视图）

**Non-Goals:**
- 不替换现有 WebUI——Electron 是新增入口，WebUI 继续独立运行
- 不改变 Agent session 逻辑（`unified:default` 已可用，不需变动）
- 不做多设备同步（Electron 连接本地 gateway）
- 不做消息编辑/撤回跨通道同步

## Decisions

### D1: 稳定主会话 ID — 客户端指定 chat_id

**选择**：允许 `attach` envelope 指定任意合法 `chat_id`，Electron 端持久化一个固定 ID（如 `"electron-main"`）每次 attach 同一个。

**替代方案**：
- (A) 服务端按 `client_id` 派生确定性 `chat_id` → 客户端无法控制，多 Electron 实例共享冲突
- (B) 引入 token 机制关联连接 → 过度设计

**影响范围**：`_dispatch_envelope` 的 `attach` 分支，确保对不存在的 `chat_id` 自动创建 session。当前 `_attach` 已是幂等的，主要需要在 `_connection_loop` 阶段支持客户端通过 query param 指定初始 `chat_id`（替代随机 UUID），或在首个 `attach` envelope 中指定。

### D2: 统一 Transcript — 双写策略

**选择**：`unifiedSession: true` 时，所有通道出站消息在写入原通道 transcript 的同时，也写入统一 transcript（key = `unified:default`），额外携带 `source_channel` 和 `source_chat_id` 字段。入站消息同理。

**写入点**：
- 出站：在 `WebSocketChannel.send()` 中增加统一 transcript 写入（该方法已有 `_try_append_webui_transcript` 调用）
- 跨通道入站：在 `AgentLoop._dispatch` 或 `AgentRunner` 的出站路径中，当 `unifiedSession: true` 时，用 bus outbound handler 统一拦截并写入

**替代方案**：
- (A) 在 MessageBus 层 hook → 侵入性强，bus 目前是纯路由
- (B) 只在 Electron 端聚合多个 transcript → 无法实时，且需要客户端知道所有通道

**理由**：后端双写保证单一数据源，Electron 只需读一个 transcript 文件。

### D3: WebSocket Fan-out — 订阅统一频道

**选择**：Electron 客户端 attach 到一个特殊频道（如 `inbox:unified`），`send()` 在 `unifiedSession: true` 时，除推送给原 `chat_id` 的订阅者外，也推送给 `inbox:unified` 的订阅者。推送事件额外携带 `source_channel` 字段。

**替代方案**：
- (A) Electron 订阅所有通道的 chat_id → 客户端需知道所有 chat_id，且新会话不会自动收到
- (B) 用独立的 pub/sub 系统 → 过度设计

### D4: Inbox HTTP 端点

**选择**：新增 `GET /api/inbox/thread` 端点，读取统一 transcript（`unified:default`）并调用 `replay_transcript_to_ui_messages` 返回 UI 消息列表。复用现有 `build_webui_thread_response` 逻辑。

### D5: Electron 应用架构

**选择**：放在 `electron/` 目录，使用 Electron Forge（vite-typescript 模板）+ React + TypeScript。通过 WebSocket 连接本地 nanobot gateway，复用 `webui/` 的组件和类型定义。

**目录结构**：三个 Forge 入口文件（`src/main.ts`、`src/preload.ts`、`src/renderer.ts`）保持在 `src/` 根以匹配 vite config 的 input 路径；功能模块在 `src/main/`（window、tray、store、ws-client）和 `src/renderer/`（components、hooks）内按功能拆分，不把入口文件挪进子目录。

**主进程职责**：窗口管理、系统托盘、截屏（`desktopCapturer`）、本地存储（persisted chat_id）
**渲染进程**：统一 Inbox 视图，基于 WebSocket 实时更新

**替代方案**：
- (A) 直接用 Tauri → Rust 绑定增加开发门槛，nanobot 团队以 TypeScript 为主
- (B) 把 WebUI 直接包在 Electron 里 → 无法做系统级集成（截屏等）

## Risks / Trade-offs

- **统一 Transcript 文件增长** → 复用现有 `_MAX_TRANSCRIPT_FILE_BYTES` 限制（8MB），后续可增加轮转/compaction
- **Fan-out 消息重复**：Electron 同时订阅 `inbox:unified` 和自身 `chat_id` 时可能收到重复消息 → fan-out 推送增加 `dedupe_id` 字段，客户端去重；或者 Electron 只订阅 `inbox:unified` 不订阅自身 `chat_id`
- **Electron 包体积** → 初期可接受，后续可考虑 delta 更新
- **现有 WebUI 兼容**：所有改动向后兼容，现有 WebUI 行为不变
