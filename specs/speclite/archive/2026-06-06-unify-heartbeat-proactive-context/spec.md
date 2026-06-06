# Spec: unify-heartbeat-proactive-context

## Why
- `HEARTBEAT.md` 已描述主动问候、跟进、资讯分享。
- `ProactiveChatService` 与 heartbeat 重复：独立定时、独立 session、独立投递。
- heartbeat 压制 `message` 工具，阻断图片、语音、富媒体主动发送。
- 桌面感知散在 proactive 服务层，agent 不能按 `HEARTBEAT.md` 自主判断。

## Scope
- 本次要做：
  - heartbeat 作为主动感知唯一调度/决策入口。
  - 新增 `desktop_context` tool：返回 Electron 桌面状态、截图路径、按 `visionModel` 配置自动 caption 或交给主模型理解。
  - 放开 heartbeat 中的 `message` tool；支持文字、图片、TTS 音频通过工具直接投递。
  - heartbeat 已调用 `message` 时，不再追加投递 `resp.content`。
  - 移除 `ProactiveChatService` 独立 loop、`proactiveChat` 配置、`proactive-chat` skill。
  - 更新 `HEARTBEAT.md` 模板和配置文档。
- 本次不做：
  - 不改 webui。
  - 不改 Electron UI。
  - 不自动覆盖真实 workspace 的 `HEARTBEAT.md`。
  - 不新增频率数据库；频率由 `gateway.heartbeat.interval_s`、会话历史、`HEARTBEAT.md` 约束。
  - 不实现 tool 结果自动多模态回灌。

## Plan
- [x] 复用 `WebSocketChannel` 现有桌面感知能力；仅在现有接口无法表达必要状态时补最小 accessor。
- [x] 在 gateway 发现 WebSocket 通道后，手动注册 `desktop_context` tool 并传入专属依赖。
- [x] 新增 `nanobot/agent/tools/desktop_context.py`，任意会话可调用。
- [x] `desktop_context` 请求最近 Electron 用户连接截图；无连接、前台、锁屏、截图失败时返回 `screenshot_path: null` 和原因。
- [x] `desktop_context` 的 visualModel 使用条件与用户发图片一致；caption 失败返回错误字段，不中断调用。
- [x] 调整 heartbeat 分支：移除 `set_suppress_delivery(True)`，启用 channel delivery 记录。
- [x] 调整 heartbeat 分支：`message` 已发送时跳过 evaluator 和 `_deliver_to_channel`，避免重复消息。
- [x] 删除 gateway 中 `ProactiveChatService` 构造、启动、停止、横幅和 `_on_proactive_chat_trigger`。
- [x] 删除或退场 `nanobot/proactive_chat/service.py`、`nanobot/skills/proactive-chat/SKILL.md`、`ProactiveChatConfig`。
- [x] 更新 `nanobot/templates/HEARTBEAT.md`，说明 `desktop_context`、`message`、`tts` 的主动感知用法。
- [x] 更新 `docs/configuration.md`，移除 `proactiveChat`，补充 heartbeat + `desktop_context` 配置。
- [x] 更新测试：desktop tool、heartbeat 富媒体投递、无重复投递、proactive 退场。

## Apply Notes
- `desktop_context` 默认受 opt-in 配置保护；截图能力默认关闭。
- 推荐配置键：`tools.desktopContext.enabled`。
- `desktop_context` 不限制 session；普通对话、heartbeat、cron turn 均可调用。
- 不扩展通用 `ToolContext` / `ToolLoader` 构造协议；WebSocket 通道和 caption 依赖由 `desktop_context` 专属构造路径提供。
- 优先复用 `get_unfocused_last_user_connection()`、`request_screenshot()`、`is_connection_focused()`、`is_connection_locked()`；不为测试形状新增大接口。
- 无 Electron 连接、前台、锁屏、截图超时均降级为空上下文。
- 配置了 `agents.defaults.visionModel` 时用辅助模型 caption；未配置时截图以 image blocks 交给主模型，无需 `include_caption` 参数。
- heartbeat 普通文本输出继续 fail-closed evaluator。
- 旧 `proactiveChat` 配置删除，不做兼容 shim。

## Verify
- [x] `pytest tests/tools/test_desktop_context_tool.py tests/channels/test_websocket_screenshot.py tests/cli/test_commands.py -q`
- [x] `pytest tests/tools/test_tool_loader.py -q`
- [x] heartbeat 中调用 `message(content, media=[...])` 可投递到 `websocket:inbox:unified`。
- [x] heartbeat 已调用 `message` 时，不再额外投递 `resp.content`。
- [x] 无 Electron 连接、前台、锁屏、截图失败时 heartbeat 正常降级。
- [x] `proactiveChat` 配置和独立 loop 不再启动。
- [x] `ruff check nanobot tests`：当前环境未安装 `ruff` / `python -m ruff`。

## Status
- State: done
- Archived: yes
