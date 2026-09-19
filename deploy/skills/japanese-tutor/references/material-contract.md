# 材料与制卡契约

AI 生成两个例句、2～4 轮短对话，以及可选分级阅读或听力文本。每份材料必须包含 curriculum node、主要新目标、生成器版本和语言事实来源。

生成后运行 `materials.py analyze`；词汇、汉字词和语法功能单位是分母，标点和纯数字排除。覆盖率低于 90% 时重写；专名或教学必需词必须作为 exemption 声明。

句子卡候选用 `materials.py preview`，每条文本同时提供对应的 `--reading`、`--meaning`，并至少提供一个 `--source-ref`。最多三张，输出与 adapter 一致的稳定 `CandidateId`。只预览不写 Anki；用户明确确认后才将单个候选 JSON 交给 `anki_adapter.py add-note --confirmed`。

带音频候选使用 `tts_media.py`。从 `~/.nanobot/config.json` 的活动 `tools.tts.preset` / `tools.tts.voice` 读取 MiniMax 服务及音色，不需要技能专用音色配置，也不在代码中固定音色 ID。

- `--language ja`（默认）：使用所选音色的 `languageVoices.ja`，未设置时沿用 `languageVoices.default`。
- `--language zh`：使用 `languageVoices.zh`，未设置时使用 `languageVoices.default`。
- 纯文本自动包裹相应语言标签；已经标注 `[zh]...[/zh]`、`[ja]...[/ja]` 的混合文本保持原有分段，各段使用对应音色。
- 输出为完整 MP3 文件。句子卡须传 `--confirmed`；独立听力题可用 `--purpose listening-question`，不写入 Anki。失败时可继续创建 Reading/Speaking 卡，但不能创建 Listening 卡。
