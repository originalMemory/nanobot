## ADDED Requirements

### Requirement: TTS preset 与音色选择器

Electron TTS 设置页 SHALL 展示活动 TTS preset 和该 preset 的音色选择器。两个选择器 MUST 显示 preset / 音色的中文 `label`，而不是 provider 名称或裸 voice ID。

#### Scenario: 切换到 IndexTTS

- **WHEN** 用户在 TTS 设置页选择 IndexTTS preset
- **THEN** 音色选择器 SHALL 仅显示该 preset 的 `voices` 数组，并默认选中当前有效音色

#### Scenario: 保存活动选择

- **WHEN** 用户保存 preset 或音色选择
- **THEN** 设置页 SHALL 调用 TTS 更新接口持久化 `tools.tts.preset` 和 `tools.tts.voice`，并显示需要重启提示
