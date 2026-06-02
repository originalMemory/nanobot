## ADDED Requirements

### Requirement: 音频媒体出站

服务端 SHALL 支持将音频文件作为出站消息媒体推送给订阅目标 `chat_id` 的连接，并将音频 MIME 纳入允许提供的媒体类型白名单。

#### Scenario: 推送音频媒体

- **WHEN** 出站消息携带音频文件（如 wav）
- **THEN** 系统 SHALL 为其生成签名媒体 URL 并随消息推送给订阅连接

#### Scenario: 音频 MIME 放行

- **WHEN** 客户端通过签名 URL 拉取音频文件
- **THEN** 系统 SHALL 以正确的音频 MIME（如 `audio/wav`）提供该文件

### Requirement: Electron 自动播放主动语音

Electron 客户端收到携带音频媒体的消息时 SHALL 自动播放该音频。

#### Scenario: 收到语音消息自动播放

- **WHEN** Electron 客户端收到带音频 `media_urls` 的消息
- **THEN** 客户端 SHALL 自动播放该音频

#### Scenario: 播放失败降级

- **WHEN** 音频自动播放被拒绝或失败
- **THEN** 客户端 SHALL 至少呈现对应文本消息，不导致界面错误
