# Spec: qwen-http-sse-tts

## Why
- Qwen VC 当前等待完整 URL，首段音频约 `2.82s` 已可播放却未利用。
- TTS 调用方需要保持一次触发、一个连续 PCM 流、一个历史 WAV。

## Scope
- 本次做：新增 Qwen HTTP SSE provider，支持 `qwen3-tts-vc-2026-01-22`。
- 本次做：请求 use `X-DashScope-SSE: enable`，中间 `audio.data` 增量输出，终止 chunk 只校验完成状态。
- 本次做：解析 Qwen 首 chunk 的 WAV 容器头，对外仅输出 24kHz mono PCM。
- 本次做：复用 `[zh]` / `[ja]` 分段规则；多语言片段并发生成、按原顺序汇成一个全局 chunk 序列。
- 本次做：中文 use `defaultVoice`，日语 use `japaneseVoice`，分别传 `language_type: Chinese/Japanese`。
- 本次做：factory 支持 `provider: qwen`；现有 MiniMax、OpenAI-compatible 行为不变。
- 本次不做：Qwen WebSocket Realtime、重新复刻音色、切换当前本机/NAS provider、Electron 改动、真实付费验收。

## Plan
- [x] 实现 Qwen SSE 响应解析与 WAV→PCM 增量转换。
- [x] 实现中日并发请求及有序单流汇聚。
- [x] 接入 provider factory 和现有跨 turn RPM 限流。
- [x] 补 SSE 非 data 行、WAV header、语言/音色、顺序、终止状态和 factory 测试。

## Apply Notes
- 首 chunk 必须校验 RIFF/WAVE、PCM 16-bit、mono；禁止把 WAV header 当 PCM 播放。
- 流式 chunk 直接聚合到现有 `SpeechRuntime`，不下载终止 URL，不产生第二份音频。
- Qwen 音色绑定非实时 VC 模型；本次不创建 Realtime 音色。
- 不重构 MiniMax provider；相同的有序队列逻辑允许少量重复，控制改动范围。

## Verify
- [x] 调用方收到一次 `start`、连续 sequence、一次 `end`。
- [x] PCM 不含 `RIFF` header，字节数与 WAV data payload 一致。
- [x] 中日片段并发请求但按原文顺序输出，语言与音色正确。
- [x] SSE `event:` 行被忽略，终止 chunk 不重复音频。
- [x] 最终历史仅保存一个可播放 WAV。
- [x] TTS provider、SpeechRuntime、历史回放相关 tests 与 ruff 通过。

## Status
- State: done
- Archived: yes
