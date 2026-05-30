### Requirement: Avatar 文件服务路由

后端 WebSocket channel SHALL 在 `/api/avatar` 路径提供一个公开（无需 token）的 HTTP GET 路由。该路由从 `get_media_dir()` 根目录按优先级查找 `avatar.jpg`、`avatar.png`、`avatar.webp`，返回第一个存在的文件内容及对应 MIME type。未找到时返回 404。

#### Scenario: avatar 文件存在

- **WHEN** `~/.nanobot/media/avatar.jpg` 存在
- **THEN** `GET /api/avatar` SHALL 返回 200，Content-Type 为 `image/jpeg`，body 为文件字节内容

#### Scenario: 多种格式按优先级

- **WHEN** `~/.nanobot/media/avatar.png` 和 `avatar.webp` 都存在，但 `avatar.jpg` 不存在
- **THEN** `GET /api/avatar` SHALL 返回 `avatar.png`（`.jpg` > `.png` > `.webp` 优先级）

#### Scenario: 无 avatar 文件

- **WHEN** `~/.nanobot/media/` 目录下无任何 `avatar.{jpg,png,webp}` 文件
- **THEN** `GET /api/avatar` SHALL 返回 404

### Requirement: Settings API 返回 avatar URL

`/api/settings` 返回的 `agent` 对象 SHALL 包含 `bot_avatar_url` 字段。当 `get_media_dir()` 根目录存在 `avatar.{jpg,png,webp}` 时，值为 `"/api/avatar"`；否则为 `null`。

#### Scenario: 有 avatar 文件时返回 URL

- **WHEN** `~/.nanobot/media/avatar.png` 存在
- **THEN** `GET /api/settings` 返回的 JSON 中 `agent.bot_avatar_url` SHALL 为 `"/api/avatar"`

#### Scenario: 无 avatar 文件时返回 null

- **WHEN** 无 avatar 文件
- **THEN** `agent.bot_avatar_url` SHALL 为 `null`

### Requirement: Bot identity context provider

系统 SHALL 提供 `BotIdentityContext`（React Context），包含 `botName: string`、`botIcon: string`、`botAvatarUrl: string | null`。WebUI 的 `ThreadShell` 和 Electron 的 `App.tsx` SHALL 从 settings state 读取对应字段并注入 Context Provider。

#### Scenario: Context 提供正确的 bot 身份

- **WHEN** 后端 settings 返回 `agent.bot_name = "nano"`、`agent.bot_icon = "🐈"`、`agent.bot_avatar_url = "/api/avatar"`
- **THEN** BotIdentityContext 的值 SHALL 为 `{ botName: "nano", botIcon: "🐈", botAvatarUrl: "/api/avatar" }`

#### Scenario: Settings 更新后 Context 值同步

- **WHEN** 用户在 settings 页面修改 `botName` 为 "mybot" 并保存
- **THEN** 返回聊天页后，BotIdentityContext 的 `botName` SHALL 更新为 "mybot"

### Requirement: Assistant 消息展示 bot 身份标识

在 WebUI 和 Electron 的聊天 thread 中，assistant 角色的有内容文本回复 SHALL 以两列布局渲染：左列为 24×24 圆形头像（靠底部对齐），右列为消息正文；footer 行（`botName` + copy + latency）位于右列底部与头像左列对齐。

#### Scenario: 有 avatar 图片的 assistant 消息

- **WHEN** `botAvatarUrl = "/api/avatar"` 且图片加载成功
- **THEN** 消息左列 SHALL 展示圆形头像图片，footer 行左侧 SHALL 展示 `botName` 文字

#### Scenario: avatar 图片加载失败时降级为 emoji

- **WHEN** `botAvatarUrl = "/api/avatar"` 但图片加载失败（404 或网络错误）
- **THEN** 左列头像位置 SHALL 降级为 `botIcon` emoji 显示在 24×24 圆形 muted 背景中

#### Scenario: 无 avatar URL 时使用 emoji 头像

- **WHEN** `botAvatarUrl = null` 且 `botIcon = "🐈"`
- **THEN** 左列头像位置 SHALL 展示 "🐈" 在 24×24 圆形 muted 背景中

#### Scenario: icon 和 avatar 均无时使用首字母

- **WHEN** `botAvatarUrl = null` 且 `botIcon = ""` 且 `botName = "nanobot"`
- **THEN** 左列头像位置 SHALL 展示 "N"（首字母大写）在 24×24 圆形 muted 背景中

#### Scenario: 空内容的流式消息不显示身份标识

- **WHEN** assistant 消息处于流式状态且内容为空（显示 TypingDots）
- **THEN** 左列头像和 footer 行 SHALL NOT 显示，消息不使用两列布局

#### Scenario: user 消息不受影响

- **WHEN** 用户发送一条消息
- **THEN** 用户消息 SHALL NOT 展示任何 bot 身份标识

#### Scenario: trace 消息不展示身份标识

- **WHEN** 消息 `kind` 为 `"trace"`（工具调用 / 进度提示）
- **THEN** 该消息 SHALL NOT 展示 bot 身份标识
