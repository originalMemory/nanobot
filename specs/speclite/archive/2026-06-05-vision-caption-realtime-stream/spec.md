# Spec: vision-caption-realtime-stream

## Why
- 配置 `visionModel` 后，`_state_caption` 用 `chat_with_retry` 阻塞等全部图片识别完，才在 BUILD 阶段把 caption 写入 session。
- Electron 本地发图时用户气泡是乐观渲染，不含 caption；WS 无 caption 事件，只能重连拉 thread 才看到 `VISION_CAPTION_SENTINEL` 段。

## Scope
- 本次要做：视觉模型改流式 `chat_stream_with_retry`，识别 token 经 bus → WebSocket 实时推送。
- 本次要做：新增 WS 事件 `vision_caption_delta` / `vision_caption_end`（含 `image_index`、`stream_id`）；ChannelManager + WebSocketChannel 路由。
- 本次要做：Electron `useNanobotStream` 消费事件，更新**当前 turn 最后一条 user 消息**的 caption 区；`CaptionBubble` 支持 streaming 态（展开 + sheen）。
- 本次要做：单测覆盖流式 caption 回调与 WS wire 形状；现有 `test_vision_caption` 保持通过。
- 本次不做：WebUI 前端（仍靠 thread 重载展示 caption）。
- 本次不做：Telegram/Discord 等非 WebSocket channel 的 caption UI。
- 本次不做：改 caption prompt、vision 配置 UI、openspec 归档。
- 本次不做：识别失败 warning 的 UI 改造（仍走现有 `_caption_warning` outbound）。

## Plan
- [x] `vision_caption.py`：`_caption_single` 改 `chat_stream_with_retry`；`caption_images` 增 `on_delta(index, text)` / `on_image_end(index)` 回调；多图仍 `asyncio.gather` 并发。
- [x] `loop.py` `_state_caption`：websocket 且 `_wants_stream` 时注册回调，`publish_outbound` 带 `_vision_caption_delta` / `_vision_caption_end` + `image_index` + `stream_id`；caption 完成后仍写 sentinel 到 `ctx.msg.content`（session 持久化不变）。
- [x] `channels/base.py` + `websocket.py` + `manager.py`：`send_vision_caption_delta/end`，`_send_once` 路由；transcript append。
- [x] Electron `types.ts`：补 `InboundEvent` 变体。
- [x] Electron `useNanobotStream.ts`：处理 delta/end，patch 最后 user 消息的 caption（sentinel 前缀 + 累积文本）；多图按 `image_index` 拼接 `format_captions` 同形段落；rAF 合并 + `turn_end` 清理 streaming 态。
- [x] Electron `MessageBubble.tsx`：`CaptionBubble` 增 `streaming` prop。
- [x] 测试：`test_vision_caption` 流式 mock；`test_websocket_channel` 或新测断言 wire JSON。

## Apply Notes
- 流式仅 WebSocket + `_wants_stream`；CLI/无订阅 channel 行为不变（阻塞 caption，无 WS）。
- `stream_id` 建议 `{session_key}:caption:{image_index}`，防多图并发串流。
- delta 推原始识别文本；`vision_caption_end` 后前端拼入与 `format_captions` 一致的前缀（单图 `图片描述：`，多图 `**图片 N**`）。
- 识别失败：该图 `on_image_end` 推占位 `（描述获取失败 - …）`，不推 delta。
- 不推 `session_updated` 替代流式——thread 重载仍应显示完整 caption（回归验证）。
- unified inbox fan-out：caption 事件跟 `reasoning_delta` 一样仅推原 chat 订阅者（user 气泡属本地 turn，不做 inbox fan-out）。

## Verify
- [ ] Electron：发带图消息 + 已配 `visionModel`，caption 区在识别过程中逐字出现，无需刷新 thread。
- [ ] Electron：多图并发，各图 caption 段落随各自完成陆续出现。
- [ ] turn 结束后 thread API 重载，caption 内容与实时展示一致（含 sentinel）。
- [ ] 未配 `visionModel` 或无图：无 caption 事件，行为与改前一致。
- [x] `pytest tests/agent/test_vision_caption.py tests/channels/test_websocket_channel.py -q` 通过。

## Status
- State: done
- Archived: no
