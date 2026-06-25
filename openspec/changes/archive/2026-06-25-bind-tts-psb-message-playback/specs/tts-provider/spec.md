## ADDED Requirements

### Requirement: Segment TTS 合成接口
系统 SHALL 在服务端提供可由 assistant message playback 调用的 TTS 合成接口。该接口 SHALL 接收 segment 的 `messageId`、`segmentIndex`、原始文本、通用控制元数据和 TTS 配置，从中派生朗读文本与可选音色，并返回与该 segment 绑定的音频结果。

#### Scenario: 合成 segment 音频
- **WHEN** 消息绑定 TTS worker 请求合成某个 assistant segment
- **THEN** TTS worker SHALL 从该 segment 的原始文本和控制元数据派生朗读文本
- **AND** TTS provider SHALL 使用派生朗读文本生成音频
- **AND** 返回结果 SHALL 关联原始 `messageId` 和 `segmentIndex`

#### Scenario: 空朗读文本
- **WHEN** 从 segment 派生出的朗读文本为空或仅包含空白
- **THEN** 系统 SHALL 不调用外部 TTS provider
- **AND** segment audio 状态 SHALL 标记为无需音频或完成

#### Scenario: 控制标签不进入 TTS input
- **WHEN** segment 原始文本包含 PSB 或其他控制标签
- **THEN** TTS provider 接收的 input SHALL 只包含剥离控制标签后的朗读文本
- **AND** 控制标签 SHALL 通过 segment controls 传递给对应消费者

### Requirement: Segment TTS 并发与取消
系统 SHALL 支持按 segment 并发请求 TTS，并能在消息停止、会话切换或播放取消时取消未完成请求或忽略过期结果。

#### Scenario: 并发合成多个 segment
- **WHEN** assistant 消息连续产生多个可朗读 segment
- **THEN** TTS worker MAY 并发调用 provider 合成多个 segment
- **AND** 每个结果 SHALL 写回对应 segment，不得通过文本内容匹配 segment

#### Scenario: 取消未完成合成
- **WHEN** 用户停止回复或切换会话
- **THEN** 系统 SHALL 取消未完成的 TTS 请求或标记其结果为过期
- **AND** 过期结果 SHALL 不进入播放队列

## MODIFIED Requirements

### Requirement: OpenAI 兼容文本转语音
系统 SHALL 提供一个文本转语音 provider，通过 OpenAI 兼容的 `POST {api_base}/audio/speech` 接口（请求体含 `model`、`input`、`voice`、`response_format`、`speed`）合成语音，并将返回的二进制音频写入文件或可播放媒体对象。该 provider SHALL 可被 segment TTS 合成接口调用，并 SHALL 保留 segment identity 直到结果写回播放管线。

#### Scenario: 合成成功
- **WHEN** 调用 TTS provider 并传入 segment 朗读文本、音色与有效配置
- **THEN** 系统 SHALL POST 到解析出的 `audio/speech` 端点，并将响应的二进制音频写入目标文件或媒体对象
- **AND** 系统 SHALL 返回可播放音频结果及其 `messageId`、`segmentIndex`

#### Scenario: base URL 自动补全端点
- **WHEN** 配置的 `api_base` 为聊天风格基址（未以 `audio/speech` 结尾）
- **THEN** 系统 SHALL 自动追加 `audio/speech` 路径后再发起请求

#### Scenario: 瞬时错误重试
- **WHEN** 请求返回 408/429/5xx 或发生连接/超时类异常且未超过重试上限
- **THEN** 系统 SHALL 按退避策略重试

#### Scenario: 缺少 API key
- **WHEN** 未配置 API key
- **THEN** 系统 SHALL 记录告警并将对应 segment audio 状态标记为 failed 或 skipped
- **AND** 系统 SHALL 不抛出未捕获异常

## REMOVED Requirements

### Requirement: TTS 工具
**Reason**: 用户语音体验改为 assistant message-bound segment playback。独立 agent `tts` 工具会让朗读文本、展示正文和桌宠控制事件再次分裂成多条管线。

**Migration**: 将 TTS provider 作为 segment TTS worker 的底层合成能力调用。若仍需开发/调试用文本转语音，可以另建内部调试入口，但不得作为默认 assistant 语音播放路径。
