## ADDED Requirements

### Requirement: Unified transcript dual-write
当 `unifiedSession: true` 时，系统 SHALL 将所有通道的入站和出站消息同步 append 到统一 transcript 文件（session key = `unified:default`），格式与现有 WebUI transcript 一致，额外携带 `source_channel` 和 `source_chat_id` 字段。

#### Scenario: Telegram 消息写入统一 transcript
- **WHEN** `unifiedSession: true` 且 Telegram 通道收到用户消息并产生 Agent 回复
- **THEN** 用户消息和 Agent 回复均 append 到 `unified:default` transcript，每条记录包含 `"source_channel": "telegram"` 和 `"source_chat_id": "<telegram_chat_id>"`

#### Scenario: WebSocket 消息同时写入原通道和统一 transcript
- **WHEN** `unifiedSession: true` 且 WebSocket 通道产生消息
- **THEN** 消息同时写入 `websocket:{chat_id}` transcript（现有行为）和 `unified:default` transcript

#### Scenario: unifiedSession 关闭时不写入统一 transcript
- **WHEN** `unifiedSession: false`（默认）
- **THEN** 消息仅写入原通道 transcript，不写入统一 transcript

### Requirement: WebSocket fan-out to inbox subscribers
当 `unifiedSession: true` 时，所有通道的出站消息 SHALL 同时推送给订阅了统一收件箱频道（`inbox:unified`）的 WebSocket 客户端。

#### Scenario: Telegram 回复实时推送到 Electron
- **WHEN** `unifiedSession: true` 且 Electron 客户端已订阅 `inbox:unified`，Agent 通过 Telegram 通道回复用户
- **THEN** Electron 客户端实时收到该回复事件，事件携带 `source_channel: "telegram"` 字段

#### Scenario: 非 WebSocket 通道入站消息的 fan-out
- **WHEN** `unifiedSession: true` 且 Telegram 收到用户消息
- **THEN** 该入站消息也以事件形式推送给 `inbox:unified` 的订阅者，携带 `source_channel: "telegram"` 和 `event: "user"`

#### Scenario: 无统一订阅者时不影响正常流程
- **WHEN** `unifiedSession: true` 但没有客户端订阅 `inbox:unified`
- **THEN** 消息正常发送到原通道，不产生错误

### Requirement: Inbox HTTP thread endpoint
系统 SHALL 提供 `GET /api/inbox/thread` HTTP 端点，返回统一 transcript 的重放结果。

#### Scenario: 加载完整统一历史
- **WHEN** Electron 客户端请求 `GET /api/inbox/thread`
- **THEN** 返回 `unified:default` transcript 重放后的 UI 消息列表，每条消息包含 `source_channel` 字段

#### Scenario: 统一 transcript 为空
- **WHEN** 统一 transcript 不存在或为空
- **THEN** 返回空消息列表 `{"messages": []}`

#### Scenario: 需要认证
- **WHEN** 请求不携带有效的 API token
- **THEN** 返回 401 Unauthorized
