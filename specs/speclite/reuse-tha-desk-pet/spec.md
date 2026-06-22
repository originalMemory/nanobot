# Spec: reuse-tha-desk-pet

## Why
- 复用 Super Agent Party 的 THA Desk Pet，给 nanobot 增加 2D 虚拟形象入口。
- Phase 1 先跑通 SAP 远端渲染流程；Phase 2 再评估 Electron 本地引擎，消除口型/渲染网络延迟。

## Scope
### Phase 1（本次）
  - 引入固定 THA 模型文件：个人项目不做用户上传/模型管理，更换时直接替换本地模型文件。
  - 引入 `/ws/tha` 渲染链路：服务端加载 `.onnx` / `.mlpackage`，保留 SAP 全部硬件加速 provider，生成 pose，输出 JPEG 帧。
  - 引入独立 THA 页面（对齐 SAP `tha.html`）：不嵌入主 WebUI，单独 URL 打开；Electron 用独立窗口，浏览器可直接访问。
  - THA 页面职责：PixiJS 显示帧流、连 `/ws/tha` 渲染、连 THA 事件通道收音频/事件、本地 Web Audio 播放 + 口型分析、鼠标跟随、窗口控制。
  - 主 WebUI 设置页：配置 `THAConfig`、显示固定模型状态、启动 THA 入口（打开独立页面/窗口）、`audioDelayMs`。
  - 接入会话/TTS 事件：解析 LLM 输出中的表情/动作标签，按 TTS chunk 触发；支持后端与 Electron 不在同一设备。
  - 远端场景：`audioDelayMs` + `/ws/tha` latency probe，先手动调口型延迟。

### Phase 2（待办，本次不做）
- Electron 本地 THA 引擎：ONNX/CoreML 推理、PixiJS 显示、Web Audio 口型，全在 THA 子窗口内完成。
- 主窗口 → THA 子窗口经 Electron IPC 传 TTS 音频与表情事件，去掉 mouth/JPEG 跨网络环。
- 可选：gateway 仅负责 agent/TTS 生成，THA 渲染不依赖 `/ws/tha`。
- **高级字幕打字机（Omni 流式）**：对齐 SAP `tha.js` 的 `omniStreaming` 体验——流式文本逐字显示（约 10 字/秒）、超长滚动窗口（60 字 + 标点切分 + `...` 前缀）、与 TTS/口型结束联动清空；需 gateway 或 `/ws/tha-events` 推送增量文本事件（非当前「整段音频 URL + 完整文本」一次性模式）。

### 明确不做
- 3D VRM/VTS。
- THA 模型训练或格式转换。
- 改动核心 agent loop 消息协议，除非 Phase 1 接入必需。

## Plan
### Phase 1
- [x] 对照 nanobot WebUI/API 架构，确定 THA 配置持久化位置与静态资源打包路径。
- [x] 移植 THA engine：`THAPoseGenerator`、ONNX engine、CoreML engine、engine cache、固定模型定位、provider 选择。
- [x] 新增后端 API：THA 配置读写、固定模型状态。
- [x] 新增 `/ws/tha`：按 `selectedModelId` 找模型，渲染 30 FPS JPEG，接收 `emotion` / `motion` / `mouth` / `mouse` / latency probe 指令。
- [x] 新增独立 THA 页面 + 静态资源：移植 SAP `tha.html` / `tha.js`，双 WebSocket（`/ws/tha` 渲染 + TTS 广播通道）。
- [x] 主 WebUI 设置页增加 THA 区块：启动独立 THA 窗口/标签页、固定模型状态、配置项、`audioDelayMs`。
- [x] 接入文本/TTS 事件：LLM 标签解析、音频附件事件触发表情/动作；THA 页本地播放/分析音频并按延迟配置驱动 mouth。
- [x] Electron 集成：独立透明窗口加载 THA URL（对齐 SAP `startTHAWindow`）。
- [ ] 补测试：固定模型定位/API、配置读写、WebSocket 模型缺失失败路径。

### Phase 2（Backlog）
- [ ] 调研 Electron 内 `onnxruntime-node` / CoreML 本地推理可行性与包体积。
- [ ] THA 子窗口 IPC：主窗口转发 TTS binary + `startSpeaking` / `expressions`。
- [ ] 本地 THA 引擎替代 `/ws/tha` 渲染链路；保留 gateway 模式作为 fallback。
- [ ] 本地模式下移除或弱化 `audioDelayMs` / latency probe。
- [ ] **高级字幕打字机**：移植 SAP `startTypewriterLoop` / `updateSubtitleAndRoll` / `finalizeSpeech`；后端增加流式字幕事件（如 `omniStreaming` 或等价 `subtitle` delta），与 TTS chunk 或 agent 流式输出同步；参考 `super-agent-party/static/js/tha.js` L526–638、L826–858。
- [ ] **THA text/TTS 绑定对齐 SAP**：SAP 将带标签台词与音频绑在同一事件；nanobot 广播 `text=message.content`（jsonl 同字段 + `media`），agent 常把 `<happy>` 等只写在 `tts` 参数、content 另写短旁白，导致 THA 表情/字幕取不到标签。可选：gateway 从同轮 `tts` tool 参数回填 THA `text`；或强化 prompt 要求 `message.content` 含标签且与 spoken 文本一致（`tts` 侧继续 `strip_tha_tags`）。
- [ ] **消息模型对齐 SAP（展示 vs 朗读 vs 桌宠）**：SAP 一轮回复收在单个 `currentMsg` 内分工——`displayBlocks`（UI，含 reasoning/tool）、`ttsChunks[]`（清洗+切分后的可朗读文本）、`audioChunks[]`（同 index 绑定 text/expressions/audio）；展示文本与 TTS 文本可不一致（Markdown/代码/图片/silence 等过滤）。nanobot 一轮回复拆散为多条 session 记录：`assistant.content`、独立 `tts` tool 参数、`media[]` 附件、tool 消息；无 chunk 级 `{spokenText, expressions, audio}` 结构，THA 只能从带 `media` 的 `content` 取 `text`。对齐需引入 chunk 级字段或 gateway 聚合层，并区分 `displayText` vs `spokenText`（类似 SAP `displayBlocks` vs `ttsChunks`）。

## Apply Notes
- 实施策略：**C 路线** — Phase 1 先跑通 SAP 远端渲染；Phase 2 本地 Electron 引擎记 backlog，不阻塞 Phase 1。
- 当前进度：Phase 1 主链路已通（配置/API/固定模型/`/ws/tha`/`/ws/tha-events`/独立页面/Electron 窗口/历史回放转发 THA/口型音频驱动）；nanobot TTS 以音频附件 URL 事件接入，非 SAP 实时 binary chunk；字幕整段显示。**已知差异**：整轮回复消息模型不同（SAP 单 `currentMsg` 多管线 vs nanobot 打散 `content`/`tts`/`media`/tool），见 Phase 2「消息模型对齐 SAP」；THA `text` 取自出站 `content`，见「THA text/TTS 绑定对齐 SAP」。
- Super Agent Party 参考路径：`/Users/illusion/dev/github/super-agent-party`。
- THA 固定模型形态：优先 nanobot 数据目录 `tha_model/model.mlpackage`（macOS）或 `tha_model/model.onnx`；没有时 fallback 到包内 `nanobot/web/tha_models/model.*`。
- 保留 SAP 硬件加速顺序：TensorRT、CUDA、ROCM、DirectML、CoreML、CPU；`.mlpackage` 走 CoreML engine。
- 不做用户上传/删除/多模型选择；更换模型时直接替换固定模型文件。
- WebUI dev server 需代理 THA API 与 `/ws/tha`。
- nanobot 后端可能运行在其他设备；不要写死 SAP 的 `150ms` 音频延迟，使用 `THAConfig.audioDelayMs`，默认值仅作本地起点。
- `/ws/tha` 需支持 ping/pong latency probe；前端可显示/记录 RTT，用于调整 `audioDelayMs`。
- 接入形态对齐 SAP：主 WebUI 只管配置和启动；THA 是独立页面 `{gateway}/tha.html`（或等价路径），不是主 SPA 内嵌组件。
- THA 页面连 THA 事件通道（nanobot 用 `/ws/tha-events`）；当前从 websocket 出站音频附件广播 URL，THA 页本地 fetch/play/analyse mouth。
- 表情/动作触发时机（对齐 SAP）：
  - `enabledEmotions=true` 时 system prompt 注入标签说明，LLM 在句首输出 `<happy>` / `<nod>` 等。
  - nanobot 当前不是 SAP 的实时 TTS chunk；先在音频附件事件中用正则提取标签到 `expressions[]`，字幕文本去掉标签。
  - 音频播放前：在 `THA_MOTIONS` 里走 `motion`，否则走 `emotion`。
  - 无 TTS 的流式文本模式走 `omniStreaming`，同样带 `expressions` 触发。
  - 一段语音结束 THA 页本地 `resetEmotionToNeutral()` + `motionClear`。
  - 空闲动画（呼吸、眨眼、鼠标跟随）由后端 `THAPoseGenerator.step()` 持续运行，不依赖 LLM 标签。
- 口型同步采用 SAP 模式：THA 独立页播放 TTS 音频并用 Web Audio `AnalyserNode` 算 mouth，再发给 `/ws/tha`；当前音频来源是 `/ws/tha-events` 传入的媒体 URL。
- 模型文件体积大，默认不把外部模型复制进本 spec；实现时确认仓库是否已有可分发模型。

## Verify
- [ ] 启动 gateway 后，`GET /api/tha` 和 `GET /api/tha/model` 返回稳定 JSON。
- [ ] 替换固定 `model.onnx` 或 `model.mlpackage` 后，模型状态变为 available。
- [ ] 从设置页或 `{gateway}/tha.html` 打开独立 THA 页面，前端收到 JPEG 帧并显示 2D 形象。
- [ ] Electron 可启动独立 THA 窗口；浏览器也可直接打开同一 URL。
- [ ] 发送 `emotion` / `motion` / `mouth` / `mouse` WebSocket 指令后，姿态变化可见。
- [ ] `/ws/tha` latency probe 可返回 RTT；调整 `audioDelayMs` 后口型相对音频延迟变化可观察。
- [ ] 出站音频附件可通过 `/ws/tha-events` 触发 THA 本地播放、字幕和 mouth。
- [ ] ONNX Runtime 可用 provider 列表按 SAP 顺序选择；无硬件 provider 时回退 CPU。
- [ ] macOS `.mlpackage` 模型走 CoreML engine；`.onnx` 模型走 ONNX engine。
- [ ] 启用表情后，含 THA 标签的回复能驱动对应表情/动作。
- [ ] 现有 settings API 测试通过，新增 THA 测试通过。

## Status
- State: done
- Archived: no
