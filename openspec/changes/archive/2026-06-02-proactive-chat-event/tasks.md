## 1. 配置

- [x] 1.1 在 `nanobot/config/schema.py` 新增 `proactive_chat` 配置块：`enabled`(默认 false)、`interval_s`、`quiet_hours`、`voice`
- [x] 1.2 新增 TTS 配置块：`provider`/`api_base`/`api_key`/`model`/`response_format`/`speed`，含 GLM-TTS preset 默认值注释

## 2. TTS Provider（client-presence 无关，可先做）

- [x] 2.1 新建 `nanobot/providers/tts.py`，对称复刻 `transcription.py`：`_resolve_speech_url` 自动补 `audio/speech`
- [x] 2.2 实现 POST JSON `{model,input,voice,response_format,speed,**extra_body}` + Bearer，二进制写文件，沿用退避重试常量
- [x] 2.3 config 支持 `extra_body: dict = {}` 合并进请求体（GLM 的 `watermark_enabled`、OpenAI 的 `instructions` 等均通过此字段）
- [x] 2.4 缺 API key / 文件写入失败时记录告警并安全返回
- [x] 2.5 在 provider factory/registry 注册 TTS provider（参考 transcription 的接入方式）
- [x] 2.6 单测：URL 解析、成功合成落盘、重试、缺 key 降级（参考 `tests/providers/test_transcription.py`）

## 3. TTS 工具

- [x] 3.1 新建 `nanobot/agent/tools/` 下 `tts` 工具：`tts(text, voice?) -> 音频文件路径`
- [x] 3.2 工具自动发现/注册校验（registry）
- [x] 3.3 单测：工具调用合成并返回路径

## 4. WebSocket 焦点上报（client-presence）

- [x] 4.1 服务端 `WebSocketChannel` 维护 `connection -> focused`（默认 true），断开时清理
- [x] 4.2 在 `_dispatch_envelope` 新增 `presence` 入站类型，更新焦点状态
- [x] 4.3 Electron `main.ts` 监听窗口 `focus`/`blur`，经 preload 暴露给 renderer
- [x] 4.4 renderer/`nanobot-client.ts` 发送 `presence` envelope（获焦/失焦各一次，连接建立后同步初值）
- [x] 4.5 单测：服务端收到 presence 后状态更新、断开清理、默认获焦

## 5. 按需截图（screenshot-on-demand）

- [x] 5.1 服务端新增出站 `screenshot_request` 事件（带 `request_id`，定向单连接），不写 transcript
- [x] 5.2 服务端新增入站 `screenshot_result` envelope：校验体积、解码 JPEG 落盘到 media 目录、按 request_id 关联
- [x] 5.3 服务端提供"请求截图并等待结果（带超时）"的等待原语（future/Event by request_id）
- [x] 5.4 修改 `captureScreen()` IPC 固定输出 JPEG（`thumbnail.toJPEG(80)` + base64 封装，通用改动），renderer 收到 `screenshot_request` 后调用并回传 `screenshot_result`
- [x] 5.5 服务端 `screenshot_result` 单独体积上限（高于普通图片上限）
- [x] 5.6 单测：request/await/超时降级、JPEG 落盘、transcript 不被污染

## 6. 音频下发与播放（audio-message-playback）

- [x] 6.1 在 `_MEDIA_ALLOWED_MIMES` 增加 `audio/wav`、`audio/mpeg`、`audio/mp4`
- [x] 6.2 验证音频经 `OutboundMessage.media` → 签名 URL → `media_urls` 链路（必要时放宽 media 校验）
- [x] 6.3 renderer 收到带音频 `media_urls` 的消息时 `<audio>` 自动播放，失败降级为文本
- [x] 6.4 单测：音频 MIME 放行、签名 URL 生成；renderer 播放/降级测试

## 7. 主动陪伴触发器（proactive-chat）

- [x] 7.1 新建独立触发服务（参考 `nanobot/heartbeat/service.py` 结构，不复用 HEARTBEAT.md 语义）
- [x] 7.2 实现"最后一条 user 消息来源 → 目标 ws 连接"定位（复用 unified-inbox source 追踪）
- [x] 7.3 tick 逻辑：enabled + 非静默时段 + 目标连接失焦 → 发起一次 agent turn，目标 chat=该连接 chat_id
- [x] 7.4 在 `nanobot/cli/commands.py` 接线启动该服务（与 heartbeat 并列）
- [x] 7.5 单测：各跳过分支（未启用/静默/无目标/前台）与触发分支

## 8. 编排 skill（proactive-chat）

- [x] 8.1 新建 `nanobot/skills/proactive-chat/SKILL.md`：指挥 LLM 请求截图→读近期对话→写简短主动文案→调 `tts`→发送给目标 chat
- [x] 8.2 提供"向目标 chat 发送文案+音频"的能力衔接（复用 message 工具/出站消息）

## 9. 隐私与文档

- [x] 9.1 默认关闭，首次开启提示用户截屏将被采集上传（文案/设置位）
- [x] 9.2 更新 `docs/configuration.md` 与相关 README，说明 proactive_chat / TTS 配置
- [x] 9.3 端到端联调：后台失焦 → 截图 → 文案 → 语音 → 自动播放

## 10. 验证

- [x] 10.1 `ruff check nanobot/` 通过
- [x] 10.2 相关 pytest 全绿
- [x] 10.3 `cd electron && bun run test` 通过
- [x] 10.4 `openspec validate proactive-chat-event --strict` 通过
