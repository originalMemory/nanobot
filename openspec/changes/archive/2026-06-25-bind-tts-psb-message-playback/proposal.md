## Why

PSB 回复标签目前混在 assistant 消息正文里，并由 renderer 作为流式文本副作用解析执行；TTS 则是一个独立、非流式的 agent 工具，生成文本和最终展示消息只松散相关。这会污染聊天输出，使桌宠控制事件按回合结束而不是语音段结束复位，并且无法可靠对齐展示文本、朗读音频、口型和桌宠表情动作。

项目仍处于开发中，因此本变更允许破坏性调整：直接用“消息绑定的分段播放管线”替换旧的正文标签副作用和独立 `tts` 工具主路径，不为未发布行为保留兼容层。

## What Changes

- **BREAKING**: assistant 可见的 PSB/TTS 控制标签不再作为普通展示正文处理。聊天气泡默认展示干净文本，仅通过显式调试开关查看原始正文或控制元数据。
- Electron 聊天气泡的文字回复 SHALL 继续按 assistant delta 完整、顺畅地流式展示；segment/TTS 播放管线只旁路消费文本，不得用音频分段节奏打断或重排文字流。
- **BREAKING**: 独立 agent `tts` 工具不再作为主要用户语音路径；TTS 生成改为可配置的 assistant 消息自动播放管线。
- **BREAKING**: PSB 标签执行从“流式文本里一出现就触发、回合结束复位”改为“分段开始触发对应控制事件、分段/音频结束复位临时状态”。
- 引入服务端 assistant 播放分段：一条 assistant 消息在出站流中派生多个 playback segment，每段保存原始文本、通用控制元数据、TTS 状态和音频结果；展示文本、朗读文本和桌宠事件在使用时按需派生。
- 新增开关：开启后 TTS 直接绑定 assistant 消息，由服务端随流式文本产生分段并按段合成语音。
- 保持单一事实源：segment 原始文本、控制元数据和音频 chunk 都按同一个 assistant message segment index 对齐；展示和朗读文本不作为独立事实源持久化。
- 一期仅将 PSB 音频播放与 segment 生命周期绑定，使 PSB 口型、表情、timeline 和语音同步；THA 暂不新增 Electron 通知服务端表情或相关播放逻辑。
- 更新 prompt 契约：PSB 控制标签只能放在句首，不允许插入句中或句尾。

## Capabilities

### New Capabilities

- `assistant-message-playback`: 消息绑定分段、raw-first 文本派生、通用控制元数据、逐段 TTS 生成和顺序播放生命周期。

### Modified Capabilities

- `psb-desk-pet`: PSB 回复标签改为 segment 级通用控制元数据的一种消费者，在 segment 开始执行、segment 结束恢复。
- `tts-provider`: 主要 TTS 契约从“agent 工具返回文件路径”改为“供自动逐段消息播放调用的 provider”。
- `audio-message-playback`: 音频播放从整条消息媒体自动播放改为带明确 message/segment identity 的有序 assistant 分段播放。

## Impact

- Agent prompt 构建：PSB/TTS 标签说明、标签位置要求和输出格式约束。
- Agent tools：移除或弱化用户可见 `tts` 工具；复用 provider API 做逐段合成。
- WebSocket 协议：新增或更新 assistant playback 事件，携带 `messageId`、`segmentIndex`、raw/control metadata、可选派生朗读文本、音频状态、媒体 URL 或流句柄。
- Electron renderer：干净气泡渲染、原文/控制标签调试开关、播放队列状态和消息绑定 TTS 设置。
- Electron main / PSB manager：segment 生命周期 IPC，以及向 PSB 窗口有序投递动作和音频。
- PSB web runtime：segment 开始执行动作，segment 结束恢复 expression/face/fade，口型同步绑定 segment 音频。
- 测试：segmenter/parser 覆盖、播放生命周期测试、WebSocket 协议测试、PSB runtime 行为测试，以及干净展示/调试展开 UI 测试。
