## Context

当前 PSB/TTS/聊天展示存在三套松散时序：

- assistant `content` 原样保存 PSB 标签；UI 展示时按设置隐藏或展示。
- Electron renderer 在流式文本中解析 PSB 标签并立即同步给 PSB 窗口；回合结束时发送 `stream-end` 复位。
- TTS 是独立 agent 工具：模型需要主动调用 `tts(text)`，工具生成音频文件，再由后续消息媒体携带并播放。

这种结构的问题是：控制标签污染正文，TTS 文本和展示消息可能不一致，桌宠动作按文本流/turn 生命周期触发而不是按语音播放生命周期触发。参考 SAP 的做法，更稳定的模型是让一条 assistant message 派生多个有序播放 segment，并让展示、朗读、音频和桌宠控制事件共享同一个 segment index。

本项目尚未发布稳定版本，因此允许删除旧协议和旧工具主路径，不需要为当前分支上的未发布行为保留兼容层。

## Goals / Non-Goals

**Goals:**

- 让 assistant message 成为 TTS、桌宠控制事件、口型同步和 UI 展示的共同宿主。
- 在服务端从流式 assistant 文本中增量生成 playback segment，每段有明确 `messageId` 和 `segmentIndex`。
- 默认展示干净正文，控制标签仅作为 metadata 或调试信息可见。
- PSB 标签在模型输出层面只要求放在句首；服务端 segmenter 将句首标签绑定到对应播放段，播放段开始时执行动作，音频结束时恢复临时状态。
- TTS 开关开启时自动逐段合成并顺序播放；第一版允许每段音频非流式生成。
- 允许破坏性移除或弱化旧的 agent `tts` 工具与整条消息音频自动播放路径。

**Non-Goals:**

- 不在第一版实现完整 SAP 式 MediaSource 边合成边播；可以先按段生成完整音频文件/URL。
- 不设计跨客户端共享播放状态；播放状态以当前 Electron 客户端为准。
- 不保证旧会话里的 PSB 标签按新 segment metadata 回放；旧内容可作为普通 raw content 展示或通过迁移脚本一次性清洗。
- 不要求所有 channel 都立即消费 segment playback 事件；一期由服务端生成事件，优先 Electron Inbox + PSB 桌宠消费。THA 不在一期新增 Electron 通知服务端表情、动作或口型相关逻辑。

## Decisions

### 1. 以 assistant playback segment 作为最小 raw 单元

每条 assistant 消息维护一个有序 segment 列表：

```ts
type AssistantPlaybackSegment = {
  messageId: string;
  segmentIndex: number;
  rawText: string;
  controls?: unknown[];
  audio?: {
    status: "idle" | "pending" | "ready" | "playing" | "done" | "failed";
    url?: string;
    mimeType?: string;
    error?: string;
  };
};
```

Segment 只持有 `rawText` 和可选的通用 `controls`。展示文本、朗读文本、PSB 控制事件等都在消费侧从 `rawText` 和 `controls` 派生：

- UI 展示侧调用 `toDisplayText(segment)`。
- TTS 侧调用 `toSpeechText(segment)`。
- PSB 侧调用 `toPsbEvents(segment)`。

第一版里，`toDisplayText` 和 `toSpeechText` 很可能都是“去掉控制标签后的文本”，但设计上不把二者写成两个持久字段。这样可以保留后续差异：例如展示保留 Markdown 链接文本，朗读去掉 URL；展示保留 emoji，朗读替换为描述；展示保留代码块，朗读跳过代码块。

备选方案是把 `displayText`、`speakText`、`psbActions` 都预先写入 segment。这个方案实现直观，但会引入三份可漂移的数据，且把 PSB 写死进通用播放模型。因此本设计只保存 raw segment 和通用 control metadata，具体 view 按需计算或缓存。

### 2. Segmenter 在服务端流式出站侧增量运行

第一版将 segmenter 放在 gateway / WebSocket 出站侧，而不是 Electron renderer：

- 它可以直接使用服务端已知的 assistant `delta`、`stream_end`、`turn_end` 边界。
- 它让 segment identity、TTS 请求、音频文件和推送事件都在同一端生成，避免客户端先分段再回传服务端合成的绕行。
- 它仍不改变普通文字 delta 的展示路径；Electron/WebUI 继续按 delta 连续渲染正文。

服务端只在需要 playback 时生成并推送 segment 事件：消息绑定 TTS 开启，或后续某个消费者明确需要 segment lifecycle。若没有音频播放需求，正常聊天展示只依赖现有 delta 流，不额外生成或推送 playback segment。

### 3. 标签固定放在 segment 开头

Prompt 契约要求模型输出：

```text
<psb:expression name="笑" /><psb:timeline name="うんうん" />嗯嗯，我明白。
<psb:expression name="通常" />接下来可以这样做。
```

Segmenter 只把句首连续 PSB/TTS 控制标签归属到该 segment 的 `controls`。句中标签应被视为无效控制标签：默认从展示/朗读派生文本中剥离，并记录到 debug metadata；是否执行由实现决定，推荐不执行以降低歧义。

备选方案是允许任意位置标签，但会让“标签触发点”和“朗读句子”不明确，也会增加流式半句解析复杂度。

### 4. TTS 第一版按段非流式生成，播放队列顺序消费

当消息绑定 TTS 开启：

1. LLM delta 在服务端出站侧进入 segmenter，同时继续原样推送给聊天文字流。
2. Segmenter 在句末、换行、`stream_end` 或 `turn_end` flush segment。
3. 服务端 TTS worker 按 segment index 启动合成，调用 `toSpeechText(segment)` 得到朗读文本；可并发生成。
4. 服务端将合成结果保存为带签名 URL 的媒体，并向订阅该 `chat_id` 的客户端推送 `assistant-playback-segment` 或等价事件。
5. Electron 播放队列按 index 串行消费 ready segment；播放某段前发送 `segment-start` 给 PSB，音频结束后发送 `segment-end`。
6. 相邻音频切换必须先结束 segment N，再开始 segment N+1：`segment-end(N)` → `segment-start(N+1)` → 播放 N+1 音频。后续段即使已 ready，也不得与当前段重叠播放。

这比整轮结束后一次性 TTS 更快，也比第一版直接做音频 streaming 风险更低。后续可在 `audio.status` 里扩展 `streaming` 状态和二进制音频帧。

### 5. PSB runtime 接收 segment lifecycle，而不是裸 tag stream

Electron 向 PSB 窗口发送高层事件：

- `segment-start`: `{ messageId, segmentIndex, controls }`
- `segment-audio`: `{ messageId, segmentIndex, url, mimeType }`
- `segment-end`: `{ messageId, segmentIndex, reason }`
- `playback-stop`: 停止当前消息并恢复初始状态

Electron 主窗口/renderer 负责维护播放队列和顺序，不直接承担 PSB 音频口型播放。PSB 窗口打开且可用时，它是 PSB 模式下的实际 audio sink：获取 segment 音频、播放、分析音量并驱动口型。若 PSB 窗口未打开或 PSB 未启用，Electron 可以用普通音频播放器播放 segment 音频，但不得与 PSB 窗口重复播放同一段音频。

PSB runtime 从 `controls` 中提取自己能理解的事件（例如 PSB expression/timeline/face/fade），在 `segment-start` 执行；在 `segment-end` 恢复 expression/face/fade。非循环 timeline 仍可在自身动画结束后恢复初始循环 timeline。`controls` 命名保持通用，但一期只实现 PSB consumer；THA 或其他桌宠接入作为后续任务，不在本次实现中新增通知服务端表情或相关逻辑。

旧的 `stream-end` 只作为无 TTS 模式或兜底恢复事件保留到迁移完成，之后可以删除。

### 6. UI 文本流保持连续，播放管线旁路分段

Electron 聊天气泡仍以原始 assistant delta 为主输入，保持现有完整、顺畅的流式文字体验。服务端 segmenter 旁路消费同一批 delta 来生成 TTS playback segments，但不得控制气泡何时显示一句话，也不得等待 TTS segment ready 后才展示文字。

正常气泡渲染只做轻量控制标签过滤：随着 delta 到达持续更新干净正文，控制标签不出现在正常 Markdown 流里。过滤器可以复用 segmenter 的解析规则，但文字流和音频播放流必须解耦。

每条 assistant 气泡提供一个轻量调试切换：

- 关闭：正常用户视图，连续流式显示干净内容。
- 打开：显示 raw content 或 segment 列表，包括 `segmentIndex`、controls、TTS/audio 状态。

这替代当前 `showResponseTags` 的“直接把标签混进正文展示”语义。设置项可重命名为“显示控制标签调试信息”。

## Risks / Trade-offs

- [风险] 服务端 segmenter 会把播放语义带入 WebSocket 出站路径。  
  [缓解] 只在消息绑定 TTS 开启或明确需要 playback consumer 时生成 segment 事件；普通 delta 展示路径保持不变。

- [风险] 模型不遵守“标签放句首”的 prompt 契约。  
  [缓解] Segmenter 对句中控制标签采取保守策略：从展示/朗读文本剥离，记录 debug，不默认执行；测试覆盖常见错误格式。

- [风险] 并发 TTS 生成可能导致后段先完成、播放等待前段。  
  [缓解] 生成可并发，播放必须按 index 顺序；UI 显示 pending/failed 状态，失败段跳过音频但仍可触发/结束 segment 生命周期。

- [风险] 旧的 `tts` tool 删除后，agent 无法主动为任意文本生成音频文件。  
  [缓解] 如果仍需要开发者工具，可保留为内部/调试工具，但不再作为默认用户语音体验；规格以 message-bound playback 为主。

- [风险] 无音频 segment 的生命周期会引入额外状态机。  
  [缓解] 一期不为纯文本展示生成 playback segment；TTS 关闭或朗读文本为空时，只保留 delta 展示和控制标签过滤，不触发 segment playback 生命周期。

## Migration Plan

1. 在服务端添加 segment 数据结构和 parser，但暂不改变现有播放行为。
2. 将聊天展示改为连续 delta 渲染时过滤控制标签；提供 raw/control debug 切换。
3. 在不改变文字渲染节奏的前提下，由服务端推送带 identity 的 playback segment 事件。
4. 接入 message-bound TTS worker，服务端逐段合成，Electron 按 index 播放。
5. 删除或降级旧 `tts` tool 主路径、整条消息音频自动播放逻辑和 `showResponseTags` 的旧语义。
6. 清理旧协议、设置文案和测试 fixture。

## Open Questions

- 后续是否让 THA 或其他桌宠消费同一套 segment `controls`？
- TTS 开关的粒度是全局、会话级，还是 provider/model preset 级？
- 是否要把 segment metadata 持久化到 session history，还是仅作为当前实时播放事件？
