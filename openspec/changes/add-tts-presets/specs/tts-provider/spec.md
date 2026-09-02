## MODIFIED Requirements

### Requirement: 多厂商配置 preset

系统 SHALL 通过活动 TTS preset 的内部 `config` 选择 TTS 厂商，且 GLM-TTS、MiniMax、IndexTTS 等均体现为配置差异而非独立工具路径。

#### Scenario: MiniMax 配置

- **WHEN** 活动 preset 的 `config` 指定 MiniMax endpoint、`model=speech-2.8-hd`，且活动音色项提供 voice ID
- **THEN** 系统 SHALL 使用该 preset 经统一 TTS 路径合成语音

#### Scenario: IndexTTS 配置

- **WHEN** 活动 preset 的 `config` 指定局域网 IndexTTS endpoint、`model=index-tts-2.5`，且活动音色项提供 `candice-glm` 或 `candice-source`
- **THEN** 系统 SHALL 使用该 preset 经统一流式 TTS 路径合成语音

## ADDED Requirements

### Requirement: TTS 运行时解析活动 preset

系统 SHALL 在 TTS 工具调用和自动朗读前解析同一个活动 TTS preset 与音色项，并将按语言选择后的 voice ID 传给 provider。

#### Scenario: 工具与自动朗读一致

- **WHEN** 用户切换活动 TTS preset 或音色后调用 TTS 工具，或启用自动朗读
- **THEN** 两条路径 SHALL 使用相同 provider 配置和语言音色映射
