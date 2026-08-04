# Spec: shared-streaming-tts

## Why
- TTS 当前分为自动回复分段播放和 `tts` 工具附件发送，桌宠、普通 Electron 播放与历史回放链路不统一。
- GLM-TTS 已支持 SSE PCM 输出；119 字实测首块约 `2.85s`、稳定播放约 `3.6s`，无需按句发起多次请求。
- 桌宠未开启时，AI 仍应能判断是否把本轮文字转为语音。

## Scope
- 本次做：抽出与桌宠无关的共享 TTS service，统一 AI 主动语音、自动朗读、Electron 播放和桌宠播放。
- 本次做：GLM-TTS use 单次 SSE 请求接收 base64 PCM；不切分输入文本，不保留增量文本分段器。
- 本次做：支持 `off`、`agent`、`always` 三种模式；`agent` 由 AI 调用语音工具，`always` 在完整回复结束后合成整段。
- 本次做：gateway use `start/chunk/end/error` 事件转发 PCM；Electron 预缓冲后连续播放。
- 本次做：流式完成后 gateway 聚合 PCM、写入完整 WAV；session 保存稳定本地路径，历史读取时转换为当前可访问 URL。
- 本次做：桌宠开启时接管同一 PCM 流并驱动口型；桌宠关闭时由 Electron 主消息窗口播放。
- 本次做：AI 主动语音绑定当前 `turnId`，最终归入本轮 assistant 消息；不通过 `message(media=...)` 生成独立消息。
- 本次不做：按标点、长度或 LLM delta 切分文本；边生成 LLM 正文边朗读。
- 本次不做：修改浏览器 WebUI；其他聊天渠道不消费 PCM 流，流式结束后仍可发送完整音频文件。
- 本次不做：音色管理、语速/音量 UI 重做、语音输入、TTS provider 自动降级。

## Plan
- [x] 配置新增 TTS mode，迁移现有 `enabled` / `messagePlaybackEnabled` 语义。
- [x] provider 新增 SSE PCM 读取能力，校验 sequence、base64、sample rate 和结束事件。
- [x] 新增共享 TTS runtime：单请求合成、PCM chunk 回调、取消、错误处理和并发串行化。
- [x] 合成期间将 PCM 同时转发并聚合；完成后写临时 WAV，再原子替换目标文件。
- [x] 将 AI 语音工具接入当前 `turnId`，生成一条 logical assistant audio，不再要求调用 `message` 工具发送附件。
- [x] WebSocket 新增 assistant audio 事件；session assistant 消息持久化完整音频元数据和本地路径。
- [x] 历史加载将本地路径签名/转换为 URL；旧 `playbackSegments` 数据保持只读回放兼容，不迁移 JSONL。
- [x] Electron 新增 PCM 播放队列和预缓冲；桌宠可用时 delegate，同一时刻只允许一个播放 owner。
- [x] 删除 `AssistantPlaybackSegmenter`、按 chat 分段合成队列及新数据的 `playbackSegments` 写入逻辑。
- [x] 补 provider、WAV 聚合、事件顺序、持久化、历史回放、桌宠 delegate 和普通播放测试。

## Apply Notes
- GLM 流式响应只有 SSE base64 PCM，没有音频 URL。
- live 事件不暴露服务端路径：`assistant_audio_end` 返回完成文件的可访问 URL；session 仅保存本地 `path`、`mimeType`、`sampleRate`、`durationMs`、provider/model/voice。
- URL 是运行期派生值：签名可能过期，gateway 地址也可能变化；禁止把 URL 作为历史唯一来源。
- PCM 规格由首个有效 chunk 的 `return_sample_rate` 确定；当前实测 `24000Hz`、signed 16-bit little-endian、mono。
- Electron 至少缓存两个 chunk 或约 `1s` PCM 后开始播放；119 字实测首块仅 `0.44s`，立即播放会 underrun。
- `always` 等完整 assistant 文本结束后发起一次 TTS；不追求与 LLM token 流同步。
- `agent` 每轮最多生成一条 logical audio；重复调用返回明确错误，避免同轮音频互相覆盖。
- TTS stream use `turnId + audioId` 关联；assistant 消息落盘晚于音频完成时，先暂存元数据并在 turn 完成后绑定。
- 完整 WAV use标准 RIFF header；写入失败仍发送 `error`，不持久化半成品。
- 桌宠表达/动作只在整段开始时应用；不提供句内表情时间轴。
- turn 取消时终止上游请求、停止转发、删除临时文件；Electron 断线不取消生成，允许重连后从历史回放完整文件。
- 仓库基线 `tsc --noEmit` 有 17 个既有错误，均不在本次改动文件；以 Electron 全量测试和 production package 作为前端构建 gate。

## Verify
- [x] GLM-TTS 119 字单请求在约 `3.6s` 内开始连续播放，无句间停顿。
- [x] 流事件严格为一次 `start`、多个有序 `chunk`、一次 `end`；失败路径以一次 `error` 终止。
- [x] 首块不足预缓冲时不提前播放；达到阈值后播放不中断。
- [x] 桌宠关闭时 Electron 播放；桌宠开启时仅桌宠播放且口型随音频变化，不出现双声。
- [x] `agent` 模式由 AI 决定是否生成语音；未调用工具时不请求 TTS。
- [x] `always` 模式每轮只提交一次完整文本；`off` 模式不注册/触发语音。
- [x] 当前对话的语音附着在对应 assistant 消息，不新增主动推送或独立附件消息。
- [x] 流结束后生成可播放 WAV；session JSONL 保存文件路径，不保存临时签名 URL。
- [x] 重启 gateway 后历史消息重新获得有效 URL并可重播。
- [x] 上游失败、用户取消后无残留 PCM 临时文件或卡死播放状态；Electron 断线后可从历史回放完整文件。
- [x] 旧 `playbackSegments` 历史音频仍可重播；新消息不再写该字段。
- [x] Python tests、Electron tests 和 production package 通过；本次改动文件无新增 TypeScript 错误。

## Status
- State: done
- Archived: yes
