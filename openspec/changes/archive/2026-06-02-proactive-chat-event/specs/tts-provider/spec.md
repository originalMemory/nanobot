## ADDED Requirements

### Requirement: OpenAI 兼容文本转语音

系统 SHALL 提供一个文本转语音 provider，通过 OpenAI 兼容的 `POST {api_base}/audio/speech` 接口（请求体含 `model`、`input`、`voice`、`response_format`、`speed`）合成语音，并将返回的二进制音频写入文件。

#### Scenario: 合成成功

- **WHEN** 调用 TTS provider 并传入文本、音色与有效配置
- **THEN** 系统 SHALL POST 到解析出的 `audio/speech` 端点，并将响应的二进制音频写入目标文件，返回该文件路径

#### Scenario: base URL 自动补全端点

- **WHEN** 配置的 `api_base` 为聊天风格基址（未以 `audio/speech` 结尾）
- **THEN** 系统 SHALL 自动追加 `audio/speech` 路径后再发起请求

#### Scenario: 瞬时错误重试

- **WHEN** 请求返回 408/429/5xx 或发生连接/超时类异常且未超过重试上限
- **THEN** 系统 SHALL 按退避策略重试

#### Scenario: 缺少 API key

- **WHEN** 未配置 API key
- **THEN** 系统 SHALL 记录告警并返回空结果，不抛出未捕获异常

### Requirement: 多厂商配置 preset

系统 SHALL 允许通过 `api_base` / `model` / `voice` 配置切换 TTS 厂商，且 GLM-TTS、OpenAI、Groq 等仅体现为配置差异而非独立代码路径。

#### Scenario: GLM-TTS 配置

- **WHEN** 配置 `api_base=https://open.bigmodel.cn/api/paas/v4`、`model=glm-tts`、`voice=<音色ID>`
- **THEN** 系统 SHALL 使用该配置经统一 OpenAI 兼容路径合成语音

### Requirement: TTS 工具

系统 SHALL 向 agent 暴露一个 `tts` 工具，接收文本（及可选音色）并返回合成音频文件路径。

#### Scenario: agent 调用 tts 工具

- **WHEN** agent 调用 `tts` 工具并传入文本
- **THEN** 系统 SHALL 合成语音并返回音频文件路径供后续发送
