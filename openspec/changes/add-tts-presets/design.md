## Context

`tools.tts` 当前同时保存运行模式、provider 连接参数、模型和音色。MiniMax 需要按语言使用不同 voice ID，IndexTTS 的两个参考音色又共用同一服务参数。Electron 只能编辑模式和一个裸音色 ID。

## Goals / Non-Goals

**Goals:**

- 将 TTS 连接配置收敛到具名 preset。
- 用有序音色数组提供中文显示名和语言覆盖。
- 让工具、自动朗读和 Electron 设置读取同一活动 preset。

**Non-Goals:**

- 不管理本地 IndexTTS 服务进程。
- 不保留旧 `tools.tts` 直连字段或迁移逻辑。
- 不新增每句动态切换音色的 agent 参数。

## Decisions

### 顶层 preset，轻量活动状态

新增 `ttsPresets: {name: preset}`；每个 preset 的 `config` 继承 TTS provider 配置，`voices` 为有序数组。`tools.tts` 仅保留 `mode`、`preset`、`voice`。

这与 `modelPresets` 的顶层命名结构一致，避免活动状态重复保存密钥或端点。未采用在 `tools.tts` 内嵌 preset，因其不利于与 LLM model preset 并列管理。

### 音色使用语言映射

每个音色项保存稳定 `id`、中文 `label` 和 `languageVoices`。运行时优先取当前语言键，缺失时取 `default`。MiniMax 现有音色组使用 `default` 与 `ja`；IndexTTS 仅使用 `default`。

未采用 `defaultVoice` / `japaneseVoice` 固定字段，因为增加语言会扩大 schema 和 UI。

### 活动 preset 解析后才构造 provider

`TtsToolConfig` 提供活动 preset 解析方法，返回一份运行时 TTS 配置与当前音色映射。`SpeechRuntime` 接收该解析结果，按已分段语言选择 voice ID。工具调用和自动朗读都走同一路径。

### Electron 仅选择，不编辑连接参数

TTS 设置页增加 preset 与音色下拉框，显示中文 label。provider、模型、密钥等属于配置文件管理，不在本次 UI 编辑范围内；切换结果持久化并提示重启。

## Risks / Trade-offs

- [开发期旧配置不兼容] → 直接重写当前 config，并在 schema 中拒绝缺失的活动 preset / 音色。
- [选中的 Index preset 服务未运行] → 保留既有健康检查与 GLM fallback 机制，由 preset 配置决定。
- [语言检测不确定] → 显式 `[zh]` / `[ja]` 标签仍优先；未标记文本回退到现有分段结果。
- [设置页只改活动选择] → 新增 preset 仍需编辑 config；避免把密钥编辑和服务生命周期混入本次功能。

## Migration Plan

1. 将 `V:\nanobot\.nanobot\config.json` 改为 `ttsPresets` 加轻量 `tools.tts`。
2. 重启 Gateway 读取新 schema。
3. 回滚时恢复已存在的配置备份并重启 Gateway。
