## Why

当前 TTS 连接参数与音色混在 `tools.tts`，切换 MiniMax 和 IndexTTS 需要手改整段配置。不同服务的音色还可能按语言使用不同 ID，设置页无法选择和显示中文名称。

## What Changes

- 新增顶层 `ttsPresets`，将 provider 连接参数下沉到 preset 内部配置。
- `tools.tts` 仅保存模式、活动 preset 和活动音色 ID；移除旧直连字段与 legacy 开关兼容。
- preset 使用有序音色数组；每项提供中文名称和按语言覆盖的 `languageVoices`。
- 内置当前 MiniMax HD preset 和 IndexTTS preset；Index 提供两个坎蒂丝参考音色。
- Electron 设置页支持切换 TTS preset 与音色，显示中文名称；变更提示重启。

## Capabilities

### New Capabilities

- `tts-presets`: 管理 TTS preset、音色与语言音色映射，并解析活动配置。

### Modified Capabilities

- `tts-provider`: TTS 工具与自动朗读从活动 preset 解析 provider 配置和语言音色。
- `electron-settings-ui`: TTS 设置页选择并展示 TTS preset 与音色。

## Impact

- 配置 schema、TTS runtime、设置 API、Electron 设置页及其测试。
- `V:\nanobot\.nanobot\config.json` 改为新结构；开发期不保留旧字段兼容。
