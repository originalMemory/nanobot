# Spec: assistant-source-badge

## Why
- 统一收件箱里 assistant 消息来自 QQ、Telegram、heartbeat/cron 等，气泡上无法区分来源
- 侧边栏只能按通道筛选，单条消息在对话流里缺少上下文

## Scope

本次要做：
- assistant 气泡 **bot 名称右侧** 展示来源徽章：`图标 + 文字`
- 来源规则：
  - 有 `sourceChannel` → 通道 label + 通道图标（`qq` 等补全 `CHANNEL_LABEL`）
  - `sourceChannel === "websocket"` → 不展示来源徽章（Electron 本机发送不标记）
  - 有 `channelDelivery` → 追加「主动推送」段（Bell 图标）；与通道同时存在时用 `·` 连接，如 `QQ · 主动推送`
  - 两者皆无 → 不展示徽章
- 覆盖 `AssistantTurnBubble` 与 `MessageBubble` 中所有 assistant 名称行
- 修复 `replay_transcript_to_ui_messages`：`source_channel` → `sourceChannel`（user / assistant message 事件），历史加载也能显示
- i18n：`message.source.proactive`（zh-CN + en）
- 单元测试：来源解析逻辑 + transcript 重放保留 `sourceChannel`

本次不做：
- 区分 heartbeat vs cron（后端无独立字段）
- user 消息来源徽章
- 实时 `event: user` fan-out 消费（已有缺口，另开 spec）
- WebUI（非 Electron）同名改造

## Plan

- [x] `electron/src/renderer/lib/message-source.ts`：`resolveMessageSourceBadge(message)` 返回 `{ icon, label } | null`
- [x] `electron/src/renderer/lib/channels.ts`：补 `qq` 等常用通道 label；`channelIcon(channel)` 映射 lucide 图标
- [x] `electron/src/renderer/components/MessageSourceBadge.tsx`：徽章 UI（`text-[11px]`、`text-muted-foreground/70`、inline-flex gap-1）
- [x] `electron/src/renderer/components/AssistantNameRow.tsx`：botName + 可选 badge，供两处气泡复用
- [x] `AssistantTurnBubble.tsx` / `MessageBubble.tsx`：名称行改用 `AssistantNameRow`
- [x] `nanobot/webui/transcript.py`：`replay_transcript_to_ui_messages` 的 `user` / `message` 分支写入 `sourceChannel`
- [x] `tests/utils/test_webui_transcript.py`：重放保留 `sourceChannel` 用例
- [x] `electron/src/renderer/tests/message-source.test.ts`：解析规则用例
- [x] i18n key

## Apply Notes

- 徽章样式：`flex items-center gap-1.5`，名称与徽章同一行，`badge` 用更低对比度，不抢 botName
- `AssistantTurnBubble` 从 `footerMessage`（或首个 text segment）取 `sourceChannel` / `channelDelivery`
- 通道图标 fallback：`MessageCircle`（lucide）
- 主动推送 icon：`Bell`
- 本机 `websocket` 来源隐藏，不占用 badge
- transcript fix 与 UI 同 PR，否则重启后历史徽章消失
- speclite 技能只保留 `.claude/skills/speclite/`（Cursor 加载路径）
- macOS 托盘另加 `trayTemplate.png` + `setTemplateImage(true)`（同 commit，非本 spec 核心范围）

## Verify

- [x] QQ 等外部通道 assistant 回复：名称右侧显示 `QQ`（或对应 label）+ 图标
- [x] heartbeat/cron 主动投递：显示 `主动推送`（可与通道组合）
- [x] Electron 本机回复（`sourceChannel=websocket`）：不展示来源徽章
- [x] 普通 WebSocket 对话（无 sourceChannel、无 channelDelivery）：无徽章
- [x] 重启后从 `/api/inbox/thread` 加载的历史仍带徽章（transcript 重放已 fix）
- [x] `npx vitest run src/renderer/tests/message-source.test.ts` 通过
- [x] `tests/utils/test_webui_transcript.py::test_replay_preserves_source_channel` 用例已添加

## Status
- State: done
- Archived: yes
