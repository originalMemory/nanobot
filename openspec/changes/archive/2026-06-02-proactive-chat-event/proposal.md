## Why

nanobot 当前只能被动响应用户消息。当用户把桌面 Electron 客户端切到后台、转去做别的事时，助手完全沉默，缺少"主动陪伴"的能力。我们希望在用户离开对话时，助手能基于"此刻屏幕在做什么 + 最近聊了什么"，主动生成一句贴合情境的话，并以语音念给用户听，营造有人在身边的陪伴感。

## What Changes

- 新增**主动陪伴触发器**（独立定时服务，与 heartbeat 解耦）：周期性检查"最后一条 user 消息来源的 Electron 连接是否当前失焦"，满足则发起一次主动事件。
- 新增 **WebSocket 焦点上报**：所有 Electron 客户端上报窗口焦点状态；服务端维护 `连接 → 是否失焦` 表。
- 新增**按需截图协议**（专用 envelope，不走 message、不污染对话）：服务端向目标 Electron 推送截图请求 → 客户端用现有 `captureScreen` 截图、**压缩成 JPEG**、回传上传。
- 新增**原生 TTS provider**（OpenAI 兼容 `/v1/audio/speech`），GLM-TTS / OpenAI / Groq 等仅作配置差异；暴露为 `tts` agent 工具。
- 新增 **Electron 音频播放**：服务端把生成的语音作为媒体推送给目标 chat，客户端自动播放；放宽出站媒体 MIME 白名单以允许音频。
- 新增**主动陪伴编排 skill**：指挥 LLM 完成"看截图 + 读近期对话 → 写一句简短主动文案 → 调 `tts` → 发送给 Electron"。
- 配置项：开关（默认关，opt-in）、触发间隔、静默时段、TTS 音色/provider。

> 不做：单独的"值不值得打扰"LLM gate（靠触发条件 + 静默时段 + 编排 skill 内容把关）。

## Capabilities

### New Capabilities

- `proactive-chat`: 主动陪伴的端到端行为——触发条件、编排流程、配置项（opt-in/间隔/静默时段）与隐私约束。
- `tts-provider`: 原生 OpenAI 兼容文本转语音 provider，多厂商配置 preset（含 GLM-TTS），及 `tts` 工具。
- `client-presence`: Electron 焦点状态上报协议与服务端追踪。
- `screenshot-on-demand`: 服务端按需向客户端请求截图、客户端截图压缩 JPEG 并回传的双向协议。
- `audio-message-playback`: 出站音频媒体推送与 Electron 自动播放。

### Modified Capabilities

<!-- 这些行为以新 capability 引入，不修改现有 spec 的既有需求。 -->

## Impact

- 服务端：`nanobot/channels/websocket.py`（新入站/出站 envelope、presence 表、音频 MIME 白名单）、`nanobot/providers/tts.py`（新建）、`nanobot/agent/tools/`（新 `tts` 工具 + 截图请求工具）、新增主动陪伴触发服务（参考 `nanobot/heartbeat/service.py`）、`nanobot/config/schema.py`、`nanobot/skills/`（新编排 skill）。
- 客户端：`electron/src/main.ts`（焦点事件 + 截图压缩 IPC）、`electron/src/preload.ts`、renderer（`nanobot-client.ts` 新事件分发、presence 上报、音频播放）。
- 依赖：无新增 Python 运行时依赖（复用 `httpx`）；TTS 需用户配置 API key。
- 隐私/安全：自动桌面截图并上传给 LLM 属高敏感操作，默认关闭，需显式开启。
