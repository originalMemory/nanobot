## ADDED Requirements

### Requirement: Electron main process
Electron 应用 SHALL 提供主进程，负责窗口管理、系统托盘、本地存储和系统级 API 调用。

#### Scenario: 应用启动
- **WHEN** 用户启动 Electron 应用
- **THEN** 应用创建主窗口，自动通过 WebSocket 连接到本地 nanobot gateway（默认 `ws://localhost:8765`），使用持久化的 `chat_id` attach

#### Scenario: 连接断开自动重连
- **WHEN** WebSocket 连接断开
- **THEN** 应用自动尝试重连（指数退避），重连后使用相同的 `chat_id` 恢复 session

#### Scenario: 系统托盘
- **WHEN** 用户关闭主窗口
- **THEN** 应用最小化到系统托盘而非退出，托盘图标提供打开/退出菜单

### Requirement: Unified inbox view
Electron 渲染进程 SHALL 提供统一收件箱视图，在一条时间线中展示所有通道的对话。

#### Scenario: 启动时加载历史
- **WHEN** Electron 应用连接成功
- **THEN** 通过 `GET /api/inbox/thread` 加载完整统一历史，按时间顺序展示

#### Scenario: 实时消息更新
- **WHEN** Electron 已订阅 `inbox:unified`，有新消息从任意通道产生
- **THEN** 消息实时追加到聊天视图底部

#### Scenario: 通道来源标签
- **WHEN** 消息携带 `source_channel` 字段
- **THEN** UI 在消息气泡旁显示来源通道标签（如 `[Telegram]`、`[Discord]`）

#### Scenario: 从 Electron 发送消息
- **WHEN** 用户在输入框输入文本并发送
- **THEN** 消息通过 WebSocket 发送到 gateway，Agent 处理后回复推回 Electron

### Requirement: Sidebar navigation
Electron 应用 SHALL 提供侧边栏导航，支持在统一收件箱和单通道视图间切换。

#### Scenario: 侧边栏展示
- **WHEN** 应用加载完成
- **THEN** 侧边栏显示「统一收件箱」入口，以及从统一 transcript 的 `source_channel` 字段聚合出的各通道入口

#### Scenario: 切换到单通道视图
- **WHEN** 用户点击侧边栏的特定通道（如 Telegram）
- **THEN** 主聊天区仅显示该通道的消息（按 `source_channel` 过滤）

### Requirement: Desktop screenshot capture
Electron 应用 SHALL 支持通过 `desktopCapturer` API 截取屏幕截图并作为附件发送。

#### Scenario: 截屏并发送
- **WHEN** 用户点击截屏按钮或使用快捷键
- **THEN** 应用调用 `desktopCapturer` 截取屏幕，预览后用户确认发送，截图作为 `media` 附件随消息发送到 gateway

### Requirement: Persistent configuration
Electron 应用 SHALL 在本地持久化连接配置（gateway 地址、chat_id、窗口状态等）。

#### Scenario: 首次启动配置
- **WHEN** 用户首次启动应用且无本地配置
- **THEN** 使用默认配置（`ws://localhost:8765`，chat_id = `electron-main`），并将配置写入本地存储

#### Scenario: 自定义 gateway 地址
- **WHEN** 用户在设置中修改 gateway 地址
- **THEN** 应用断开当前连接并使用新地址重连，配置持久化
