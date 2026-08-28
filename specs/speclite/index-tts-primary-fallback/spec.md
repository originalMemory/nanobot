# Spec: index-tts-primary-fallback

## Why
- 局域网 IndexTTS 为默认 TTS，失败时保留现有 GLM 可用性。

## Scope
- TTS 配置支持内联 GLM fallback。
- Index 首包前失败时切换 GLM，并去除语言标签。
- 工具提示要求中日文本使用 `[zh]` / `[ja]`。
- 更新实际部署配置为 Index 主用、原 GLM 备用。

## Plan
- [x] 增加 fallback 配置与标签清理。
- [x] 在 SpeechRuntime 实现首包前 fallback。
- [x] 补充测试与部署配置。
- [x] fallback 前以短超时探测本地服务健康状态。

## Apply Notes
- 已输出主服务不 fallback，避免重复播放。
- GLM fallback 固定复用当前 config 的音色和密钥。
- `/health` 使用 0.5 秒超时，失败时跳过主请求重试。

## Verify
- [x] Index 失败前调用 GLM，且 GLM 收到无语言标签文本。
- [x] Index 已输出时不调用 GLM。
- [x] 原有 TTS 测试通过。

## Status
- State: done
- Archived: yes
