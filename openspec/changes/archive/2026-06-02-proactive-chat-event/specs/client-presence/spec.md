## ADDED Requirements

### Requirement: Electron 焦点上报

Electron 客户端 SHALL 在窗口获得或失去焦点时，通过 WebSocket 上报当前焦点状态（`{"type":"presence","focused":bool}`）。最小化或隐藏到托盘等导致失焦的情形 SHALL 上报为失焦。

#### Scenario: 失焦时上报

- **WHEN** Electron 主窗口失去焦点（含最小化、隐藏到托盘、切到其他应用）
- **THEN** 客户端 SHALL 发送 `presence` envelope 且 `focused=false`

#### Scenario: 获焦时上报

- **WHEN** Electron 主窗口重新获得焦点
- **THEN** 客户端 SHALL 发送 `presence` envelope 且 `focused=true`

### Requirement: 服务端焦点追踪

服务端 SHALL 维护每个 WebSocket 连接的焦点状态，新连接默认视为获焦（`focused=true`），收到 `presence` envelope 时更新。

#### Scenario: 接收 presence 更新

- **WHEN** 服务端收到合法的 `presence` envelope
- **THEN** 系统 SHALL 更新该连接的焦点状态

#### Scenario: 连接断开清理

- **WHEN** 连接关闭
- **THEN** 系统 SHALL 清除该连接的焦点状态记录

#### Scenario: 默认获焦

- **WHEN** 一个新连接建立但尚未上报 presence
- **THEN** 系统 SHALL 将其视为 `focused=true`
