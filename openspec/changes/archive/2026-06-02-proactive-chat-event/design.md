## Context

nanobot 的 Electron 客户端通过 `nanobot/channels/websocket.py`（`WebSocketChannel`）与服务端建立**双向** WebSocket，复用稳定 `chat_id` 重连恢复 session。现状盘点：

- **双向通道已具备**：入站 envelope（`new_chat`/`attach`/`message`）在 `_dispatch_envelope` 路由；出站事件经 `send()`/`_safe_send_to` 推送，renderer `nanobot-client.ts` 按 `event` 字段分发。加新类型是标准扩展点。
- **媒体推送链路已具备**：`OutboundMessage.media`（本地路径）→ `_sign_media_path` 签名 URL → 客户端 `media_urls`。但 `_MEDIA_ALLOWED_MIMES` 仅含 image/video。
- **截图能力已具备**：`electron/src/main.ts` 的 `captureScreen()` + `screenshot:capture` IPC，目前仅由快捷键触发。
- **缺口**：无焦点/presence 上报；无 server→client 指令事件；无 TTS provider（仅有 STT `transcription.py`）；无音频播放。
- **heartbeat**：`HEARTBEAT.md` 驱动的 decide/execute，语义面向"任务"，不适合承载主动陪伴。

约束：自动桌面截图 + 上传 LLM 高度敏感；定时语音易构成骚扰；需向后兼容现有 webui/Electron 协议。

## Goals / Non-Goals

**Goals:**

- 用户把 Electron 切到后台时，助手基于"屏幕截图 + 近期对话"主动生成一句话并语音播放。
- TTS 走厂商无关的 OpenAI 兼容接口，GLM-TTS 仅为配置差异。
- 编排逻辑（语气、是否打扰）用 skill 表达、可自然语言调整；传输/采集/播放为 code 基建。
- 隐私默认安全：功能 opt-in，支持静默时段。

**Non-Goals:**

- 不做单独的"值不值得打扰"LLM gate。
- 不支持非 Electron 客户端的截图/语音（webui 浏览器端不在本期）。
- 不做声音克隆/音色管理 UI（音色用配置 ID）。
- 不改动 heartbeat 既有语义。

## Decisions

### D1. 目标 Electron 的选择：以"最后一条 user 消息来源"判断

触发时不维护独立的"最近连接"注册表，而是读取统一会话里**最后一条 user 消息的来源**（`source_channel="websocket"` + `source_chat_id`），匹配当前订阅该 `chat_id` 且**失焦**的连接。

- 理由：复用现有 unified-inbox 的 source 追踪；天然表达"刚才在跟你聊的那个端"，避免多端歧义。
- 备选：维护全局 last-active 连接表 → 复杂且语义弱（最近活跃 ≠ 当前对话对象）。

### D2. 焦点上报：全部 Electron 上报，失焦即后台

新增入站 envelope `{"type":"presence","focused":bool}`。Electron `main.ts` 监听窗口 `focus`/`blur`（含隐藏到托盘/最小化均触发 blur）→ 经 preload/renderer 上报。服务端在 `WebSocketChannel` 维护 `connection → focused`，默认 `True`。

- 判定：**失焦（`focused=false`）即视为后台**，不细分最小化/遮挡。
- 理由：实现简单、语义足够（用户切走 = 失焦）；`main` 进程焦点比 renderer `visibilityState` 更准。

### D3. 按需截图：专用双向 envelope，回传压缩 JPEG

- 出站：服务端推 `{"event":"screenshot_request","chat_id":...,"request_id":...}` 给目标连接。
- 入站：客户端截图 → 回传 `{"type":"screenshot_result","request_id":...,"data_url":"data:image/jpeg;base64,..."}`。
- 服务端按 `request_id` 解码落盘到 media 目录，供后续 vision 输入。
- 专用而非复用 `message`：避免把截图请求/结果写进对话 transcript 污染上下文。
- **JPEG 是 `captureScreen()` IPC 的通用输出格式**（将 `thumbnail.toDataURL()` 改为 `thumbnail.toJPEG(80)` + base64 封装），不为本功能特判；服务端对 `screenshot_result` 单独设较宽体积上限。

### D4. TTS：原生 OpenAI 兼容 provider（选 A）

各厂商 TTS 已收敛到 OpenAI `POST /v1/audio/speech`（body `{model,input,voice,response_format,speed}` → 二进制音频）：OpenAI 原生、Groq `…/openai/v1/audio/speech`、**GLM-TTS `open.bigmodel.cn/api/paas/v4/audio/speech` 同形**、NanoGPT/LiteLLM 等聚合兼容。

- 新建 `nanobot/providers/tts.py`，**对称复刻 `transcription.py`**：`_resolve_speech_url(api_base, default)` 自动补 `audio/speech`；POST JSON + Bearer；二进制写文件；带重试（沿用 `_RETRYABLE_*`）。
- **厂商额外参数统一用 `extra_body: dict = {}` 合并进 POST JSON**，无 per-provider 分支。GLM 的 `watermark_enabled`、OpenAI 的 `instructions`/`language` 等均通过此字段传入，约 3 行代码。实际超出 base 5 个参数的仅有：GLM-TTS 1 个、OpenAI 2 个，Groq 情感控制靠 input 文本标记（无额外 API 参数）。
- GLM-TTS = 配置 preset：`api_base=https://open.bigmodel.cn/api/paas/v4`、`model=glm-tts`、`voice=<音色ID>`，`extra_body={"watermark_enabled":false}`。
- 暴露 `tts` agent 工具：`tts(text, voice?) -> 音频文件路径`。
- 备选 B（包 glm-tts 脚本/curl 子进程）：脚本本身是同步阻塞 `subprocess.run(curl)`，在 asyncio 上下文需要 `asyncio.to_thread` 包装或重写为 httpx，代价反而更高；且只覆盖 GLM-TTS 单家，与 STT 模式不对称 → 否决。

### D5. 音频下发与播放

- 复用现有 `OutboundMessage.media` → 签名 URL 链路；在 `_MEDIA_ALLOWED_MIMES` 增加 `audio/wav`、`audio/mpeg`、`audio/mp4`。
- renderer 收到带音频 `media_urls` 的消息 → `<audio>` 程序化 `play()` 自动播放。
- 默认输出 `wav`（低延迟、免解码）。

### D6. 触发器：新建独立"主动陪伴"服务

新建独立定时服务（结构参考 `nanobot/heartbeat/service.py`，但不复用 HEARTBEAT.md 语义）：

```
tick:
  if not config.enabled: return
  if 当前在静默时段: return
  target = 最后一条 user 消息来源对应的 ws 连接   # D1
  if target is None or target.focused: return       # D2: 仅后台才触发
  发起一次 agent turn（带主动陪伴 skill），目标 chat = target.chat_id
```

- **连接不存在或处于前台则直接终止 tick，不进入编排**（如伪代码第 3–4 行）。没有 Electron 连接时不需要降级处理。
- 与 heartbeat 解耦：独立 config、独立 interval。
- 备选：塞进 heartbeat 的 run 分支 → 语义混淆、互相干扰 → 否决。

### D7. 编排做成 skill + 配套 tool（回答"抽成技能"）

主动陪伴 skill（`nanobot/skills/`）指挥 LLM：调 `request_screenshot` 工具（发 D3 请求并等回传）→ 读近期对话（已在上下文）→ 写一句简短主动文案 → 调 `tts` 工具 → 调既有 message 能力发给目标 chat。

- skill 只承载"看图+写文案+串 tool"的编排，语气/节制可自然语言调；presence/截图/TTS/播放为 code。
- 不存在"单个 skill 兜全流程"——它依赖 D2–D5 的 code 基建。

### D8. 配置

`nanobot/config/schema.py` 新增两处配置：

- **`proactive_chat`**（根级）：`enabled`（默认 `false`）、`interval_s`、`quiet_hours`（如 `["22:00","08:00"]`）。
- **`tools.tts`**（`ToolsConfig` 下，与 `imageGeneration` 对称）：`enabled`、`default_voice`、`provider`/`api_base`/`api_key`/`model`/`response_format`/`speed`/`extra_body`。

TTS 作为通用工具独立于主动陪伴功能，任何 skill 均可调用 `tts` 工具。主动陪伴需要 `tools.tts.enabled=true` 与 `proactiveChat.enabled=true` 同时开启。

## Risks / Trade-offs

- [自动截屏 + 上传隐私敏感] → 默认 opt-in；首次开启明确提示；仅截目标失焦端；JPEG 落盘走现有签名 media 通道。
- [定时语音骚扰 + token/$$ 成本] → 失焦才触发 + 静默时段 + 间隔下限；后续可加冷却（距上次主动发话最小间隔）。
- [失焦即后台过于宽松：用户切窗口几秒也算后台] → 本期接受；可在 tasks 留"失焦持续 N 秒才算"的增强位。
- [全屏截图体积/多显示器] → 客户端压缩 JPEG + 仅主显示器（沿用 `captureScreen` 现状）。
- [音频自动播放被策略拦截] → Electron renderer 程序化播放一般不受限，实现时验证；失败降级为静默 + 文本消息。
- [多 Electron 同时连接] → D1 以 last-user-message 来源唯一定位，天然去重。

## Open Questions

- 是否需要"失焦持续 N 秒"才算后台，避免瞬时切窗误触发？（倾向后续增强，本期失焦即触发）
- 主动发话是否要写入对话历史（让用户回到前台能看到文字+回放语音）？倾向写入（作为助手消息，附音频），截图请求/结果不写入。
- 冷却窗口（最小主动间隔）默认值多少合适？
