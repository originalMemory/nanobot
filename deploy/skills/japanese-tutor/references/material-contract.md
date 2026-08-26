# 材料与制卡契约

AI 生成两个例句、2～4 轮短对话，以及可选分级阅读或听力文本。每份材料必须包含 curriculum node、主要新目标、生成器版本和语言事实来源。

生成后运行 `materials.py analyze`；词汇、汉字词和语法功能单位是分母，标点和纯数字排除。覆盖率低于 90% 时重写；专名或教学必需词必须作为 exemption 声明。

句子卡候选用 `materials.py preview`，每条文本同时提供对应的 `--reading`、`--meaning`，并至少提供一个 `--source-ref`。最多三张，输出与 adapter 一致的稳定 `CandidateId`。只预览不写 Anki；用户明确确认后才将单个候选 JSON 交给 `anki_adapter.py add-note --confirmed`。

带音频候选使用 `tts_media.py`。私密配置为：

```json
{"japaneseVoiceId":"REPLACE_WITH_JAPANESE_VOICE_ID"}
```

它从 `~/.nanobot/config.json` 读取现有 TTS 服务配置，只从技能私密配置读取独立日语音色，并非流式。`--purpose card` 必须传 `--confirmed`；`--purpose listening-question` 用于课堂自动安排的短听力题，生成后必须通过 `message(media=[path])` 与题干一并发送。卡片合成失败时可继续创建 Reading/Speaking 卡，但不能创建 Listening 卡。
