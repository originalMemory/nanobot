## ADDED Requirements

### Requirement: Client-specified chat_id on attach
WebSocket 客户端 SHALL 能够在 `attach` envelope 中指定一个自定义 `chat_id`，Gateway MUST 使用该 ID 作为 session key 的一部分（`websocket:{chat_id}`），而非分配随机 UUID。

#### Scenario: Electron 客户端首次连接并指定 chat_id
- **WHEN** 客户端发送 `{"type": "attach", "chat_id": "electron-main"}`
- **THEN** Gateway 使用 `electron-main` 作为 chat_id，创建对应 session（如不存在），并返回 `{"event": "attached", "chat_id": "electron-main"}`

#### Scenario: Electron 客户端重连并恢复 session
- **WHEN** 客户端断开后重新连接，再次发送 `{"type": "attach", "chat_id": "electron-main"}`
- **THEN** Gateway 挂载已有的 `websocket:electron-main` session，推送历史 transcript 数据

#### Scenario: 未指定 chat_id 时保持现有行为
- **WHEN** 客户端连接但不发送 `attach` envelope
- **THEN** Gateway 按现有逻辑分配随机 UUID 作为 `default_chat_id`，行为不变

### Requirement: Connection query param for initial chat_id
WebSocket 连接 URL SHALL 支持 `?chat_id=<value>` 查询参数，作为 `default_chat_id` 的替代来源。

#### Scenario: 通过 URL 参数指定初始 chat_id
- **WHEN** 客户端连接到 `ws://host:port/?chat_id=electron-main&client_id=electron-1`
- **THEN** Gateway 使用 `electron-main` 作为 `default_chat_id`（替代随机 UUID），`ready` 事件返回该 ID

#### Scenario: URL 参数与 attach envelope 的优先级
- **WHEN** 客户端通过 URL 参数指定 `chat_id=A`，随后发送 `{"type": "attach", "chat_id": "B"}`
- **THEN** 客户端同时订阅 A 和 B 两个 chat_id（现有 attach 行为是追加订阅，不替换）

### Requirement: chat_id validation
Gateway MUST 验证客户端指定的 `chat_id` 格式，防止路径遍历和非法字符。

#### Scenario: 非法 chat_id 被拒绝
- **WHEN** 客户端发送 `{"type": "attach", "chat_id": "../../../etc/passwd"}`
- **THEN** Gateway 返回 `{"event": "error", "detail": "invalid chat_id"}` 并拒绝 attach

#### Scenario: 合法 chat_id 格式
- **WHEN** chat_id 包含字母、数字、连字符、下划线，长度 ≤ 128 字符
- **THEN** Gateway 接受该 chat_id
