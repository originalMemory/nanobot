# AGENTS.md 语音规则改写（替换原「## 语音（TTS）」小节）

```markdown
## 语音（TTS）

- 语音由系统在 AI 回复结束后自动生成并统一播报：模型不需要调用语音工具，也不需要编写语音文本。
- 短回复直接朗读清洗后的原文；超过阈值（默认 300 字，配置项 `tools.tts.thresholdChars`）或含日文的回复，由系统后台生成摘要/打标后再播报，不阻塞回复发送。
- 朗读内容自动去除 Markdown 符号、动作描写（如摇尾巴/叹气）、路径与代码；日文片段自动按日语音色播报（需在 `tools.tts.japaneseVoice` 配置日语音色）。
- 系统轮、空回复或回复异常时不播报；语音生成失败不影响文字回复。
```

## 同步位置

- NAS：`/home/nanobot/.nanobot/workspace/AGENTS.md` 的「## 语音（TTS）」小节整体替换为上面内容。
- 若本地有同文件副本（如 `~/.nanobot/workspace/AGENTS.md`）一并替换。
