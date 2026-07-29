## MODIFIED Requirements

### Requirement: Assistant 消息展示 bot 身份标识

在 WebUI 和 Electron 的聊天 thread 中，每轮 assistant 输出 SHALL 仅在首个 agent 展示单元前显示一次身份头；身份头包含头像、botName 和该轮来源。没有前置 user 消息的主动投递 SHALL 各自形成独立轮次。

#### Scenario: 有 avatar 图片的 assistant 轮次
- **WHEN** `botAvatarUrl = "/api/avatar"` 且图片加载成功
- **THEN** 该轮首个 agent 展示单元前 SHALL 展示圆形头像图片和 `botName`

#### Scenario: avatar 图片加载失败时降级为 emoji
- **WHEN** `botAvatarUrl = "/api/avatar"` 但图片加载失败（404 或网络错误）
- **THEN** 头像位置 SHALL 降级为 `botIcon` emoji 显示在圆形 muted 背景中

#### Scenario: 无 avatar URL 时使用 emoji 头像
- **WHEN** `botAvatarUrl = null` 且 `botIcon = "🐈"`
- **THEN** 头像位置 SHALL 展示 "🐈" 在圆形 muted 背景中

#### Scenario: icon 和 avatar 均无时使用首字母
- **WHEN** `botAvatarUrl = null` 且 `botIcon = ""` 且 `botName = "nanobot"`
- **THEN** 头像位置 SHALL 展示 "N"（首字母大写）在圆形 muted 背景中

#### Scenario: 同轮多条 assistant 消息只展示一次
- **WHEN** 一轮回复包含 activity、reasoning 或多条 assistant 消息
- **THEN** 身份头 SHALL 仅出现在该轮首个 agent 展示单元前

#### Scenario: 连续主动投递各自展示身份和来源
- **WHEN** 多条 assistant 消息均携带 `channelDelivery=true` 且中间没有 user 消息
- **THEN** 每条主动投递 SHALL 各自展示一次头像、昵称和 cron/heartbeat 来源

#### Scenario: 空内容的流式消息不显示身份标识
- **WHEN** assistant 消息处于流式状态且内容为空（显示 TypingDots）
- **THEN** 头像和昵称 SHALL NOT 单独形成空身份头

#### Scenario: user 消息不受影响
- **WHEN** 用户发送一条消息
- **THEN** 用户消息 SHALL NOT 展示任何 bot 身份标识

#### Scenario: trace 消息不单独展示身份标识
- **WHEN** 消息 `kind` 为 `"trace"`（工具调用 / 进度提示）
- **THEN** trace SHALL NOT 在同轮内重复展示身份头
