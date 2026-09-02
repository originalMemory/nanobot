## ADDED Requirements

### Requirement: 顶层 TTS preset 配置
系统 SHALL 在顶层 `ttsPresets` 保存具名 TTS preset。每个 preset MUST 包含中文 `label`、内部 `config` 和有序 `voices` 数组；内部 `config` MUST 包含 provider 调用所需的连接参数和固定模型。

#### Scenario: 读取活动 MiniMax preset
- **WHEN** `tools.tts.preset` 为 `minimax`
- **THEN** 系统 SHALL 从 `ttsPresets.minimax.config` 解析 MiniMax provider 配置，而不是从 `tools.tts` 读取连接参数

### Requirement: 活动 TTS preset 与音色
`tools.tts` SHALL 仅保存 `mode`、`preset` 和 `voice`。`voice` MUST 引用活动 preset 的 `voices[].id`；不存在的 preset 或音色 MUST 使配置校验失败。

#### Scenario: 选择 IndexTTS 原声音色
- **WHEN** `tools.tts.preset` 为 `index` 且 `tools.tts.voice` 为 `candice-source`
- **THEN** 系统 SHALL 使用 Index preset 的 provider 配置和该音色项

### Requirement: 语言音色映射
每个音色项 SHALL 包含中文 `label` 和 `languageVoices` 字典。系统 MUST 优先使用当前语言键对应的 voice ID，缺失时 MUST 使用 `default`；`default` 缺失 MUST 使配置校验失败。

#### Scenario: MiniMax 日语合成
- **WHEN** 活动 MiniMax 音色项同时配置 `default` 和 `ja`
- **THEN** 系统 SHALL 对中文使用 `default`，对日语使用 `ja`

#### Scenario: IndexTTS 共用音色
- **WHEN** 活动 IndexTTS 音色项仅配置 `default`
- **THEN** 系统 SHALL 对中文和日语均使用该 `default` voice ID

### Requirement: 不支持旧 TTS 直连配置
系统 MUST 不再读取 `tools.tts` 中的 provider、apiBase、apiKey、model、defaultVoice、japaneseVoice、extraBody、fallback 或健康检查字段。

#### Scenario: 旧字段存在
- **WHEN** 配置在 `tools.tts` 中包含旧直连字段
- **THEN** 配置校验 SHALL 拒绝该配置并要求改用 `ttsPresets`
